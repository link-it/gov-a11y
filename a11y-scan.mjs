#!/usr/bin/env node
/*
 * gov-a11y - Accessibility (WCAG) scanner for Link.it web consoles
 * https://github.com/link-it/gov-a11y
 *
 * Copyright (c) 2025-2026 Link.it srl (https://link.it).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3, as published by
 * the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
/*
 * gov-a11y — Audit di accessibilita' WCAG 2.x, esterno e black-box, config-driven multi-app.
 *
 * Esegue axe-core (via Playwright) contro una webapp in esecuzione via HTTP, gestendo il login
 * e (opzionalmente) crawlando le pagine raggiungibili. Verifica anche l'accessibility tree
 * (elementi interattivi senza nome) e, opzionale, un virtual screen reader e Lighthouse.
 * Produce report in piu' formati agganciabili a Jenkins/GitHub Actions e SonarQube.
 *
 * Uso a mano:
 *   node a11y-scan.mjs --base http://localhost:6200 --config ./targets.<app>.json --out ./report-<app>
 *
 * Uso in pipeline (stesso comando): vedi README.md
 *
 * Output (in --out, default ./report):
 *   axe-results.json   report grezzo axe per ogni pagina
 *   a11y.sarif         SARIF 2.1.0            -> Jenkins Warnings NG
 *   sonar-issues.json  Generic Issue Import   -> Sonar (sonar.externalIssuesReportPaths)
 *   a11y-junit.xml     JUnit                  -> Jenkins JUnit plugin (trend)
 *   summary.json       riepilogo sintetico
 *   report.html        report leggibile
 *
 * Exit code != 0 se il gate configurato non e' rispettato (--fail-on / --min-score).
 */

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ----------------------------- CLI parsing ------------------------------ */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    } else { a._.push(t); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`gov-a11y — audit accessibilita' (multi-app) WCAG 2.x, esterno e black-box

  --base <url>        Base URL della webapp in test (o env A11Y_BASE_URL). Default http://localhost:8080
  --user <u>          Utenza (o env A11Y_USER). Default amministratore
  --pass <p>          Password (o env A11Y_PASS). Default 123456
  --config <file>     File target (default ./targets.json)
  --out <dir>         Directory report (default ./report)
  --only <k>          Limita a un target (chiave del config)
  --crawl <n>         Dopo il login, scopre e scansiona fino a n pagine per target (default 0 = solo pagine in config)
  --crawl-depth <d>   Profondita' di navigazione del crawl (BFS). Default 2
  --tags <list>       Tag WCAG axe (default wcag2a,wcag2aa,wcag21a,wcag21aa)
  --fail-on <sev>     Gate axe: fallisci se esistono violazioni >= gravita'. critical|serious|moderate|minor|none (default serious)
  --fail-on-nameless  Gate a11y-tree: fallisci se esistono elementi interattivi senza nome accessibile (screen-reader)
  --lighthouse        Calcola anche il punteggio Lighthouse Accessibility (richiede optional deps)
  --min-score <0..1>  Gate Lighthouse: fallisci se un punteggio scende sotto la soglia (es. 0.90). Implica --lighthouse
  --screen-reader     Esegui il virtual screen reader (annunci) su ogni vista (richiede optional deps)
  --no-flows          Non eseguire i flows di navigazione scriptata (pagine di dettaglio)
  --no-lighthouse     Disabilita Lighthouse anche se attivo in config (precedenza sulla config)
  --no-screen-reader  Disabilita il virtual screen reader anche se attivo in config
  --no-crawl          Disabilita il crawl anche se attivo in config (equivale a --crawl 0)
  --insecure          Ignora errori certificato HTTPS (default true)
  --help              Questo aiuto

  Credenziali per-target: env A11Y_<TARGET>_USER / A11Y_<TARGET>_PASS (fallback: GW_<TARGET>_USER/PASS).

  Parametri in CONFIG: oltre che da CLI, i parametri si possono dichiarare nel file config, nel blocco
  "defaults" (globali) e/o dentro ogni target (override per-target). Chiavi: tags, crawl, crawlDepth,
  lighthouse, screenReader, failOn, failOnNameless, minScore, noFlows, insecure.
  Precedenza: CLI > target > defaults > built-in. (Il gate failOn/failOnNameless/minScore è globale.)
`);
  process.exit(0);
}

// Env de-brandizzate (A11Y_*), con fallback alle legacy GovWay (GW_*) per retrocompatibilita'.
const BASE = (args.base || process.env.A11Y_BASE_URL || process.env.GW_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const USER = args.user || process.env.A11Y_USER || process.env.GW_USER || 'amministratore';
const PASS = args.pass || process.env.A11Y_PASS || process.env.GW_PASS || '123456';
const OUT = resolve(process.cwd(), args.out || './report');
const CONFIG = resolve(process.cwd(), args.config || resolve(__dirname, 'targets.json'));
const ONLY = args.only || null;
// Lettura anticipata della config per il blocco 'defaults' (parametri dichiarativi globali).
let RAW_CFG = {};
try { RAW_CFG = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { /* errore gestito da loadTargets() */ }
const DEFAULTS = (RAW_CFG && typeof RAW_CFG.defaults === 'object' && RAW_CFG.defaults) || {};

// Risoluzione di un parametro con precedenza: CLI (se passato) > config target > config defaults > built-in.
// 'cli' = valore da riga di comando (undefined se non passato); 'target' = null per parametri globali.
function resolveParam(cli, target, cfgKey, def) {
  if (cli !== undefined) return cli;
  if (target && target[cfgKey] !== undefined) return target[cfgKey];
  if (DEFAULTS[cfgKey] !== undefined) return DEFAULTS[cfgKey];
  return def;
}
const asInsecure = v => (v === undefined ? true : (v === 'false' || v === false ? false : !!v));

// Flag CLI negabili: --no-<x> forza OFF (precedenza sulla config), --<x> forza ON, assente = config.
// Restituiscono il "valore CLI effettivo" da passare a resolveParam (undefined = non impostato da CLI).
const CLI_LH = args['no-lighthouse'] ? false : (args.lighthouse ? true : undefined);
const CLI_SR = args['no-screen-reader'] ? false : (args['screen-reader'] ? true : undefined);
const CLI_FLOWS_OFF = args['no-flows'] ? true : undefined;        // noFlows: true da CLI
const CLI_CRAWL = args['no-crawl'] ? 0 : args.crawl;             // --no-crawl disabilita (0)

// Parametri di GATE: globali (la valutazione del gate è complessiva). CLI > defaults > built-in.
const FAIL_ON = String(resolveParam(args['fail-on'], null, 'failOn', 'serious')).toLowerCase();
const FAIL_ON_NAMELESS = !!resolveParam(args['fail-on-nameless'], null, 'failOnNameless', false);
const MIN_SCORE = (() => { const v = resolveParam(args['min-score'], null, 'minScore', null); return (v === null || v === undefined) ? null : parseFloat(v); })();

// Parametri PER-TARGET: inizializzati al valore globale, riassegnati per ogni target da applyTargetParams().
let CRAWL = parseInt(resolveParam(CLI_CRAWL, null, 'crawl', 0), 10) || 0;
let CRAWL_DEPTH = parseInt(resolveParam(args['crawl-depth'], null, 'crawlDepth', 2), 10) || 2;
let TAGS = String(resolveParam(args.tags, null, 'tags', 'wcag2a,wcag2aa,wcag21a,wcag21aa')).split(',').map(s => s.trim());
let DO_SR = !!resolveParam(CLI_SR, null, 'screenReader', false);
let NO_FLOWS = !!resolveParam(CLI_FLOWS_OFF, null, 'noFlows', false);
let INSECURE = asInsecure(resolveParam(args.insecure, null, 'insecure', undefined));
let DO_LH = !!resolveParam(CLI_LH, null, 'lighthouse', false) || MIN_SCORE !== null;

// Riassegna i parametri per-target (CLI > target > defaults > built-in). Chiamata a inizio di ogni target.
function applyTargetParams(target) {
  CRAWL = parseInt(resolveParam(CLI_CRAWL, target, 'crawl', 0), 10) || 0;
  CRAWL_DEPTH = parseInt(resolveParam(args['crawl-depth'], target, 'crawlDepth', 2), 10) || 2;
  TAGS = String(resolveParam(args.tags, target, 'tags', 'wcag2a,wcag2aa,wcag21a,wcag21aa')).split(',').map(s => s.trim());
  DO_SR = !!resolveParam(CLI_SR, target, 'screenReader', false);
  NO_FLOWS = !!resolveParam(CLI_FLOWS_OFF, target, 'noFlows', false);
  INSECURE = asInsecure(resolveParam(args.insecure, target, 'insecure', undefined));
  DO_LH = !!resolveParam(CLI_LH, target, 'lighthouse', false) || MIN_SCORE !== null;
}

const SEVERITY_ORDER = { critical: 4, serious: 3, moderate: 2, minor: 1, none: 0 };
const FAIL_THRESHOLD = SEVERITY_ORDER[FAIL_ON] ?? 3;

/* ----------------------------- helpers ---------------------------------- */
function loadTargets() {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const out = [];
  for (const key of Object.keys(cfg)) {
    if (key.startsWith('$')) continue;
    if (key === 'defaults') continue;   // blocco parametri dichiarativi, non è un target
    if (!cfg[key] || typeof cfg[key] !== 'object') continue;
    if (ONLY && ONLY !== key) continue;
    if (cfg[key].enabled === false) continue;
    out.push({ key, ...cfg[key] });
  }
  return out;
}

function credsFor(target) {
  // Priorita': env per-target (A11Y_<KEY>_USER, fallback legacy GW_<KEY>_USER) > config > globale (--user/--pass).
  const k = target.key.toUpperCase();
  const user = process.env[`A11Y_${k}_USER`] || process.env[`GW_${k}_USER`] || target.user || USER;
  const pass = process.env[`A11Y_${k}_PASS`] || process.env[`GW_${k}_PASS`] || target.pass || PASS;
  return { user, pass };
}

async function login(page, target) {
  if (!target.login) return true;   // target senza form: auth via header/SSO
  const url = BASE + target.loginPath;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const l = target.login;
  const { user, pass } = credsFor(target);
  // I form possono non essere presenti se gia' autenticati o SSO: gestione soft.
  // Su SPA il form appare solo dopo il bootstrap: attendo il campo invece di leggerlo subito.
  const userField = await page.waitForSelector(l.usernameSelector, { timeout: l.waitMs || 8000 }).catch(() => null);
  if (userField) {
    await page.fill(l.usernameSelector, user);
    await page.fill(l.passwordSelector, pass);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click(l.submitSelector),
    ]);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  const ok = !l.successUrlIncludes || page.url().includes(l.successUrlIncludes);
  return ok;
}

// Step post-login (es. selezione organizzazione, sempre presente in GovCat):
// eseguiti dopo il login riusando il motore step dei flow.
async function postLogin(page, target) {
  for (const s of (target.postLogin?.steps || [])) {
    try { await runStep(page, s); }
    catch (e) { if (!s.optional) throw e; console.warn(`    postLogin: step opzionale fallito (${e.message})`); }
  }
}

// Non seguire link che deautenticano o mutano stato via GET (test env: prudenza).
const SKIP_LINK = /logout|esci|signout|delete|elimina|remove|rimuovi|reset|export|download/i;

async function harvestLinks(page) {
  // Raccoglie URL sia dagli <a href> sia dagli onclick/JS (JSF/RichFaces naviga via onclick):
  // cerca pattern .jsf/.xhtml/.do/.action anche dentro gli attributi onclick.
  return await page.evaluate(() => {
    const urls = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.href) urls.add(a.href);
    }
    const re = /['"]([^'"]*?\.(?:jsf|xhtml|do|action)(?:\?[^'"]*)?)['"]/gi;
    for (const el of document.querySelectorAll('[onclick]')) {
      const s = el.getAttribute('onclick') || '';
      let m;
      while ((m = re.exec(s)) !== null) {
        try { urls.add(new URL(m[1], location.href).href); } catch { /* ignora */ }
      }
    }
    return [...urls];
  });
}

// Normalizza un URL per confronto/dedup: senza hash e senza slash finale.
function normUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '') + x.search; } catch { return u; } }

// Normalizza in path relativi allo stesso contextPath, scartando asset e link pericolosi.
function normalizeLinks(hrefs, contextPath) {
  const out = new Set();
  for (const h of hrefs) {
    try {
      const u = new URL(h);
      const path = u.pathname + u.search;
      if (!u.pathname.startsWith(contextPath)) continue;
      if (SKIP_LINK.test(path)) continue;
      if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|map|json)$/i.test(u.pathname)) continue;
      out.add(path);
    } catch { /* href non assoluto/valido: ignora */ }
  }
  return [...out];
}

async function runLighthouse(browser, url, target) {
  try {
    const { default: lighthouse } = await import('lighthouse');
    // Il browser e' lanciato con --remote-debugging-port=9222 (vedi scan()).
    // Usiamo il modulo lighthouse grezzo: apre una tab sullo stesso browser (CDP),
    // quindi con disableStorageReset condivide localStorage/sessione (es. organizzazione
    // selezionata) e con extraHeaders porta l'eventuale header di auth.
    const runner = await lighthouse(url, {
      port: 9222,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['accessibility'],
      disableStorageReset: true,
      extraHeaders: target?.extraHTTPHeaders || undefined,
      formFactor: 'desktop',
      screenEmulation: { disabled: true },
      throttlingMethod: 'provided',
    });
    return runner?.lhr?.categories?.accessibility?.score ?? null;
  } catch (e) {
    console.warn(`  [lighthouse] errore su ${url}: ${e.message}`);
    return null;
  }
}

// Ruoli interattivi che uno screen reader annuncia: se privi di nome accessibile,
// vengono letti col solo ruolo ("pulsante", "link") -> inutilizzabili al non vedente.
const INTERACTIVE_ROLES = [
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'searchbox',
  'listbox', 'spinbutton', 'treeitem',
];
// Riga di ariaSnapshot senza nome quotato per un ruolo interattivo (es. "- button", "- link:").
const AX_NAMELESS_RE = new RegExp(`^(\\s*)-\\s+(${INTERACTIVE_ROLES.join('|')})\\s*:?\\s*$`);
// Riga di ariaSnapshot CON nome quotato (qualsiasi ruolo): "- button \"Salva\"".
const AX_NAMED_RE = /^(\s*)-\s+([a-z]+)\s+"([^"]*)"/;

// Analizza l'accessibility tree (cio' che lo screen reader consuma) e individua gli elementi
// interattivi PRIVI di nome accessibile. Complementare ad axe: verifica l'output semantico
// dell'albero, non solo le regole statiche, e intercetta i widget custom senza nome.
// Sorgente: Playwright ariaSnapshot (motore a11y di Chromium: onora la visibilita' CSS).
async function analyzeAxTree(page) {
  let snap = null;
  try { snap = await page.locator('body').ariaSnapshot(); } catch { /* ariaSnapshot non disponibile */ }
  if (!snap) return { nodes: 0, nameless: [] };
  const nameless = [];
  const ancestors = [];   // stack {indent, name} per ricostruire un contesto leggibile
  let nodes = 0;
  for (const line of snap.split('\n')) {
    if (!/^\s*-\s+/.test(line)) continue;
    nodes++;
    const indent = line.match(/^\s*/)[0].length;
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= indent) ancestors.pop();
    const nl = line.match(AX_NAMELESS_RE);
    if (nl) {
      nameless.push({ role: nl[2], context: ancestors.slice(-3).map(a => a.name).join(' > ') });
      continue;
    }
    const named = line.match(AX_NAMED_RE);
    if (named) ancestors.push({ indent, name: named[3] });
  }
  return { nodes, nameless, snapshot: snap };
}

/* -------------------- virtual screen reader (opzionale) ----------------- */
// Livello 3 dei test SR: un virtual screen reader (guidepup) percorre l'accessibility tree
// della vista e produce gli ANNUNCI reali (es. "button, Salva"). Un elemento interattivo privo
// di nome viene annunciato col solo ruolo ("button"): lo intercettiamo come problema, dall'output
// effettivo dello SR (complementare ad analyzeAxTree, che ispeziona l'albero grezzo).
// Gira su Linux CI headless: alimentiamo jsdom con l'HTML gia' renderizzato (page.content()),
// niente screen reader del sistema operativo. Deps opzionali: @guidepup/virtual-screen-reader + jsdom.
let _srMod = null;   // cache: modulo caricato | false (non disponibile)
async function loadSR() {
  if (_srMod !== null) return _srMod;
  try {
    const [{ virtual }, { JSDOM }] = await Promise.all([
      import('@guidepup/virtual-screen-reader'),
      import('jsdom'),
    ]);
    _srMod = { virtual, JSDOM };
  } catch (e) {
    console.warn(`  [screen-reader] moduli non disponibili (${e.message}). Installa: npm i @guidepup/virtual-screen-reader jsdom`);
    _srMod = false;
  }
  return _srMod;
}

// jsdom non fornisce window.CSS; il virtual SR (dom-accessibility-api) usa CSS.escape → senza
// polyfill alcune viste danno "CSS is not defined". Implementazione da spec CSSOM.
const CSS_POLYFILL = {
  escape(value) {
    const str = String(value), len = str.length;
    const first = str.charCodeAt(0);
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = str.charCodeAt(i);
      if (c === 0) { out += '�'; continue; }
      if ((c >= 0x1 && c <= 0x1f) || c === 0x7f
        || (i === 0 && c >= 0x30 && c <= 0x39)
        || (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)) {
        out += '\\' + c.toString(16) + ' '; continue;
      }
      if (i === 0 && len === 1 && c === 0x2d) { out += '\\' + str.charAt(i); continue; }
      if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39)
        || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        out += str.charAt(i); continue;
      }
      out += '\\' + str.charAt(i);
    }
    return out;
  },
  supports() { return false; },
};

// Un annuncio composto dal SOLO nome-ruolo (senza nome accessibile) = elemento inutilizzabile al SR.
const SR_ROLE_ONLY = /^(button|link|textbox|combobox|checkbox|radio|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|searchbox|listbox|spinbutton|option|treeitem)$/;

async function runScreenReader(page) {
  const mod = await loadSR();
  if (!mod) return null;
  const { virtual, JSDOM } = mod;
  // jsdom non ha layout/CSS: senza potatura il virtual SR "vedrebbe" anche gli elementi nascosti
  // (es. pannelli filtri collassati) e li annuncerebbe come falsi positivi. Rimuoviamo nel browser
  // (dove il layout esiste) i sottoalberi non visibili prima di serializzare per jsdom.
  let html;
  try {
    html = await page.evaluate(() => {
      const hidden = el => el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true'
        || ['none'].includes(getComputedStyle(el).display)
        || ['hidden', 'collapse'].includes(getComputedStyle(el).visibility);
      const marked = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (hidden(el)) { el.setAttribute('data-gova11y-hidden', '1'); marked.push(el); }
      }
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('[data-gova11y-hidden]').forEach(n => n.remove());
      marked.forEach(el => el.removeAttribute('data-gova11y-hidden'));   // ripristina il DOM live
      return `<!doctype html><html lang="${document.documentElement.lang || 'it'}">${clone.outerHTML}</html>`;
    });
  } catch { return null; }
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { window } = dom;
  // vsr opera sui globali window/document: li puntiamo al DOM catturato e li ripristiniamo dopo.
  // (CSS serve alla name-computation di dom-accessibility-api: senza, alcune viste danno
  // "CSS is not defined" e nessun annuncio.)
  const saved = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter, getComputedStyle: global.getComputedStyle, CSS: global.CSS };
  global.window = window; global.document = window.document;
  global.Node = window.Node; global.NodeFilter = window.NodeFilter;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.CSS = window.CSS || CSS_POLYFILL;
  const phrases = [];
  try {
    await virtual.start({ container: window.document.body });
    const MAX = 1500;   // cap anti-loop su viste enormi
    for (let i = 0; i < MAX; i++) {
      await virtual.next();
      const p = await virtual.lastSpokenPhrase();
      if (p === 'end of document') break;
      phrases.push(p);
      // salvagente: se il cursore non avanza piu' (stesso annuncio 3 volte), esci
      if (phrases.length >= 3 && phrases.at(-1) === phrases.at(-2) && phrases.at(-2) === phrases.at(-3)) break;
    }
    await virtual.stop();
  } catch (e) {
    console.warn(`  [screen-reader] errore: ${e.message}`);
  } finally {
    try { window.close(); } catch { /* ignora */ }
    Object.assign(global, saved);
  }
  const roleOnly = phrases.filter(p => SR_ROLE_ONLY.test(p.trim()));
  return { stops: phrases.length, phrases, roleOnly };
}

// Esegue axe (e Lighthouse / screen reader) sullo stato CORRENTE del DOM e registra il risultato.
async function recordScan(browser, page, target, name, pageResults, sourceHint) {
  const url = page.url();
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  let lhScore = null;
  if (DO_LH) lhScore = await runLighthouse(browser, url, target);
  // L'albero ARIA (ariaSnapshot) viene salvato come artefatto separato (dir aria-tree/): lo
  // teniamo fuori dall'oggetto axTree per non gonfiare axe-results.json.
  const { snapshot: ariaSnapshot, ...axTree } = await analyzeAxTree(page);
  let sr = null;
  if (DO_SR) sr = await runScreenReader(page);
  pageResults.push({
    target: target.key, targetName: target.name, sourceHint: sourceHint || target.sourceHint,
    name, url, violations: r.violations, incomplete: r.incomplete, lhScore, axTree, ariaSnapshot, sr,
  });
  const counts = summarizeImpacts(r.violations);
  const incN = (r.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
  const nm = axTree.nameless.length ? `  a11y-tree: ${axTree.nameless.length} elem. interattivi senza nome` : '';
  const srN = sr ? `  SR: ${sr.stops} annunci${sr.roleOnly.length ? `, ${sr.roleOnly.length} solo-ruolo` : ''}` : '';
  console.log(`  [${name}] ${url} -> violazioni: ${fmtCounts(counts)}${incN ? `  da-verificare: ${incN}` : ''}${lhScore != null ? `  LH=${(lhScore * 100).toFixed(0)}%` : ''}${nm}${srN}`);
}

function slug(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }

// Chiave di dedup: rimuove i parametri-token di sessione volatili (tabKey/csrf/nonce), cosi' lo
// stesso URL "logico" non viene rivisitato all'infinito.
function normVisit(u) {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/tabkey|csrf|nonce|timestamp|_ts$/i.test(k)) x.searchParams.delete(k);
    const q = [...x.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');
    return x.origin + x.pathname + (q ? '?' + q : '');
  } catch { return u; }
}

// Esplorazione RICORSIVA "solo navigazione": da una pagina segue i link <a href> navigazionali
// (matite, count-link tipo Soggetti(0)/Ruoli(0), ecc.), scansiona e ricorre. NON tocca form/
// checkbox/SALVA. Esclude menu sinistro/header. Dedup su URL normalizzato + limiti (opts.max,
// depth) per evitare loop/esplosioni. opts: {ctxPath, skipRe, visited:Set, state:{count}, max, sourceHint}.
async function recurseFollow(browser, page, target, pageResults, flowName, opts, baseLabel, depth) {
  if (depth <= 0 || opts.state.count >= opts.max) return;
  const home = page.url();
  // Espansione TAB client-side (jQuery UI / RichFaces): il pannello inattivo e' nel DOM ma nascosto,
  // axe non lo verifica finche' non lo si attiva. Clicca ogni tab (oltre il primo, gia' attivo) e scansiona.
  if (opts.tabsSel) {
    let tabTexts = [];
    try { tabTexts = await page.$$eval(opts.tabsSel, els => els.map(e => (e.textContent || '').trim().replace(/\s+/g, ' '))); } catch { /* nessun tab */ }
    for (let ti = 1; ti < tabTexts.length && opts.state.count < opts.max; ti++) {
      try {
        await page.locator(opts.tabsSel).nth(ti).click({ timeout: 4000 });
        await page.waitForTimeout(400);
      } catch { continue; }
      opts.state.count++;
      await recordScan(browser, page, target, `flow:${flowName}/${baseLabel}/tab-${slug(tabTexts[ti]) || ti}`, pageResults, opts.sourceHint);
    }
  }
  const links = await page.$$eval('a[href]', els => {
    const menuct = document.getElementById('menuct');
    return els.filter(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || /^(javascript:|mailto:|#)/i.test(href)) return false;
      if (/td2PageHeader|voceMenuRC/.test(a.className)) return false;   // esclude header switcher e voci menu
      if (menuct && menuct.contains(a)) return false;                    // esclude il menu sinistro
      return true;
    }).map(a => ({ href: a.getAttribute('href'), text: (a.textContent || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40) }));
  });
  for (const l of links) {
    if (opts.state.count >= opts.max) break;
    let abs; try { abs = new URL(l.href, home).href; } catch { continue; }
    if (!abs.includes(opts.ctxPath)) continue;                          // resta dentro la console
    if (opts.skipRe.test(abs) || opts.skipRe.test(l.text)) continue;    // distruttivi/logout/salva
    const key = normVisit(abs);
    if (opts.visited.has(key)) continue;
    opts.visited.add(key);
    opts.state.count++;
    const clab = `${baseLabel}/${slug(l.text) || 'link'}`;
    try { await page.goto(abs, { waitUntil: 'networkidle' }); }
    catch (e) { console.warn(`      ricorsione: '${l.text}' non aperto: ${e.message}`); continue; }
    await recordScan(browser, page, target, `flow:${flowName}/${clab}`, pageResults, opts.sourceHint);
    await recurseFollow(browser, page, target, pageResults, flowName, opts, clab, depth - 1);
  }
  await page.goto(home, { waitUntil: 'networkidle' }).catch(() => {});   // torna al livello corrente per i fratelli
}

// Applica l'attesa post-azione di uno step (load-state o comparsa selettore) + eventuale delay.
async function applyWait(page, step) {
  const to = step.timeoutMs || 8000;
  if (['networkidle', 'load', 'domcontentloaded'].includes(step.wait)) await page.waitForLoadState(step.wait).catch(() => {});
  else if (typeof step.wait === 'string') await page.waitForSelector(step.wait, { timeout: to });
  if (step.delayMs) await page.waitForTimeout(step.delayMs);
}

// Esegue un singolo step di azione di un flow.
async function runStep(page, step) {
  const to = step.timeoutMs || 8000;
  if (step.goto) await page.goto(BASE + step.goto, { waitUntil: 'domcontentloaded' });
  else if (step.fill) await page.fill(step.fill.selector, step.fill.value, { timeout: to });
  else if (step.clickText) await page.getByText(step.clickText, { exact: !!step.exact }).first().click({ timeout: to });
  else if (step.click) await page.click(step.click, { timeout: to });
  await applyWait(page, step);
}

// Esegue i flows di navigazione scriptata (raggiungono viste non GET-navigabili).
// Ogni flow gira in un contesto/login PULITI: le app JSF conservano lo stato di vista in
// sessione, quindi riusare la sessione del BFS falserebbe i flow (es. "Cerca" -> "Nuova Ricerca").
async function runFlows(browser, target, pageResults) {
  for (const flow of target.flows) {
    console.log(`  flow: ${flow.name}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: INSECURE, extraHTTPHeaders: target.extraHTTPHeaders || undefined, viewport: target.viewport || undefined });
    const page = await ctx.newPage();
    try {
      await login(page, target);
      await postLogin(page, target);
      await page.goto(BASE + flow.start, { waitUntil: 'networkidle' });
      // skipIfMissing: se un elemento-sentinella non c'e' (es. lista vuota), salta il flow.
      if (flow.skipIfMissing && !(await page.$(flow.skipIfMissing))) {
        console.warn(`    flow '${flow.name}' saltato: sentinella '${flow.skipIfMissing}' assente (dati mancanti?)`);
        continue;
      }
      let aborted = false, scanned = false;
      for (const step of (flow.steps || [])) {
        // Step 'scan': scansiona lo stato CORRENTE (permette piu' scan in un flow, es. i tab di un dettaglio).
        if (step.scan !== undefined) {
          const name = step.scan ? `flow:${flow.name}/${step.scan}` : `flow:${flow.name}`;
          await recordScan(browser, page, target, name, pageResults, step.sourceHint || flow.sourceHint);
          scanned = true;
          continue;
        }
        // Step 'scanCharts': enumera DINAMICAMENTE tutte le icone-report di una griglia (es. Analisi
        // Statistica: 33 tra sezioni x tipi grafico), e per ognuna: ri-naviga, clicca l'icona, genera
        // il report e scansiona. Copre TUTTE le statistiche senza cablarle. Se il form presenta una
        // select "dimensioni" (individuata via dimensionField, l'UNICO valore cablato), enumera le sue
        // opzioni a runtime e genera+scansiona il report per ognuna (es. 2-dimensioni e 3-dimensioni).
        if (step.scanCharts !== undefined) {
          const cfg = step.scanCharts || {};
          const grid = BASE + (cfg.grid || flow.start);
          const iconSel = cfg.icon || 'a.tipologia-button';
          const genSel = cfg.generate || '#generaReport';
          const labelSel = cfg.label || 'span';
          const dimRe = cfg.dimensionField || 'dimensioni';   // pattern per riconoscere la select dimensioni
          const optSel = cfg.dimensionOption || '.rich-combobox-item';   // selettore delle opzioni nella lista combobox
          const dimSkip = cfg.dimensionSkip ? new RegExp(cfg.dimensionSkip, 'i') : null;   // opzioni dimensione da saltare (es. varianti che richiedono config aggiuntiva)
          const to = step.timeoutMs || 8000;
          const openChart = async (ci) => {
            await page.goto(grid, { waitUntil: 'networkidle' });
            await page.locator(iconSel).nth(ci).click({ timeout: to });
            await page.waitForSelector(genSel, { timeout: to });
          };
          await page.goto(grid, { waitUntil: 'networkidle' });
          const items = await page.$$eval(iconSel, (els, ls) => els.map(a => {
            const fs = a.closest('fieldset');
            const legend = fs && fs.querySelector('legend') ? fs.querySelector('legend').textContent : '';
            const lab = a.querySelector(ls) ? a.querySelector(ls).textContent : a.textContent;
            return { section: (legend || '').trim().replace(/\s+/g, ' '), type: (lab || '').trim().replace(/\s+/g, ' ') };
          }), labelSel);
          if (!items.length) { console.warn(`    scanCharts: nessuna icona trovata con '${iconSel}'`); continue; }
          const limit = cfg.limit ? Math.min(cfg.limit, items.length) : items.length;
          console.log(`    scanCharts: ${items.length} report${cfg.limit ? ` (limitati a ${limit})` : ''}`);
          for (let ci = 0; ci < limit; ci++) {
            const baseLabel = `${slug(items[ci].section)}-${slug(items[ci].type)}` || `chart${ci + 1}`;
            // apri il form e rileva se c'e' la select dimensioni + le sue opzioni (dinamico)
            let dimBase = null, variants = [null];
            try {
              await openChart(ci);
              const fieldId = await page.$$eval('input[id$=comboboxField]',
                (els, pat) => { const re = new RegExp(pat, 'i'); const f = els.find(i => re.test(i.value || '')); return f ? f.id : null; }, dimRe);
              if (fieldId) {
                dimBase = fieldId.replace(/comboboxField$/, '');
                await page.click(`#${dimBase}comboboxButton`).catch(() => {});
                await page.waitForTimeout(300);
                let opts = await page.$$eval(`#${dimBase}list ${optSel}`, els => els.map(e => (e.textContent || '').trim()).filter(Boolean));
                if (dimSkip) opts = opts.filter(o => !dimSkip.test(o));   // scarta le opzioni da saltare
                if (opts.length) variants = opts; else dimBase = null;
              }
            } catch (e) { console.warn(`    report '${baseLabel}' non aperto: ${e.message}`); continue; }
            // genera+scansiona il report per ogni variante dimensionale (o una volta sola se assente)
            for (const v of variants) {
              const label = v ? `${baseLabel}/${slug(v)}` : baseLabel;
              try {
                if (dimBase) {   // stato fresco + selezione opzione dimensione
                  await openChart(ci);
                  await page.click(`#${dimBase}comboboxButton`);
                  await page.waitForTimeout(250);
                  await page.locator(`#${dimBase}list ${optSel}`).filter({ hasText: v }).first().click({ timeout: to });
                  await page.waitForTimeout(250);
                }
                await page.click(genSel);
                await applyWait(page, step);
              } catch (e) { console.warn(`    report '${label}' non generato: ${e.message}`); continue; }
              await recordScan(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
              scanned = true;
            }
          }
          continue;
        }
        // Step 'scanTabs': scopre DINAMICAMENTE i tab presenti (selettore, default .rich-tab-header),
        // clicca ognuno e lo scansiona. Robusto ai record con tab diversi/nuovi.
        if (step.scanTabs !== undefined) {
          const sel = typeof step.scanTabs === 'string' && step.scanTabs ? step.scanTabs : '.rich-tab-header';
          const labels = await page.$$eval(sel, els => els.map(e => {
            const c = e.cloneNode(true);
            c.querySelectorAll('script,style').forEach(s => s.remove());   // escludi JS inline dal testo del tab
            return (c.textContent || '').trim().replace(/\s+/g, ' ');
          }));
          if (!labels.length) { console.warn(`    scanTabs: nessun tab trovato con '${sel}'`); continue; }
          console.log(`    scanTabs: ${labels.length} tab scoperti (${sel})`);
          for (let ti = 0; ti < labels.length; ti++) {
            const label = slug(labels[ti]) || `tab${ti + 1}`;
            try {
              await page.locator(sel).nth(ti).click({ timeout: step.timeoutMs || 8000 });
              await applyWait(page, step);
            } catch (e) { console.warn(`    tab '${labels[ti]}' non cliccabile: ${e.message}`); continue; }
            await recordScan(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
            scanned = true;
          }
          continue;
        }
        // Step 'scanMenu': scopre DINAMICAMENTE le voci di uno o piu' menu (selettori in config) e le
        // scansiona. Nessuna label/URL cablata: enumera a runtime cio' che c'e'. Gestisce i dropdown
        // (campo 'open': selettore da cliccare per aprire il menu prima di enumerare/cliccare).
        // Guardia universale: salta sempre le voci di logout (spezzerebbero la sessione). Opzionale:
        // 'skip' (regex), 'listRow' (primo elemento di lista -> dettaglio). Config: stringa | oggetto
        // {menuItem|item, open, listRow, skip} | array di questi (piu' menu: sinistra, utente, profili).
        if (step.scanMenu !== undefined) {
          const LOGOUT = /logout|signout|\besci\b/i;   // guardia: mai deautenticarsi
          const raw = step.scanMenu;
          const menus = Array.isArray(raw) ? raw
            : (typeof raw === 'string' ? [{ item: raw }]
              : [{ item: raw.menuItem || raw.item || '#menuct a.voceMenuRC', open: raw.open, listRow: raw.listRow, skip: raw.skip }]);
          const start = BASE + (flow.start || target.loginPath);
          const to = step.timeoutMs || 8000;
          for (const m of menus) {
            const menuSel = m.item || m.menuItem || '#menuct a.voceMenuRC';
            const openSel = m.open || null;              // dropdown: selettore da cliccare per aprire
            const rowSel = m.listRow || null;            // opzionale: primo elemento di lista -> dettaglio
            const editSel = m.detailEdit || null;        // opzionale: dal dettaglio, segue le "matite" (edit-link) di ogni sezione
            const dmenu = m.detailMenu || null;          // opzionale: dropdown sul dettaglio (3-puntini): {open, item} -> segue ogni azione
            const cfgBtn = m.detailConfig || null;       // opzionale: bottone CONFIGURA -> entra nel wizard e scansiona la pagina d'ingresso (NON avanza tra gli step, per non salvare)
            const rec = m.recurse || null;               // opzionale: dal dettaglio, esplora RICORSIVAMENTE i link navigazionali (matite, count-link...). {depth, max, skip}
            const skipRe = m.skip ? new RegExp(m.skip, 'i') : null;
            await page.goto(start, { waitUntil: 'networkidle' });
            if (openSel) await page.click(openSel, { timeout: to }).catch(() => {});   // apri per enumerare (le voci possono essere hidden)
            const voices = await page.$$eval(menuSel, els => els.map(a => ({
              text: (a.textContent || '').trim().replace(/\s+/g, ' '),
              href: a.getAttribute('href') || '',
            })));
            if (!voices.length) { console.warn(`    scanMenu: nessuna voce trovata con '${menuSel}'`); continue; }
            console.log(`    scanMenu: ${voices.length} voci (${menuSel})${openSel ? ` [dropdown ${openSel}]` : ''}`);
            for (let vi = 0; vi < voices.length; vi++) {
              const v = voices[vi];
              if (LOGOUT.test(v.href) || LOGOUT.test(v.text)) { console.warn(`    voce '${v.text}' saltata (logout)`); continue; }
              if (skipRe && (skipRe.test(v.href) || skipRe.test(v.text))) { console.warn(`    voce '${v.text}' saltata (skip config)`); continue; }
              const label = slug(v.text) || `voce-${vi + 1}`;
              try {
                await page.goto(start, { waitUntil: 'networkidle' });        // stato pulito, menu presente
                if (openSel) { await page.click(openSel, { timeout: to }); await page.waitForTimeout(200); }
                await page.locator(menuSel).nth(vi).click({ timeout: to });   // click per indice (niente URL/label cablati)
                await applyWait(page, step);
              } catch (e) { console.warn(`    voce '${v.text}' non raggiunta: ${e.message}`); continue; }
              await recordScan(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
              scanned = true;
              if (rowSel) {   // opzionale: entra nel dettaglio del primo elemento della lista
                const row = await page.$(rowSel);
                if (row) {
                  let detailUrl = null;
                  try {
                    await row.click({ timeout: to });
                    await applyWait(page, step);
                    await recordScan(browser, page, target, `flow:${flow.name}/${label}/dettaglio`, pageResults, step.sourceHint || flow.sourceHint);
                    scanned = true;
                    detailUrl = page.url();
                  } catch (e) { console.warn(`    dettaglio di '${v.text}' non aperto: ${e.message}`); }
                  // opzionale: esplorazione RICORSIVA "solo navigazione" dal dettaglio (supersede detailEdit).
                  // recOpts (visited+conteggio+limiti) è condiviso col wizard CONFIGURA piu' sotto.
                  let recOpts = null;
                  if (detailUrl && rec) {
                    recOpts = {
                      ctxPath: target.contextPath || target.loginPath || '/',
                      skipRe: new RegExp(rec.skip || 'logout|signout|esci|elimina|delete|remove|rimuovi|reset|export|download|salva|annulla', 'i'),
                      tabsSel: rec.tabs === false ? null : (typeof rec.tabs === 'string' ? rec.tabs : '.ui-tabs-nav a'),
                      visited: new Set([normVisit(detailUrl)]),
                      state: { count: 0 },
                      max: rec.max || 300,
                      sourceHint: step.sourceHint || flow.sourceHint,
                    };
                    await recurseFollow(browser, page, target, pageResults, flow.name, recOpts, `${label}/dettaglio`, rec.depth || 3);
                    console.log(`      ${label}: ricorsione -> ${recOpts.state.count} pagine (depth<=${rec.depth || 3}, max ${recOpts.max})`);
                    scanned = true;
                  }
                  if (detailUrl && !rec && editSel) {
                    // raccoglie titolo + target: i link con target=_blank aprono una NUOVA SCHEDA (popup)
                    const links = await page.$$eval(editSel, els => els.map(e => ({
                      title: (e.getAttribute('title') || e.textContent || '').trim().replace(/\s+/g, ' '),
                      target: e.getAttribute('target') || '',
                    })));
                    if (links.length) console.log(`      ${label}: ${links.length} matite/link (${editSel})`);
                    for (let ei = 0; ei < links.length; ei++) {
                      const elab = slug(links[ei].title) || `edit-${ei + 1}`;
                      try {
                        await page.goto(detailUrl, { waitUntil: 'networkidle' });   // torna al dettaglio (stato pulito)
                        if (links[ei].target === '_blank') {   // newTab: cattura la nuova scheda e scansiona QUELLA, non il dettaglio
                          const [popup] = await Promise.all([
                            page.waitForEvent('popup', { timeout: to }).catch(() => null),
                            page.locator(editSel).nth(ei).click({ timeout: to }),
                          ]);
                          if (popup) {
                            await popup.waitForLoadState('networkidle').catch(() => {});
                            await recordScan(browser, popup, target, `flow:${flow.name}/${label}/dettaglio/${elab}`, pageResults, step.sourceHint || flow.sourceHint);
                            await popup.close();
                            scanned = true;
                            continue;
                          }
                        } else {
                          await page.locator(editSel).nth(ei).click({ timeout: to });
                          await applyWait(page, step);
                        }
                      } catch (e) { console.warn(`      matita '${links[ei].title}' non aperta: ${e.message}`); continue; }
                      await recordScan(browser, page, target, `flow:${flow.name}/${label}/dettaglio/${elab}`, pageResults, step.sourceHint || flow.sourceHint);
                      scanned = true;
                    }
                  }
                  // opzionale: dal dettaglio, apri il dropdown 3-puntini e segui ogni azione (enumerate a runtime)
                  if (detailUrl && dmenu && dmenu.open && dmenu.item) {
                    await page.goto(detailUrl, { waitUntil: 'networkidle' });
                    await page.click(dmenu.open, { timeout: to }).catch(() => {});
                    await page.waitForTimeout(300);
                    const acts = await page.$$eval(dmenu.item, els => els.map(e => (e.textContent || '').trim().replace(/\s+/g, ' ')));
                    if (acts.length) console.log(`      ${label}: ${acts.length} azioni menu 3-puntini (${dmenu.item})`);
                    for (let mi = 0; mi < acts.length; mi++) {
                      if (LOGOUT.test(acts[mi])) { console.warn(`      azione '${acts[mi]}' saltata (logout)`); continue; }
                      const mlab = slug(acts[mi]) || `azione-${mi + 1}`;
                      try {
                        await page.goto(detailUrl, { waitUntil: 'networkidle' });
                        await page.click(dmenu.open, { timeout: to });
                        await page.waitForTimeout(300);
                        await page.locator(dmenu.item).nth(mi).click({ timeout: to });
                        await applyWait(page, step);
                      } catch (e) { console.warn(`      azione '${acts[mi]}' non aperta: ${e.message}`); continue; }
                      await recordScan(browser, page, target, `flow:${flow.name}/${label}/dettaglio/menu/${mlab}`, pageResults, step.sourceHint || flow.sourceHint);
                      scanned = true;
                    }
                  }
                  // opzionale: bottone CONFIGURA -> entra nel wizard e scansiona SOLO la pagina d'ingresso (niente step successivi, per non salvare)
                  if (detailUrl && cfgBtn) {
                    try {
                      await page.goto(detailUrl, { waitUntil: 'networkidle' });
                      const btn = await page.$(cfgBtn);
                      if (btn) {
                        await btn.click({ timeout: to });
                        await applyWait(page, step);
                        await recordScan(browser, page, target, `flow:${flow.name}/${label}/dettaglio/configura`, pageResults, step.sourceHint || flow.sourceHint);
                        scanned = true;
                        // esplora RICORSIVAMENTE anche il wizard CONFIGURA (matite, sotto-sezioni...), condividendo dedup/limiti
                        if (recOpts) {
                          recOpts.visited.add(normVisit(page.url()));
                          await recurseFollow(browser, page, target, pageResults, flow.name, recOpts, `${label}/dettaglio/configura`, rec.depth || 3);
                          console.log(`      ${label}/configura: ricorsione -> ${recOpts.state.count} pagine totali`);
                        }
                      }
                    } catch (e) { console.warn(`      configura di '${v.text}' non aperto: ${e.message}`); }
                  }
                }
              }
            }
          }
          continue;
        }
        const label = step.desc || step.click || step.clickText || step.goto || (step.fill && step.fill.selector) || 'step';
        try {
          await runStep(page, step);
        } catch (e) {
          if (step.optional) { console.warn(`    step '${label}' non riuscito (opzionale, proseguo): ${e.message}`); continue; }
          console.warn(`    step '${label}' non riuscito: ${e.message} → flow '${flow.name}' interrotto`);
          aborted = true; break;
        }
      }
      // Se il flow non ha step 'scan' espliciti, scansiona lo stato finale (comportamento di default).
      if (!scanned && !aborted) await recordScan(browser, page, target, `flow:${flow.name}`, pageResults, flow.sourceHint);
    } catch (e) {
      console.warn(`  flow '${flow.name}' errore: ${e.message}`);
    } finally {
      await ctx.close();
    }
  }
}

/* ----------------------------- scan ------------------------------------- */
async function scan() {
  mkdirSync(OUT, { recursive: true });
  const targets = loadTargets();
  if (!targets.length) { console.error('Nessun target abilitato.'); process.exit(2); }

  // Lighthouse può essere abilitato per-target: la porta di debug serve se ANCHE UN SOLO target lo usa.
  const anyLh = MIN_SCORE !== null || targets.some(t => !!resolveParam(CLI_LH, t, 'lighthouse', false));
  const browser = await chromium.launch({
    args: anyLh ? ['--remote-debugging-port=9222'] : [],
  });

  const pageResults = [];   // { target, name, url, violations:[axe], lhScore }

  for (const target of targets) {
    applyTargetParams(target);   // risolve tags/crawl/lighthouse/screen-reader/... per QUESTO target
    console.log(`\n== ${target.name} (${BASE}${target.loginPath}) ==`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: INSECURE, extraHTTPHeaders: target.extraHTTPHeaders || undefined, viewport: target.viewport || undefined });
    const page = await ctx.newPage();

    const logged = await login(page, target);
    await postLogin(page, target);
    if (!logged) {
      console.warn(`  ! login non confermato per ${target.name} come '${credsFor(target).user}' (url=${page.url()}). Proseguo comunque.`);
    } else {
      console.log(`  login ok (utenza '${credsFor(target).user}')`);
    }

    // Coda BFS: pagine in config (depth 0, sempre scansionate) + crawl opzionale.
    const ctxPath = target.contextPath || target.loginPath;
    const configPages = (target.pages || []).map(p => ({ path: p.path, name: p.name, depth: 0 }));
    const queue = [...configPages];
    if (CRAWL > 0 && queue.length === 0) queue.push({ path: target.loginPath, name: 'landing', depth: 0 });
    const visited = new Set();
    const scannedFinal = new Set();   // dedup per URL EFFETTIVO (dopo redirect)
    let crawlCount = 0;

    while (queue.length) {
      const item = queue.shift();
      if (visited.has(item.path)) continue;
      visited.add(item.path);
      const url = BASE + item.path;
      try {
        await page.goto(url, { waitUntil: target.navWait || 'networkidle' });
        if (target.navDelayMs) await page.waitForTimeout(target.navDelayMs);
        // Rileva redirect (pagina non navigabile standalone: modulo disabilitato, permessi, ...)
        const finalUrl = page.url();
        if (normUrl(finalUrl) !== normUrl(url)) {
          console.warn(`  [${item.name}] redirect: ${item.path} → ${finalUrl.replace(BASE, '')}`);
        }
        // Dedup: se l'URL effettivo e' gia' stato scansionato (es. piu' pagine rimbalzano su welcome), salta.
        if (scannedFinal.has(normUrl(finalUrl))) {
          console.warn(`  [${item.name}] gia' scansionata come ${finalUrl.replace(BASE, '')}, salto`);
          continue;
        }
        scannedFinal.add(normUrl(finalUrl));
        await recordScan(browser, page, target, item.name, pageResults);

        // crawl: scopri nuovi link finche' c'e' budget e profondita'
        if (CRAWL > 0 && item.depth < CRAWL_DEPTH && crawlCount < CRAWL) {
          const links = normalizeLinks(await harvestLinks(page), ctxPath);
          for (const p of links) {
            if (visited.has(p) || queue.some(q => q.path === p)) continue;
            if (crawlCount >= CRAWL) break;
            crawlCount++;
            queue.push({ path: p, name: `crawl-${crawlCount}`, depth: item.depth + 1 });
          }
        }
      } catch (e) {
        console.warn(`  [${item.name}] errore su ${url}: ${e.message}`);
      }
    }
    if (CRAWL > 0) console.log(`  crawl: ${crawlCount} pagine scoperte (depth<=${CRAWL_DEPTH}), ${visited.size} pagine scansionate in totale`);

    // Flows: navigazione scriptata per raggiungere le pagine di DETTAGLIO (JSF postback).
    if (!NO_FLOWS && (target.flows || []).length) await runFlows(browser, target, pageResults);

    await ctx.close();
  }

  await browser.close();
  // Per la reportistica complessiva: SR risulta attivo se lo è stato per almeno un target.
  DO_SR = targets.some(t => !!resolveParam(CLI_SR, t, 'screenReader', false));
  return pageResults;
}

function summarizeImpacts(violations) {
  const c = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    const n = (v.nodes || []).length || 1;
    c[v.impact || 'minor'] = (c[v.impact || 'minor'] || 0) + n;
  }
  return c;
}
function fmtCounts(c) {
  return `crit=${c.critical} ser=${c.serious} mod=${c.moderate} min=${c.minor}`;
}

/* ----------------------------- reporters -------------------------------- */
function writeAxeJson(results) {
  // ariaSnapshot esce come file separato (writeAriaTrees): lo togliamo dal JSON grezzo.
  const slim = results.map(({ ariaSnapshot, ...r }) => r);
  writeFileSync(resolve(OUT, 'axe-results.json'), JSON.stringify(slim, null, 2));
}

// Albero ARIA (accessibility tree) per pagina/stato come EVIDENZA per la revisione manuale
// (ordine di lettura, ruoli, struttura). Un file YAML per vista in aria-tree/. Ritorna la mappa
// {indice -> filename} per referenziarli in summary/HTML.
function writeAriaTrees(results) {
  const dir = resolve(OUT, 'aria-tree');
  const files = {};
  const withSnap = results.filter(pr => pr.ariaSnapshot);
  if (!withSnap.length) return files;
  mkdirSync(dir, { recursive: true });
  results.forEach((pr, i) => {
    if (!pr.ariaSnapshot) return;
    const file = `${slug(pr.target)}-${String(i + 1).padStart(3, '0')}-${slug(pr.name)}.yaml`;
    const header = `# Albero ARIA (accessibility tree) — evidenza per revisione manuale\n`
      + `# target: ${pr.targetName}  |  vista: ${pr.name}\n# url: ${pr.url}\n`
      + `# Fonte: Playwright ariaSnapshot (motore a11y di Chromium). Righe '- <ruolo>' senza\n`
      + `# nome quotato = elemento senza nome accessibile.\n\n`;
    writeFileSync(resolve(dir, file), header + pr.ariaSnapshot + '\n');
    files[i] = `aria-tree/${file}`;
  });
  return files;
}

function writeSarif(results) {
  const rulesMap = new Map();
  const sarifResults = [];
  const levelOf = imp => (imp === 'critical' || imp === 'serious') ? 'error' : 'warning';
  for (const pr of results) {
    for (const v of pr.violations) {
      if (!rulesMap.has(v.id)) {
        rulesMap.set(v.id, {
          id: v.id,
          name: v.id,
          shortDescription: { text: v.help },
          fullDescription: { text: v.description },
          helpUri: v.helpUrl,
          properties: { tags: v.tags, impact: v.impact },
        });
      }
      for (const node of v.nodes) {
        const selector = (node.target || []).join(' ');
        sarifResults.push({
          ruleId: v.id,
          level: levelOf(v.impact),
          message: { text: `${v.help} — ${node.failureSummary || ''}`.trim() },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: pr.url },
              region: { startLine: 1 },
            },
            logicalLocations: [{ fullyQualifiedName: selector, kind: 'element' }],
          }],
          properties: {
            impact: v.impact, page: pr.name, target: pr.targetName,
            selector, html: node.html,
          },
        });
      }
    }
  }
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'axe-core',
        informationUri: 'https://github.com/dequelabs/axe-core',
        rules: [...rulesMap.values()],
      } },
      results: sarifResults,
    }],
  };
  writeFileSync(resolve(OUT, 'a11y.sarif'), JSON.stringify(sarif, null, 2));
}

function writeSonar(results) {
  // Generic Issue Import Format. filePath deve esistere nel progetto analizzato:
  // usiamo sourceHint (template della console). La posizione precisa e' nel selettore/message.
  const sonarSevOf = imp => ({ critical: 'BLOCKER', serious: 'CRITICAL', moderate: 'MAJOR', minor: 'MINOR' }[imp] || 'MINOR');
  const issues = [];
  for (const pr of results) {
    for (const v of pr.violations) {
      for (const node of v.nodes) {
        const selector = (node.target || []).join(' ');
        issues.push({
          engineId: 'axe-core',
          ruleId: v.id,
          severity: sonarSevOf(v.impact),
          type: 'CODE_SMELL',
          primaryLocation: {
            message: `[${pr.targetName}] ${v.help} | pagina=${pr.url} | selettore=${selector} | ${v.helpUrl}`,
            filePath: pr.sourceHint,
            textRange: { startLine: 1 },
          },
        });
      }
    }
  }
  writeFileSync(resolve(OUT, 'sonar-issues.json'), JSON.stringify({ issues }, null, 2));
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
function writeJUnit(results) {
  let tests = 0, failures = 0;
  const cases = [];
  for (const pr of results) {
    tests++;
    const blocking = pr.violations.filter(v => (SEVERITY_ORDER[v.impact] || 1) >= FAIL_THRESHOLD);
    const nodes = blocking.reduce((n, v) => n + v.nodes.length, 0);
    if (blocking.length) {
      failures++;
      const detail = blocking.map(v => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help}`).join('\n');
      cases.push(`    <testcase classname="a11y.${xmlEscape(pr.targetName)}" name="${xmlEscape(pr.name)} (${xmlEscape(pr.url)})">
      <failure message="${xmlEscape(`${blocking.length} regole, ${nodes} occorrenze >= ${FAIL_ON}`)}">${xmlEscape(detail)}</failure>
    </testcase>`);
    } else {
      cases.push(`    <testcase classname="a11y.${xmlEscape(pr.targetName)}" name="${xmlEscape(pr.name)} (${xmlEscape(pr.url)})"/>`);
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="accessibility-wcag21aa" tests="${tests}" failures="${failures}">
${cases.join('\n')}
</testsuite>
`;
  writeFileSync(resolve(OUT, 'a11y-junit.xml'), xml);
}

// Etichetta dell'app esaminata per i titoli del report: override esplicito nel config (`$app`),
// altrimenti i nomi distinti dei target scansionati (es. "govwayMonitor, govwayConsole").
function appLabel(results) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (cfg.$app) return String(cfg.$app);
  } catch { /* config non leggibile: fallback ai nomi target */ }
  const names = [...new Set(results.map(r => r.targetName).filter(Boolean))];
  return names.join(', ') || 'App';
}

// Dichiarazione esplicita di COPERTURA E LIMITI dell'automazione (richiesta dalla specifica e
// dalle linee guida AgID: l'automazione copre solo una parte di WCAG → evitare falsi sensi di
// conformità). Inclusa in summary.json e in evidenza in report.html.
const COVERAGE = {
  automated: "L'automazione (axe-core + accessibility tree + virtual screen reader) copre solo "
    + "una parte dei criteri WCAG 2.1 AA (indicativamente ~30–40%): es. contrasto colore, testi "
    + "alternativi e label mancanti, attributo lang, ruoli/nomi ARIA, ordine degli heading, "
    + "struttura dell'albero di accessibilità.",
  manualRequired: [
    "Navigazione da tastiera e ordine di focus reale.",
    "Test con screen reader reale (fedeltà d'uso, verbosità, senso degli annunci).",
    "Qualità del testo alternativo e delle label (l'automazione vede se mancano, non se hanno senso).",
  ],
  note: "Questo report è EVIDENZA a supporto della dichiarazione di accessibilità AgID, "
    + "NON una certificazione di conformità: un esito automatico pulito non implica conformità WCAG.",
};

function writeSummaryAndHtml(results, ariaFiles = {}) {
  const app = appLabel(results);
  const perTarget = {};
  const summary = { base: BASE, app, generatedFrom: 'gov-a11y', tags: TAGS, failOn: FAIL_ON, failOnNameless: FAIL_ON_NAMELESS, minScore: MIN_SCORE, screenReader: DO_SR, coverage: COVERAGE, pages: [], totals: { critical: 0, serious: 0, moderate: 0, minor: 0 }, namelessTotal: 0, incompleteTotal: 0, srRoleOnlyTotal: 0, lighthouse: [] };
  for (const pr of results) {
    const c = summarizeImpacts(pr.violations);
    for (const k of Object.keys(summary.totals)) if (k !== 'namelessTotal') summary.totals[k] += c[k];
    const nameless = pr.axTree ? pr.axTree.nameless.length : 0;
    summary.namelessTotal += nameless;
    const incNodes = (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
    summary.incompleteTotal += incNodes;
    const srRoleOnly = pr.sr ? pr.sr.roleOnly.length : 0;
    summary.srRoleOnlyTotal += srRoleOnly;
    summary.pages.push({ target: pr.targetName, name: pr.name, url: pr.url, counts: c, incomplete: incNodes, lhScore: pr.lhScore, namelessInteractive: nameless, srStops: pr.sr ? pr.sr.stops : null, srRoleOnly, ariaTree: ariaFiles[results.indexOf(pr)] || null });
    if (pr.lhScore != null) summary.lighthouse.push({ url: pr.url, score: pr.lhScore });
    perTarget[pr.targetName] = perTarget[pr.targetName] || [];
    perTarget[pr.targetName].push(pr);
  }
  writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const impClass = imp => imp === 'critical' ? 'crit' : imp === 'serious' ? 'ser' : imp === 'moderate' ? 'mod' : 'min';

  // Tabella riepilogo per pagina
  const rows = results.map((pr, i) => {
    const c = summarizeImpacts(pr.violations);
    const nameless = pr.axTree ? pr.axTree.nameless.length : 0;
    const incNodes = (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
    return `<tr><td>${esc(pr.targetName)}</td><td><a href="#pg${i}">${esc(pr.name)}</a></td><td><a href="${esc(pr.url)}">${esc(pr.url)}</a></td>
      <td class="crit">${c.critical}</td><td class="ser">${c.serious}</td><td>${c.moderate}</td><td>${c.minor}</td>
      <td>${pr.lhScore != null ? (pr.lhScore * 100).toFixed(0) + '%' : '-'}</td>
      <td class="${incNodes ? 'mod' : ''}">${incNodes || '-'}</td>
      <td class="${nameless ? 'ser' : ''}">${nameless || '-'}</td></tr>`;
  }).join('\n');

  // Riepilogo aggregato per REGOLA WCAG (cosa correggere, per priorita')
  const byRule = new Map();
  for (const pr of results) for (const v of pr.violations) {
    const r = byRule.get(v.id) || { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags || [], nodes: 0, pages: new Set() };
    r.nodes += v.nodes.length; r.pages.add(pr.name); byRule.set(v.id, r);
  }
  const ruleRows = [...byRule.values()]
    .sort((a, b) => (SEVERITY_ORDER[b.impact] - SEVERITY_ORDER[a.impact]) || (b.nodes - a.nodes))
    .map(r => `<tr><td><code>${esc(r.id)}</code></td><td class="${impClass(r.impact)}">${esc(r.impact)}</td>
      <td>${esc(r.help)}</td><td>${r.nodes}</td><td>${r.pages.size}</td>
      <td>${(r.tags || []).filter(t => /wcag\d/.test(t)).map(esc).join(', ')}</td>
      <td><a href="${esc(r.helpUrl)}" target="_blank">regola ↗</a></td></tr>`).join('\n');

  // Drill-down per pagina: ogni violazione con elementi, selettore e snippet + elementi senza nome (a11y-tree)
  const details = results.map((pr, i) => {
    const nameless = pr.axTree ? pr.axTree.nameless : [];
    const ariaLink = ariaFiles[i] ? ` — <a href="${esc(ariaFiles[i])}">albero ARIA ↗</a>` : '';
    let axBlock = '';
    if (nameless.length) {
      const byRole = {};
      for (const n of nameless) byRole[n.role] = (byRole[n.role] || 0) + 1;
      const roleSummary = Object.entries(byRole).map(([r, n]) => `${esc(r)}×${n}`).join(', ');
      const items = nameless.slice(0, 30).map(n => `<li><code>${esc(n.role)}</code> — <small>${esc(n.context || '(radice)')}</small></li>`).join('\n');
      axBlock = `<details><summary><span class="ser">a11y-tree</span> ${nameless.length} elementi interattivi <b>senza nome accessibile</b> (${roleSummary})
        <small>— lo screen reader li annuncia col solo ruolo</small></summary><ul class="nodes">${items}</ul></details>`;
    }
    let incBlock = '';
    const incomplete = pr.incomplete || [];
    if (incomplete.length) {
      const irows = incomplete.map(v => `<li><code>${esc(v.id)}</code> — ${esc(v.help)} <b>(${v.nodes.length})</b></li>`).join('\n');
      incBlock = `<details><summary><span class="mod">da verificare</span> ${incomplete.reduce((n, v) => n + v.nodes.length, 0)} elementi che axe non ha deciso (sfondi calcolati/gradienti): NON sono un pass, verifica manuale</summary><ul class="nodes">${irows}</ul></details>`;
    }
    let srBlock = '';
    if (pr.sr) {
      const ro = pr.sr.roleOnly.length;
      const roMark = ro ? `<span class="ser">${ro} annunci solo-ruolo</span> (elementi letti senza nome) — ` : '';
      const lines = pr.sr.phrases.map(p => `<li class="${SR_ROLE_ONLY.test(p.trim()) ? 'ser' : ''}">${esc(p)}</li>`).join('\n');
      srBlock = `<details><summary><span class="mod">screen reader</span> ${roMark}${pr.sr.stops} annunci del virtual screen reader (trascrizione)</summary><ol class="nodes">${lines}</ol></details>`;
    }
    if (!pr.violations.length && !axBlock && !incBlock && !srBlock) return `<h3 id="pg${i}">${esc(pr.name)} <small>— nessuna violazione${ariaLink}</small></h3>`;
    const vs = pr.violations
      .sort((a, b) => SEVERITY_ORDER[b.impact] - SEVERITY_ORDER[a.impact])
      .map(v => {
        const nodes = v.nodes.map(n => `<li><code class="sel">${esc((n.target || []).join(' '))}</code>
          <pre>${esc((n.html || '').slice(0, 400))}</pre>
          ${n.failureSummary ? `<div class="fs">${esc(n.failureSummary)}</div>` : ''}</li>`).join('\n');
        return `<details><summary><span class="${impClass(v.impact)}">${esc(v.impact)}</span>
          <code>${esc(v.id)}</code> — ${esc(v.help)} <b>(${v.nodes.length})</b>
          <a href="${esc(v.helpUrl)}" target="_blank">↗</a></summary>
          <ul class="nodes">${nodes}</ul></details>`;
      }).join('\n');
    return `<h3 id="pg${i}">${esc(pr.name)} <small>— <a href="${esc(pr.url)}">${esc(pr.url)}</a>${ariaLink}</small></h3>${axBlock}${incBlock}${srBlock}${vs}`;
  }).join('\n');

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(app)} — Accessibility Report</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222;max-width:1200px}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:14px;vertical-align:top}th{background:#f4f4f4}
.crit{color:#b00;font-weight:700}.ser{color:#d60;font-weight:700}.mod{color:#a80;font-weight:600}.min{color:#666}
caption{text-align:left;font-weight:700;margin-bottom:.5rem}
details{margin:.3rem 0;border-left:3px solid #ddd;padding:.2rem .6rem;background:#fafafa}
summary{cursor:pointer}ul.nodes{margin:.4rem 0}li{margin:.5rem 0}
code.sel{background:#eef;padding:1px 4px}pre{background:#f6f6f6;padding:.4rem;overflow-x:auto;font-size:12px;margin:.2rem 0;white-space:pre-wrap}
.fs{font-size:12px;color:#555;white-space:pre-wrap}h3{margin-top:1.5rem;border-bottom:1px solid #eee}
.disclaimer{border:1px solid #d9a441;background:#fff8e8;border-left:5px solid #d9a441;padding:.8rem 1rem;margin:1rem 0;border-radius:4px}
.disclaimer h2{margin:.2rem 0 .5rem;font-size:1.05rem;border:0}.disclaimer ul{margin:.3rem 0 .3rem 1.1rem}.disclaimer .note{font-weight:600;margin-top:.5rem}</style></head>
<body><h1>${esc(app)} — Report Accessibilita' WCAG 2.1 AA</h1>
<p>Base: <code>${esc(BASE)}</code> — tag: <code>${esc(TAGS.join(', '))}</code> — gate: <code>fail-on=${esc(FAIL_ON)}${MIN_SCORE != null ? `, min-score=${MIN_SCORE}` : ''}</code></p>
<p>Totali occorrenze axe: <span class="crit">critical ${summary.totals.critical}</span>, <span class="ser">serious ${summary.totals.serious}</span>, moderate ${summary.totals.moderate}, minor ${summary.totals.minor}
 — <span class="mod">da verificare (incomplete): ${summary.incompleteTotal}</span> — <span class="ser">a11y-tree: ${summary.namelessTotal} elementi interattivi senza nome accessibile</span> (verifica screen-reader-oriented)${DO_SR ? ` — <span class="ser">screen reader: ${summary.srRoleOnlyTotal} annunci solo-ruolo</span>` : ''}</p>

<div class="disclaimer">
<h2>⚠️ Copertura e limiti dell'automazione</h2>
<p>${esc(COVERAGE.automated)}</p>
<p>Restano <b>necessari test manuali/assistiti</b> non delegabili all'automazione:</p>
<ul>${COVERAGE.manualRequired.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
<p class="note">${esc(COVERAGE.note)}</p>
</div>

<table><caption>Riepilogo per pagina (clicca la pagina per il dettaglio)</caption>
<tr><th>Console</th><th>Pagina</th><th>URL</th><th>Crit</th><th>Serious</th><th>Moderate</th><th>Minor</th><th>LH a11y</th><th>Da verificare<br><small>(incomplete)</small></th><th>Senza nome<br><small>(a11y-tree)</small></th></tr>
${rows}
</table>

<table><caption>Riepilogo per regola WCAG — cosa correggere (ordinato per gravita' e diffusione)</caption>
<tr><th>Regola axe</th><th>Gravita'</th><th>Descrizione</th><th>Occorrenze</th><th>Pagine</th><th>WCAG</th><th>Rif.</th></tr>
${ruleRows}
</table>

<h2>Dettaglio violazioni per pagina</h2>
${details}
</body></html>`;
  writeFileSync(resolve(OUT, 'report.html'), html);
  return summary;
}

/* ----------------------------- gate ------------------------------------- */
function evaluateGate(results, summary) {
  const reasons = [];
  if (FAIL_THRESHOLD > 0) {
    const blocking = results.reduce((n, pr) =>
      n + pr.violations.filter(v => (SEVERITY_ORDER[v.impact] || 1) >= FAIL_THRESHOLD)
        .reduce((m, v) => m + v.nodes.length, 0), 0);
    if (blocking > 0) reasons.push(`${blocking} occorrenze axe di gravita' >= ${FAIL_ON}`);
  }
  if (MIN_SCORE != null) {
    for (const l of summary.lighthouse) {
      if (l.score < MIN_SCORE) reasons.push(`Lighthouse ${(l.score * 100).toFixed(0)}% < soglia ${(MIN_SCORE * 100).toFixed(0)}% su ${l.url}`);
    }
  }
  if (FAIL_ON_NAMELESS && summary.namelessTotal > 0) {
    reasons.push(`${summary.namelessTotal} elementi interattivi senza nome accessibile (a11y-tree)`);
  }
  return reasons;
}

// Esportate per test/riuso programmatico (vedi test/); l'auto-run resta sotto IS_MAIN.
export {
  analyzeAxTree, runScreenReader, loadSR, AX_NAMELESS_RE, SR_ROLE_ONLY,
  // pure / helper
  parseArgs, resolveParam, credsFor, loadTargets, slug, normUrl, normVisit, normalizeLinks,
  summarizeImpacts, fmtCounts, xmlEscape, appLabel,
  // browser
  harvestLinks, recordScan, runStep, applyWait, runFlows, recurseFollow, login, postLogin, scan, runLighthouse,
  // reporters + gate
  writeAxeJson, writeAriaTrees, writeSarif, writeSonar, writeJUnit, writeSummaryAndHtml, evaluateGate,
};

/* ----------------------------- main ------------------------------------- */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) (async () => {
  const results = await scan();
  writeAxeJson(results);
  writeSarif(results);
  writeSonar(results);
  writeJUnit(results);
  const ariaFiles = writeAriaTrees(results);
  const summary = writeSummaryAndHtml(results, ariaFiles);

  console.log(`\nReport scritti in: ${OUT}`);
  console.log(`  axe-results.json | a11y.sarif | sonar-issues.json | a11y-junit.xml | summary.json | report.html${Object.keys(ariaFiles).length ? ` | aria-tree/ (${Object.keys(ariaFiles).length} file)` : ''}`);

  const reasons = evaluateGate(results, summary);
  if (reasons.length) {
    console.error(`\n❌ Gate accessibilita' NON superato:`);
    reasons.forEach(r => console.error(`   - ${r}`));
    process.exit(1);
  }
  console.log(`\n✅ Gate accessibilita' superato.`);
  process.exit(0);
})().catch(e => {
  console.error('Errore fatale:', e);
  process.exit(2);
});
