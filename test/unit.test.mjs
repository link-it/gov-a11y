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

// Test UNITARI (senza browser): funzioni pure (parsing/precedenza config/normalizzazione URL/
// dedup/utility) + reporter (JSON/SARIF/Sonar/JUnit/HTML) + gate, su dati sintetici.

import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OUT deve puntare a una dir temporanea: va impostato via argv PRIMA dell'import del modulo.
const OUT = mkdtempSync(join(tmpdir(), 'gova11y-unit-'));
// NB: preserviamo argv[0]/argv[1] (il file di test) così IS_MAIN resta falso e il modulo NON
// esegue main() all'import; aggiungiamo solo i flag che il tool legge da argv.slice(2).
process.argv = [process.argv[0], process.argv[1], '--out', OUT, '--no-lighthouse', '--no-screen-reader'];
const M = await import('../a11y-scan.mjs');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}  (atteso ${JSON.stringify(b)}, ottenuto ${JSON.stringify(a)})`);

console.log('— parseArgs');
eq(M.parseArgs(['--a', '1', '--flag', '--b', '2', 'x']), { _: ['x'], a: '1', flag: true, b: '2' }, 'flag/valori/posizionali');

console.log('— slug');
eq(M.slug('Modifica Informazioni Generali!'), 'modifica-informazioni-generali', 'accenti/spazi/punteggiatura');
eq(M.slug('  A / B  '), 'a-b', 'trim + separatori');

console.log('— normUrl');
eq(M.normUrl('http://h/app/lista/?x=1'), 'http://h/app/lista?x=1', 'rimuove slash finale, tiene query');
// Le app con routing sul fragment (Angular useHash, molte SPA storiche) tengono
// li' l'intera rotta: se il fragment uscisse dalla chiave, tutte le viste
// avrebbero lo stesso URL normalizzato e il dedup ne scarterebbe tutte tranne
// una.
eq(M.normUrl('http://h/app/#/pendenze'), 'http://h/app#/pendenze', 'tiene il fragment');
check(M.normUrl('http://h/app/#/pendenze') !== M.normUrl('http://h/app/#/ricevute'), 'due rotte sul fragment → chiavi distinte');
eq(M.normUrl('http://h/app/#!/pendenze'), 'http://h/app#!/pendenze', 'tiene anche la rotta in stile hashbang');
eq(M.normUrl('http://h/app/lista#main-content'), 'http://h/app/lista', "un'ancora non e' una rotta: fuori dalla chiave");
eq(M.normUrl('http://h/app/#state=abc&code=xyz'), 'http://h/app', 'i parametri di un login nel fragment restano fuori dalla chiave');

console.log('— normVisit (dedup: ignora token di sessione, ordina i parametri)');
eq(M.normVisit('http://h/x.do?id=2&__prevTabKey__=AAA&a=1'), 'http://h/x.do?a=1&id=2', 'strip __prevTabKey__ + sort');
check(M.normVisit('http://h/x.do?id=2&__tabKey__=A') === M.normVisit('http://h/x.do?id=2&__tabKey__=B'), 'due token diversi → stessa chiave');

console.log('— normalizeLinks (stesso contextPath, no asset, no distruttivi)');
eq(M.normalizeLinks([
  'http://h/app/a.do?x=1', 'http://h/app/logout.do', 'http://h/app/style.css', 'http://h/other/z.do',
], '/app/'), ['/app/a.do?x=1'], 'tiene solo il .do valido dentro /app/ (skip logout/asset/altro-path)');

console.log('— resolveParam (precedenza CLI > target > defaults > built-in)');
eq(M.resolveParam('X', { k: 'Y' }, 'k', 'Z'), 'X', 'CLI vince');
eq(M.resolveParam(undefined, { k: 'Y' }, 'k', 'Z'), 'Y', 'target vince su default');
eq(M.resolveParam(undefined, {}, 'k', 'Z'), 'Z', 'fallback built-in');
eq(M.resolveParam(undefined, null, 'k', 'Z'), 'Z', 'target null → built-in');

console.log('— credsFor (env per-target > config > globale)');
eq(M.credsFor({ key: 'foo', user: 'u', pass: 'p' }), { user: 'u', pass: 'p' }, 'da config target');
process.env.A11Y_FOO_USER = 'envuser';
eq(M.credsFor({ key: 'foo', user: 'u', pass: 'p' }).user, 'envuser', 'env per-target sovrascrive');
delete process.env.A11Y_FOO_USER;

console.log('— summarizeImpacts / fmtCounts');
eq(M.summarizeImpacts([{ impact: 'critical', nodes: [{}, {}] }, { impact: 'serious', nodes: [{}] }]),
  { critical: 2, serious: 1, moderate: 0, minor: 0 }, 'conta i nodi per gravità');
check(typeof M.fmtCounts({ critical: 1, serious: 0, moderate: 0, minor: 0 }) === 'string', 'fmtCounts → stringa');

console.log('— xmlEscape');
eq(M.xmlEscape('<a> & "b"'), '&lt;a&gt; &amp; &quot;b&quot;', 'escape XML');

// --- Reporter + gate su risultati sintetici ---
const RESULTS = [{
  target: 'app', targetName: 'App', sourceHint: 'src/x.jsp', name: 'home', url: 'http://h/app/home',
  violations: [{ id: 'color-contrast', impact: 'serious', help: 'Contrast', helpUrl: 'http://d/cc', tags: ['wcag2aa'],
    nodes: [{ target: ['.a'], html: '<a>x</a>', failureSummary: 'fix contrast' }] }],
  incomplete: [{ id: 'color-contrast', impact: 'serious', nodes: [{ target: ['.b'], html: '<b>' }] }],
  lhScore: null, axTree: { nodes: 4, nameless: [{ role: 'button', context: 'main' }] },
  ariaSnapshot: '- button\n- link "Home"', sr: null,
}];

console.log('— appLabel');
check(typeof M.appLabel(RESULTS) === 'string' && M.appLabel(RESULTS).length > 0, 'appLabel → stringa non vuota');

console.log('— reporter (scrivono in OUT)');
M.writeAxeJson(RESULTS);
check(existsSync(join(OUT, 'axe-results.json')), 'axe-results.json creato');
M.writeSarif(RESULTS);
const sarif = JSON.parse(readFileSync(join(OUT, 'a11y.sarif'), 'utf8'));
check(sarif.version === '2.1.0' && sarif.runs?.[0]?.tool?.driver?.name === 'axe-core', 'a11y.sarif valido (driver axe-core)');
M.writeSonar(RESULTS);
const sonar = JSON.parse(readFileSync(join(OUT, 'sonar-issues.json'), 'utf8'));
check(Array.isArray(sonar.issues) && sonar.issues.length >= 1 && sonar.issues[0].engineId === 'axe-core', 'sonar-issues.json con issues');
M.writeJUnit(RESULTS);
check(readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8').includes('<testsuite'), 'a11y-junit.xml valido');
const ariaFiles = M.writeAriaTrees(RESULTS);
check(existsSync(join(OUT, 'aria-tree')) && readdirSync(join(OUT, 'aria-tree')).length >= 1, 'aria-tree/*.yaml creato');
const summary = M.writeSummaryAndHtml(RESULTS, ariaFiles);
check(existsSync(join(OUT, 'summary.json')) && existsSync(join(OUT, 'report.html')), 'summary.json + report.html creati');
check(summary.totals.serious === 1 && summary.namelessTotal === 1, 'summary: totali violazioni + nameless');

console.log('— copertura dichiarata (costruita sull\'esecuzione)');
// Il test gira con --no-lighthouse --no-screen-reader: la dichiarazione deve dirlo.
const cov = M.buildCoverage();
check(!/Lighthouse/.test(cov.automated), 'livello spento non dichiarato (Lighthouse)');
check(!/screen reader virtuale/.test(cov.automated), 'livello spento non dichiarato (screen reader)');
check(/axe-core/.test(cov.automated) && /albero di accessibilit/.test(cov.automated), 'livelli sempre attivi dichiarati');
check(cov.manualRequired.some(m => /screen reader/.test(m) && /non è stato eseguito/.test(m)), 'il livello spento passa fra le verifiche manuali');
check(cov.manualRequired.length >= 6, 'verifiche manuali: tastiera, screen reader, alt/label, zoom, moduli, multimedia');
eq(M.wcagVerificato(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).breve, 'WCAG 2.2 AA', 'etichetta WCAG dai tag');
eq(M.wcagVerificato(['wcag2a', 'wcag2aa']).versioni, ['2.0'], 'versioni WCAG dai tag');
check(summary.coverage && summary.coverage.wcag && Array.isArray(summary.coverage.wcag.versioni), 'summary.json porta la copertura con versioni/livelli');
check('productVersion' in summary, 'summary.json porta la versione del prodotto (null se non dichiarata)');

console.log('— evaluateGate');
const reasons = M.evaluateGate(RESULTS, summary);
check(Array.isArray(reasons) && reasons.length >= 1, 'gate fallisce con 1 serious (fail-on=serious di default)');

console.log('— vista vuota (pagina non renderizzata)');
const VUOTA = [{ target: 'app', targetName: 'App', name: 'lista-bianca', url: 'http://h/app/lista', violations: [], incomplete: [],
  lhScore: null, axTree: { nodes: 0, nameless: [] }, ariaSnapshot: '', sr: null, vuota: true }];
const sommarioVuota = M.writeSummaryAndHtml(VUOTA, M.writeAriaTrees(VUOTA));
check(sommarioVuota.pages[0].vuota === true && sommarioVuota.emptyViews.length === 1, 'summary.json: la vista e\' marcata vuota ed elencata in emptyViews');
const motiviVuota = M.evaluateGate(VUOTA, sommarioVuota);
check(motiviVuota.some(m => /viste vuote/.test(m) && /lista-bianca/.test(m)), 'gate: zero violazioni ma vista vuota -> non superato (failOnEmpty predefinito)');
check(/VISTA VUOTA/.test(readFileSync(join(OUT, 'report.html'), 'utf8')), 'report.html: avviso e riga marcata');
M.writeJUnit(VUOTA);
check(/<failure message="vista vuota/.test(readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8')), 'JUnit: la vista vuota e\' un test fallito');

console.log('— loginPath assoluto (login su un\'altra origine)');
check(M.isAbsUrl('http://localhost:5200/auth/realmdb') && M.isAbsUrl('https://h/x') && !M.isAbsUrl('/auth') && !M.isAbsUrl(undefined), 'isAbsUrl riconosce solo http(s)://');
eq(M.absUrl('http://localhost:5200/auth/realmdb'), 'http://localhost:5200/auth/realmdb', 'URL assoluto lasciato com\'e\'');
check(M.absUrl('/auth').endsWith('/auth') && M.absUrl('/auth').startsWith('http'), 'percorso relativo prefissato con --base');
eq(M.defaultCtxPath({ loginPath: 'http://localhost:5200/auth/realmdb' }), '/', 'contextPath di default: radice di --base se il login e\' altrove');
eq(M.defaultCtxPath({ loginPath: '/app/' }), '/app/', 'contextPath di default: loginPath se relativo');
eq(M.defaultCtxPath({ loginPath: 'http://h/x', contextPath: '/c/' }), '/c/', 'contextPath esplicito vince');

console.log('— Lighthouse: la pagina misurata e\' quella richiesta');
check(M.lhStessaVista('http://h:1/examiner', 'http://h:1/examiner/') === true, "stessa vista: '/' finale ignorato");
check(M.lhStessaVista('http://h:1/#/servizi', 'http://h:1/#/adesioni') === true, 'frammento ignorato (rotte a hash: nessuno scarto indebito)');
check(M.lhStessaVista('http://h:1/auth/login', 'http://h:1/profile') === false, 'rimandato al login: vista diversa');
check(M.lhStessaVista('http://h:2/x', 'http://h:1/x') === false, 'porta diversa: vista diversa');
check(M.lhStessaVista('non-url', 'http://h/x') === null, 'URL non leggibile: nessun giudizio');

console.log("— valori da variabili d'ambiente (fill.env / select.env)");
const FLOW_ENV = { steps: [
  { fill: { selector: '#cf', env: 'A11Y_TEST_CF' } },
  { select: { selector: '#mot', env: 'A11Y_TEST_MOT' } },
  { fill: { selector: '#cf2', env: 'A11Y_TEST_CF' } },
  { fill: { selector: '#x', value: 'letterale' } },
  { click: '#go' },
] };
eq(M.flowEnvRefs(FLOW_ENV), ['A11Y_TEST_CF', 'A11Y_TEST_MOT'], 'variabili ricavate dai passi, senza duplicati');
delete process.env.A11Y_TEST_CF; delete process.env.A11Y_TEST_MOT;
eq(M.missingEnv(M.flowEnvRefs(FLOW_ENV)), ['A11Y_TEST_CF', 'A11Y_TEST_MOT'], 'mancanti se non impostate');
process.env.A11Y_TEST_CF = 'RSSMRA80A01H501U';
process.env.A11Y_TEST_MOT = 'Verifica "d\'ufficio" <test>';
eq(M.missingEnv(M.flowEnvRefs(FLOW_ENV)), [], 'nessuna mancante se impostate');
let envThrown = false; try { M.envValue('A11Y_TEST_ASSENTE'); } catch { envThrown = true; }
check(envThrown, 'envValue: variabile assente -> errore esplicito');
eq(M.envValue('A11Y_TEST_CF'), 'RSSMRA80A01H501U', 'envValue restituisce il valore');
M.envValue('A11Y_TEST_MOT');
const MOT = process.env.A11Y_TEST_MOT;
const masked = M.maskSecrets(`cf RSSMRA80A01H501U | json ${JSON.stringify(MOT)} | html ${M.xmlEscape(MOT)}`);
check(!masked.includes('RSSMRA80A01H501U'), 'maschera il valore in chiaro');
check(!masked.includes('Verifica'), 'maschera anche le forme JSON e XML del valore');
const motHtml = MOT.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
check(!M.maskSecrets(`<td>${motHtml}</td>`).includes('Verifica'), "maschera la forma HTML del report (apostrofo non codificato)");
process.env.A11Y_TEST_CORTO = 'ab'; M.envValue('A11Y_TEST_CORTO');
check(M.maskSecrets('ab cd ab') === 'ab cd ab', `valori più corti di ${M.MIN_SECRET} caratteri non mascherati`);
M.writeAxeJson([{ ...RESULTS[0], violations: [{ ...RESULTS[0].violations[0],
  nodes: [{ target: ['#cf'], html: '<input id="cf" value="RSSMRA80A01H501U">', failureSummary: 'x' }] }] }]);
const axeTxt = readFileSync(join(OUT, 'axe-results.json'), 'utf8');
check(!axeTxt.includes('RSSMRA80A01H501U') && axeTxt.includes('***'), 'il report scritto su disco non contiene il valore (***)');

console.log(failed ? `\n❌ unit: ${failed} check falliti` : '\n✅ unit: tutti i check superati');
process.exit(failed ? 1 : 0);
