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
 *   tempi.json         tempi della scansione: per fase, per vista, navigazione (anche in report.html)
 *   report.html        report leggibile
 *
 * Exit code != 0 se il gate configurato non e' rispettato (--fail-on / --min-score).
 */

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:net';

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

// true se il file e' eseguito come comando (non importato dai test / da altro codice):
// solo in questo caso i prerequisiti mancanti terminano il processo.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

/* Lighthouse puo' lasciare attese interne pendenti (es. checkForQuiet) che falliscono dopo la
   fine dell'audit, a pagina gia' chiusa: su macchine cariche capita ("Session closed",
   "Target closed"). Quel rifiuto non e' gestito da nessuno e Node chiuderebbe l'intera
   scansione, perdendo il report. Lo si riduce a un avviso: il punteggio di quella vista e' gia'
   stato registrato o scartato da runLighthouse. Ogni altro rifiuto non gestito resta fatale. */
if (IS_MAIN) {
  process.on('unhandledRejection', (reason) => {
    const stack = String(reason?.stack || '');
    if (/[\\/]node_modules[\\/]lighthouse[\\/]/.test(stack)) {
      console.warn(`  [lighthouse] errore tardivo ignorato (pagina gia' chiusa): ${reason?.message || reason}`);
      return;
    }
    throw reason;
  });
}

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
  --tags <list>       Tag axe (default wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice: WCAG fino al livello
                      AA delle 2.2, piu' le regole di buona pratica. I tag AAA restano esclusi)
  --fail-on <sev>     Gate axe: fallisci se esistono violazioni >= gravita'. critical|serious|moderate|minor|none (default serious)
  --fail-on-nameless  Gate a11y-tree, ATTIVO per impostazione predefinita: fallisci se esistono elementi
                      interattivi senza nome accessibile. Si spegne con "failOnNameless": false nel config
  --fail-on-empty     Gate delle viste vuote, ATTIVO per impostazione predefinita: fallisci se una vista
                      e' stata analizzata senza alcun contenuto accessibile (pagina non renderizzata:
                      backend irraggiungibile, sessione persa, errore dell'app). Si spegne con
                      "failOnEmpty": false nel config
  --fail-on-http-error  Gate delle viste in errore HTTP: fallisci se una vista e' arrivata con stato
                      HTTP >= 400 (pagina d'errore dell'app, URL non piu' valido, sessione persa). Lo
                      stato di ogni vista e' comunque riportato nei report. Spento di default; si
                      accende con "failOnHttpError": true nel config
  --fail-on-screen-reader  Gate del virtual screen reader: fallisci se esistono annunci col solo ruolo
                      (elementi letti senza nome). Richiede --screen-reader
  --fail-on-mouse-only  Gate tastiera, ATTIVO per impostazione predefinita: fallisci se esistono comandi
                      utilizzabili col solo mouse (gestore del clic su un elemento non raggiungibile
                      da tastiera). Si spegne con "failOnMouseOnly": false nel config
  --lighthouse        Calcola anche il punteggio Lighthouse Accessibility (richiede optional deps)
  --min-score <0..1>  Gate Lighthouse: fallisci se un punteggio scende sotto la soglia (es. 0.90). Implica --lighthouse
  --screen-reader     Esegui il virtual screen reader (annunci) su ogni vista (richiede optional deps)
  --equal-access      Secondo motore indipendente da axe: IBM Equal Access (regole WCAG 2.2 A/AA) sullo stesso
                      stato di ogni vista. Esiti in una sezione propria (richiede optional deps); decide il
                      gate solo con --fail-on-equal-access
  --fail-on-equal-access  Gate del secondo motore, SPENTO per impostazione predefinita: fallisci se IBM
                      Equal Access trova violazioni (i casi da verificare non contano) o non riesce a
                      girare su una vista. Vale sulle viste dei target con "equalAccess" attivo.
                      Si accende con "failOnEqualAccess": true nel config
  --no-screenshots    Niente immagini delle occorrenze. Per difetto ogni violazione e ogni caso da verificare
                      ha uno screenshot con l'elemento evidenziato (al massimo 'screenshotsMax' per vista, 20)
  --no-contrast-estimate  Niente stima del contrasto sui casi da verificare. Per difetto, per ogni testo il cui
                      contrasto axe non ha deciso (o IBM ha segnalato) si misura lo sfondo reale dai pixel
                      della vista, col testo nascosto: rapporto minimo e massimo e soglia richiesta
  --no-flows         Non eseguire i flows di navigazione scriptata (pagine di dettaglio)
  --no-incomplete     Nascondi la colonna/sezione "Da verificare" (incomplete axe) dal report HTML
  --false-positives <f>  File .json (o directory di .json) con i falsi positivi dichiarati: le occorrenze
                      corrispondenti escono da "Da verificare" e finiscono in una sezione propria del report.
                      Si applica SOLO agli 'incomplete', mai alle violazioni. Vedi docs/GUIDA-falsi-positivi.md
  --no-lighthouse     Disabilita Lighthouse anche se attivo in config (precedenza sulla config)
  --no-screen-reader  Disabilita il virtual screen reader anche se attivo in config
  --no-equal-access   Disabilita IBM Equal Access anche se attivo in config
  --no-mouse-only     Disabilita il controllo dei comandi utilizzabili col solo mouse
  --no-crawl          Disabilita il crawl anche se attivo in config (equivale a --crawl 0)
  --reflow            Controllo 1.4.10: la vista a 320px di larghezza non deve scorrere in orizzontale
  --text-spacing      Controllo 1.4.12: con la spaziatura del testo aumentata nessun testo viene tagliato
  --keyboard-walk     Controlli 2.4.7 / 2.4.11 / 2.1.2: percorre la vista col tasto Tab (focus visibile,
                      focus non coperto, nessuna trappola) e registra l'ordine di focus
  --keyboard-walk-max <n>  Fermate massime del percorso col Tab per vista (default 45)
  --keyboard-walk-wait-ms <ms>  Attesa dopo ogni Tab prima di leggere il fuoco e il suo aspetto (default 120)
  --[no-]keyboard-walk-widget-focus  Fuoco visibile anche con l'indicatore nel widget che marca il fuoco con
                      una classe (ng-select), nel contenitore di un comando trasparente o nell'icona
                      interna di un comando piccolo (default spento)
  --[no-]keyboard-walk-obscured-paint-only  Fuoco coperto solo da un elemento che in quel punto disegna
                      qualcosa: un contenitore vuoto e senza sfondo non copre (default spento)
                      (--no-reflow / --no-text-spacing / --no-keyboard-walk li spengono se attivi in config)
  --[no-]equal-access-keyboard-confirm  Casi da verificare di IBM sul fuoco (si vede, non e' coperto, diventa
                      visibile) confermati dalla misura del percorso col Tab sullo stesso elemento: escono dai
                      da verificare e vanno in un elenco a parte. Default acceso; serve che siano attivi sia
                      il secondo motore sia il percorso col Tab
  --locale <tag>      Lingua del browser (es. it-IT): navigator.language e Accept-Language. Le app che
                      scelgono la lingua dal browser si mostrano come la vedono i loro utenti
  --login-base <url>  Indirizzo dell'applicazione su cui si fa il login, quando non è quella di --base
                      (es. le app ospitate da una shell che le autentica): il loginPath relativo si
                      accoda a questo invece che a --base. Cambia ambiente senza toccare il config
  --product-version <v>  Versione del prodotto in prova (o env A11Y_PRODUCT_VERSION). Dichiarativa:
                      compare nel report e in summary.json, cosi' l'esito e' riferibile a una versione
  --insecure          Ignora errori certificato HTTPS (default true)
  --check-deps        Verifica (senza scansionare) se le dipendenze opzionali richieste sono installate
  --help              Questo aiuto

  Credenziali per-target: env A11Y_<TARGET>_USER / A11Y_<TARGET>_PASS.

  Parametri in CONFIG: oltre che da CLI, i parametri si possono dichiarare nel file config, nel blocco
  "defaults" (globali) e/o dentro ogni target (override per-target). Chiavi: tags, crawl, crawlDepth,
  lighthouse, screenReader, mouseOnly, mouseOnlyIgnore, mouseOnlyMax, failOn, failOnNameless,
  failOnMouseOnly, failOnEmpty, failOnHttpError, failOnScreenReader, failOnEqualAccess, minScore, noFlows, insecure, locale, loginBase,
  productVersion, reflow, textSpacing, keyboardWalk, keyboardWalkMax, keyboardWalkWaitMs, languageParts, equalAccess,
  equalAccessKeyboardConfirm, screenshots, screenshotsMax,
  contrastEstimate, contrastEstimateMax.
  Nei valori di "extraHTTPHeaders" ${'${NOME}'} si sostituisce con la variabile d'ambiente NOME (dati
  personali, come l'identità del principal, restano fuori dal config).
  Precedenza: CLI > target > defaults > built-in. (Il gate failOn/failOnNameless/failOnEqualAccess/minScore è globale.)
`);
  process.exit(0);
}

// Parametri globali da env (A11Y_*) o flag CLI.
const BASE = (args.base || process.env.A11Y_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const USER = args.user || process.env.A11Y_USER || 'amministratore';
const PASS = args.pass || process.env.A11Y_PASS || '123456';
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
const CLI_INCOMPLETE = args['no-incomplete'] ? false : undefined; // showIncomplete: false da CLI (--no-incomplete)
const CLI_CRAWL = args['no-crawl'] ? 0 : args.crawl;             // --no-crawl disabilita (0)

// Parametri di GATE: globali (la valutazione del gate è complessiva). CLI > defaults > built-in.
const FAIL_ON = String(resolveParam(args['fail-on'], null, 'failOn', 'serious')).toLowerCase();
// Predefinito ATTIVO, come il gate della tastiera: un comando che lo screen reader annuncia col
// solo ruolo ("pulsante") e' inservibile a chi non vede lo schermo. Si spegne con
// "failOnNameless": false nel config.
const FAIL_ON_NAMELESS = !!resolveParam(args['fail-on-nameless'], null, 'failOnNameless', true);
// Predefinito ATTIVO: un comando che risponde al clic ma non alla tastiera e' un difetto
// oggettivo, e in un'interfaccia grafica non dovrebbe passare in silenzio. Si spegne con
// "failOnMouseOnly": false nel config.
const FAIL_ON_MOUSE_ONLY = !!resolveParam(args['fail-on-mouse-only'], null, 'failOnMouseOnly', true);
// Gate del livello 3: fallisce se il virtual screen reader annuncia elementi col solo ruolo.
// Predefinito SPENTO, perche' il livello 3 e' opzionale (moduli aggiuntivi) e si sovrappone in
// buona parte a 'failOnNameless', che misura la stessa famiglia dall'albero di accessibilita'.
const FAIL_ON_SCREEN_READER = !!resolveParam(args['fail-on-screen-reader'], null, 'failOnScreenReader', false);
/* Gate delle viste VUOTE, predefinito ATTIVO. Una vista analizzata senza alcun contenuto accessibile
   non e' una vista pulita: e' una vista che non si e' renderizzata (backend irraggiungibile, sessione
   persa, errore dell'app, tempi). Su una pagina bianca nessuna regola puo' fallire, quindi il suo
   esito "zero violazioni" e' falso, e senza questo gate farebbe passare la scansione. */
const FAIL_ON_EMPTY = !!resolveParam(args['fail-on-empty'], null, 'failOnEmpty', true);
/* Gate delle viste in ERRORE HTTP (stato del documento >= 400), predefinito SPENTO. La pagina
   d'errore di un'applicazione e' di solito accessibile, quindi la vista risulta pulita mentre la
   vista che si voleva esaminare non e' mai stata vista: un URL scaduto, un contesto di navigazione
   mancante, un bug. Lo stato viene sempre rilevato e riportato; acceso, fa fallire il gate. Resta
   spento di default perche' alcune applicazioni rispondono di proposito con un 4xx a pagine che si
   vogliono comunque esaminare (es. la pagina "non trovato"). */
const FAIL_ON_HTTP_ERROR = !!resolveParam(args['fail-on-http-error'], null, 'failOnHttpError', false);
/* Gate del secondo motore, predefinito SPENTO: IBM Equal Access ha regole proprie, e su
   un'applicazione nuova va prima conosciuto (quante segnalazioni, quali vere). Chi ha corretto
   i difetti che trova lo accende, perche' non ne tornino di nuovi. Conta solo le violazioni:
   i casi da verificare chiedono una conferma manuale, come quelli di axe. */
const FAIL_ON_EQUAL_ACCESS = !!resolveParam(args['fail-on-equal-access'], null, 'failOnEqualAccess', false);
const CLI_MOUSE_ONLY = args['no-mouse-only'] ? false : (args['mouse-only'] ? true : undefined);
let DO_MOUSE_ONLY = resolveParam(CLI_MOUSE_ONLY, null, 'mouseOnly', true) !== false;   // risolti per-target da applyTargetParams
let MOUSE_ONLY_IGNORE = null;    // selettore CSS dichiarato dall'applicazione nel target
let MOUSE_ONLY_MAX = 40;
const MIN_SCORE = (() => { const v = resolveParam(args['min-score'], null, 'minScore', null); return (v === null || v === undefined) ? null : parseFloat(v); })();
// Quanto si attende che la rete si posi prima di analizzare una vista (vedi recordScan).
const RETE_A_RIPOSO_MS = 2000;
// Quanto si attende, una volta, una vista che si presenta senza contenuto accessibile (vedi recordScan).
const VISTA_VUOTA_ATTESA_MS = 5000;
/* Tempi della scansione, per capire dove va il tempo: ogni vista registra la durata delle sue fasi,
   e fra una vista e l'altra si misura il tempo di navigazione (passi dei flow, menu, ricorsione).
   performance.now() costa meno di un microsecondo: nessun effetto sulla durata della scansione.
   Finiscono in tempi.json e, in blocchi chiusi, in report.html. */
const TEMPI = { avvio: performance.now(), login: 0, fineUltimaVista: null };
const FASI_TEMPI = {
  attesa: 'Attesa della vista (caricamento, rete a riposo)',
  axe: 'axe-core',
  falsiPositivi: 'Registro dei falsi positivi',
  equalAccess: 'IBM Equal Access',
  lighthouse: 'Lighthouse',
  axTree: "Albero di accessibilita'",
  mouseOnly: 'Comandi solo mouse',
  screenReader: 'Screen reader virtuale',
  reflow: 'Riflusso a 320px',
  textSpacing: 'Spaziatura del testo',
  languageParts: 'Lingua delle parti',
  keyboardWalk: 'Percorso col tasto Tab',
  contrastiFuoriVista: 'Contrasti fuori vista',
  contrastEstimate: 'Stima del contrasto',
  screenshot: 'Screenshot delle occorrenze',
};
// Report HTML (globale: il report è aggregato su tutti i target -> no override per-target). CLI --no-incomplete > defaults.showIncomplete > built-in.
const SHOW_INCOMPLETE = resolveParam(CLI_INCOMPLETE, null, 'showIncomplete', true) !== false;

// Parametri PER-TARGET: inizializzati al valore globale, riassegnati per ogni target da applyTargetParams().
let CRAWL = parseInt(resolveParam(CLI_CRAWL, null, 'crawl', 0), 10) || 0;
let CRAWL_DEPTH = parseInt(resolveParam(args['crawl-depth'], null, 'crawlDepth', 2), 10) || 2;
/* Le WCAG 2.2 sono la versione vigente e il livello AA e' quello richiesto alle pubbliche
   amministrazioni: fermarsi alle 2.1 lascerebbe fuori criteri con difetti reali, come la
   dimensione minima dei bersagli. Le regole 'best-practice' non discendono da un criterio ma
   intercettano difetti concreti — contenuto fuori da ogni regione, viste senza intestazione di
   primo livello, attributi non ammessi. Le AAA restano escluse: sono un impegno diverso. */
const TAG_PREDEFINITI = 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice';

let TAGS = String(resolveParam(args.tags, null, 'tags', TAG_PREDEFINITI)).split(',').map(s => s.trim());
/* I tag sono per-target: il report e' aggregato, quindi tiene memoria di TUTTI quelli usati.
   Da qui si ricava che cosa dichiarare di aver verificato, invece di scriverlo a mano. */
const TAG_USATI = new Set(TAGS);
/* Versione del prodotto in prova: nessuno strumento esterno puo' dedurla, la dichiara chi lancia
   la scansione. Serve a rendere il report citabile come evidenza: dice a COSA si riferisce l'esito. */
const PRODUCT_VERSION = (() => {
  const cli = typeof args['product-version'] === 'string' ? args['product-version'] : undefined;
  const v = resolveParam(cli, null, 'productVersion', process.env.A11Y_PRODUCT_VERSION || null);
  return v ? String(v).trim() : null;
})();
let DO_SR = !!resolveParam(CLI_SR, null, 'screenReader', false);
/* Controlli di presentazione e tastiera che axe non fa: riflusso a 320px (1.4.10), spaziatura del
   testo (1.4.12), percorso col tasto Tab (2.4.7, 2.4.11, 2.1.2) e lingua delle parti (3.1.2).
   Predefiniti SPENTI: cambiano gli esiti delle applicazioni gia' in scansione e il loro costo
   (il percorso col Tab soprattutto) va scelto per target. */
const cliOnOff = k => (args[`no-${k}`] ? false : (args[k] ? true : undefined));
const CLI_REFLOW = cliOnOff('reflow'), CLI_TEXT_SPACING = cliOnOff('text-spacing'), CLI_KEYBOARD = cliOnOff('keyboard-walk');
let DO_REFLOW = false, DO_TEXT_SPACING = false, DO_KEYBOARD = false, KEYBOARD_MAX = 45, KEYBOARD_ATTESA_MS = 120, LANGUAGE_PARTS = null;
/* Criteri estesi del percorso col Tab, predefiniti SPENTI perché cambiano l'esito sui target già in
   scansione: fuoco visibile anche quando l'indicatore sta nel widget che marca il fuoco con una
   classe, nel contenitore del comando trasparente o nell'icona interna (keyboardWalkWidgetFocus);
   fuoco coperto solo da un elemento che in quel punto disegna qualcosa (keyboardWalkObscuredPaintOnly). */
const CLI_KEYBOARD_WIDGET = cliOnOff('keyboard-walk-widget-focus'), CLI_KEYBOARD_COPERTO = cliOnOff('keyboard-walk-obscured-paint-only');
let KEYBOARD_WIDGET = false, KEYBOARD_COPERTO_DISEGNA = false;
/* Secondo motore, indipendente da axe: IBM Equal Access, con regole e algoritmi propri. Due motori
   diversi trovano problemi diversi, ed e' quello che chiedono le linee guida che prescrivono la
   verifica "con almeno due strumenti". Predefinito SPENTO (modulo opzionale); i suoi esiti decidono
   il gate solo con "failOnEqualAccess" (vedi FAIL_ON_EQUAL_ACCESS).
   Screenshot delle occorrenze: predefiniti ACCESI, perche' chi riceve il report deve poter vedere
   DOVE sta il problema senza ricostruirlo dal selettore. */
const CLI_EA = cliOnOff('equal-access'), CLI_SCREENSHOT = cliOnOff('screenshots');
let DO_EA = false, DO_SCREENSHOT = true, SCREENSHOT_MAX = 20;
/* Stima del contrasto sui casi da verificare: predefinita ACCESA. Non decide nulla e non tocca il
   gate: affianca a ogni caso una misura fatta sui pixel, perché la verifica manuale parta da un
   numero e non da zero (vedi stimaContrasti). */
const CLI_CONTRASTO = cliOnOff('contrast-estimate');
let DO_CONTRASTO = true, CONTRASTO_MAX = 40;
/* Casi da verificare di IBM sul fuoco, confermati dal percorso col Tab: predefinita ACCESA, ma ha
   effetto solo dove sono attivi sia il secondo motore sia il percorso col Tab (entrambi spenti di
   default). IBM chiede di confermare a mano che il fuoco si veda, non sia coperto, renda visibile
   l'elemento (vedi REGOLE_CONFERMATE_DAL_TAB); il percorso col Tab lo misura sulla pagina vera. Un
   caso esce dai "da verificare" solo se il Tab ha raggiunto PROPRIO quell'elemento e la misura e'
   positiva; resta nel report, fra i confermati, e non tocca il gate. */
const CLI_EA_TAB = cliOnOff('equal-access-keyboard-confirm');
let DO_EA_TAB = true;
const CONTROLLI_USATI = new Set();   // per la copertura dichiarata nel report (aggregato su tutti i target)
let NO_FLOWS = !!resolveParam(CLI_FLOWS_OFF, null, 'noFlows', false);
let INSECURE = asInsecure(resolveParam(args.insecure, null, 'insecure', undefined));
/* Lingua del browser. Molte SPA scelgono la lingua dell'interfaccia da navigator.language, e il
   Chromium di CI e' in inglese: senza indicarla si analizzerebbe una variante che gli utenti non
   vedono. Per-target nel context; quella globale (CLI o defaults) anche all'avvio del browser,
   perche' la scheda di Lighthouse vive nel context di default e non eredita quella del target. */
const LOCALE_GLOBALE = resolveParam(typeof args.locale === 'string' ? args.locale : undefined, null, 'locale', null);
let LOCALE = LOCALE_GLOBALE;
const CLI_LOGIN_BASE = typeof args['login-base'] === 'string' ? args['login-base'] : undefined;
let LOGIN_BASE = resolveParam(CLI_LOGIN_BASE, null, 'loginBase', null);
/* '--no-lighthouse' vince su 'minScore': senza questa precedenza la sola presenza della soglia nel
   config riaccenderebbe l'audit, e una scansione rapida in CI durerebbe quanto una completa. */
let DO_LH = CLI_LH === false ? false : (!!resolveParam(CLI_LH, null, 'lighthouse', false) || MIN_SCORE !== null);

// Riassegna i parametri per-target (CLI > target > defaults > built-in). Chiamata a inizio di ogni target.
// Falsi positivi dichiarati: per-target, risolti come gli altri parametri.
let FALSE_POSITIVES = [];
const FALSE_POSITIVES_USATI = [];   // tutte le voci caricate, per il riepilogo nel report
const REGISTRI_CARICATI = new Map();   // percorso del registro -> voci, caricate una volta sola

function applyTargetParams(target) {
  const fpCli = args['false-positives'];
  const fpSpec = resolveParam(fpCli, target, 'falsePositives', null);
  FALSE_POSITIVES = loadFalsePositives(fpSpec, fpCli !== undefined ? process.cwd() : dirname(CONFIG));
  CRAWL = parseInt(resolveParam(CLI_CRAWL, target, 'crawl', 0), 10) || 0;
  CRAWL_DEPTH = parseInt(resolveParam(args['crawl-depth'], target, 'crawlDepth', 2), 10) || 2;
  TAGS = String(resolveParam(args.tags, target, 'tags', TAG_PREDEFINITI)).split(',').map(s => s.trim());
  TAGS.forEach(t => TAG_USATI.add(t));
  DO_SR = !!resolveParam(CLI_SR, target, 'screenReader', false);
  DO_REFLOW = !!resolveParam(CLI_REFLOW, target, 'reflow', false);
  DO_TEXT_SPACING = !!resolveParam(CLI_TEXT_SPACING, target, 'textSpacing', false);
  DO_KEYBOARD = !!resolveParam(CLI_KEYBOARD, target, 'keyboardWalk', false);
  KEYBOARD_MAX = parseInt(resolveParam(args['keyboard-walk-max'], target, 'keyboardWalkMax', 45), 10) || 45;
  { const a = parseInt(resolveParam(args['keyboard-walk-wait-ms'], target, 'keyboardWalkWaitMs', 120), 10); KEYBOARD_ATTESA_MS = Number.isFinite(a) && a >= 0 ? a : 120; }
  KEYBOARD_WIDGET = !!resolveParam(CLI_KEYBOARD_WIDGET, target, 'keyboardWalkWidgetFocus', false);
  KEYBOARD_COPERTO_DISEGNA = !!resolveParam(CLI_KEYBOARD_COPERTO, target, 'keyboardWalkObscuredPaintOnly', false);
  LANGUAGE_PARTS = resolveParam(undefined, target, 'languageParts', null) || null;
  if (DO_REFLOW) CONTROLLI_USATI.add('reflow');
  if (DO_TEXT_SPACING) CONTROLLI_USATI.add('textSpacing');
  if (DO_KEYBOARD) CONTROLLI_USATI.add('keyboardWalk');
  if (LANGUAGE_PARTS) CONTROLLI_USATI.add('languageParts');
  DO_EA = !!resolveParam(CLI_EA, target, 'equalAccess', false);
  if (DO_EA) CONTROLLI_USATI.add('equalAccess');
  DO_SCREENSHOT = resolveParam(CLI_SCREENSHOT, target, 'screenshots', true) !== false;
  SCREENSHOT_MAX = parseInt(resolveParam(undefined, target, 'screenshotsMax', 20), 10) || 20;
  DO_CONTRASTO = resolveParam(CLI_CONTRASTO, target, 'contrastEstimate', true) !== false;
  DO_EA_TAB = resolveParam(CLI_EA_TAB, target, 'equalAccessKeyboardConfirm', true) !== false;
  CONTRASTO_MAX = parseInt(resolveParam(undefined, target, 'contrastEstimateMax', 40), 10) || 40;
  NO_FLOWS = !!resolveParam(CLI_FLOWS_OFF, target, 'noFlows', false);
  INSECURE = asInsecure(resolveParam(args.insecure, target, 'insecure', undefined));
  LOCALE = resolveParam(typeof args.locale === 'string' ? args.locale : undefined, target, 'locale', null);
  LOGIN_BASE = resolveParam(CLI_LOGIN_BASE, target, 'loginBase', null);
  DO_LH = CLI_LH === false ? false : (!!resolveParam(CLI_LH, target, 'lighthouse', false) || MIN_SCORE !== null);
  /* Controllo dei comandi utilizzabili col solo mouse: attivo salvo diversa indicazione.
     Le eccezioni sono un fatto dell'APPLICAZIONE, non dello strumento: si dichiarano nel
     target con 'mouseOnlyIgnore' (selettore CSS), non si cablano qui. */
  DO_MOUSE_ONLY = resolveParam(CLI_MOUSE_ONLY, target, 'mouseOnly', true) !== false;
  MOUSE_ONLY_IGNORE = resolveParam(undefined, target, 'mouseOnlyIgnore', null);
  MOUSE_ONLY_MAX = parseInt(resolveParam(undefined, target, 'mouseOnlyMax', 40), 10) || 40;
}

/* --------------------- dipendenze opzionali (preflight) ------------------ */
// Lighthouse e virtual screen reader sono 'optionalDependencies': un npm install con --no-optional
// (o un download fallito) li lascia fuori. Se la feature e' RICHIESTA, il modulo mancante e' un
// prerequisito mancante, non un errore di runtime: si blocca subito, prima di aprire il browser.
const OPTIONAL_FEATURES = {
  lighthouse: {
    label: 'Lighthouse',
    how: '--lighthouse / --min-score / "lighthouse": true in config',
    off: '--no-lighthouse',
    modules: ['lighthouse'],
    install: 'npm install lighthouse',
  },
  screenReader: {
    label: 'virtual screen reader',
    how: '--screen-reader / "screenReader": true in config',
    off: '--no-screen-reader',
    modules: ['@guidepup/virtual-screen-reader', 'jsdom'],
    install: 'npm install @guidepup/virtual-screen-reader jsdom',
  },
  equalAccess: {
    label: 'IBM Equal Access',
    how: '--equal-access / "equalAccess": true in config',
    off: '--no-equal-access',
    modules: ['accessibility-checker-engine'],
    install: 'npm install accessibility-checker-engine',
  },
};

const _require = createRequire(import.meta.url);

// Risolve un modulo SENZA importarlo (nessun side effect, nessun costo di caricamento). Due
// tentativi: import.meta.resolve non c'e' su Node vecchi, require.resolve non vede i pacchetti
// ESM-only con exports map. Ritorna il path dell'entry point, o null se non installato.
function resolveModule(name) {
  try { return fileURLToPath(import.meta.resolve(name)); } catch { /* fallback */ }
  try { return _require.resolve(name); } catch { return null; }
}

// Versione installata di un modulo ('?' se il package.json non e' leggibile, null se assente).
function moduleVersion(name) {
  const entry = resolveModule(name);
  if (!entry) return null;
  // Il package.json spesso non e' esportato (exports map): risaliamo dall'entry point.
  for (let dir = dirname(entry), prev = null; dir !== prev; prev = dir, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return pkg.version || '?';
    } catch { /* continua a risalire */ }
  }
  return '?';
}

function missingModules(feature) {
  return (OPTIONAL_FEATURES[feature]?.modules || []).filter(m => !resolveModule(m));
}

// Una feature e' richiesta se lo e' per ALMENO UN target (CLI > target > defaults); senza target
// caricabili si guarda solo CLI + defaults.
function featureRequested(cli, cfgKey, targets) {
  if (!targets || !targets.length) return !!resolveParam(cli, null, cfgKey, false);
  return targets.some(t => !!resolveParam(cli, t, cfgKey, false));
}

// Gate sui prerequisiti: 'requested' = { lighthouse: bool, screenReader: bool }. Esce con codice 2
// se una feature richiesta non ha i moduli. Non fa nulla se il file e' importato (test).
function preflightOptionalDeps(requested) {
  const problems = Object.entries(requested)
    .filter(([, req]) => req)
    .map(([key]) => ({ key, missing: missingModules(key) }))
    .filter(p => p.missing.length);
  if (!problems.length) return;
  console.error(`\n\u274c Dipendenza opzionale mancante: la scansione e' stata richiesta con una feature non installata.`);
  for (const { key, missing } of problems) {
    const f = OPTIONAL_FEATURES[key];
    console.error(`   - ${f.label} (richiesto da: ${f.how})`);
    console.error(`     moduli assenti: ${missing.join(', ')}`);
    console.error(`     installa con:   ${f.install}`);
  }
  console.error(`   Alternativa: disabilita la feature con ${problems.map(p => OPTIONAL_FEATURES[p.key].off).join(' ')}`);
  if (IS_MAIN) process.exit(2);
}

// --check-deps: stampa lo stato dei moduli opzionali (installati/mancanti) e cosa chiede la config
// corrente, SENZA avviare browser o scansione. Exit 0 se tutto il richiesto c'e', 1 altrimenti.
function checkDeps() {
  let targets = [];
  // Senza config non si sa QUALI feature servono: dirlo e uscire in errore, altrimenti un path
  // sbagliato darebbe un esito verde ("nessuna feature richiesta") che non vuol dire niente.
  try {
    targets = loadTargets();
  } catch (e) {
    console.error(`\u274c Config non leggibile: ${CONFIG}`);
    console.error(`   ${e.code === 'ENOENT' ? 'file inesistente' : e.message}`);
    console.error(`   Senza config non e' possibile sapere quali feature opzionali servono.`);
    return 2;
  }
  if (!targets.length) console.warn(`\u26a0 Nessun target abilitato nel config: valgono solo i flag CLI e il blocco "defaults".\n`);
  const requested = {
    lighthouse: MIN_SCORE !== null || featureRequested(CLI_LH, 'lighthouse', targets),
    screenReader: featureRequested(CLI_SR, 'screenReader', targets),
    equalAccess: featureRequested(CLI_EA, 'equalAccess', targets),
  };
  console.log(`Dipendenze opzionali (config: ${CONFIG}${targets.length ? `, target: ${targets.map(t => t.key).join(', ')}` : ''})\n`);
  let ko = 0;
  for (const [key, f] of Object.entries(OPTIONAL_FEATURES)) {
    console.log(`[${f.label}] richiesto da questa esecuzione: ${requested[key] ? 'SI' : 'no'}`);
    for (const m of f.modules) {
      const v = moduleVersion(m);
      console.log(`   ${v ? '\u2713' : '\u2717'} ${m.padEnd(32)} ${v ? v : 'NON INSTALLATO'}`);
    }
    const missing = missingModules(key);
    if (missing.length) {
      console.log(`   installa con: ${f.install}`);
      if (requested[key]) ko++;
    }
    console.log('');
  }
  if (ko) console.error(`\u274c ${ko} feature richieste non sono installate: la scansione si fermerebbe con errore.`);
  else console.log(`\u2705 Tutte le feature richieste da questa esecuzione hanno i moduli installati.`);
  return ko ? 1 : 0;
}

const SEVERITY_ORDER = { critical: 4, serious: 3, moderate: 2, minor: 1, none: 0 };
const FAIL_THRESHOLD = SEVERITY_ORDER[FAIL_ON] ?? 3;

/* -------------------------- falsi positivi ------------------------------- */
/* Registro delle occorrenze gia' esaminate e riconosciute come falsi positivi. Si applica SOLO
   agli 'incomplete' — le occorrenze che axe non ha saputo decidere — e MAI alle violazioni: una
   violazione derogata e' il modo in cui questi registri degenerano in un posto dove si nascondono
   i problemi. Le occorrenze derogate non spariscono: escono da "Da verificare" ed entrano in una
   sezione propria del report, con la motivazione e la verifica che le giustificano, cosi' che un
   revisore possa contestarle.

   Una voce con "engine": "equalAccess" vale invece per il secondo motore, e lì copre sia le
   violazioni sia i casi da verificare: IBM Equal Access non partecipa al gate, e alcune sue regole
   danno per violazione un comportamento previsto di una libreria (per esempio gli ancoraggi del
   focus trap di Angular CDK, focalizzabili dentro aria-hidden per costruzione). "rule" è l'id della
   regola IBM, "cause" il suo reasonId; il selettore si confronta con l'elemento indicato
   dall'XPath del motore. Le violazioni di axe restano non derogabili. */
const MOTORI_FP = new Set(['axe', 'equalAccess']);

/* 'esplicito' distingue il file indicato per nome — dove un contenuto sbagliato e' un errore da
   segnalare — dai file trovati dentro una directory, dove un JSON che non e' un registro
   semplicemente non lo e' (nella stessa cartella risiedono anche i file di target). */
function leggiFileFalsiPositivi(file, esplicito) {
  let dati;
  try { dati = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.warn(`  [falsi positivi] ${file}: file illeggibile o JSON non valido (${e.message}) — ignorato`); return []; }
  const voci = Array.isArray(dati) ? dati : (Array.isArray(dati.falsePositives) ? dati.falsePositives : null);
  if (!voci) {
    if (esplicito) console.warn(`  [falsi positivi] ${file}: manca l'array "falsePositives" — ignorato`);
    return [];
  }
  const out = [];
  for (const v of voci) {
    if (!v || typeof v !== 'object') continue;
    const mancanti = ['id', 'rule', 'reason', 'verification'].filter(k => !v[k] || !String(v[k]).trim());
    if (mancanti.length) {
      console.warn(`  [falsi positivi] voce "${v && v.id || '(senza id)'}" priva di ${mancanti.join(', ')} — ignorata`);
      continue;   // 'reason' e 'verification' sono obbligatori: una deroga senza prova e' un'opinione
    }
    if (v.engine !== undefined && !MOTORI_FP.has(v.engine)) {
      console.warn(`  [falsi positivi] voce "${v.id}": motore "${v.engine}" sconosciuto (ammessi: ${[...MOTORI_FP].join(', ')}) — ignorata`);
      continue;
    }
    out.push({ ...v, engine: v.engine || 'axe', file: basename(file), matches: 0 });
  }
  return out;
}

/* Accetta un file .json o una directory di .json. I percorsi relativi si risolvono rispetto alla
   directory corrente se il valore arriva da riga di comando — come '--config' e '--out' — e
   rispetto alla directory del config se arriva dal file di configurazione, dove accanto risiede. */
function loadFalsePositives(spec, base) {
  if (!spec) return [];
  const percorso = isAbsolute(String(spec)) ? String(spec) : resolve(base || dirname(CONFIG), String(spec));
  if (!existsSync(percorso)) { console.warn(`  [falsi positivi] percorso inesistente: ${percorso} — ignorato`); return []; }
  /* Lo stesso registro dichiarato in 'defaults' vale per ogni target: si carica una volta sola e
     i target ne condividono le voci. Ricaricarlo duplicherebbe le voci nel report, e quelle del
     target che non le usa comparirebbero "senza riscontro" accanto alle stesse voci con riscontro. */
  if (REGISTRI_CARICATI.has(percorso)) return REGISTRI_CARICATI.get(percorso);
  const dir = statSync(percorso).isDirectory();
  const files = dir
    ? readdirSync(percorso).filter(f => f.endsWith('.json')).sort().map(f => join(percorso, f))
    : [percorso];
  const daFile = new Map();
  const voci = [];
  for (const f of files) {
    const v = leggiFileFalsiPositivi(f, !dir);
    if (v.length) { daFile.set(basename(f), v.length); voci.push(...v); }
  }
  const oggi = new Date();
  for (const v of voci) {
    v.expired = !!(v.expires && new Date(v.expires) < oggi);
    if (v.expired) console.warn(`  [falsi positivi] "${v.id}" scaduta il ${v.expires}: le occorrenze tornano fra quelle da verificare`);
  }
  if (voci.length) console.log(`  [falsi positivi] ${voci.length} voci caricate da ${[...daFile.keys()].join(', ')}`);
  else if (dir) console.warn(`  [falsi positivi] nessun registro trovato in ${percorso}`);
  FALSE_POSITIVES_USATI.push(...voci);
  REGISTRI_CARICATI.set(percorso, voci);
  return voci;
}

/* Confronta il selettore di una voce del registro con il nodo indicato da axe. Distingue
   quattro esiti: 'si', 'no', 'assente' — l'elemento non e' nel documento in questo istante —
   ed 'errore', quando la valutazione stessa non e' riuscita (pagina in navigazione, contesto
   distrutto). Trattare 'assente' ed 'errore' come 'no' fa figurare fra le occorrenze da
   verificare nodi che una voce del registro copre: sono esiti diversi e vanno distinti. */
async function provaSelettore(page, selettore, bersaglio, xpath = false) {
  return page.evaluate(([sel, tgt, xp]) => {
    try {
      const el = xp
        ? document.evaluate(tgt, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : document.querySelector(tgt);
      if (!el) return 'assente';
      return el.nodeType === 1 && el.matches(sel) ? 'si' : 'no';
    } catch { return 'no'; }
  }, [selettore, String(bersaglio), xpath]).catch(() => 'errore');
}

/* Cerca la prima voce attiva del registro che copre un'occorrenza: stesso motore, stessa regola,
   stessa causa se indicata, URL e selettore se indicati. 'bersaglio' e' il selettore CSS di axe o
   l'XPath del secondo motore. Su un esito 'assente' o 'errore' si riprova una volta per
   occorrenza, attesa la pagina: in un'applicazione a ridisegno parziale il documento puo' essere in
   trasformazione fra l'analisi e il confronto. I contatori finiscono negli avvisi del chiamante. */
async function voceDelRegistro(page, attive, { motore, regola, causa, url, bersaglio, xpath, conta }) {
  let riprovato = false;
  for (const fp of attive) {
    if (fp.engine !== motore || fp.rule !== regola) continue;
    if (fp.cause && fp.cause !== causa) continue;
    if (fp.urlPattern && !new RegExp(fp.urlPattern).test(url)) continue;
    if (fp.selector) {
      if (!bersaglio) continue;
      let esito = await provaSelettore(page, fp.selector, bersaglio, xpath);
      if ((esito === 'assente' || esito === 'errore') && !riprovato) {
        riprovato = true;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(300);
        esito = await provaSelettore(page, fp.selector, bersaglio, xpath);
      }
      if (esito === 'errore') conta.errori++;
      else if (esito === 'assente') conta.assenti++;
      if (esito !== 'si') continue;
    }
    return fp;
  }
  return null;
}

function avvisaConfronti(conta, url, motore) {
  /* Un errore isolato e' fisiologico; molti significano che su questa vista il registro non
     e' stato applicato, e le occorrenze figurano fra quelle da verificare senza esserlo.
     Meglio dirlo che lasciare all'occhio di chi legge il report il compito di accorgersene. */
  const chi = motore === 'equalAccess' ? ' (IBM Equal Access)' : '';
  if (conta.errori > 0) {
    console.warn(`    [falsi positivi${chi}] ${conta.errori} confronti non riusciti su ${url}: le occorrenze corrispondenti restano fra quelle segnalate`);
  }
  /* Elemento sparito fra l'analisi e il confronto: succede nelle applicazioni a ridisegno
     parziale. Va detto, perche' l'occorrenza resta segnalata senza che si sia potuto stabilire
     se una voce del registro la copra. */
  if (conta.assenti > 0) {
    console.warn(`    [falsi positivi${chi}] ${conta.assenti} elementi non piu' presenti al confronto su ${url}: le occorrenze corrispondenti restano fra quelle segnalate`);
  }
}

/* Lo stesso per il secondo motore: violazioni e casi da verificare. Le occorrenze coperte escono
   dalle due liste ed entrano fra le derogate, con il motore indicato. */
async function separaFalsiPositiviEA(page, equalAccess, url) {
  const attive = FALSE_POSITIVES.filter(v => !v.expired && v.engine === 'equalAccess');
  if (!equalAccess || !attive.length) return { equalAccess, derogati: [] };
  const conta = { errori: 0, assenti: 0 };
  const derogati = [];
  const filtra = async (lista, tipo) => {
    const rimasti = [];
    for (const x of lista) {
      const voce = await voceDelRegistro(page, attive, { motore: 'equalAccess', regola: x.regola, causa: x.motivo, url, bersaglio: x.xpath, xpath: true, conta });
      if (voce) { voce.matches++; derogati.push({ engine: 'equalAccess', tipo, rule: x.regola, cause: x.motivo, id: voce.id, target: x.xpath, html: x.snippet }); }
      else rimasti.push(x);
    }
    return rimasti;
  };
  const violazioni = await filtra(equalAccess.violazioni, 'violazione');
  const daVerificare = await filtra(equalAccess.daVerificare, 'da verificare');
  avvisaConfronti(conta, url, 'equalAccess');
  return { equalAccess: { ...equalAccess, violazioni, daVerificare }, derogati };
}

/* Separa gli 'incomplete' in due liste: quelli ancora da verificare e quelli coperti da una voce
   del registro. Il confronto del selettore avviene NELLA PAGINA con Element.matches, perche' e'
   l'unico modo esatto: axe restituisce un percorso CSS, non l'elemento, e riconoscere una famiglia
   dal frammento HTML sarebbe un'approssimazione. */
async function separaFalsiPositivi(page, incomplete, url) {
  if (!FALSE_POSITIVES.length || !incomplete || !incomplete.length) return { incomplete: incomplete || [], derogati: [] };
  const attive = FALSE_POSITIVES.filter(v => !v.expired && v.engine === 'axe');
  if (!attive.length) return { incomplete, derogati: [] };

  const rimasti = [];
  const derogati = [];
  // valutazioni non riuscite (se sono molte, il confronto non e' avvenuto) ed elementi non piu'
  // nel documento quando si e' arrivati a confrontarli
  const conta = { errori: 0, assenti: 0 };
  for (const v of incomplete) {
    const nodiRimasti = [];
    for (const n of v.nodes) {
      const causa = (n.any || []).concat(n.all || [], n.none || [])
        .map(c => (c.data || {}).messageKey).find(Boolean) || null;
      const bersaglio = Array.isArray(n.target) ? n.target[n.target.length - 1] : n.target;
      const voce = await voceDelRegistro(page, attive, { motore: 'axe', regola: v.id, causa, url, bersaglio, xpath: false, conta });
      if (voce) { voce.matches++; derogati.push({ engine: 'axe', tipo: 'da verificare', rule: v.id, cause: causa, id: voce.id, target: n.target, html: n.html }); }
      else nodiRimasti.push(n);
    }
    if (nodiRimasti.length) rimasti.push({ ...v, nodes: nodiRimasti });
  }
  avvisaConfronti(conta, url, 'axe');
  return { incomplete: rimasti, derogati };
}

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
    const t = { key, ...cfg[key] };
    if (t.extraHTTPHeaders) {
      const h = espandiEnv(t.extraHTTPHeaders);
      t.extraHTTPHeaders = h.valori;
      if (h.mancanti.length) t.envMancanti = h.mancanti;
    }
    out.push(t);
  }
  return out;
}

/* ${NOME} nei valori di un oggetto (le intestazioni HTTP del target) diventa il valore della
   variabile d'ambiente NOME. Un'autenticazione per intestazione porta spesso l'identita' di una
   persona (un codice fiscale): e' un dato personale e va tenuto fuori dal config, come le
   password. Le variabili non impostate restano tali e vengono restituite in 'mancanti'. */
function espandiEnv(obj) {
  const mancanti = [];
  const valori = {};
  for (const [k, v] of Object.entries(obj || {})) {
    valori[k] = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, nome) => {
      if (process.env[nome] !== undefined) return process.env[nome];
      if (!mancanti.includes(nome)) mancanti.push(nome);
      return m;
    });
  }
  return { valori, mancanti };
}

function credsFor(target) {
  // Priorita': env per-target (A11Y_<KEY>_USER) > config > globale (--user/--pass).
  const k = target.key.toUpperCase();
  const user = process.env[`A11Y_${k}_USER`] || target.user || USER;
  const pass = process.env[`A11Y_${k}_PASS`] || target.pass || PASS;
  return { user, pass };
}

/* URL della pagina di login. Il loginPath e' di norma relativo a --base, ma puo' essere un URL
   assoluto: serve quando il login si fa su un'altra applicazione, come le app GovDesk in sviluppo,
   ognuna sulla sua porta e autenticate dalla sessione di GovHub (localhost:5200). I cookie
   dipendono dall'host e non dalla porta, quindi la sessione aperta sull'origine del login vale
   anche per le pagine scansionate su --base. In quel caso contextPath e pagina di partenza del
   crawl, che il login relativo forniva per difetto, ricadono sulla radice di --base.
   Lo stesso si ottiene con un loginPath relativo e 'loginBase' (CLI --login-base): l'indirizzo
   dell'applicazione di login sta fuori dal percorso, e lo stesso config vale in sviluppo e in
   collaudo cambiando solo l'opzione. Si accoda come --base, senza risolvere l'URL, così può
   contenere anche un percorso (https://host/govhub). Un loginPath assoluto resta com'è. */
const isAbsUrl = p => typeof p === 'string' && /^https?:\/\//i.test(p);
const absUrl = p => (isAbsUrl(p) ? p : BASE + (p || ''));
const loginAltrove = (target, loginBase = LOGIN_BASE) => isAbsUrl(target.loginPath) || !!loginBase;
const loginUrl = (target, loginBase = LOGIN_BASE) =>
  (!isAbsUrl(target.loginPath) && loginBase ? String(loginBase).replace(/\/+$/, '') + (target.loginPath || '') : absUrl(target.loginPath));
const defaultCtxPath = (target, loginBase = LOGIN_BASE) => target.contextPath || (loginAltrove(target, loginBase) ? '/' : target.loginPath) || '/';

async function login(page, target) {
  if (!target.login) return true;   // target senza form: auth via header/SSO
  const url = loginUrl(target);
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
    /* Il rimando dopo il login può arrivare ben dopo la quiete della rete: un'app appena avviata
       risponde al primo login anche dopo diversi secondi, e intanto la pagina resta sul form.
       Controllando subito, il login risultava non confermato e le pagine aperte dopo trovavano la
       sessione non ancora pronta e rimandavano al login. Si aspetta l'URL atteso, entro un limite. */
    if (l.successUrlIncludes && !page.url().includes(l.successUrlIncludes)) {
      await page.waitForURL(u => u.href.includes(l.successUrlIncludes), { timeout: l.successWaitMs || 15000 }).catch(() => {});
    }
  }
  const ok = !l.successUrlIncludes || page.url().includes(l.successUrlIncludes);
  return ok;
}

// Step post-login (es. selezione organizzazione, sempre presente in GovCat):
// eseguiti dopo il login riusando il motore step dei flow.
async function postLogin(page, target) {
  for (const s of (target.postLogin?.steps || [])) {
    try { await runStep(page, s); }
    catch (e) { if (!s.optional) throw e; console.warn(`    postLogin: step opzionale fallito (${maskSecrets(e.message)})`); }
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

// Normalizza un URL per confronto/dedup: senza slash finale, con il fragment quando e' una ROTTA.
// Le app con HashLocationStrategy (Angular con useHash, molte SPA storiche) tengono li' l'intera
// rotta: senza, tutte le viste collassano su origin+pathname e il dedup scarta tutto dopo la prima
// pagina, segnalando "gia' scansionata" indicando pero' un URL diverso. Entra solo il fragment che
// ha la forma di una rotta ('#/...' o '#!/...'): le ancore ('#main-content') e i parametri che
// alcuni login lasciano nel fragment ('#state=...&code=...') renderebbero la chiave instabile e
// farebbero vedere redirect che non ci sono. Per le app senza routing sul fragment non cambia nulla.
const ROTTA_FRAGMENT = /^#!?\//;
function normUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '') + x.search + (ROTTA_FRAGMENT.test(x.hash) ? x.hash : ''); } catch { return u; } }

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

// Statistiche Lighthouse della run: distinguono "feature spenta" da "feature attiva ma sempre in
// errore" (altrimenti si vedono solo lhScore: null e sembra un problema di installazione).
let _lhOk = 0, _lhFail = 0, _lhFirstErr = null;
// motivo dell'ultimo audit senza punteggio: finisce nel risultato della vista (evidenza nei report)
let _lhUltimoMotivo = null;

// Porta CDP su cui il browser della scansione si apre a Lighthouse (vedi scan()). Non e' fissa:
// scan() ne chiede al sistema una libera prima di lanciare il browser. Con una porta fissa due
// scansioni contemporanee se la contendevano: la seconda non riusciva ad aprirla e il suo
// Lighthouse misurava le viste nel browser dell'altra, poi falliva su tutte quando l'altra finiva.
let LH_PORT = 9222;

// Porta TCP libera su localhost, scelta dal sistema (listen sulla porta 0).
function portaLibera() {
  return new Promise((ok, ko) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', ko);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ok(port)); });
  });
}

/* Sessione per la tab di Lighthouse. La tab aperta via CDP vive nel context DI DEFAULT del
   browser, mentre la scansione naviga in un browser context ISOLATO (browser.newContext()): la
   sessione NON e' condivisa, e senza questo passaggio Lighthouse misura la pagina che l'app
   mostra a chi non e' autenticato (login, scelta dell'organizzazione), presentandola come la vista.
   Ci si collega al context di default via CDP e vi si porta:
   - i COOKIE, ciascuno con il suo dominio e il suo path. Spediti come header 'Cookie' fisso
     valevano solo quelli del path della pagina: il cookie di sessione di GovHub ha path
     /govhub-reverse-proxy, restava fuori, il backend rispondeva 403 e l'app rimandava al login.
     E solo i cookie veri sono leggibili dalla pagina (document.cookie), come il token XSRF;
   - lo SESSION STORAGE dell'origine della vista, con uno script d'avvio: vale per singola
     scheda, e quella di Lighthouse e' nuova. GovHub vi tiene l'organizzazione scelta: senza,
     ogni vista rimanda alla scelta dell'organizzazione.
   Restituisce gli header per Lighthouse e 'rilascia', da chiamare dopo la run: toglie lo script,
   che altrimenti resterebbe attivo per le viste successive. */
const _lhDefault = new Map();   // porta CDP -> context di default (connessione riusata)
async function lhContextDefault(port) {
  if (!_lhDefault.has(port)) {
    // connessione persa (browser chiuso, nuova scansione nello stesso processo): la si riapre alla prossima vista
    _lhDefault.set(port, chromium.connectOverCDP(`http://127.0.0.1:${port}`).then(b => {
      b.on('disconnected', () => _lhDefault.delete(port));
      return b.contexts()[0];
    }));
  }
  try { return await _lhDefault.get(port); } catch (e) { _lhDefault.delete(port); throw e; }
}
async function lhPreparaSessione(page, target, port = LH_PORT) {
  const headers = { ...(target?.extraHTTPHeaders || {}) };
  let script = null;
  try {
    const def = await lhContextDefault(port);
    const cookies = await page.context().cookies();
    if (cookies.length) await def.addCookies(cookies);
    const ss = await page.evaluate(() => ({ origin: location.origin, items: Object.fromEntries(Object.entries(sessionStorage)) })).catch(() => null);
    if (ss && Object.keys(ss.items).length) {
      script = await def.addInitScript(({ origin, items }) => {
        if (location.origin !== origin) return;
        for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v);
      }, ss);
    }
  } catch (e) {
    // ripiego: l'header con i cookie del path della pagina (copre le app con un solo cookie a path /)
    console.warn(`  [lighthouse] sessione non copiata (${e.message}): uso l'header Cookie`);
    try {
      const cookies = await page.context().cookies(page.url());
      if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch { /* senza cookie LH vedra' la pagina non autenticata: lo dira' lo scarto del punteggio */ }
  }
  return {
    headers: Object.keys(headers).length ? headers : undefined,
    rilascia: async () => { if (script) await script.dispose().catch(() => {}); },
  };
}

// true se i due URL indicano la stessa vista (frammento e '/' finale a parte); null se non leggibili.
function lhStessaVista(a, b) {
  try {
    const n = u => { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, '') + x.search; };
    return n(a) === n(b);
  } catch { return null; }
}

async function runLighthouse(browser, url, target, extraHeaders) {
  _lhUltimoMotivo = null;
  try {
    const { default: lighthouse } = await import('lighthouse');
    // Il browser e' lanciato con --remote-debugging-port=LH_PORT, porta libera scelta da scan().
    // Usiamo il modulo lighthouse grezzo: apre una tab sullo stesso browser (CDP),
    // quindi con disableStorageReset condivide localStorage e conserva i cookie di sessione
    // copiati da lhPreparaSessione; extraHeaders porta l'eventuale header di auth del target.
    const runner = await lighthouse(url, {
      port: LH_PORT,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['accessibility'],
      disableStorageReset: true,
      extraHeaders: extraHeaders || target?.extraHTTPHeaders || undefined,
      formFactor: 'desktop',
      screenEmulation: { disabled: true },
      throttlingMethod: 'provided',
    });
    // Lighthouse NON lancia eccezioni quando la pagina non e' analizzabile (redirect a login,
    // errore HTTP, nessun paint): completa la run e mette l'esito in lhr.runtimeError, con
    // categories.accessibility.score = null. Va detto, altrimenti si vede solo lhScore: null.
    const lhr = runner?.lhr;
    const rtErr = lhr?.runtimeError;
    if (rtErr && rtErr.code && rtErr.code !== 'NO_ERROR') {
      _lhFail++;
      if (!_lhFirstErr) _lhFirstErr = `${rtErr.code}: ${rtErr.message}`;
      _lhUltimoMotivo = `${rtErr.code}: ${rtErr.message}`;
      console.warn(`  [lighthouse] ${rtErr.code} su ${url}: ${rtErr.message}`);
      return null;
    }
    const score = lhr?.categories?.accessibility?.score;
    if (score == null) {
      _lhFail++;
      if (!_lhFirstErr) _lhFirstErr = 'run completata senza punteggio accessibility';
      _lhUltimoMotivo = `run completata senza punteggio accessibility${lhr?.finalDisplayedUrl ? ` (url finale: ${lhr.finalDisplayedUrl})` : ''}`;
      console.warn(`  [lighthouse] nessun punteggio accessibility su ${url}${lhr?.finalDisplayedUrl ? ` (url finale: ${lhr.finalDisplayedUrl})` : ''}`);
      return null;
    }
    /* La vista arriva qui gia' risolta (url effettivo dopo i redirect): se Lighthouse finisce
       altrove, di norma e' stato rimandato al login, e il punteggio sarebbe quello di un'altra
       pagina presentato come se fosse di questa. Lo si scarta, e lo si dice. */
    const finale = lhr?.finalDisplayedUrl;
    if (finale && lhStessaVista(finale, url) === false) {
      _lhFail++;
      if (!_lhFirstErr) _lhFirstErr = `misurata un'altra pagina (${finale} invece di ${url}): sessione non arrivata a Lighthouse?`;
      _lhUltimoMotivo = `punteggio scartato: misurata un'altra pagina (${finale})`;
      console.warn(`  [lighthouse] punteggio scartato: misurata ${finale} invece di ${url}`);
      return null;
    }
    _lhOk++;
    return score;
  } catch (e) {
    // Modulo assente = prerequisito mancante, non errore della pagina: stop immediato (di norma
    // gia' intercettato dal preflight in scan(); qui copre l'uso programmatico e le importazioni).
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      preflightOptionalDeps({ lighthouse: true });
      if (IS_MAIN) { console.error(`  [lighthouse] modulo non caricabile: ${e.message}`); process.exit(2); }
    }
    _lhFail++;
    if (!_lhFirstErr) _lhFirstErr = e.message;
    _lhUltimoMotivo = `errore: ${e.message.split('\n')[0]}`;
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
  let illeggibile = false;
  try { snap = await page.locator('body').ariaSnapshot(); } catch { illeggibile = true; /* ariaSnapshot non disponibile */ }
  // 'illeggibile': l'albero non si e' potuto leggere, che non e' lo stesso che leggerlo vuoto
  if (!snap) return illeggibile ? { nodes: 0, nameless: [], illeggibile } : { nodes: 0, nameless: [] };
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

/* ----------------- comandi utilizzabili col solo mouse ------------------ */
// axe non puo' sapere se un widget risponde alla tastiera: nessuna regola statica lo verifica,
// e l'albero ARIA vede solo cio' che DICHIARA un ruolo. Un <div> o una <td> con un gestore del
// clic e nessun 'tabindex' e' invisibile a entrambi, ma per chi non usa il mouse semplicemente
// non esiste (WCAG 2.1.1).
//
// Qui l'informazione che manca la si prende alla fonte: si strumenta 'addEventListener' PRIMA
// che girino gli script della pagina e si annota quali elementi ricevono un gestore del clic.
// Poi si segnala chi, fra questi, non e' raggiungibile da tastiera.
//
// Per non produrre rumore si escludono: gli elementi gia' focalizzabili, quelli dentro un
// comando focalizzabile, quelli che CONTENGONO un elemento focalizzabile (i contenitori con
// gestione delegata: form, tabelle, pannelli), i nascosti, quelli fuori dall'albero di
// accessibilita' ('aria-hidden') e le voci di un widget composito, cioe' con un 'role' e
// 'tabindex=-1': li' il fuoco lo governa il widget (roving tabindex).
const SELETTORE_FOCALIZZABILE = 'a[href],button,input,select,textarea,summary,[contenteditable],[tabindex]:not([tabindex="-1"])';

const INIT_SOLO_MOUSE = `(() => {
  const originale = EventTarget.prototype.addEventListener;
  window.__gwConClic = new Set();
  EventTarget.prototype.addEventListener = function (tipo, fn, opzioni) {
    try {
      if ((tipo === 'click' || tipo === 'mousedown') && this instanceof Element) window.__gwConClic.add(this);
    } catch (e) { /* target non ispezionabile: si prosegue */ }
    return originale.call(this, tipo, fn, opzioni);
  };
})()`;

/* Contrasti fuori vista. axe misura il contrasto su quel che e' a schermo: un testo che sta sotto il
   bordo di un contenitore che scorre (lo stato vuoto in fondo alla colonna, "Scorri per caricare
   altri risultati" in coda a una lista) o coperto in parte da una barra fissa esce come 'incomplete'
   con elmPartiallyObscured. Non e' un'incertezza sul colore ma sulla geometria: l'elemento si porta
   al centro della vista, si rimisura il solo 'color-contrast' su di lui e lo scorrimento torna com'era. Cosi' axe
   decide davvero: passato, violazione, o ancora da verificare se resta coperto anche in vista.
   Va in fondo all'analisi della vista: scorrere puo' far caricare altro (scroll infinito), e gli
   altri controlli devono aver gia' fotografato la vista a riposo. */
const FUORI_VISTA = new Set(['elmPartiallyObscured', 'elmPartiallyObscuring']);

/* Pausa degli scroll infiniti durante la rimisura: il testo in coda alla lista ("Scorri per
   caricare altri risultati") e' proprio dove lo scroll infinito carica, e portarlo in vista farebbe
   arrivare altre righe, che lo spingono di nuovo fuori (o lo sostituiscono con l'attesa). Con
   window.__gwPausaIO si scartano le due cose a cui reagiscono le librerie: i callback degli
   IntersectionObserver e gli eventi 'scroll' (ngx-infinite-scroll), fermati in cattura sulla
   finestra prima di ogni altro gestore. Tolta la pausa la vista e' di nuovo quella di prima, e
   non carica niente. Installato prima degli script di pagina, come INIT_SOLO_MOUSE. */
const INIT_PAUSA_IO = `(() => {
  addEventListener('scroll', e => { if (window.__gwPausaIO) e.stopImmediatePropagation(); }, true);
  const Originale = window.IntersectionObserver;
  if (!Originale) return;
  window.IntersectionObserver = class extends Originale {
    constructor(callback, opzioni) {
      super((voci, osservatore) => { if (!window.__gwPausaIO) callback(voci, osservatore); }, opzioni);
    }
  };
})();`;

async function rimisuraContrastiFuoriVista(page, incomplete, violations) {
  const regola = (incomplete || []).find(r => r.id === 'color-contrast');
  if (!regola) return { incomplete, violations, rimisurati: 0 };

  const candidati = regola.nodes.filter(n => n.target.length === 1 && (n.any || []).some(c => FUORI_VISTA.has(c.data?.messageKey)));
  if (!candidati.length) return { incomplete, violations, rimisurati: 0 };

  const restano = new Set(regola.nodes);
  const nuoveViolazioni = [];
  let rimisurati = 0;

  for (const nodo of candidati) {
    // Il selettore di axe e' corto ("p") e vale per il DOM di quell'analisi: l'elemento si
    // ritrova fra quelli che corrispondono confrontando l'HTML registrato da axe, e si marca.
    // Anche un elemento in vista ma coperto in parte da una barra fissa (il campo di scrittura in
    // fondo a una chat) si porta al centro: scorrendo esce da sotto la barra. Se resta coperto
    // anche li' (un velo modale), axe lo lascia da verificare, e l'incertezza e' reale.
    const scorrimenti = await page.evaluate(([sel, html]) => {
      const inizio = html.slice(0, 120);
      const el = Array.from(document.querySelectorAll(sel)).find(e => e.outerHTML.slice(0, 120) === inizio);
      if (!el) return null;
      const salvati = [];
      for (let a = el.parentElement; a; a = a.parentElement) if (a.scrollHeight > a.clientHeight || a.scrollWidth > a.clientWidth) salvati.push([a, a.scrollTop, a.scrollLeft]);
      window.__gwScorrimenti = { salvati, x: scrollX, y: scrollY, el };
      window.__gwPausaIO = true;
      el.setAttribute('data-gw-rimisura', '');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    }, [nodo.target[0], nodo.html || '']).catch(() => null);
    if (!scorrimenti) continue;

    try {
      // Solo l'elemento marcato (e il suo testo): passato se axe non ha piu' dubbi ne' violazioni
      const esito = await new AxeBuilder({ page }).withRules(['color-contrast']).include('[data-gw-rimisura]').analyze();
      const nodi = r => r.flatMap(x => x.nodes || []);
      const violati = nodi(esito.violations);
      const passato = !violati.length && !nodi(esito.incomplete).length && nodi(esito.passes).length > 0;
      if (passato || violati.length) {
        restano.delete(nodo);
        rimisurati++;
        if (violati.length) nuoveViolazioni.push({ ...esito.violations[0], nodes: violati });
      }
    } finally {
      await page.evaluate(() => {
        const s = window.__gwScorrimenti;
        if (!s) return;
        s.el.removeAttribute('data-gw-rimisura');
        for (const [a, top, left] of s.salvati) { a.scrollTop = top; a.scrollLeft = left; }
        scrollTo(s.x, s.y);
        delete window.__gwScorrimenti;
        // La pausa resta finche' l'osservatore non ha consegnato le notifiche dello scorrimento
        return new Promise(fine => requestAnimationFrame(() => requestAnimationFrame(() => { window.__gwPausaIO = false; fine(); })));
      }).catch(() => {});
    }
  }

  const altre = incomplete.filter(r => r !== regola);
  const nodi = regola.nodes.filter(n => restano.has(n));
  const regolaViolata = violations.find(v => v.id === 'color-contrast');
  const piuViolazioni = nuoveViolazioni.flatMap(v => v.nodes);
  let violazioni = violations;
  if (piuViolazioni.length) {
    violazioni = regolaViolata
      ? violations.map(v => (v === regolaViolata ? { ...v, nodes: [...v.nodes, ...piuViolazioni] } : v))
      : [...violations, { ...nuoveViolazioni[0], nodes: piuViolazioni }];
  }
  return { incomplete: nodi.length ? [...altre, { ...regola, nodes: nodi }] : altre, violations: violazioni, rimisurati, violati: piuViolazioni.length };
}

async function analyzeMouseOnly(page, opzioni) {
  const { ignora = null, massimo = 40 } = opzioni || {};
  try {
    return await page.evaluate(({ focalizzabile, massimo, ignora }) => {
      const visibile = (e) => {
        if (!e.isConnected) return false;
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const s = getComputedStyle(e);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const descrivi = (e) => ({
        tag: e.tagName.toLowerCase(),
        id: e.id || null,
        classe: (e.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ') || null,
        role: e.getAttribute('role') || null,
        testo: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null,
      });
      /* Popup delle combobox ARIA 1.2 (ng-select, mat-autocomplete...): il fuoco resta sulla
         combobox e le opzioni si scelgono con le frecce (aria-activedescendant), quindi le opzioni
         e il pannello che le contiene hanno un gestore del clic ma non devono essere focalizzabili. */
      const popupCombobox = [];
      document.querySelectorAll('[role="combobox"][aria-controls], [role="combobox"][aria-owns]').forEach((c) => {
        `${c.getAttribute('aria-controls') || ''} ${c.getAttribute('aria-owns') || ''}`.split(/\s+/)
          .filter(Boolean).forEach((id) => { const p = document.getElementById(id); if (p) popupCombobox.push(p); });
      });
      const inPopupCombobox = (e) => popupCombobox.some((p) => p.contains(e) || e.contains(p));
      /* Sfondo di un dialog aperto (cdk-overlay-backdrop, MUI Backdrop...): elemento senza ruolo
         ne' testo che chiude il dialog al clic; da tastiera la stessa azione e' Esc (verifica
         manuale, come per tutti i widget compositi). Non solo aria-modal: Angular Material 17+
         non lo imposta e rende inerte il resto della pagina con aria-hidden. */
      const dialogModali = Array.from(document.querySelectorAll(
        '[aria-modal="true"], [role="dialog"], [role="alertdialog"], dialog[open]')).filter(visibile);
      const sfondoDialog = (e) => dialogModali.length > 0 && !e.getAttribute('role')
        && !(e.textContent || '').trim() && !dialogModali.some((d) => d.contains(e) || e.contains(d));
      const candidati = [];
      const esamina = (e) => {
        if (!(e instanceof Element) || !visibile(e)) return;
        if (e.matches(focalizzabile) || e.tabIndex >= 0) return;          // gia' raggiungibile
        if (e.closest('[aria-hidden="true"]')) return;                    // fuori dall'albero
        /* Voce di un widget composito: chi scrive 'role' insieme a 'tabindex=-1' dichiara di
           gestire il fuoco da se' (roving tabindex), com'e' giusto per le celle di un calendario
           o le voci di un menu. Che i tasti facciano poi la cosa giusta e' verifica manuale;
           qui non e' un comando dimenticato. */
        if (e.getAttribute('role') && e.getAttribute('tabindex') === '-1') return;
        if (e.closest(focalizzabile)) return;                             // dentro un comando
        if (e.querySelector(focalizzabile)) return;                       // contenitore con delega
        if (inPopupCombobox(e)) return;                                   // opzioni via aria-activedescendant
        if (sfondoDialog(e)) return;                                      // sfondo del dialog: Esc
        if (ignora) { try { if (e.matches(ignora) || e.closest(ignora)) return; } catch (x) { /* selettore non valido: si ignora l'esclusione */ } }
        candidati.push(descrivi(e));
      };
      (window.__gwConClic || new Set()).forEach(esamina);
      document.querySelectorAll('[onclick]').forEach(esamina);            // gestori come attributo
      /* dedup: lo stesso elemento puo' aver ricevuto piu' gestori */
      const visti = new Set();
      const unici = candidati.filter((c) => {
        const k = JSON.stringify(c);
        if (visti.has(k)) return false;
        visti.add(k);
        return true;
      });
      return { totale: unici.length, elementi: unici.slice(0, massimo) };
    }, { focalizzabile: SELETTORE_FOCALIZZABILE, massimo, ignora });
  } catch {
    return { totale: 0, elementi: [] };   // pagina chiusa o contesto non valutabile
  }
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
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      preflightOptionalDeps({ screenReader: true });   // esce con codice 2 se i moduli non ci sono
      if (IS_MAIN) { console.error(`  [screen-reader] moduli non caricabili: ${e.message}`); process.exit(2); }
    }
    console.warn(`  [screen-reader] moduli non disponibili (${e.message}). Installa: ${OPTIONAL_FEATURES.screenReader.install}`);
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

/* Lighthouse escluso per il flow in corso ("lighthouse": false nel flow). L'audit ricarica
   l'URL della vista in una scheda separata, con la stessa sessione: su un'applicazione che
   rinnova a ogni pagina un token anti-CSRF, quella ricarica invalida il token del form aperto
   nella scheda della scansione, e l'invio successivo del flow viene rifiutato. Il flow
   fotografa allora una pagina d'errore invece della vista che doveva raggiungere. */
let LH_ESCLUSO_NEL_FLOW = false;

// Esegue axe (e Lighthouse / screen reader) sullo stato CORRENTE del DOM e registra il risultato.
// Nodi dell'albero di accessibilita' della pagina (null se non leggibile): 0 = nessun contenuto
// percepibile da una tecnologia assistiva, la firma di una vista che non si e' renderizzata.
async function nodiAccessibili(page) {
  try {
    const snap = await page.locator('body').ariaSnapshot();
    return (snap || '').split('\n').filter(l => /^\s*-\s+/.test(l)).length;
  } catch { return null; }
}

/* ------------- controlli di presentazione e tastiera (fuori da axe) ------------- */
/* I risultati escono nel formato delle violazioni di axe (id, impact, tags, help, nodes): cosi'
   finiscono senza altro lavoro nel report HTML, in JUnit, SARIF, Sonar e nel gate --fail-on.
   Gli id hanno il prefisso 'gova11y-' per distinguerli dalle regole di axe. */
const CRITERI = {
  '1.4.10': { tag: 'wcag21aa', titolo: 'Reflow', slug: 'reflow' },
  '1.4.12': { tag: 'wcag21aa', titolo: 'Text Spacing', slug: 'text-spacing' },
  '2.1.1': { tag: 'wcag2a', titolo: 'Keyboard', slug: 'keyboard' },
  '2.1.2': { tag: 'wcag2a', titolo: 'No Keyboard Trap', slug: 'no-keyboard-trap' },
  '2.4.3': { tag: 'wcag2a', titolo: 'Focus Order', slug: 'focus-order' },
  '2.4.7': { tag: 'wcag2aa', titolo: 'Focus Visible', slug: 'focus-visible' },
  '2.4.11': { tag: 'wcag22aa', titolo: 'Focus Not Obscured (Minimum)', slug: 'focus-not-obscured-minimum' },
  '1.4.13': { tag: 'wcag21aa', titolo: 'Content on Hover or Focus', slug: 'content-on-hover-or-focus' },
  '3.1.2': { tag: 'wcag2aa', titolo: 'Language of Parts', slug: 'language-of-parts' },
  '4.1.2': { tag: 'wcag2a', titolo: 'Name, Role, Value', slug: 'name-role-value' },
};

// Una violazione nel formato di axe. 'nodi': [{ target: '<selettore>', html?, messaggio }].
function violazione(id, criterio, impatto, help, nodi) {
  const c = CRITERI[criterio] || {};
  return {
    id, impact: impatto, help, description: help,
    tags: ['gov-a11y', ...(c.tag ? [c.tag] : []), `wcag${criterio.replace(/\./g, '')}`],
    helpUrl: c.slug ? `https://www.w3.org/WAI/WCAG22/Understanding/${c.slug}.html` : 'https://www.w3.org/WAI/WCAG22/quickref/',
    nodes: nodi.map(n => ({ target: [n.target], html: n.html || '', failureSummary: n.messaggio, impact: impatto })),
  };
}

/* Problemi dichiarati da uno script di flow (scan(nome, { problemi })): verifiche che solo
   l'applicazione sa fare, come "il menu si apre con Invio" o "Esc riporta il focus al bottone".
   Uno per voce: { criterio: '2.1.1', messaggio, selettore?, impatto? (predefinito 'serious') }. */
function violazioniDaProblemi(problemi) {
  const out = new Map();
  for (const p of problemi || []) {
    const criterio = String(p.criterio || '').trim();
    if (!criterio || !p.messaggio) throw new Error("problema dichiarato senza 'criterio' o 'messaggio'");
    const impatto = p.impatto || 'serious';
    const id = `gova11y-script-${criterio.replace(/\./g, '')}`;
    const chiave = `${id}|${impatto}`;
    if (!out.has(chiave)) out.set(chiave, violazione(id, criterio, impatto, `${criterio} ${CRITERI[criterio]?.titolo || ''}`.trim() + ' (verifica dello script del target)', []));
    out.get(chiave).nodes.push({ target: [p.selettore || 'html'], html: '', failureSummary: p.messaggio, impact: impatto });
  }
  return [...out.values()];
}

// Descrizione breve di un elemento, usata come 'target' dei nodi (tag#id.classi). Installata nella
// pagina prima di ogni controllo: le funzioni passate a page.evaluate non vedono questo modulo.
async function installaDescrivi(page) {
  await page.evaluate(() => {
    window.__gwDescrivi = e => {
      const s = e.tagName.toLowerCase();
      if (e.id) return s + '#' + CSS.escape(e.id);
      const cl = typeof e.className === 'string' ? e.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
      return s + cl.map(c => '.' + CSS.escape(c)).join('');
    };
  });
}

// 1.4.10: a 320 px CSS di larghezza la vista non deve richiedere lo scorrimento orizzontale.
async function analyzeReflow(page) {
  const prima = page.viewportSize() || { width: 1280, height: 720 };
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(300);
  try {
    await installaDescrivi(page);
    const r = await page.evaluate(() => {
      const larghezza = document.documentElement.scrollWidth;
      const larghi = [...document.querySelectorAll('body *')].filter(e => {
        const b = e.getBoundingClientRect();
        return e.offsetParent && b.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed';
      }).slice(0, 5).map(e => ({ target: window.__gwDescrivi(e), html: e.outerHTML.slice(0, 200), destra: Math.round(e.getBoundingClientRect().right) }));
      return { larghezza, larghi };
    });
    if (r.larghezza <= 321) return [];
    const nodi = r.larghi.length ? r.larghi : [{ target: 'html', html: '', destra: r.larghezza }];
    return [violazione('gova11y-reflow-320', '1.4.10', 'serious', 'A 320px di larghezza la vista scorre in orizzontale',
      nodi.map(n => ({ target: n.target, html: n.html, messaggio: `Larghezza del documento ${r.larghezza}px a 320px: l'elemento arriva a ${n.destra}px` })))];
  } finally {
    await page.setViewportSize(prima);
    await page.waitForTimeout(150);
  }
}

/* 1.4.12: con interlinea 1.5, spaziatura lettere 0.12em, parole 0.16em, paragrafi 2em nessun testo si perde.
   Il criterio riguarda il testo che si perde PER EFFETTO della spaziatura: si misura quali testi sono
   tagliati prima di applicarla e quali dopo.
   - tagliato solo dopo: violazione (gova11y-text-spacing);
   - tagliato gia' prima, e visibile: caso da verificare (gova11y-text-truncated), non una violazione
     1.4.12. Un testo troncato all'origine (es. con i puntini) e' un difetto solo se il testo completo
     non e' disponibile altrove; come caso da verificare ha lo screenshot e si puo' dichiarare nel
     registro dei falsi positivi;
   - nascosto di proposito (testo per screen reader, testo sostituito da un'icona): ignorato. Si
     riconosce dallo stile (clip, riquadro di 1px, text-indent fuori schermo), non dal nome della classe.
   Restituisce { violazioni, daVerificare } nel formato di axe. */
async function analyzeTextSpacing(page) {
  await installaDescrivi(page);
  const esito = await page.evaluate(() => {
    const nascostoDiProposito = (e, cs) => {
      if (/sr-only|visually-hidden/.test(e.getAttribute('class') || '')) return true;
      const b = e.getBoundingClientRect();
      if (b.width <= 1 || b.height <= 1) return true;
      if (/^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(cs.clip)) return true;
      if (/^inset\(\s*(50|100)%/.test(cs.clipPath || '')) return true;
      return Math.abs(parseFloat(cs.textIndent) || 0) >= 999;   // testo spostato fuori dal riquadro (icona)
    };
    // Nodi di testo che si leggono: non il contenuto di style e script (un contenitore puo' includerli).
    const nodiDiTesto = e => {
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: n =>
        !n.nodeValue.trim() || n.parentElement.closest('style, script, noscript, template') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodi = []; while (w.nextNode()) nodi.push(w.currentNode); return nodi;
    };
    const testoDi = e => nodiDiTesto(e).map(n => n.nodeValue.trim()).join(' ');
    // Tagliato: il contenitore nasconde cio' che esce e almeno un testo finisce fuori dalla sua area
    // visibile. Non basta che il contenuto sia piu' grande (margini o spazio vuoto non tolgono testo);
    // con text-overflow:ellipsis il testo occupa comunque tutta la sua lunghezza, quindi esce anch'esso.
    const tagliato = e => {
      const cs = getComputedStyle(e);
      const nasconde = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.textOverflow === 'ellipsis';
      if (!nasconde || (e.scrollWidth <= e.clientWidth + 2 && e.scrollHeight <= e.clientHeight + 2)) return false;
      const b = e.getBoundingClientRect();
      const sx = b.left + e.clientLeft, sy = b.top + e.clientTop, dx = sx + e.clientWidth, gy = sy + e.clientHeight;
      const r = document.createRange();
      return nodiDiTesto(e).some(n => { r.selectNodeContents(n);
        return [...r.getClientRects()].some(t => t.width > 0 && (t.right > dx + 2 || t.bottom > gy + 2 || t.left < sx - 2 || t.top < sy - 2)); });
    };
    const candidati = [...document.querySelectorAll('body *')].filter(e =>
      e.offsetParent && e.children.length <= 3 && testoDi(e) && !nascostoDiProposito(e, getComputedStyle(e)));
    const giaTagliati = new Set(candidati.filter(tagliato));
    const st = document.createElement('style');
    st.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}';
    document.head.appendChild(st);
    const voce = e => ({ target: window.__gwDescrivi(e), html: e.outerHTML.slice(0, 200), testo: testoDi(e).slice(0, 40) });
    const violazioni = [], daVerificare = [];
    for (const e of candidati) {
      if (giaTagliati.has(e)) { if (daVerificare.length < 5) daVerificare.push(voce(e)); }
      else if (violazioni.length < 5 && tagliato(e)) violazioni.push(voce(e));
      if (violazioni.length >= 5 && daVerificare.length >= 5) break;
    }
    st.remove();
    return { violazioni, daVerificare };
  });
  const violazioni = esito.violazioni.length ? [violazione('gova11y-text-spacing', '1.4.12', 'moderate', 'Con la spaziatura del testo aumentata il testo viene tagliato',
    esito.violazioni.map(t => ({ target: t.target, html: t.html, messaggio: `Testo tagliato con la spaziatura aumentata: "${t.testo}"` })))] : [];
  const daVerificare = esito.daVerificare.length ? [{
    id: 'gova11y-text-truncated', impact: 'moderate', tags: ['gov-a11y', 'best-practice'],
    help: 'Testo gia\' troncato con la spaziatura normale: verificare che il testo completo sia disponibile',
    description: 'Il testo e\' tagliato dal suo contenitore anche senza spaziatura aggiunta: non e\' un effetto della spaziatura (1.4.12), ma va verificato che il testo completo si possa leggere altrove.',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html',
    nodes: esito.daVerificare.map(t => ({ target: [t.target], html: t.html, impact: 'moderate',
      failureSummary: `Testo gia' troncato senza spaziatura aggiunta: "${t.testo}"`,
      any: [{ id: 'gova11y-text-truncated', data: { messageKey: 'giaTroncato' }, message: 'testo troncato dal contenitore' }], all: [], none: [] })),
  }] : [];
  return { violazioni, daVerificare };
}

/* 2.4.7 / 2.4.11 / 2.1.2: percorre la vista col tasto Tab dall'inizio del documento. Per ogni fermata
   verifica che il focus si veda, che non sia coperto da un altro elemento e che
   il focus non resti fermo (trappola). Restituisce anche l'ordine di focus, evidenza per la revisione
   manuale (2.4.3). Si parte da un segnaposto non tabulabile in cima al body, cosi' il percorso non
   dipende da dove si trovava il focus e nessun clic tocca la pagina.
   Il focus si vede se l'elemento ha un outline o un box-shadow, oppure se lui o uno dei due
   contenitori piu' vicini cambia aspetto rispetto a prima del percorso (bordo, fondo, colore,
   sottolineatura): e' il caso dei menu che evidenziano la voce con ':focus-within' sul contenitore.
   L'aspetto di partenza si registra prima del primo Tab, senza togliere il focus durante il percorso,
   che altrimenti cambierebbe lo stato della pagina (un calendario che si apre col focus).
   Se la vista ha una finestra modale aperta (aria-modal="true" o <dialog> modale) il percorso parte
   dentro la finestra: il resto della pagina e' inerte per contratto, e partendo dall'inizio del
   documento si visiterebbero i comandi sotto la maschera. Una finestra modale con un solo comando
   trattiene il focus su quello: e' il giro della finestra, non una trappola. */
/* 'daMisurare': percorsi XPath (nel formato di IBM Equal Access) degli elementi di cui interessa la
   misura del fuoco. Si risolvono nella pagina PRIMA di iniziare, sullo stesso DOM che ha visto IBM:
   l'abbinamento usa il percorso del motore, non uno ricostruito qui. Le misure degli elementi
   raggiunti tornano in 'misure', per percorso. */
async function analyzeKeyboard(page, massimo = 45, attesaMs = 120, daMisurare = [], opzioni = {}) {
  const { fuocoNeiWidget = false, copertoSoloSeDisegna = false } = opzioni;
  await installaDescrivi(page);
  await page.evaluate(({ daMisurare, fuocoNeiWidget }) => {
    window.__gwEaPercorsi = new Map();
    for (const xp of daMisurare) {
      try {
        const n = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (n && n.nodeType === 1 && !window.__gwEaPercorsi.has(n)) window.__gwEaPercorsi.set(n, xp);
      } catch { /* percorso non valido per questo documento */ }
    }
    const visibile = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const modale = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
      .filter(e => visibile(e) && (e.getAttribute('aria-modal') === 'true' || e.matches(':modal'))).pop() || null;
    window.__gwModale = modale;
    const s = document.createElement('span'); s.id = '__gw_partenza'; s.tabIndex = -1;
    (modale || document.body).prepend(s); s.focus(); if (!modale) window.scrollTo(0, 0);
    const proprieta = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'backgroundImage', 'color', 'textDecorationLine',
      ...['Top', 'Right', 'Bottom', 'Left'].flatMap(l => [`border${l}Style`, `border${l}Width`, `border${l}Color`])];
    const aspetto = e => { const cs = getComputedStyle(e); return proprieta.map(p => cs[p]).join('|'); };
    /* Si confrontano l'elemento e i due contenitori più vicini. Con keyboardWalkWidgetFocus (spento di
       default: senza, il criterio resta quello di sempre) anche i casi che seguono.
       Più in alto solo dentro un widget che
       marca il proprio fuoco con una classe. È il caso delle combobox come ng-select: l'input con il
       fuoco è tre livelli sotto il contenitore che cambia bordo, e il componente aggiunge
       'ng-select-focused' al suo elemento radice. La classe lega il cambio d'aspetto al fuoco di questo
       elemento: senza, un contenitore alto che cambia aspetto per altri motivi (':focus-within' di un
       intero form) farebbe passare anche i campi senza indicatore. */
    const LIVELLI_WIDGET = fuocoNeiWidget ? 6 : 2;
    const catena = e => { const l = [e]; for (let p = e.parentElement; p && l.length <= LIVELLI_WIDGET && p !== document.body; p = p.parentElement) l.push(p); return l; };
    const classi = x => new Set(String(x.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    /* Comando trasparente steso sopra un altro elemento (l'input file invisibile sopra un pulsante
       "carica"): l'indicatore non può stare su di lui, e l'applicazione lo mostra su un fratello,
       di solito con ':focus-within' sul contenitore. Per questi si confrontano anche gli elementi
       dentro il contenitore diretto (al più 50). */
    const trasparenteAlFuoco = e => { for (let x = e; x && x.nodeType === 1; x = x.parentElement) if (parseFloat(getComputedStyle(x).opacity) < 0.05) return true; return false; };
    const vicinato = e => e.parentElement && e.parentElement !== document.body ? [...e.parentElement.querySelectorAll('*')].filter(x => x !== e).slice(0, 50) : [];
    /* Indicatore su un elemento interno: il comando colora l'icona che contiene (la X "Clear all" di
       ng-select diventa rossa col fuoco). Solo per i comandi piccoli, al più 20 elementi interni: in
       un contenitore grande un cambio d'aspetto all'interno può non avere niente a che fare col fuoco. */
    const INTERNI_MAX = 20;
    const interni = e => { if (!fuocoNeiWidget) return []; const d = e.querySelectorAll('*'); return d.length <= INTERNI_MAX ? [...d] : []; };
    const base = new Map(), baseClassi = new Map();
    const registra = x => { if (!base.has(x)) { base.set(x, aspetto(x)); baseClassi.set(x, classi(x)); } };
    for (const e of document.querySelectorAll('a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]')) {
      catena(e).forEach(registra);
      interni(e).forEach(registra);
      if (fuocoNeiWidget && trasparenteAlFuoco(e)) vicinato(e).forEach(registra);
    }
    const cambiato = x => base.has(x) && base.get(x) !== aspetto(x);
    const classeDelFuoco = x => baseClassi.has(x) && [...classi(x)].some(c => !baseClassi.get(x).has(c) && /focus/i.test(c));
    // true/false: cambia o no rispetto alla partenza; null: elemento comparso dopo, senza aspetto di partenza
    window.__gwFocusCambiaAspetto = e => {
      if (!base.has(e)) return null;
      const l = catena(e);
      if (l.slice(0, 3).some(cambiato)) return true;
      if (interni(e).some(cambiato)) return true;
      if (fuocoNeiWidget && trasparenteAlFuoco(e) && vicinato(e).some(cambiato)) return true;
      if (!fuocoNeiWidget) return false;
      let radice = -1;
      for (let i = l.length - 1; i >= 1; i--) if (classeDelFuoco(l[i])) { radice = i; break; }
      return radice > 0 && l.slice(0, radice + 1).some(cambiato);
    };
    /* Identita' degli elementi raggiunti: il giro completo e la trappola si riconoscono dall'elemento
       stesso, non dalla sua descrizione. Descrizione e testo (troncato) possono coincidere per
       elementi diversi, come i collegamenti di due righe che cominciano con lo stesso nome lungo, e
       il percorso si fermava li' credendo di essere tornato all'inizio. */
    window.__gwIdentita = new WeakMap(); window.__gwIdentitaN = 0;
    /* L'ultimo elemento che ha ricevuto il fuoco, con la sua descrizione: se un aggiornamento AJAX
       lo sostituisce mentre ha il fuoco, il fuoco cade sul <body> e il percorso lo riprende dal
       sostituto (vedi sotto). */
    window.__gwUltimoFuoco = null;
    window.__gwSuFocusin = ev => { window.__gwUltimoFuoco = ev.target; window.__gwUltimoFuocoDescr = window.__gwDescrivi(ev.target); };
    document.addEventListener('focusin', window.__gwSuFocusin, true);
  }, { daMisurare, fuocoNeiWidget });
  const ordine = [], senzaFocus = [], coperti = [], misure = {}, visitati = new Set();
  let trappola = null, prec = null, uguali = 0, recuperi = 0, saltaTab = false;
  /* Richieste in corso, per sapere quando la rete e' davvero ferma: waitForLoadState('networkidle')
     non serve, perche' ritorna subito se la pagina quello stato l'ha gia' raggiunto al caricamento,
     anche con una richiesta AJAX partita dopo. */
  let inVolo = 0;
  const parte = () => { inVolo++; }, finisce = () => { inVolo = Math.max(0, inVolo - 1); };
  page.on('request', parte); page.on('requestfinished', finisce); page.on('requestfailed', finisce);
  const reteFerma = async (quieteMs = 300, limiteMs = RETE_A_RIPOSO_MS) => {
    const fine = Date.now() + limiteMs; let ferma = 0;
    while (Date.now() < fine && ferma < quieteMs) { await page.waitForTimeout(50); ferma = inVolo ? 0 : ferma + 50; }
  };
  try {
    for (let i = 0; i < massimo; i++) {
      if (!saltaTab) {
        await page.keyboard.press('Tab');
        // il tempo per applicare gli stili del fuoco (transizioni, script su 'focus'): vedi keyboardWalkWaitMs
        await page.waitForTimeout(attesaMs);
      }
      saltaTab = false;
      const leggiFuoco = () => page.evaluate(copertoSoloSeDisegna => {
        const e = document.activeElement;
        if (!e || e === document.body || e.id === '__gw_partenza') return null;
        const cs = getComputedStyle(e);
        const visibile = c => c && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && visibile(cs.outlineColor);
        const ombra = cs.boxShadow !== 'none' && cs.boxShadow.split(/,(?![^(]*\))/).some(s => /0px 0px 0px [1-9]/.test(s) || /[1-9]px -?\d+px [1-9]/.test(s)) && /rgb\(|rgba\((?!.*, 0\))/.test(cs.boxShadow);
        const b = e.getBoundingClientRect();
        // Coperto (2.4.11, "Minimum") vuol dire nascosto DEL TUTTO, e da qualcosa che si vede: si
        // provano piu' punti, cioe' il centro del riquadro e centro e angoli di ogni riga dell'elemento
        // (un link che va a capo ha un riquadro complessivo che comprende anche i vicini), e basta che
        // uno solo mostri l'elemento. Non conta chi copre restando trasparente (opacity 0: lo strato
        // che alcuni componenti stendono sopra un select per intercettare il clic). Con
        // keyboardWalkObscuredPaintOnly (spento di default) non conta neanche chi in quel punto non
        // disegna nulla: un contenitore fisso vuoto e senza sfondo (una fascia per i messaggi a
        // comparsa, quando non ce ne sono) intercetta il clic ma lascia vedere l'elemento. Si scorrono
        // tutti gli elementi sopra il punto, fino all'elemento col fuoco: copre il primo che disegna.
        const fuori = b.bottom < 0 || b.top > innerHeight;
        const trasparente = t => { for (let x = t; x && x.nodeType === 1; x = x.parentElement) if (parseFloat(getComputedStyle(x).opacity) < 0.05) return true; return false; };
        const colorato = c => c && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c);
        const disegna = t => {
          if (/^(img|svg|canvas|video|iframe|object|embed|input|select|textarea|button)$/i.test(t.tagName)) return true;
          const c = getComputedStyle(t);
          return colorato(c.backgroundColor) || c.backgroundImage !== 'none' || c.boxShadow !== 'none'
            || (c.backdropFilter && c.backdropFilter !== 'none')
            || ['Top', 'Right', 'Bottom', 'Left'].some(l => c[`border${l}Style`] !== 'none' && parseFloat(c[`border${l}Width`]) > 0 && colorato(c[`border${l}Color`]))
            || [...t.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        };
        const copritore = (x, y) => {
          if (!copertoSoloSeDisegna) { const t = document.elementFromPoint(x, y);
            return t && t !== e && !e.contains(t) && !t.contains(e) && !trasparente(t) ? t : null; }
          for (const t of document.elementsFromPoint(x, y)) {
            if (t === e || e.contains(t) || t.contains(e)) return null;
            if (!trasparente(t) && disegna(t)) return t;
          }
          return null;
        };
        const punti = [[b.left + b.width / 2, b.top + Math.min(b.height / 2, 5)]];
        for (const r of e.getClientRects()) if (r.width > 4 && r.height > 4)
          punti.push([r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]);
        const inVista = punti.filter(([x, y]) => y >= 0 && y < innerHeight && x >= 0 && x < innerWidth);
        const coperture = fuori || !inVista.length ? [] : inVista.map(([x, y]) => copritore(x, y));
        const copre = coperture.length && coperture.every(Boolean) ? window.__gwDescrivi(coperture[0]) : null;
        const testo = ((e.innerText || '').trim() || e.value || e.getAttribute('aria-label') || e.getAttribute('title')
          || e.querySelector('img[alt]')?.getAttribute('alt') || '').trim().slice(0, 30);
        const nome = e.getAttribute('name');
        const ok = outline || ombra || window.__gwFocusCambiaAspetto(e) === true;
        // visibile con il fuoco: un riquadro vero (non il pixel dei testi per soli lettori) dentro la finestra
        const mostrato = b.width > 1 && b.height > 1 && !fuori && b.right > 0 && b.left < innerWidth
          && cs.visibility !== 'hidden' && !trasparente(e);
        const percorsoEa = window.__gwEaPercorsi?.get(e) || null;
        const m = window.__gwModale;
        const unicoNellaModale = !!m && m.contains(e) && [...m.querySelectorAll('a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]')]
          .filter(x => x.tabIndex >= 0 && !x.disabled && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden').length === 1;
        if (!window.__gwIdentita) { window.__gwIdentita = new WeakMap(); window.__gwIdentitaN = 0; }
        let uid = window.__gwIdentita.get(e);
        if (!uid) { uid = ++window.__gwIdentitaN; window.__gwIdentita.set(e, uid); }
        return { target: window.__gwDescrivi(e) + (nome ? `[name="${nome}"]` : ''), testo, html: e.outerHTML.slice(0, 200), ok, copre, unicoNellaModale, mostrato, percorsoEa, uid };
      }, copertoSoloSeDisegna);
      let f = await leggiFuoco();
      /* Una copertura puo' essere solo del momento: l'indicatore di caricamento che molte applicazioni
         stendono sopra la pagina durante una richiesta (polling, aggiornamenti AJAX). Si attende che la
         rete torni a riposo e si rilegge lo stesso elemento: conta solo se e' coperto anche allora.
         L'attesa scatta solo quando c'e' una copertura, quindi non rallenta il percorso. */
      if (f?.copre) {
        await reteFerma();
        await page.waitForTimeout(attesaMs);
        const g = await leggiFuoco();
        if (g && g.uid === f.uid) f = g;
      }
      // nessun elemento col fuoco: a percorso iniziato e' l'uscita dalla pagina; all'inizio si concedono
      // alcuni tentativi, poi una vista senza nulla da raggiungere non consuma tutte le fermate
      /* Fuoco perso perche' l'elemento appena raggiunto e' stato ridisegnato (un aggiornamento AJAX
         periodico, come un'icona di stato nell'intestazione, sostituisce il nodo che aveva il fuoco):
         non e' l'uscita dalla pagina. Si attende la rete, si rimette il fuoco sul sostituto (stesso
         id, o stessa descrizione se unica) e lo si misura senza premere Tab. Se il nodo c'e' ancora,
         o non ha un sostituto riconoscibile, il fuoco e' davvero uscito e il percorso finisce. */
      if (!f && ordine.length && recuperi < 3) {
        await reteFerma();
        const ripreso = await page.evaluate(() => {
          const u = window.__gwUltimoFuoco;
          if (!u || u.isConnected || (document.activeElement && document.activeElement !== document.body)) return false;
          let r = u.id ? document.getElementById(u.id) : null;
          if (!r && window.__gwUltimoFuocoDescr) {
            try { const l = document.querySelectorAll(window.__gwUltimoFuocoDescr); if (l.length === 1) r = l[0]; } catch { /* descrizione non usabile come selettore */ }
          }
          if (!r) return false;
          r.focus();
          return document.activeElement === r;
        }).catch(() => false);
        if (ripreso) { recuperi++; saltaTab = true; continue; }
      }
      if (!f) { if (ordine.length || i >= 9) break; else continue; }
      const chiave = `${f.target} "${f.testo}"`;
      if (f.uid === prec) { if (++uguali > 2) { if (!f.unicoNellaModale) trappola = f; break; } continue; }
      uguali = 0;
      if (visitati.has(f.uid)) break;   // giro completo
      prec = f.uid; visitati.add(f.uid); ordine.push(chiave);
      if (f.percorsoEa && !misure[f.percorsoEa]) misure[f.percorsoEa] = { ok: f.ok, coperto: !!f.copre, mostrato: f.mostrato };
      if (!f.ok) senzaFocus.push(f);
      if (f.copre) coperti.push(f);
    }
  } finally {
    page.off('request', parte); page.off('requestfinished', finisce); page.off('requestfailed', finisce);
    await page.evaluate(() => { document.getElementById('__gw_partenza')?.remove(); delete window.__gwFocusCambiaAspetto; delete window.__gwModale; delete window.__gwEaPercorsi; delete window.__gwIdentita; delete window.__gwIdentitaN;
      if (window.__gwSuFocusin) document.removeEventListener('focusin', window.__gwSuFocusin, true);
      delete window.__gwSuFocusin; delete window.__gwUltimoFuoco; delete window.__gwUltimoFuocoDescr; }).catch(() => {});
  }
  const violazioni = [];
  if (senzaFocus.length) violazioni.push(violazione('gova11y-focus-visible', '2.4.7', 'serious', 'Indicatore del focus non visibile',
    senzaFocus.map(f => ({ target: f.target, html: f.html, messaggio: `Con il focus da tastiera l'elemento "${f.testo}" non cambia aspetto: né outline o box-shadow, né bordo, fondo o colore suoi o del contenitore` }))));
  if (coperti.length) violazioni.push(violazione('gova11y-focus-obscured', '2.4.11', 'moderate', "L'elemento con il focus è coperto da un altro elemento",
    coperti.map(f => ({ target: f.target, html: f.html, messaggio: `Coperto da ${f.copre}` }))));
  if (trappola) violazioni.push(violazione('gova11y-keyboard-trap', '2.1.2', 'critical', 'Il focus resta bloccato su un elemento',
    [{ target: trappola.target, html: trappola.html, messaggio: 'Premendo Tab il focus non si sposta' }]));
  return { violazioni, ordine, misure };
}

/* Le domande di IBM Equal Access sul fuoco a cui risponde il percorso col Tab, con il criterio di
   conferma sulla misura e la frase che lo dichiara nel report. Le stesse misure decidono le
   violazioni del Tab (2.4.7, 2.4.11): se la misura e' negativa il caso resta da verificare e il
   Tab ha gia' la sua violazione. */
const REGOLE_CONFERMATE_DAL_TAB = {
  style_focus_visible: { conferma: m => m.ok,
    frase: "con il fuoco l'aspetto cambia (contorno, ombra, bordo, sfondo o colore suoi o del contenitore)" },
  element_tabbable_unobscured: { conferma: m => !m.coperto,
    frase: "con il fuoco l'elemento non e' coperto da altri elementi" },
  element_tabbable_visible: { conferma: m => m.mostrato && !m.coperto,
    frase: "con il fuoco l'elemento e' visibile nella finestra" },
};

/* Separa i casi da verificare di IBM a cui il percorso col Tab ha risposto. Funzione pura:
   { daVerificare, confermati }, i confermati con la frase della conferma. */
function confermaDalTab(daVerificare, misure) {
  const restano = [], confermati = [];
  for (const x of daVerificare || []) {
    const regola = REGOLE_CONFERMATE_DAL_TAB[x.regola];
    const m = regola && x.xpath ? misure?.[x.xpath] : null;
    if (m && regola.conferma(m)) confermati.push({ ...x, conferma: `Percorso col tasto Tab: ${regola.frase}` });
    else restano.push(x);
  }
  return { daVerificare: restano, confermati };
}

/* 3.1.2: testo in una lingua diversa da quella dichiarata per la sua parte di pagina. Le espressioni
   le dichiara il target, per lingua: { "it": ["Accedendo accetti", ...], "en": ["\\b(the|your)\\b"] }.
   Un testo che corrisponde a un'espressione della lingua L e la cui lingua effettiva (l'attributo
   lang piu' vicino) non comincia per L e' una violazione. Si guardano anche i testi negli attributi
   letti dalle tecnologie assistive (aria-label, placeholder, title, value dei pulsanti). */
async function analyzeLanguageParts(page, espressioni) {
  await installaDescrivi(page);
  const trovati = await page.evaluate(espressioni => {
    const regole = Object.entries(espressioni).map(([l, v]) => [l.toLowerCase(), [].concat(v).map(r => new RegExp(r, 'i'))]);
    const lingua = el => ((el.closest('[lang]') || document.documentElement).getAttribute('lang') || '').toLowerCase();
    const out = [];
    const prova = (el, testo) => {
      const ling = lingua(el);
      for (const [l, rs] of regole) if (!ling.startsWith(l) && rs.some(r => r.test(testo))) out.push({ target: window.__gwDescrivi(el), testo: testo.trim().slice(0, 50), l, ling });
    };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const el = w.currentNode.parentElement;
      if (!el || !el.offsetParent || el.closest('script,style,code,noscript')) continue;
      if (w.currentNode.textContent.trim()) prova(el, w.currentNode.textContent);
    }
    for (const el of document.querySelectorAll('[aria-label],[placeholder],[title],input[type=submit],input[type=button]')) {
      if (!el.offsetParent) continue;
      for (const v of [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), /^(submit|button)$/.test(el.type) ? el.value : null]) if (v) prova(el, v);
    }
    const visti = new Set();
    return out.filter(o => { const k = o.target + o.testo; if (visti.has(k)) return false; visti.add(k); return true; }).slice(0, 8);
  }, espressioni);
  if (!trovati.length) return [];
  return [violazione('gova11y-language-of-parts', '3.1.2', 'serious', 'Testo in una lingua diversa da quella dichiarata',
    trovati.map(t => ({ target: t.target, html: '', messaggio: `"${t.testo}" è in '${t.l}' ma la lingua dichiarata è '${t.ling || '(nessuna)'}'` })))];
}

/* ---------------------- secondo motore: IBM Equal Access ------------------- */
/* Il motore (accessibility-checker-engine, Apache-2.0) e' lo stesso dell'estensione e del checker
   di IBM, senza il loro contorno (browser proprio, telemetria): un unico script da eseguire nella
   pagina, come axe. Si inietta con evaluate e non con un tag <script>, cosi' una Content Security
   Policy che vieta gli script inline non lo blocca. Si usa l'insieme di regole WCAG 2.2, che
   contiene i soli criteri di livello A e AA. Esiti tenuti come li classifica il motore: FAIL e'
   una violazione, POTENTIAL un caso da verificare; raccomandazioni e verifiche manuali no. */
const EA_RULESET = 'WCAG_2_2';
let _eaSorgente = null;
async function runEqualAccess(page, include) {
  if (_eaSorgente === null) _eaSorgente = readFileSync(resolveModule('accessibility-checker-engine'), 'utf8');
  const presente = await page.evaluate(() => typeof window.ace !== 'undefined' && !!window.ace.Checker).catch(() => false);
  if (!presente) await page.evaluate(_eaSorgente);
  return page.evaluate(async ({ include, ruleset }) => {
    const checker = new window.ace.Checker();
    const regole = checker.getGuidelines().find(g => g.id === ruleset);
    const criteri = {};
    for (const cp of regole.checkpoints) {
      for (const r of cp.rules || []) {
        criteri[r.id] = criteri[r.id] || [];
        if (!criteri[r.id].includes(cp.num)) criteri[r.id].push(cp.num);
      }
    }
    const radice = (include && document.querySelector(include)) || document;
    const esito = await checker.check(radice, [ruleset]);
    const voce = x => ({
      regola: x.ruleId, motivo: x.reasonId, messaggio: x.message,
      snippet: String(x.snippet || '').slice(0, 300), xpath: (x.path && x.path.dom) || null,
      wcag: criteri[x.ruleId] || [],
    });
    const violazioni = [], daVerificare = [];
    for (const x of esito.results) {
      if (x.value[0] !== 'VIOLATION') continue;
      if (x.value[1] === 'FAIL') violazioni.push(voce(x));
      else if (x.value[1] === 'POTENTIAL') daVerificare.push(voce(x));
    }
    return { violazioni, daVerificare };
  }, { include: include || null, ruleset: EA_RULESET });
}

/* ------------------------- screenshot delle occorrenze --------------------- */
/* Chi riceve il report deve poter vedere dove sta il problema senza ricostruirlo dal selettore.
   Per ogni occorrenza (violazione, caso da verificare, esito del secondo motore) si fotografa la
   porzione di vista intorno all'elemento, evidenziato da un bordo rosso che poi si toglie. Lo
   stesso elemento segnalato da piu' regole ha una sola immagine. Gli elementi dentro iframe o
   shadow DOM (selettore axe composto) e quelli non visibili restano senza immagine. Il nome del
   file porta l'indice della vista, unico nella scansione. */
async function fotografaOccorrenze(page, indiceVista, nodi) {
  mkdirSync(resolve(OUT, 'screenshot'), { recursive: true });
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const fatte = new Map();
  let k = 0;
  for (const n of nodi) {
    const chiave = chiaveOccorrenza(n);
    if (!chiave) continue;
    if (fatte.has(chiave)) { n.screenshot = fatte.get(chiave); continue; }
    if (k >= SCREENSHOT_MAX) break;
    const loc = page.locator(chiave).first();
    let stile;
    try {
      if (!(await loc.count())) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      const bb = await loc.boundingBox();
      if (!bb || bb.width < 1 || bb.height < 1) continue;
      stile = await loc.evaluate(el => {
        const s = el.getAttribute('style');
        el.style.outline = '3px solid #d00';
        el.style.outlineOffset = '2px';
        return s;
      });
      const m = 40;
      const x = Math.max(0, bb.x - m), y = Math.max(0, bb.y - m);
      const clip = { x, y, width: Math.min(vp.width, bb.x + bb.width + m) - x, height: Math.min(vp.height, bb.y + bb.height + m) - y };
      if (clip.width < 1 || clip.height < 1) continue;
      const file = `screenshot/v${indiceVista}-${k + 1}.png`;
      await page.screenshot({ path: resolve(OUT, file), clip });
      k++;
      n.screenshot = file;
      fatte.set(chiave, file);
    } catch { /* elemento sparito o non fotografabile: l'occorrenza resta senza immagine */ }
    finally {
      if (stile !== undefined) await loc.evaluate((el, s) => { if (s === null) el.removeAttribute('style'); else el.setAttribute('style', s); }, stile).catch(() => {});
    }
  }
  return k;
}

/* ---------------- stima del contrasto sui casi da verificare --------------- */
/* axe lascia "da verificare" il contrasto di un testo quando non sa ricavarne lo sfondo (un
   gradiente, un'immagine, uno pseudo-elemento, un elemento sovrapposto) o quando il testo e' di uno o
   due caratteri; il secondo motore ne segnala altri. Lo sfondo vero pero' e' sullo schermo. Si
   rende trasparente il testo dell'elemento (pseudo-elementi compresi), si fotografa la sola area
   delle sue righe di testo e si confronta il colore del testo con ogni pixel di sfondo: ne escono il
   rapporto minimo e massimo e la soglia richiesta (4,5:1, oppure 3:1 per il testo grande).
   E' una STIMA. L'opacita' si applica al solo colore del testo; filtri, ombre e testi sopra
   contenuti in movimento non sono considerati; il 2% dei pixel per parte si scarta (bordi, puntini).
   Non sposta nulla fra violazioni e casi da verificare e non tocca il gate: e' il punto di partenza
   della verifica manuale, e la misura da citare in un falso positivo. */
const REGOLE_CONTRASTO = new Set(['color-contrast', 'text_contrast_sufficient']);

/* PNG -> pixel RGBA, senza dipendenze: gli screenshot di Chromium sono a 8 bit, non interlacciati. */
function decodificaPng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('non è un PNG');
  let pos = 8, w = 0, h = 0, prof = 0, tipo = 0, interl = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), nome = buf.toString('ascii', pos + 4, pos + 8);
    const dati = buf.subarray(pos + 8, pos + 8 + len);
    if (nome === 'IHDR') { w = dati.readUInt32BE(0); h = dati.readUInt32BE(4); prof = dati[8]; tipo = dati[9]; interl = dati[12]; }
    else if (nome === 'IDAT') idat.push(dati);
    else if (nome === 'IEND') break;
    pos += 12 + len;
  }
  const canali = { 0: 1, 2: 3, 4: 2, 6: 4 }[tipo];
  if (prof !== 8 || !canali || interl) throw new Error(`PNG non supportato (profondità ${prof}, tipo ${tipo}, interlacciato ${interl})`);
  const raw = inflateSync(Buffer.concat(idat));
  const riga = w * canali;
  const out = new Uint8Array(w * h * 4);
  let prec = new Uint8Array(riga), cur = new Uint8Array(riga);
  for (let y = 0; y < h; y++) {
    const base = y * (riga + 1), filtro = raw[base];
    for (let i = 0; i < riga; i++) {
      const a = i >= canali ? cur[i - canali] : 0, b = prec[i], c = i >= canali ? prec[i - canali] : 0;
      let v = raw[base + 1 + i];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = x * canali;
      if (canali >= 3) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = canali === 4 ? cur[i + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = canali === 2 ? cur[i + 1] : 255; }
    }
    [prec, cur] = [cur, prec];
  }
  return { larghezza: w, altezza: h, dati: out };
}

// Luminanza relativa e rapporto di contrasto come li definiscono le WCAG 2.x
const lumCanale = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminanza = ([r, g, b]) => 0.2126 * lumCanale(r) + 0.7152 * lumCanale(g) + 0.0722 * lumCanale(b);
function rapportoContrasto(a, b) {
  const x = luminanza(a), y = luminanza(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* Testo [r,g,b,alfa] contro gli sfondi misurati, [[r,g,b], pixel]. Il testo semitrasparente si
   compone su ogni sfondo. Esito: 'conforme' se al piu' il 2% dell'area sta sotto la soglia, 'non
   conforme' se ci sta almeno il 98%, altrimenti 'parziale' (un gradiente che passa la soglia a meta'). */
function valutaContrasto(testo, sfondi, richiesto) {
  const [r, g, b, a = 1] = testo;
  const voci = [];
  let totale = 0;
  for (const [s, n] of sfondi) {
    const fg = [r * a + s[0] * (1 - a), g * a + s[1] * (1 - a), b * a + s[2] * (1 - a)];
    voci.push([rapportoContrasto(fg, s), n]);
    totale += n;
  }
  if (!totale) return null;
  voci.sort((x, y) => x[0] - y[0]);
  const quantile = q => { let acc = 0; for (const [v, n] of voci) { acc += n; if (acc >= q * totale) return v; } return voci[voci.length - 1][0]; };
  const sotto = voci.reduce((s, [v, n]) => s + (v < richiesto ? n : 0), 0) / totale;
  const perDifetto = v => Math.floor(v * 100) / 100;   // 4,499 resta 4,49: non diventa conforme arrotondando
  return {
    minimo: perDifetto(quantile(0.02)), massimo: perDifetto(quantile(0.98)), richiesto,
    sotto: Math.round(sotto * 100) / 100,
    esito: sotto <= 0.02 ? 'conforme' : sotto >= 0.98 ? 'non conforme' : 'parziale',
  };
}

const esadecimale = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// Locator di un'occorrenza: XPath del secondo motore o selettore axe semplice (no iframe/shadow DOM)
function chiaveOccorrenza(n) {
  if (n.xpath) return `xpath=${n.xpath}`;
  return Array.isArray(n.target) && n.target.length === 1 && typeof n.target[0] === 'string' ? n.target[0] : null;
}

/* Nella pagina: colore e dimensione del testo, aree delle sue righe (nella vista), firma del
   componente; poi rende trasparente il testo. Il foglio di stile e' "adottato" (CSSOM), non un tag
   <style>: una Content Security Policy senza 'unsafe-inline' non lo blocca. Lo stesso elemento
   segnalato da piu' regole o da tutti e due i motori si misura una volta: torna l'id della misura. */
function misuraTestoInPagina(el, { vp, giro }) {
  // Il segno vale per un solo giro di misure: in una SPA lo stesso elemento resta da una vista all'altra
  if (el.__gwStima && el.__gwStima.startsWith(giro + ':')) return { gia: el.__gwStima };
  window.__gwStimaSeq = (window.__gwStimaSeq || 0) + 1;
  const id = el.__gwStima = `${giro}:${window.__gwStimaSeq}`;
  // Firma: tag, id se stabile (senza cifre: quelli generati ne hanno), al piu' tre classi non di Angular
  const pulisci = e => e.tagName.toLowerCase() + (/^[a-z][a-z_-]*$/i.test(e.id) ? '#' + e.id : '')
    + [...e.classList].filter(c => !/^ng-/.test(c)).slice(0, 3).map(c => '.' + c).join('');
  const componente = [el.parentElement, el].filter(Boolean).map(pulisci).join(' > ');
  const cs = getComputedStyle(el);
  const m = cs.color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return { id, componente, errore: `colore del testo in un formato non gestito: ${cs.color}` };
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  let alfa = p.length > 3 ? p[3] : 1;
  for (let a = el; a; a = a.parentElement) alfa *= parseFloat(getComputedStyle(a).opacity) || 0;
  if (alfa < 0.05) return { id, componente, errore: 'testo trasparente o elemento invisibile' };
  // Righe di testo: i nodi di testo propri dell'elemento, altrimenti quelli dei discendenti; per un
  // campo senza testo (input, select) l'area del contenuto. Si tagliano sull'elemento e sulla vista.
  const testi = [...el.childNodes].filter(t => t.nodeType === 3 && t.textContent.trim());
  if (!testi.length) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.textContent.trim()) testi.push(w.currentNode);
  }
  const box = el.getBoundingClientRect();
  let rett = [];
  for (const t of testi) { const r = document.createRange(); r.selectNodeContents(t); rett.push(...r.getClientRects()); }
  if (!rett.length) {
    const px = k => parseFloat(cs[k]) || 0;
    rett = [{ left: box.left + px('paddingLeft') + px('borderLeftWidth'), top: box.top + px('paddingTop') + px('borderTopWidth'),
      right: box.right - px('paddingRight') - px('borderRightWidth'), bottom: box.bottom - px('paddingBottom') - px('borderBottomWidth') }];
  }
  const vis = rett.map(r => ({
    x0: Math.ceil(Math.max(0, r.left, box.left)), y0: Math.ceil(Math.max(0, r.top, box.top)),
    x1: Math.floor(Math.min(vp.width, r.right, box.right)), y1: Math.floor(Math.min(vp.height, r.bottom, box.bottom)),
  })).filter(r => r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1);
  if (!vis.length) return { id, componente, errore: 'testo fuori dalla vista o senza area' };
  const dim = parseFloat(cs.fontSize) || 16, peso = parseInt(cs.fontWeight, 10) || 400;
  el.setAttribute('data-gw-contrasto', '');
  const sel = '[data-gw-contrasto]';
  const foglio = new CSSStyleSheet();
  foglio.replaceSync(`${[sel, `${sel} *`, `${sel}::before`, `${sel}::after`, `${sel} *::before`, `${sel} *::after`, `${sel}::placeholder`].join(', ')}
    { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important;
      text-decoration-color: transparent !important; caret-color: transparent !important; transition: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, foglio];
  window.__gwContrasto = { el, foglio };
  return new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(() => ok({
    id, componente, colore: [p[0], p[1], p[2], Math.round(alfa * 1000) / 1000], rettangoli: vis,
    grande: dim >= 24 || (dim >= 18.66 && peso >= 700), dimensione: dim, peso,
  }))));
}

async function stimaContrasti(page, nodi) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const perChiave = new Map(), perId = new Map();
  const giro = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let misurati = 0;
  for (const n of nodi) {
    const chiave = chiaveOccorrenza(n);
    if (!chiave) continue;
    if (perChiave.has(chiave)) { if (perChiave.get(chiave)) n.contrasto = perChiave.get(chiave); continue; }
    if (misurati >= CONTRASTO_MAX) break;
    const loc = page.locator(chiave).first();
    let stima = null, nascosto = false;
    try {
      if (!(await loc.count())) { perChiave.set(chiave, null); continue; }
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const info = await loc.evaluate(misuraTestoInPagina, { vp, giro });
      if (info.gia) { stima = perId.get(info.gia) || null; continue; }
      misurati++;
      if (info.errore) { stima = { componente: info.componente, errore: info.errore }; perId.set(info.id, stima); continue; }
      nascosto = true;
      const x0 = Math.min(...info.rettangoli.map(r => r.x0)), y0 = Math.min(...info.rettangoli.map(r => r.y0));
      const x1 = Math.max(...info.rettangoli.map(r => r.x1)), y1 = Math.max(...info.rettangoli.map(r => r.y1));
      const img = decodificaPng(await page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, scale: 'css' }));
      // Solo i pixel sotto le righe di testo: un'icona fra due nodi di testo non e' sfondo
      const conteggio = new Map();
      for (const r of info.rettangoli) {
        for (let y = r.y0 - y0; y < Math.min(img.altezza, r.y1 - y0); y++) {
          for (let x = r.x0 - x0; x < Math.min(img.larghezza, r.x1 - x0); x++) {
            const o = (y * img.larghezza + x) * 4;
            const k = (img.dati[o] << 16) | (img.dati[o + 1] << 8) | img.dati[o + 2];
            conteggio.set(k, (conteggio.get(k) || 0) + 1);
          }
        }
      }
      const sfondi = [...conteggio].map(([k, c]) => [[(k >> 16) & 255, (k >> 8) & 255, k & 255], c]);
      const valutazione = valutaContrasto(info.colore, sfondi, info.grande ? 3 : 4.5);
      stima = valutazione
        ? { componente: info.componente, testo: esadecimale(info.colore), alfa: info.colore[3], grande: info.grande, dimensione: info.dimensione, peso: info.peso, ...valutazione }
        : { componente: info.componente, errore: 'nessun pixel di sfondo misurabile' };
      perId.set(info.id, stima);
    } catch (e) {
      stima = { errore: `misura non riuscita: ${String(e.message || e).split('\n')[0]}` };
    } finally {
      if (nascosto) {
        await page.evaluate(() => {
          const s = window.__gwContrasto;
          if (!s) return;
          s.el.removeAttribute('data-gw-contrasto');
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(f => f !== s.foglio);
          delete window.__gwContrasto;
        }).catch(() => {});
      }
      perChiave.set(chiave, stima);
      if (stima) n.contrasto = stima;
    }
  }
  return [...new Set(perId.values())];
}

/* Le stime raggruppate per componente su tutta la scansione: il colore da cambiare (o il falso
   positivo da dichiarare) e' uno per componente, non uno per vista. Lo stesso elemento visto da
   tutti e due i motori conta una volta. */
const ORDINE_ESITO = { 'non conforme': 0, parziale: 1, conforme: 2, 'non stimabile': 3 };
function contrastiPerComponente(results) {
  const gruppi = new Map();
  for (const pr of results) {
    const nodi = [
      ...(pr.incomplete || []).filter(v => REGOLE_CONTRASTO.has(v.id)).flatMap(v => (v.nodes || []).map(n => ['axe', n])),
      ...[...(pr.equalAccess?.violazioni || []), ...(pr.equalAccess?.daVerificare || [])].filter(x => REGOLE_CONTRASTO.has(x.regola)).map(x => ['IBM', x]),
    ];
    for (const [motore, n] of nodi) {
      const c = n.contrasto;
      if (!c) continue;
      const componente = c.componente || selettoreComponente(n.target) || n.xpath || '?';
      const g = gruppi.get(componente) || { componente, motori: new Set(), viste: new Set(), stime: new Set(), testi: new Set(), minimo: null, massimo: null, richiesto: new Set(), esiti: {} };
      g.motori.add(motore);
      g.viste.add(pr.name);
      if (!g.stime.has(c)) {
        g.stime.add(c);
        const esito = c.errore ? 'non stimabile' : c.esito;
        g.esiti[esito] = (g.esiti[esito] || 0) + 1;
        if (!c.errore) {
          g.testi.add(c.alfa < 1 ? `${c.testo} (${Math.round(c.alfa * 100)}%)` : c.testo);
          g.richiesto.add(c.richiesto);
          g.minimo = g.minimo == null ? c.minimo : Math.min(g.minimo, c.minimo);
          g.massimo = g.massimo == null ? c.massimo : Math.max(g.massimo, c.massimo);
        } else g.errore = c.errore;
      }
      gruppi.set(componente, g);
    }
  }
  return [...gruppi.values()].map(g => {
    const esito = Object.keys(g.esiti).sort((a, b) => ORDINE_ESITO[a] - ORDINE_ESITO[b])[0];
    return { componente: g.componente, motori: [...g.motori], viste: [...g.viste], occorrenze: g.stime.size, testi: [...g.testi],
      minimo: g.minimo, massimo: g.massimo, richiesto: [...g.richiesto], esiti: g.esiti, esito, errore: g.errore || null };
  }).sort((a, b) => ORDINE_ESITO[a.esito] - ORDINE_ESITO[b.esito] || b.viste.length - a.viste.length || b.occorrenze - a.occorrenze);
}

async function recordScan(browser, page, target, name, pageResults, sourceHint, extra = {}) {
  const t0 = performance.now();
  const primaDellaVista = TEMPI.fineUltimaVista == null ? null : t0 - TEMPI.fineUltimaVista;
  const fasi = {};
  const misura = async (fase, fn) => {
    const t = performance.now();
    try { return await fn(); } finally { fasi[fase] = (fasi[fase] || 0) + performance.now() - t; }
  };
  const url = page.url();
  /* axe fotografa il DOM com'e' in quel momento: con una richiesta ancora in volo puo'
     trovare in pagina gli elementi transitori dell'attesa (maschere, indicatori di
     caricamento), che nessuna vista mostra a riposo. Si lascia posare la rete, ma con un
     limite breve: alcune applicazioni non raggiungono mai 'networkidle' (polling, connessioni
     tenute aperte) e l'attesa predefinita costerebbe mezzo minuto per vista. */
  /* Il documento corrente deve essere ARRIVATO: un invio di form che non passa per AJAX e' una
     navigazione, e senza questa attesa axe puo' fotografare la pagina mentre sta ancora
     caricando — senza titolo, senza 'main', senza intestazione, cioe' con la firma di una
     pagina vuota che verrebbe scambiata per un difetto. Se e' gia' caricata torna subito. */
  await misura('attesa', async () => {
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: RETE_A_RIPOSO_MS }).catch(() => {});
    /* Vista senza contenuto accessibile: di solito non e' ancora arrivata (un backend lento, una lista
       che tarda), a volte non arrivera' mai. Si concede un'attesa, una sola, prima di analizzarla; se
       resta vuota viene analizzata comunque e segnalata come tale (vedi 'vuota' piu' sotto). */
    if (await nodiAccessibili(page) === 0) {
      console.warn(`    [vista vuota] ${name}: nessun contenuto accessibile, attendo ${VISTA_VUOTA_ATTESA_MS / 1000}s e riprovo`);
      await page.waitForTimeout(VISTA_VUOTA_ATTESA_MS);
      await page.waitForLoadState('networkidle', { timeout: RETE_A_RIPOSO_MS }).catch(() => {});
    }
  });
  /* Stato HTTP del documento della vista (Navigation Timing, responseStatus): e' quello della
     risposta che ha caricato la pagina, anche se poi la vista e' cambiata via AJAX. 0 o assente =
     non noto (file://, pagine da cache, browser senza il dato): non e' un errore. */
  const httpStatus = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n && typeof n.responseStatus === 'number' && n.responseStatus > 0 ? n.responseStatus : null;
  }).catch(() => null);
  const erroreHttp = httpStatus != null && httpStatus >= 400;
  /* Fotografia COERENTE: se il documento viene sostituito mentre axe lo percorre — una
     navigazione tardiva, un ridisegno che ricarica la vista — il risultato e' quello di una
     pagina a meta', e si presenta con la firma inconfondibile della pagina vuota (senza
     titolo, senza 'main', senza intestazione di primo livello). Si marca il documento prima
     dell'analisi e si verifica dopo che sia ancora lo stesso: altrimenti si rifa'. */
  let r = null;
  const tAxe = performance.now();
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    const marcatore = `gw-${Date.now()}-${tentativo}`;
    await page.evaluate(m => { window.__gwMarcatore = m; }, marcatore).catch(() => {});
    /* 'include' (selettore CSS) limita l'analisi a una parte della vista: serve negli stati in cui
       un elemento sovrapposto (una tendina aperta) copre per costruzione cio' che ha sotto, che
       axe non potrebbe misurare e che si analizza comunque nella vista a riposo. */
    let builder = new AxeBuilder({ page }).withTags(TAGS);
    if (extra.include) builder = builder.include(extra.include);
    r = await builder.analyze();
    const dopo = await page.evaluate(() => ({ marcatore: window.__gwMarcatore, stato: document.readyState })).catch(() => ({}));
    if (dopo.marcatore === marcatore && dopo.stato === 'complete') break;
    console.warn(`    [vista non ferma durante l'analisi] ${name}: rifaccio (tentativo ${tentativo + 2}/3)`);
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: RETE_A_RIPOSO_MS }).catch(() => {});
  }
  fasi.axe = performance.now() - tAxe;
  // Le occorrenze coperte dal registro dei falsi positivi escono da 'incomplete' e vengono
  // conservate a parte: restano nel report, ma non fra le cose ancora da verificare.
  //
  // SUBITO dopo l'analisi, e prima di ogni altra cosa: il confronto avviene nella pagina, e
  // deve trovare il DOM che axe ha esaminato. Stava in fondo, dopo Lighthouse, l'albero ARIA
  // e la simulazione dello screen reader: decine di secondi durante i quali un'applicazione a
  // ridisegno parziale sostituisce interi rami, e gli elementi da confrontare sparivano. Su
  // una vista di govwayMonitor questo bastava a far figurare 38 occorrenze fra quelle da
  // verificare, pur essendo coperte dal registro su tutte le altre viste.
  let { incomplete, derogati } = await misura('falsiPositivi', () => separaFalsiPositivi(page, r.incomplete, url));
  /* I controlli che falliscono restano nel risultato della vista: un controllo non eseguito e' un'evidenza.
     Quelli che decidono il gate si ripetono una volta, se la pagina e' ancora la stessa: di norma l'errore
     e' dell'ambiente (un refresh automatico o una risposta lenta proprio durante la misura). Se nel
     frattempo la pagina e' cambiata non si riprova, perche' si misurerebbe un'altra vista. */
  const nonEseguiti = [], eseguiti = [];
  const prova = async (nome, fn) => {
    const urlPrima = page.url();
    for (let tentativo = 1; ; tentativo++) {
      try { const esito = await fn(); eseguiti.push(nome); return esito; } catch (e) {
        const m = e.message.split('\n')[0];
        const stessa = !page.isClosed() && page.url() === urlPrima;
        if (tentativo === 1 && stessa && CONTROLLI_DA_RIPETERE.has(nome)) {
          console.warn(`    [${name}] controllo ${nome}: primo tentativo non riuscito (${m}), riprovo`);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          continue;
        }
        const errore = `${m}${stessa ? '' : ` (la pagina e' cambiata durante la misura: ${page.isClosed() ? 'scheda chiusa' : page.url()})`}${tentativo > 1 ? ' (anche al secondo tentativo)' : ''}`;
        nonEseguiti.push({ controllo: nome, errore });
        console.warn(`    [${name}] controllo ${nome} non eseguito: ${errore}`);
        return null;
      }
    }
  };
  // Il secondo motore subito dopo axe: deve vedere lo stesso stato della vista.
  let equalAccess = null;
  if (DO_EA) {
    equalAccess = await misura('equalAccess', () => prova('equalAccess', () => runEqualAccess(page, extra.include)));
    if (equalAccess) {
      const ea = await misura('falsiPositivi', () => separaFalsiPositiviEA(page, equalAccess, url));
      equalAccess = ea.equalAccess;
      derogati = [...derogati, ...ea.derogati];
    }
  }
  let lhScore = null, lhMotivo = null;
  /* extra.senzaLighthouse: motivo per cui questa sola vista non passa da Lighthouse (es. il suo URL
     cambia la configurazione e ricaricarlo ripeterebbe l'azione). */
  const lhEscluso = DO_LH && (LH_ESCLUSO_NEL_FLOW || !!extra.senzaLighthouse);
  if (extra.senzaLighthouse && DO_LH) lhMotivo = extra.senzaLighthouse;
  if (DO_LH && !lhEscluso) await misura('lighthouse', async () => {
    const sessione = await lhPreparaSessione(page, target);
    try { lhScore = await runLighthouse(browser, url, target, sessione.headers); lhMotivo = lhScore == null ? _lhUltimoMotivo : null; }
    finally { await sessione.rilascia(); }
  });
  // L'albero ARIA (ariaSnapshot) viene salvato come artefatto separato (dir aria-tree/): lo
  // teniamo fuori dall'oggetto axTree per non gonfiare axe-results.json.
  const { snapshot: ariaSnapshot, ...axTree } = await misura('axTree', () => analyzeAxTree(page));
  // Albero letto e vuoto: la vista non si e' renderizzata, e il suo esito non vale (vedi FAIL_ON_EMPTY).
  const vuota = axTree.nodes === 0 && !axTree.illeggibile;
  const soloMouse = DO_MOUSE_ONLY ? await misura('mouseOnly', () => analyzeMouseOnly(page, { ignora: MOUSE_ONLY_IGNORE, massimo: MOUSE_ONLY_MAX })) : { totale: 0, elementi: [] };
  let sr = null;
  if (DO_SR) sr = await misura('screenReader', () => runScreenReader(page));
  /* Controlli fuori da axe, in fondo: cambiano la larghezza della vista, la spaziatura e il focus,
     e non devono disturbare le analisi precedenti, che fotografano la vista a riposo. */
  const aggiuntive = violazioniDaProblemi(extra.problemi);
  let tabOrder = null;
  if (DO_REFLOW) aggiuntive.push(...(await misura('reflow', () => prova('reflow', () => analyzeReflow(page))) || []));
  // spaziatura del testo: le violazioni con le altre; i testi gia' troncati fra i casi da verificare (piu' sotto)
  let troncati = [];
  if (DO_TEXT_SPACING) {
    const ts = await misura('textSpacing', () => prova('textSpacing', () => analyzeTextSpacing(page)));
    if (ts) { aggiuntive.push(...ts.violazioni); troncati = ts.daVerificare; }
  }
  if (LANGUAGE_PARTS) aggiuntive.push(...(await misura('languageParts', () => prova('languageParts', () => analyzeLanguageParts(page, LANGUAGE_PARTS))) || []));
  if (DO_KEYBOARD && extra.keyboard !== false) {
    const daMisurare = DO_EA_TAB && equalAccess
      ? [...new Set(equalAccess.daVerificare.filter(x => REGOLE_CONFERMATE_DAL_TAB[x.regola] && x.xpath).map(x => x.xpath))] : [];
    const k = await misura('keyboardWalk', () => prova('keyboardWalk', () => analyzeKeyboard(page, KEYBOARD_MAX, KEYBOARD_ATTESA_MS, daMisurare, { fuocoNeiWidget: KEYBOARD_WIDGET, copertoSoloSeDisegna: KEYBOARD_COPERTO_DISEGNA })));
    if (k) { aggiuntive.push(...k.violazioni); tabOrder = k.ordine; }
    if (k && daMisurare.length) {
      const c = confermaDalTab(equalAccess.daVerificare, k.misure);
      equalAccess = { ...equalAccess, daVerificare: c.daVerificare, confermatiDaTab: c.confermati };
      if (c.confermati.length) { const n = c.confermati.length; console.log(`    [IBM] ${n} ${n === 1 ? 'caso' : 'casi'} da verificare sul fuoco ${n === 1 ? 'confermato' : 'confermati'} dal percorso col Tab`); }
    }
  }
  // In fondo, per ultima: scorre la vista (vedi rimisuraContrastiFuoriVista)
  const rimisura = await misura('contrastiFuoriVista', () => prova('contrasti fuori vista', () => rimisuraContrastiFuoriVista(page, incomplete, r.violations)));
  if (rimisura?.rimisurati) {
    incomplete = rimisura.incomplete;
    r.violations = rimisura.violations;
    console.log(`    [contrasto] ${rimisura.rimisurati} elementi fuori vista rimisurati in vista${rimisura.violati ? `: ${rimisura.violati} violazioni` : ', tutti conformi'}`);
  }
  r.violations = [...r.violations, ...aggiuntive];
  // i testi gia' troncati sono casi da verificare: passano anche dal registro dei falsi positivi
  if (troncati.length) {
    const sep = await misura('falsiPositivi', () => separaFalsiPositivi(page, troncati, url));
    incomplete = [...(incomplete || []), ...sep.incomplete];
    derogati = [...derogati, ...sep.derogati];
  }
  /* Stima del contrasto prima degli screenshot: nasconde per un attimo il testo, e l'immagine deve
     mostrarlo. Sui casi che axe non ha deciso e su quelli del secondo motore. */
  if (DO_CONTRASTO) {
    const nodi = [
      ...(incomplete || []).filter(v => REGOLE_CONTRASTO.has(v.id)).flatMap(v => v.nodes || []),
      ...(equalAccess ? [...equalAccess.violazioni, ...equalAccess.daVerificare].filter(x => REGOLE_CONTRASTO.has(x.regola)) : []),
    ];
    const stime = nodi.length ? await misura('contrastEstimate', () => prova('stima del contrasto', () => stimaContrasti(page, nodi))) : null;
    if (stime?.length) {
      CONTROLLI_USATI.add('contrastEstimate');
      const conta = e => stime.filter(s => (s.errore ? 'non stimabile' : s.esito) === e).length;
      console.log(`    [contrasto] stima sullo sfondo reale di ${stime.length} testi: ${conta('non conforme')} sotto soglia, ${conta('parziale')} in parte, ${conta('conforme')} conformi${conta('non stimabile') ? `, ${conta('non stimabile')} non stimabili` : ''}`);
    }
  }
  if (DO_SCREENSHOT) {
    /* In ordine di importanza, perche' il numero di immagini per vista ha un tetto: prima le
       violazioni dei due motori, poi i casi da verificare (quelli del secondo motore sono molti). */
    const nodi = [
      ...r.violations.flatMap(v => v.nodes || []),
      ...(equalAccess ? equalAccess.violazioni : []),
      ...(incomplete || []).flatMap(v => v.nodes || []),
      ...(equalAccess ? equalAccess.daVerificare : []),
    ];
    if (nodi.length) await misura('screenshot', () => prova('screenshot', () => fotografaOccorrenze(page, pageResults.length, nodi)));
  }
  pageResults.push({
    target: target.key, targetName: target.name, sourceHint: sourceHint || target.sourceHint,
    name, url, violations: r.violations, incomplete, falsePositives: derogati, lhScore, lhEscluso, lhMotivo, axTree, soloMouse, ariaSnapshot, sr, vuota, httpStatus, erroreHttp, tabOrder, equalAccess,
    controlliNonEseguiti: nonEseguiti, controlliEseguiti: eseguiti,
    tempi: { inizio: t0 - TEMPI.avvio, primaDellaVista, totale: performance.now() - t0, fasi },
  });
  TEMPI.fineUltimaVista = performance.now();
  const counts = summarizeImpacts(r.violations);
  const incN = (incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
  const fpN = derogati.length;
  const nm = axTree.nameless.length ? `  a11y-tree: ${axTree.nameless.length} elem. interattivi senza nome` : '';
  const mo = soloMouse.totale ? `  solo-mouse: ${soloMouse.totale} comandi non raggiungibili da tastiera` : '';
  const srN = sr ? `  SR: ${sr.stops} annunci${sr.roleOnly.length ? `, ${sr.roleOnly.length} solo-ruolo` : ''}` : '';
  const eaN = equalAccess ? `  IBM: ${equalAccess.violazioni.length} violazioni, ${equalAccess.daVerificare.length} da verificare` : '';
  if (erroreHttp) console.warn(`  ! [${name}] ERRORE HTTP ${httpStatus}: la vista e' la risposta d'errore dell'applicazione, non la pagina che si voleva esaminare`);
  if (vuota) console.warn(`  ! [${name}] VISTA VUOTA: nessun contenuto accessibile dopo l'attesa (pagina non renderizzata?). Il suo esito non e' valido`);
  console.log(`  [${name}] ${url} -> violazioni: ${fmtCounts(counts)}${incN ? `  da-verificare: ${incN}` : ''}${fpN ? `  falsi-positivi: ${fpN}` : ''}${lhScore != null ? `  LH=${(lhScore * 100).toFixed(0)}%` : ''}${nm}${mo}${srN}${eaN}  (${((TEMPI.fineUltimaVista - t0) / 1000).toFixed(1)} s)`);
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

/* Link <a href> navigazionali della pagina. 'escludi' (recurse.excludeLinks del target) e' un
   selettore CSS dei link da non seguire: tipicamente menu e intestazione dell'applicazione, che
   porterebbero la ricorsione fuori dalla sezione che sta esplorando. Senza, si seguono tutti. */
function linkNavigazionali(page, escludi) {
  return page.$$eval('a[href]', (els, escludi) => els.filter(a => {
    const href = a.getAttribute('href') || '';
    if (!href || href === '#' || /^(javascript:|mailto:|#)/i.test(href)) return false;
    if (escludi) { try { if (a.matches(escludi)) return false; } catch { /* selettore non valido: nessun link escluso */ } }
    return true;
  }).map(a => ({ href: a.getAttribute('href'), text: (a.textContent || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40) })), escludi || null);
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
  const links = await linkNavigazionali(page, opts.excludeLinks);
  let mutanti = 0;
  for (const l of links) {
    if (opts.state.count >= opts.max) break;
    let abs; try { abs = new URL(l.href, home).href; } catch { continue; }
    if (!abs.includes(opts.ctxPath)) continue;                          // resta dentro la console
    if (opts.skipRe.test(abs) || opts.skipRe.test(l.text)) continue;    // distruttivi/logout/salva
    if (opts.mutatingRe && opts.mutatingRe.test(abs)) { mutanti++; continue; }   // dopo gli altri: vedi sotto
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
  /* Link che cambiano lo stato (opts.mutatingRe, dal 'mutating' del target): es. le frecce che
     riordinano un elenco con una GET e ricreano le voci con identificativi nuovi. Si seguono dopo
     tutti gli altri link, i cui URL restano cosi' validi. Per ciascuno si riapre la pagina, se ne
     rileggono i link e si segue quello nella stessa posizione: l'URL letto prima puo' contenere
     identificativi non piu' esistenti. La vista risultante non passa da Lighthouse (ricaricarne
     l'URL ripeterebbe l'azione) e non si ricorre da essa. */
  const chiaveHome = normVisit(home);
  for (let i = 0; i < mutanti && opts.state.count < opts.max; i++) {
    const key = `${chiaveHome}#mutante-${i}`;
    if (opts.visited.has(key)) continue;
    opts.visited.add(key);
    try { await page.goto(home, { waitUntil: 'networkidle' }); } catch { break; }
    const attuali = (await linkNavigazionali(page, opts.excludeLinks)).map(l => { try { return { ...l, abs: new URL(l.href, home).href }; } catch { return null; } })
      .filter(l => l && l.abs.includes(opts.ctxPath) && !opts.skipRe.test(l.abs) && !opts.skipRe.test(l.text) && opts.mutatingRe.test(l.abs));
    const l = attuali[i];
    if (!l) { console.warn(`      ricorsione: link che cambia lo stato n. ${i + 1} non piu' presente dopo la rilettura`); break; }
    opts.state.count++;
    const clab = `${baseLabel}/${slug(l.text) || 'azione'}-${i + 1}`;
    try { await page.goto(l.abs, { waitUntil: 'networkidle' }); }
    catch (e) { console.warn(`      ricorsione: '${l.text}' non aperto: ${e.message}`); continue; }
    await recordScan(browser, page, target, `flow:${flowName}/${clab}`, pageResults, opts.sourceHint,
      { senzaLighthouse: "il collegamento cambia lo stato dell'applicazione: ricaricarlo ripeterebbe l'azione" });
  }
  await page.goto(home, { waitUntil: 'networkidle' }).catch(() => {});   // torna al livello corrente per i fratelli
}

// Applica l'attesa post-azione di uno step (load-state o comparsa selettore) + eventuale delay.
/* Risolve quando il documento non cambia da 'quieteMs', oppure allo scadere di 'limiteMs'.
   L'osservatore vive nella pagina: qui si aspetta solo la sua promessa. */
async function attendiDomFermo(page, quieteMs, limiteMs) {
  await page.evaluate(({ quieteMs, limiteMs }) => new Promise(fine => {
    let attesa = setTimeout(chiudi, quieteMs);
    const limite = setTimeout(chiudi, limiteMs);
    const osservatore = new MutationObserver(() => { clearTimeout(attesa); attesa = setTimeout(chiudi, quieteMs); });
    function chiudi() { clearTimeout(attesa); clearTimeout(limite); osservatore.disconnect(); fine(); }
    osservatore.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }), { quieteMs, limiteMs }).catch(() => { /* pagina in navigazione: si prosegue */ });
}

/* Pagine successive di un elenco. Un elenco paginato mostra nella prima pagina solo una parte dei
   record: le righe che cadono piu' avanti (un esito diverso, uno stato diverso) non verrebbero mai
   esaminate. Con 'nextPage' nel target, dopo la prima pagina si preme il comando di pagina
   successiva, finche' c'e' e per al piu' 'max' pagine (default 1), e si esamina ogni pagina come
   vista a se' ('<nome>/pagina-2', ...). Il selettore dipende dalla libreria di componenti
   dell'applicazione e si dichiara nel target: deve trovare il comando solo quando e' attivo
   (all'ultima pagina, di solito, il comando non e' un collegamento o e' disabilitato). Le attese
   ('wait', 'waitQuietMs', 'delayMs', 'timeoutMs') sono quelle del blocco 'nextPage'. */
async function scansionaPagineSuccessive(browser, page, target, nome, pageResults, sourceHint) {
  const cfg = target.nextPage;
  if (!cfg || !cfg.selector) return 0;
  const max = Number.isInteger(cfg.max) && cfg.max > 0 ? cfg.max : 1;
  const attesa = { wait: cfg.wait || 'networkidle', waitQuietMs: cfg.waitQuietMs, delayMs: cfg.delayMs, timeoutMs: cfg.timeoutMs };
  let pagine = 0;
  for (let n = 2; n <= max + 1; n++) {
    const comando = page.locator(cfg.selector).filter({ visible: true }).first();
    if (!(await comando.count().catch(() => 0))) break;
    if (await comando.isDisabled().catch(() => false)) break;
    try {
      await comando.click({ timeout: cfg.timeoutMs || 8000 });
      await applyWait(page, attesa);
    } catch (e) { console.warn(`    ${nome}: pagina ${n} non raggiunta: ${e.message.split('\n')[0]}`); break; }
    await recordScan(browser, page, target, `${nome}/pagina-${n}`, pageResults, sourceHint);
    pagine++;
  }
  /* 'back': comando per tornare alla pagina precedente, premuto una volta per ogni pagina in piu'.
     Serve alle applicazioni che ricordano in sessione la pagina dell'elenco e se ne lasciano
     condizionare anche altrove (una console che, ferma sulla seconda pagina, risponde vuota alla
     propria radice): riportato l'elenco alla prima pagina, la navigazione successiva riparte pulita. */
  if (cfg.back) {
    for (let k = 0; k < pagine; k++) {
      try {
        await page.locator(cfg.back).filter({ visible: true }).first().click({ timeout: cfg.timeoutMs || 8000 });
        await applyWait(page, attesa);
      } catch (e) { console.warn(`    ${nome}: ritorno alla pagina precedente non riuscito: ${e.message.split('\n')[0]}`); break; }
    }
  }
  return pagine;
}

async function applyWait(page, step) {
  const to = step.timeoutMs || 8000;
  if (['networkidle', 'load', 'domcontentloaded'].includes(step.wait)) await page.waitForLoadState(step.wait).catch(() => {});
  else if (typeof step.wait === 'string') await page.waitForSelector(step.wait, { timeout: to });
  /* Attesa che la vista smetta di cambiare. Dove il lavoro che resta e' tutto nel browser —
     la rete e' gia' a riposo, ma il contenuto si sta ancora costruendo — analizzare adesso
     significa fotografare uno stato di passaggio: elementi transitori dell'attesa, contenuto
     non ancora disegnato, e un DOM che cambia perfino fra l'analisi e i confronti successivi.
     Si osservano le modifiche al documento e si prosegue quando per un tratto non ne arrivano
     piu'. Quanta quiete serve dipende dall'applicazione: si dichiara nel target. */
  if (step.waitQuietMs) await attendiDomFermo(page, step.waitQuietMs, to);
  if (step.delayMs) await page.waitForTimeout(step.delayMs);
}

/* File da caricare in un campo 'input[type=file]'. I percorsi relativi si risolvono sulla
   directory del config, come per i falsi positivi: l'archivio di prova sta accanto al target
   che lo usa. Un file mancante ferma lo step con un messaggio chiaro, invece dell'errore
   generico di Playwright. */
function risolviFileUpload(upload) {
  const elenco = [].concat(upload.files ?? upload.file ?? []);
  if (!elenco.length) throw new Error("step 'upload' senza 'files'");
  return elenco.map(f => {
    const percorso = isAbsolute(String(f)) ? String(f) : resolve(dirname(CONFIG), String(f));
    if (!existsSync(percorso)) throw new Error(`file da caricare non trovato: ${percorso}`);
    return percorso;
  });
}

/* Valori dei campi da variabili d'ambiente. I dati con cui si compila un modulo (un codice fiscale,
   una motivazione) possono essere personali anche quando sono di collaudo, e il config e' versionato
   e condiviso: un passo 'fill' o 'select' puo' quindi dichiarare, al posto del valore, il NOME della
   variabile da cui leggerlo ({ "env": "A11Y_..." }). Quali variabili servano a un flow si ricava dai
   suoi passi, senza un elenco da tenere allineato a mano, e se ne manca una il flow viene saltato.
   I valori letti vengono mascherati nei log e in ogni file di report: l'analisi fotografa la pagina
   con i campi compilati, e senza questa sostituzione il dato finirebbe nell'albero ARIA e negli
   estratti HTML di axe. I valori piu' corti di MIN_SECRET caratteri non vengono mascherati: un
   numero o una lettera comparirebbero ovunque e renderebbero i report illeggibili. */
const MIN_SECRET = 3;
const SECRET_VALUES = new Set();

function envValue(name) {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`variabile d'ambiente ${name} non impostata`);
  if (v.length >= MIN_SECRET) SECRET_VALUES.add(v);
  return v;
}

// Nomi delle variabili d'ambiente citate dai passi di un flow (o di un elenco di passi).
function flowEnvRefs(flowOrSteps) {
  const steps = Array.isArray(flowOrSteps) ? flowOrSteps : (flowOrSteps?.steps || []);
  const names = [];
  for (const s of steps) for (const k of ['fill', 'select']) if (s?.[k]?.env && !names.includes(s[k].env)) names.push(s[k].env);
  return names;
}

const missingEnv = names => names.filter(n => process.env[n] === undefined || process.env[n] === '');

// Sostituisce con '***' ogni valore letto dall'ambiente, nelle forme in cui puo' comparire in un
// report: testo semplice, stringa JSON (con le sequenze di escape), XML (JUnit/SARIF, che codificano
// anche l'apostrofo) e HTML del report, che codifica solo <>&" e lascia l'apostrofo in chiaro.
const htmlEscapeReport = v => v.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function maskSecrets(text) {
  if (typeof text !== 'string' || !SECRET_VALUES.size) return text;
  const forme = new Set();
  for (const v of SECRET_VALUES) { forme.add(v); forme.add(JSON.stringify(v).slice(1, -1)); forme.add(xmlEscape(v)); forme.add(htmlEscapeReport(v)); }
  let out = text;
  for (const f of [...forme].sort((a, b) => b.length - a.length)) if (f) out = out.split(f).join('***');
  return out;
}

// Scrittura dei file di report: passa sempre dal mascheramento dei valori letti dall'ambiente.
const writeReport = (file, content) => writeFileSync(file, maskSecrets(content));

/* Campo di un passo 'fill' o 'select': per selettore CSS ('selector') oppure per etichetta ('label'),
   cioe' per nome accessibile. L'etichetta serve dove l'id del campo e' generato a ogni rendering
   (es. 'lnk-form-field-<uuid>'): il nome accessibile resta stabile, e se manca e' a sua volta un
   difetto da segnalare. Per default l'etichetta si confronta per sottostringa; "labelExact": true
   chiede l'uguaglianza. */
function fieldLocator(page, f, passo) {
  if (f.label) return page.getByLabel(f.label, { exact: !!f.labelExact }).first();
  if (f.selector) return page.locator(f.selector).first();
  throw new Error(`passo '${passo}': serve 'selector' oppure 'label'`);
}

/* Passo 'select': sceglie un'opzione per testo. Su una <select> nativa usa l'etichetta dell'opzione;
   su un componente a tendina (ng-select, combobox ARIA) apre il controllo e clicca l'opzione con
   ruolo 'option' il cui nome corrisponde (per sottostringa, o esatto con "exact": true). */
async function selectOption(page, sel, to) {
  const value = sel.env ? envValue(sel.env) : sel.value;
  if (value === undefined) throw new Error("passo 'select': serve 'value' (o 'env')");
  const el = fieldLocator(page, sel, 'select');
  await el.waitFor({ state: 'visible', timeout: to });
  if (await el.evaluate(n => n.tagName === 'SELECT')) { await el.selectOption({ label: value }, { timeout: to }); return; }
  await el.click({ timeout: to });
  const opzione = page.getByRole('option', { name: value, exact: !!sel.exact }).first();
  if (!(await opzione.waitFor({ state: 'visible', timeout: to }).then(() => true, () => false))) {
    // L'errore elenca le opzioni presenti: la causa piu' frequente e' un valore scritto diversamente.
    const presenti = (await page.getByRole('option').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    throw new Error(`passo 'select': opzione '${value}' non trovata; opzioni disponibili: ${presenti.length ? presenti.join(' | ') : '(nessuna)'}`);
  }
  await opzione.click({ timeout: to });
}

// Esegue un singolo step di azione di un flow.
async function runStep(page, step) {
  const to = step.timeoutMs || 8000;
  // 'goto' accetta anche un URL assoluto: serve per i link che non stanno sotto --base (es. un link
  // ricevuto per email, un IdP su un'altra origine). Un path resta relativo a --base come sempre.
  if (step.goto) await page.goto(absUrl(step.goto), { waitUntil: 'domcontentloaded' });
  else if (step.fill) await fieldLocator(page, step.fill, 'fill').fill(step.fill.env ? envValue(step.fill.env) : step.fill.value, { timeout: to });
  else if (step.upload) await page.setInputFiles(step.upload.selector, risolviFileUpload(step.upload), { timeout: to });
  else if (step.select) await selectOption(page, step.select, to);
  else if (step.clickText) await page.getByText(step.clickText, { exact: !!step.exact }).first().click({ timeout: to });
  else if (step.click) await page.click(step.click, { timeout: to });
  /* Messaggio alla finestra della pagina, come lo invierebbe la shell che ospita l'app in un
     iframe. Un'app incorporata (es. le app GovDesk dentro GovHub) puo' ricevere dalla shell
     dati di contesto, come l'organizzazione scelta, che fuori dall'iframe non arrivano mai:
     scansionata sulla sua porta resterebbe ferma sullo stato "in attesa". Funziona con le app
     che non verificano la provenienza del messaggio. */
  else if (step.postMessage !== undefined) await page.evaluate(m => window.postMessage(m, '*'), step.postMessage);
  /* Tastiera e storia di navigazione. 'focus' + 'press' riproducono l'uso da tastiera di un comando
     (un menu che si apre con Invio e si chiude con Esc) per poi analizzare lo stato che ne risulta.
     'clearCookies' + 'back' + 'reload' portano l'applicazione negli stati di sessione scaduta o
     persa, che hanno pagine proprie e non si raggiungono con un URL. */
  else if (step.focus) await page.focus(step.focus, { timeout: to });
  else if (step.press) await page.keyboard.press(step.press);
  else if (step.clearCookies) await page.context().clearCookies();
  else if (step.back) await page.goBack({ waitUntil: 'domcontentloaded' });
  else if (step.reload) await page.reload({ waitUntil: 'domcontentloaded' });
  else if (step.script) throw new Error("passo 'script' ammesso solo nei flow");
  await applyWait(page, step);
}

/* Passo 'script': esegue una funzione JavaScript dichiarata accanto al config, per le viste che
   nessun passo dichiarativo raggiunge (un'email da leggere, un codice TOTP da calcolare, un
   autenticatore WebAuthn virtuale, una chiamata alle API di amministrazione). La logica specifica
   di un'applicazione resta nella cartella del suo target, e lo strumento non ne sa nulla.
   Forma: "file.mjs#funzione" (senza '#' si usa l'export default). Il file si risolve sulla
   directory del config e deve stare al suo interno: il config e' versionato insieme agli script
   che richiama, e un percorso che ne esce verrebbe da altrove. */
const SCRIPT_CACHE = new Map();

async function caricaScript(spec) {
  const [file, nome = 'default'] = String(spec).split('#');
  const radice = dirname(CONFIG);
  const percorso = resolve(radice, file);
  if (isAbsolute(file) || !percorso.startsWith(radice + sep)) throw new Error(`script '${file}' fuori dalla directory del config (${radice})`);
  if (!existsSync(percorso)) throw new Error(`script non trovato: ${percorso}`);
  if (!SCRIPT_CACHE.has(percorso)) SCRIPT_CACHE.set(percorso, await import(pathToFileURL(percorso).href));
  const fn = SCRIPT_CACHE.get(percorso)[nome];
  if (typeof fn !== 'function') throw new Error(`script '${file}': nessuna funzione esportata '${nome}'`);
  return fn;
}

// Esegue i flows di navigazione scriptata (raggiungono viste non GET-navigabili).
// Ogni flow gira in un contesto/login PULITI: le app JSF conservano lo stato di vista in
// sessione, quindi riusare la sessione del BFS falserebbe i flow (es. "Cerca" -> "Nuova Ricerca").
/* Perimetro NON coperto: flow saltati o interrotti, pagine in errore o rimbalzate su una vista gia'
   analizzata, login non confermato. Finiva solo nel log della console, che non accompagna il
   report: chi lo leggeva non poteva sapere che una vista prevista dal config non era stata
   analizzata, e gli zeri del report sembravano valere anche per lei. */
const PERIMETRO = [];
function annotaPerimetro(target, tipo, nome, esito, motivo) {
  PERIMETRO.push({ target: target.name || target.key, tipo, nome, esito, motivo: maskSecrets(String(motivo || '')) });
}

/* Motore delle varianti di un form, comune a 'scanCharts' e 'scanFormVariants'. I campi si
   scoprono a runtime (etichetta, valore corrente, obbligatorieta'); nessun selettore
   dell'applicazione in prova risiede qui: 'campo' (il blocco 'field' del target) dice come si
   riconosce un campo e come se ne aprono le opzioni, e nei modelli 'toggle' e 'list' il segnaposto
   '#{base}' e' la radice dell'id del campo.
   Gli assi si dichiarano in 'productAxes' (incrociati fra loro) e 'linearAxes' (variati uno alla
   volta, gli altri al valore predefinito). Un asse e' un pattern confrontato con etichetta e valore
   del campo, oppure il token 'required' che designa ogni campo obbligatorio. L'opzione 'non
   selezionato' di un campo obbligatorio (tipicamente '--') viene mantenuta, perche' genera la
   pagina d'errore, che e' a sua volta una vista da verificare, ma non viene incrociata con gli
   altri assi, che produrrebbero pagine d'errore identiche. */
const NON_SELEZIONATO = /^\s*-+\s*$/;
function motoreVarianti(page, campo, { to = 8000, skipRe = null, optSel = null } = {}) {
  const opzione = optSel || campo.option;
  /* La radice dell'id va codificata per CSS: gli id generati (es. JSF 'form:campo') contengono
     caratteri come ':' che in un selettore '#…' hanno un altro significato. */
  const cssId = (v) => { const e = String(v).replace(/[^A-Za-z0-9_\-\u00A0-\uFFFF]/g, ch => `\\${ch}`); return /^\d/.test(e) ? `\\3${e[0]} ${e.slice(1)}` : e; };
  const conBase = (modello, base) => String(modello).split('#{base}').join(cssId(base));
  /* Campi visibili del form, con quanto serve a riconoscerli. */
  const campiForm = () => page.$$eval(campo.selector, (els, c) => els.map(i => {
    const gruppo = c.group ? i.closest(c.group) : null;
    const etichetta = gruppo && c.label && gruppo.querySelector(c.label) ? gruppo.querySelector(c.label).textContent : '';
    return {
      base: i.id.replace(new RegExp(c.idSuffix + '$'), ''),
      label: (etichetta || '').trim().replace(/\s+/g, ' '),
      value: i.value || '',
      required: !!(gruppo && c.requiredMarker && gruppo.querySelector(c.requiredMarker)),
      visible: i.offsetParent !== null
    };
  }).filter(f => f.visible), { group: campo.group || null, label: campo.label || 'label', idSuffix: campo.idSuffix, requiredMarker: campo.requiredMarker || null }).catch(() => []);
  const combaciaAsse = (c, asse) =>
    asse === 'required' ? c.required : new RegExp(asse, 'i').test(`${c.label} ${c.value}`);
  const opzioniDi = async (base) => {
    await page.click(conBase(campo.toggle, base)).catch(() => {});
    await page.waitForTimeout(300);
    let opts = await page.$$eval(`${conBase(campo.list, base)} ${opzione}`, els => els.map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(120);
    if (skipRe) opts = opts.filter(o => !skipRe.test(o));
    return opts;
  };
  const scegli = async (base, valore) => {
    await page.click(conBase(campo.toggle, base), { timeout: to });
    await page.waitForTimeout(250);
    await page.locator(`${conBase(campo.list, base)} ${opzione}`).filter({ hasText: valore }).first().click({ timeout: to });
    await page.waitForTimeout(400);
  };
  /* Riempie con la prima opzione utile i campi obbligatori comparsi dopo una scelta. */
  const completaObbligatoriNuovi = async (giaVisti) => {
    const campi = await campiForm();
    for (const c of campi) {
      if (!c.required || giaVisti.has(c.base)) continue;
      const opts = (await opzioniDi(c.base)).filter(o => !NON_SELEZIONATO.test(o));
      if (!opts.length) continue;
      await scegli(c.base, opts[0]).catch(() => {});
      giaVisti.add(c.base);
    }
  };
  /* Assi presenti nel form corrente: un campo con una sola opzione non e' un asse. */
  const scopriAssi = async (productAxes, linearAxes) => {
    const campi = await campiForm();
    const usati = new Set(), assiP = [], assiL = [];
    for (const [assi, dest] of [[productAxes, assiP], [linearAxes, assiL]]) {
      for (const asse of assi) {
        for (const c of campi) {
          if (usati.has(c.base) || !combaciaAsse(c, asse)) continue;
          const opts = await opzioniDi(c.base);
          if (opts.length > 1) { dest.push({ base: c.base, label: c.label, opts }); usati.add(c.base); }
        }
      }
    }
    return { assiP, assiL };
  };
  /* Combinazioni: prodotto degli assi incrociati; una combinazione che sceglie 'non selezionato'
     su un campo obbligatorio si ferma li'. Gli assi lineari aggiungono le sole opzioni oltre la
     prima, con gli altri campi al valore predefinito. */
  const combinazioni = (assiP, assiL) => {
    let combs = [[]];
    for (const asse of assiP) {
      const prossime = [];
      for (const parziale of combs) {
        if (parziale.some(sc => NON_SELEZIONATO.test(sc.valore))) { prossime.push(parziale); continue; }
        for (const o of asse.opts) prossime.push(parziale.concat([{ base: asse.base, valore: o }]));
      }
      combs = prossime;
    }
    const viste = new Set();
    combs = combs.filter(c => { const k = c.map(x => x.base + '=' + x.valore).join('|'); if (viste.has(k)) return false; viste.add(k); return true; });
    for (const asse of assiL) {
      for (const o of asse.opts.slice(1)) combs.push([{ base: asse.base, valore: o }]);
    }
    return combs.length ? combs : [[]];
  };
  /* Applica una combinazione al form corrente, riempiendo gli obbligatori che compaiono. */
  const applica = async (comb) => {
    const giaVisti = new Set(comb.map(c => c.base));
    for (const sc of comb) {
      await scegli(sc.base, sc.valore);
      await completaObbligatoriNuovi(giaVisti);
    }
  };
  return { campiForm, opzioniDi, scegli, scopriAssi, combinazioni, applica };
}

async function runFlows(browser, target, pageResults) {
  for (const flow of target.flows) {
    LH_ESCLUSO_NEL_FLOW = flow.lighthouse === false;
    if (LH_ESCLUSO_NEL_FLOW && DO_LH) console.log(`    flow '${flow.name}': Lighthouse escluso dal config del flow`);
    console.log(`  flow: ${flow.name}`);
    // Variabili d'ambiente richieste dai passi (fill.env / select.env): se ne manca una il flow non
    // puo' compilare il suo modulo, e lo si salta prima ancora di autenticarsi.
    const envMancanti = missingEnv(flowEnvRefs(flow));
    if (envMancanti.length) {
      console.warn(`    flow '${flow.name}' saltato: variabili d'ambiente mancanti ${envMancanti.join(', ')}`);
      annotaPerimetro(target, 'flow', flow.name, 'saltato', `variabili d'ambiente non impostate: ${envMancanti.join(', ')}`);
      continue;
    }
    // Contesti aperti dal flow: quello principale e quelli chiesti dagli script (newPage), chiusi
    // tutti a fine flow. Stesse opzioni e stessa strumentazione solo-mouse per tutti.
    const contesti = [];
    const nuovaPagina = async () => {
      const c = await browser.newContext({ ignoreHTTPSErrors: INSECURE, extraHTTPHeaders: target.extraHTTPHeaders || undefined, viewport: target.viewport || undefined, locale: LOCALE || undefined });
      if (DO_MOUSE_ONLY) await c.addInitScript(INIT_SOLO_MOUSE);   // annota i gestori del clic: va installato prima degli script di pagina
      await c.addInitScript(INIT_PAUSA_IO);   // vedi rimisuraContrastiFuoriVista
      c.setDefaultNavigationTimeout(90000);   // backend lenti: il default di 30 s fa fallire i flussi
      contesti.push(c);
      return c.newPage();
    };
    const page = await nuovaPagina();
    try {
      await login(page, target);
      await postLogin(page, target);
      // Coerente con la navigazione delle pages: onora navWait/navDelayMs del target (le SPA con
      // HMR non raggiungono 'networkidle' e le liste async non sono pronte al momento di skipIfMissing).
      await page.goto(absUrl(flow.start), { waitUntil: target.navWait || 'networkidle' });
      if (target.navDelayMs) await page.waitForTimeout(target.navDelayMs);
      // skipIfMissing: se un elemento-sentinella non c'e' (es. lista vuota), salta il flow. Attende
      // (non controllo istantaneo): le liste async possono comparire dopo navDelayMs; l'assenza va
      // confermata solo dopo un timeout ragionevole.
      if (flow.skipIfMissing && !(await page.waitForSelector(flow.skipIfMissing, { timeout: flow.skipIfMissingTimeoutMs || 8000 }).catch(() => null))) {
        console.warn(`    flow '${flow.name}' saltato: sentinella '${flow.skipIfMissing}' assente (dati mancanti?)`);
        annotaPerimetro(target, 'flow', flow.name, 'saltato', `elemento '${flow.skipIfMissing}' assente in ${flow.start}: dati mancanti o pagina diversa da quella attesa`);
        continue;
      }
      let aborted = false, scanned = false;
      for (const step of (flow.steps || [])) {
        // Step 'scan': scansiona lo stato CORRENTE (permette piu' scan in un flow, es. i tab di un dettaglio).
        if (step.scan !== undefined) {
          const name = step.scan ? `flow:${flow.name}/${step.scan}` : `flow:${flow.name}`;
          /* 'lighthouse': false sul passo esclude da Lighthouse questa sola vista, per esempio quando il
             suo URL ha cambiato lo stato (Lighthouse lo ricaricherebbe ripetendo l'azione). Il motivo
             e' 'lighthouseNote', se c'e'. */
          const senzaLighthouse = step.lighthouse === false ? (step.lighthouseNote || "escluso dal passo ('lighthouse': false)") : undefined;
          await recordScan(browser, page, target, name, pageResults, step.sourceHint || flow.sourceHint, { keyboard: step.keyboard, include: step.include, senzaLighthouse });
          scanned = true;
          continue;
        }
        /* Step 'scanCharts': enumera DINAMICAMENTE le icone-report di una griglia (es. Analisi
           Statistica) e per ognuna genera+scansiona il report. Le varianti del form non sono cablate:
           i campi si scoprono a runtime leggendo etichetta, valore corrente e obbligatorieta' (il
           marcatore '*' nell'etichetta). Gli assi di iterazione si dichiarano in 'productAxes' (incrociati
           fra loro) e 'linearAxes' (variati uno alla volta, gli altri al valore predefinito): incrociare
           un asse che cambia solo i dati rappresentati moltiplica il tempo senza produrre strutture nuove.
           Un asse e' un pattern confrontato con etichetta e valore del campo, oppure il token 'required'
           che designa ogni campo obbligatorio. Dopo ogni selezione i campi vengono ri-scoperti, perche'
           una scelta puo' farne comparire di nuovi (es. 'Informazione 3D' dopo '3-dimensioni
           personalizzato'): i nuovi obbligatori vengono riempiti con la loro prima opzione utile.
           L'opzione 'non selezionato' di un campo obbligatorio (tipicamente '--') viene mantenuta, perche'
           genera la pagina d'errore, che e' a sua volta una vista da verificare; non viene pero' incrociata
           con gli altri assi, che produrrebbero pagine d'errore identiche. */
        if (step.scanCharts !== undefined) {
          const cfg = step.scanCharts || {};
          const grid = BASE + (cfg.grid || flow.start);
          const to = step.timeoutMs || 8000;
          const maxViews = cfg.maxViews || 400;

          /* Nessun selettore dell'applicazione in prova risiede qui: sono tutti dichiarati nel
             target, perche' dipendono dalla libreria di componenti usata (una comboBox RichFaces,
             una select nativa, un widget proprietario) e non da questo strumento. Il campo 'field'
             descrive come si riconosce un campo del form e come se ne aprono le opzioni; nei
             modelli 'toggle' e 'list' il segnaposto '#{base}' e' la radice dell'id del campo. */
          const iconSel = cfg.icon;
          const genSel = cfg.generate;
          const labelSel = cfg.label || 'span';
          const campo = cfg.field || {};
          const optSel = campo.option || cfg.dimensionOption;   // 'dimensionOption': nome precedente
          // assi: retrocompatibilita' con dimensionField/dimensionSkip (un solo asse incrociato)
          const productAxes = cfg.productAxes || (cfg.dimensionField ? [cfg.dimensionField] : []);
          const linearAxes = cfg.linearAxes || [];
          const skipRe = cfg.dimensionSkip ? new RegExp(cfg.dimensionSkip, 'i') : null;
          /* Senza assi da iterare non c'e' nulla da scoprire nel form: il passo apre ogni report
             e lo scansiona, e il blocco 'field' non serve. */
          const conAssi = productAxes.length > 0 || linearAxes.length > 0;

          const mancanti = [];
          if (!iconSel) mancanti.push('icon');
          if (!genSel) mancanti.push('generate');
          if (conAssi) {
            if (!campo.selector) mancanti.push('field.selector');
            if (!campo.idSuffix) mancanti.push('field.idSuffix');
            if (!campo.toggle) mancanti.push('field.toggle');
            if (!campo.list) mancanti.push('field.list');
            if (!optSel) mancanti.push('field.option');
          }
          if (mancanti.length) {
            console.warn(`    scanCharts: configurazione incompleta, manca ${mancanti.join(', ')} — passo saltato`);
            continue;
          }
          const motore = motoreVarianti(page, campo, { to, skipRe, optSel });

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
          console.log(`    scanCharts: ${items.length} report${cfg.limit ? ` (limitati a ${limit})` : ''}, assi incrociati [${productAxes.join(', ')}], assi lineari [${linearAxes.join(', ') || '-'}]`);

          let viste = 0;
          for (let ci = 0; ci < limit && viste < maxViews; ci++) {
            const baseLabel = `${slug(items[ci].section)}-${slug(items[ci].type)}` || `chart${ci + 1}`;
            // scopre gli assi presenti su QUESTO report
            let assiP = [], assiL = [];
            try {
              await openChart(ci);
              if (conAssi) ({ assiP, assiL } = await motore.scopriAssi(productAxes, linearAxes));
            } catch (e) { console.warn(`    report '${baseLabel}' non aperto: ${e.message}`); continue; }
            const combinazioni = motore.combinazioni(assiP, assiL);

            for (const comb of combinazioni) {
              if (viste >= maxViews) { console.warn(`    scanCharts: raggiunto maxViews=${maxViews}, viste successive non scansionate`); break; }
              const label = comb.length ? `${baseLabel}/${comb.map(c => slug(c.valore) || 'non-selezionato').join('_')}` : baseLabel;
              try {
                if (comb.length) {
                  await openChart(ci);   // stato fresco
                  await motore.applica(comb);   // riempie anche gli obbligatori nuovi, es. 'Informazione 3D'
                }
                await page.click(genSel);
                await applyWait(page, step);
              } catch (e) { console.warn(`    report '${label}' non generato: ${e.message}`); continue; }
              await recordScan(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
              scanned = true;
              viste++;
            }
          }
          continue;
        }
        /* Step 'scanFormVariants': varia i campi del form della vista CORRENTE e scansiona ogni
           combinazione. E' il motore delle varianti di 'scanCharts' senza la griglia dei report:
           serve alle viste che si ridisegnano a ogni scelta (es. un cruscotto con periodo, profilo e
           tipo) o che si generano con un comando ('submit'). Per ogni combinazione la vista viene
           riaperta dall'URL in cui il passo e' cominciato, cosi' ogni scelta parte dallo stato
           predefinito. Come per 'scanCharts', i campi e gli assi si dichiarano nel target. */
        if (step.scanFormVariants !== undefined) {
          const cfg = step.scanFormVariants || {};
          const to = step.timeoutMs || 8000;
          const maxViews = cfg.maxViews || 400;
          const campo = cfg.field || {};
          const productAxes = cfg.productAxes || [];
          const linearAxes = cfg.linearAxes || [];
          const mancanti = [];
          if (!productAxes.length && !linearAxes.length) mancanti.push('productAxes o linearAxes');
          for (const k of ['selector', 'idSuffix', 'toggle', 'list', 'option']) if (!campo[k]) mancanti.push('field.' + k);
          if (mancanti.length) {
            console.warn(`    scanFormVariants: configurazione incompleta, manca ${mancanti.join(', ')} — passo saltato`);
            continue;
          }
          const origine = page.url();
          const prefisso = cfg.name ? `${slug(cfg.name)}/` : '';
          const motore = motoreVarianti(page, campo, { to, skipRe: cfg.skip ? new RegExp(cfg.skip, 'i') : null });
          /* 'fixed': campi da portare a un valore fisso prima di ogni combinazione, ad esempio un
             periodo abbastanza ampio perche' i risultati non siano vuoti. Chiave = pattern su
             etichetta e valore del campo (come gli assi), valore = testo dell'opzione. */
          const fissi = Object.entries(cfg.fixed || {});
          const applicaFissi = async () => {
            if (!fissi.length) return;
            const campi = await motore.campiForm();
            for (const [pattern, valore] of fissi) {
              const c = campi.find(x => new RegExp(pattern, 'i').test(`${x.label} ${x.value}`));
              if (!c) { console.warn(`    scanFormVariants: nessun campo per il valore fisso '${pattern}'`); continue; }
              if (c.value !== valore) await motore.scegli(c.base, valore);
            }
          };
          /* 'reveal': comando che rende visibili i campi quando, riaperta la vista, sono nascosti (es. un
             riquadro dei filtri che l'applicazione ricorda chiuso dopo una ricerca). Si preme solo se
             nessun campo visibile corrisponde agli assi. */
          const assiDichiarati = productAxes.concat(linearAxes).filter(a => a !== 'required');
          const mostraCampi = async () => {
            if (!cfg.reveal) return;
            const campi = await motore.campiForm();
            if (campi.some(c => assiDichiarati.some(a => new RegExp(a, 'i').test(`${c.label} ${c.value}`)))) return;
            await page.click(cfg.reveal, { timeout: to });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForTimeout(400);
          };
          const riapri = async () => {
            await page.goto(origine, { waitUntil: 'networkidle' });
            if (cfg.ready) await page.waitForSelector(cfg.ready, { timeout: to });
            await mostraCampi();
            await applicaFissi();
          };
          let assiP = [], assiL = [];
          try { await mostraCampi(); await applicaFissi(); ({ assiP, assiL } = await motore.scopriAssi(productAxes, linearAxes)); }
          catch (e) { console.warn(`    scanFormVariants: campi non leggibili: ${e.message}`); continue; }
          if (!assiP.length && !assiL.length) { console.warn(`    scanFormVariants: nessun campo corrisponde agli assi [${productAxes.concat(linearAxes).join(', ')}]`); continue; }
          const combinazioni = motore.combinazioni(assiP, assiL);
          console.log(`    scanFormVariants: ${combinazioni.length} combinazioni, assi incrociati [${assiP.map(a => `${a.label} (${a.opts.length})`).join(', ')}], assi lineari [${assiL.map(a => `${a.label} (${a.opts.length})`).join(', ') || '-'}]`);
          let viste = 0;
          for (const comb of combinazioni) {
            if (viste >= maxViews) { console.warn(`    scanFormVariants: raggiunto maxViews=${maxViews}, viste successive non scansionate`); break; }
            const label = prefisso + (comb.length ? comb.map(c => slug(c.valore) || 'non-selezionato').join('_') : 'predefinito');
            try {
              await riapri();   // stato fresco
              await motore.applica(comb);
              if (cfg.submit) await page.click(cfg.submit, { timeout: to });
              await applyWait(page, step);
            } catch (e) { console.warn(`    variante '${label}' non applicata: ${e.message}`); continue; }
            await recordScan(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
            scanned = true;
            viste++;
          }
          continue;
        }
        // Step 'scanTabs': scopre DINAMICAMENTE i tab presenti, clicca ognuno e lo scansiona.
        // Robusto ai record con tab diversi/nuovi. Il selettore dipende dalla libreria di
        // componenti dell'applicazione e va quindi dichiarato nel target.
        if (step.scanTabs !== undefined) {
          const sel = typeof step.scanTabs === 'string' ? step.scanTabs.trim() : '';
          if (!sel) { console.warn('    scanTabs: manca il selettore dei tab — passo saltato'); continue; }
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
        // Step 'scanOptions': scopre DINAMICAMENTE le opzioni di un <select> nativo, le sceglie una
        // alla volta e scansiona lo stato che ognuna produce (campi che compaiono o cambiano). Le
        // opzioni non sono cablate: dipendono spesso dalla configurazione dell'applicazione.
        // Config: stringa (selettore) | oggetto {selector, name, skip}. 'name' antepone un prefisso
        // al nome delle viste (utile con piu' select nello stesso flow), 'skip' e' una regex sul
        // testo delle opzioni da non scegliere (es. il segnaposto '--'). Un'opzione che non si
        // riesce a scegliere — ad esempio perche' la scelta precedente ha tolto il select — viene
        // saltata con un avviso.
        if (step.scanOptions !== undefined) {
          const cfg = typeof step.scanOptions === 'string' ? { selector: step.scanOptions } : (step.scanOptions || {});
          const sel = String(cfg.selector || '').trim();
          if (!sel) { console.warn('    scanOptions: manca il selettore del select — passo saltato'); continue; }
          const scarta = cfg.skip ? new RegExp(cfg.skip, 'i') : null;
          const opzioni = await page.$$eval(`${sel} option`, os => os.filter(o => !o.disabled)
            .map(o => ({ value: o.value, label: (o.textContent || '').trim().replace(/\s+/g, ' ') }))).catch(() => []);
          if (!opzioni.length) { console.warn(`    scanOptions: nessuna opzione trovata in '${sel}'`); continue; }
          console.log(`    scanOptions: ${opzioni.length} opzioni scoperte (${sel})`);
          const prefisso = cfg.name ? `${slug(cfg.name)}-` : '';
          for (let oi = 0; oi < opzioni.length; oi++) {
            const o = opzioni[oi];
            if (scarta && scarta.test(o.label)) continue;
            try {
              await page.selectOption(sel, { value: o.value }, { timeout: step.timeoutMs || 8000 });
              await applyWait(page, step);
            } catch (e) { console.warn(`    opzione '${o.label}' non selezionabile: ${e.message}`); continue; }
            await recordScan(browser, page, target, `flow:${flow.name}/${prefisso}${slug(o.label) || `opzione${oi + 1}`}`, pageResults, step.sourceHint || flow.sourceHint);
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
              : [raw]);
          const start = flow.start ? BASE + flow.start : loginUrl(target);
          const to = step.timeoutMs || 8000;
          for (const m of menus) {
            const menuSel = m.item || m.menuItem;
            if (!menuSel) { console.warn(`    scanMenu: manca 'item' (selettore delle voci del menu): voce del flow saltata`); continue; }
            const openSel = m.open || null;              // dropdown: selettore da cliccare per aprire
            const rowSel = m.listRow || null;            // opzionale: primo elemento di lista -> dettaglio
            const editSel = m.detailEdit || null;        // opzionale: dal dettaglio, segue le "matite" (edit-link) di ogni sezione
            const dmenu = m.detailMenu || null;          // opzionale: dropdown sul dettaglio (3-puntini): {open, item} -> segue ogni azione
            const cfgBtn = m.detailConfig || null;       // opzionale: bottone CONFIGURA -> entra nel wizard e scansiona la pagina d'ingresso (NON avanza tra gli step, per non salvare)
            const rec = m.recurse || null;               // opzionale: dal dettaglio, esplora RICORSIVAMENTE i link navigazionali (matite, count-link...). {depth, max, skip, tabs, fromItem}
            // opzioni comuni della ricorsione; 'partenza' e' l'URL da cui parte (non viene rivisitato)
            const opzioniRicorsione = partenza => ({
              ctxPath: defaultCtxPath(target),
              skipRe: new RegExp(rec.skip || 'logout|signout|esci|elimina|delete|remove|rimuovi|reset|export|download|salva|annulla', 'i'),
              mutatingRe: rec.mutating ? new RegExp(rec.mutating, 'i') : null,
              excludeLinks: rec.excludeLinks || null,
              tabsSel: rec.tabs === false ? null : (typeof rec.tabs === 'string' ? rec.tabs : '.ui-tabs-nav a'),
              visited: new Set([normVisit(partenza)]),
              state: { count: 0 },
              max: rec.max || 300,
              sourceHint: step.sourceHint || flow.sourceHint,
            });
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
              let conRighe = false;
              if (rowSel) {   // opzionale: entra nel dettaglio del primo elemento della lista
                const row = await page.$(rowSel);
                if (row) {
                  conRighe = true;
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
                    recOpts = opzioniRicorsione(detailUrl);
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
                          /* recurse.configMax: limite proprio per la ricorsione da CONFIGURA. Senza, il limite e'
                             quello del dettaglio, e se la ricorsione dal dettaglio lo esaurisce (per esempio
                             seguendo i collegamenti verso altre voci) la pagina di configurazione resta inesplorata.
                             Il dedup resta condiviso: le pagine gia' viste dal dettaglio non si rivisitano. */
                          const opz = rec.configMax ? { ...recOpts, state: { count: 0 }, max: rec.configMax } : recOpts;
                          await recurseFollow(browser, page, target, pageResults, flow.name, opz, `${label}/dettaglio/configura`, rec.depth || 3);
                          console.log(`      ${label}/configura: ricorsione -> ${opz.state.count} pagine${rec.configMax ? ` (limite proprio ${rec.configMax})` : ' totali'}`);
                        }
                      }
                    } catch (e) { console.warn(`      configura di '${v.text}' non aperto: ${e.message}`); }
                  }
                }
              }
              // opzionale (recurse.fromItem): la voce non apre un elenco con righe (pagina di soli
              // collegamenti, form, elenco vuoto) -> la ricorsione parte dalla pagina della voce stessa
              if (!conRighe && rec && rec.fromItem) {
                const recOpts = opzioniRicorsione(page.url());
                await recurseFollow(browser, page, target, pageResults, flow.name, recOpts, label, rec.depth || 3);
                if (recOpts.state.count) console.log(`      ${label}: ricorsione dalla voce -> ${recOpts.state.count} pagine (depth<=${rec.depth || 3}, max ${recOpts.max})`);
              }
              /* pagine successive dell'elenco della voce (target.nextPage): la voce viene riaperta, perche'
                 dettaglio e ricorsione hanno lasciato la pagina altrove */
              if (conRighe && target.nextPage) {
                try {
                  await page.goto(start, { waitUntil: 'networkidle' });
                  if (openSel) { await page.click(openSel, { timeout: to }); await page.waitForTimeout(200); }
                  await page.locator(menuSel).nth(vi).click({ timeout: to });
                  await applyWait(page, step);
                  await scansionaPagineSuccessive(browser, page, target, `flow:${flow.name}/${label}`, pageResults, step.sourceHint || flow.sourceHint);
                } catch (e) { console.warn(`    pagine successive di '${v.text}' non raggiunte: ${e.message}`); }
              }
            }
          }
          continue;
        }
        const label = step.desc || step.script || step.click || step.clickText || step.goto || (step.fill && (step.fill.selector || step.fill.label)) || (step.upload && step.upload.selector) || (step.select && (step.select.selector || step.select.label)) || step.focus || step.press || 'step';
        try {
          if (step.script) {
            /* Lo script riceve la pagina del flow e puo' produrre piu' viste: 'scan(nome)' analizza lo
               stato corrente (o quello di un'altra pagina, { page }), con lo stesso nome 'flow:<flow>/<nome>'
               dei passi 'scan'. Con { problemi } aggiunge alla vista le verifiche fatte dallo script
               (vedi violazioniDaProblemi); con { keyboard: false } salta il percorso col Tab, che
               sposterebbe il focus da uno stato che lo script vuole ancora usare (un menu aperto).
               'newPage()' apre una sessione separata (un secondo utente, una nuova visita senza
               cookie), chiusa con il flow. */
            const fn = await caricaScript(step.script);
            await fn({
              page, browser, target, base: BASE, args: step.args || {},
              newPage: nuovaPagina,
              runStep: (s, p = page) => runStep(p, s),
              scan: async (nome, { page: p = page, sourceHint, problemi, keyboard, include } = {}) => {
                await recordScan(browser, p, target, nome ? `flow:${flow.name}/${nome}` : `flow:${flow.name}`, pageResults, sourceHint || step.sourceHint || flow.sourceHint, { problemi, keyboard, include });
                scanned = true;
              },
            });
            await applyWait(page, step);
          } else await runStep(page, step);
        } catch (e) {
          if (step.optional) { console.warn(`    step '${label}' non riuscito (opzionale, proseguo): ${maskSecrets(e.message)}`); continue; }
          console.warn(`    step '${label}' non riuscito: ${maskSecrets(e.message)} → flow '${flow.name}' interrotto`);
          annotaPerimetro(target, 'flow', flow.name, 'interrotto', `passo '${label}' non riuscito: ${e.message.split('\n')[0]}${scanned ? ' (le viste precedenti sono state analizzate)' : ''}`);
          aborted = true; break;
        }
      }
      // Se il flow non ha step 'scan' espliciti, scansiona lo stato finale (comportamento di default).
      if (!scanned && !aborted) {
        await recordScan(browser, page, target, `flow:${flow.name}`, pageResults, flow.sourceHint);
        // stato finale di un elenco paginato (es. i risultati di una ricerca): anche le pagine successive
        await scansionaPagineSuccessive(browser, page, target, `flow:${flow.name}`, pageResults, flow.sourceHint);
      }
    } catch (e) {
      console.warn(`  flow '${flow.name}' errore: ${maskSecrets(e.message)}`);
      annotaPerimetro(target, 'flow', flow.name, 'errore', e.message.split('\n')[0]);
    } finally {
      for (const c of contesti) await c.close().catch(() => {});
    }
  }
  LH_ESCLUSO_NEL_FLOW = false;
}

/* ----------------------------- scan ------------------------------------- */
async function scan() {
  const targets = loadTargets();
  if (!targets.length) { console.error('Nessun target abilitato.'); process.exit(2); }
  for (const t of targets) {
    const lb = resolveParam(CLI_LOGIN_BASE, t, 'loginBase', null);
    if (lb && !isAbsUrl(lb)) { console.error(`loginBase del target ${t.key} non è un URL http(s): ${lb}`); process.exit(2); }
  }
  // Un'intestazione con una variabile non impostata autenticherebbe come nessuno: meglio fermarsi.
  const senzaEnv = targets.filter(t => t.envMancanti);
  if (senzaEnv.length) {
    for (const t of senzaEnv) console.error(`❌ Target '${t.key}': extraHTTPHeaders usa variabili d'ambiente non impostate: ${t.envMancanti.join(', ')}`);
    process.exit(2);
  }
  PERIMETRO.length = 0;

  // Lighthouse può essere abilitato per-target: la porta di debug serve se ANCHE UN SOLO target lo usa.
  // '--no-lighthouse' vince anche qui: senza questa precedenza la sola soglia nel config lo terrebbe
  // acceso per il preflight e lo farebbe dichiarare come eseguito nel report.
  const anyLh = CLI_LH === false ? false : (MIN_SCORE !== null || featureRequested(CLI_LH, 'lighthouse', targets));
  const anySr = featureRequested(CLI_SR, 'screenReader', targets);
  const anyEa = CLI_EA === false ? false : featureRequested(CLI_EA, 'equalAccess', targets);
  // Prerequisiti PRIMA di aprire il browser: se una feature richiesta non e' installata si esce
  // subito con errore, invece di scansionare tutto e produrre punteggi/annunci vuoti.
  preflightOptionalDeps({ lighthouse: anyLh, screenReader: anySr, equalAccess: anyEa });

  mkdirSync(OUT, { recursive: true });   // solo dopo i controlli: niente directory report a vuoto
  if (anyLh) LH_PORT = await portaLibera();   // una porta per scansione: niente conflitti fra scansioni contemporanee
  const browser = await chromium.launch({
    args: [...(anyLh ? [`--remote-debugging-port=${LH_PORT}`] : []), ...(LOCALE_GLOBALE ? [`--lang=${LOCALE_GLOBALE}`] : [])],
  });

  const pageResults = [];   // { target, name, url, violations:[axe], lhScore }

  for (const target of targets) {
    applyTargetParams(target);   // risolve tags/crawl/lighthouse/screen-reader/... per QUESTO target
    console.log(`\n== ${target.name} (${loginUrl(target)})${LOCALE ? ` [lingua ${LOCALE}]` : ''} ==`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: INSECURE, extraHTTPHeaders: target.extraHTTPHeaders || undefined, viewport: target.viewport || undefined, locale: LOCALE || undefined });
    if (DO_MOUSE_ONLY) await ctx.addInitScript(INIT_SOLO_MOUSE);   // annota i gestori del clic: va installato prima degli script di pagina
    await ctx.addInitScript(INIT_PAUSA_IO);   // vedi rimisuraContrastiFuoriVista
    ctx.setDefaultNavigationTimeout(90000);   // backend lenti: il default di 30 s fa fallire i flussi
    const page = await ctx.newPage();

    const tLogin = performance.now();
    const logged = await login(page, target);
    await postLogin(page, target);
    TEMPI.login += performance.now() - tLogin;
    TEMPI.fineUltimaVista = performance.now();   // la navigazione verso la prima vista parte da qui
    if (!logged) {
      console.warn(`  ! login non confermato per ${target.name} come '${credsFor(target).user}' (url=${page.url()}). Proseguo comunque.`);
      annotaPerimetro(target, 'login', target.loginPath || '/', 'non confermato', `dopo il login l'indirizzo è ${page.url()}: le viste seguenti potrebbero essere quelle di un utente non autenticato`);
    } else if (target.login) {
      console.log(`  login ok (utenza '${credsFor(target).user}')`);
    } else {
      console.log('  nessun login a form (pagine pubbliche, header o SSO)');
    }

    // Coda BFS: pagine in config (depth 0, sempre scansionate) + crawl opzionale.
    const ctxPath = defaultCtxPath(target);
    const configPages = (target.pages || []).map(p => ({ path: p.path, name: p.name, depth: 0 }));
    const queue = [...configPages];
    if (CRAWL > 0 && queue.length === 0) queue.push({ path: loginAltrove(target) ? '/' : target.loginPath, name: 'landing', depth: 0 });
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
          if (item.depth === 0) annotaPerimetro(target, 'pagina', item.name, 'non analizzata', `${item.path} rimanda a ${finalUrl.replace(BASE, '')}, già analizzata`);
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
        // elenchi paginati: anche le pagine successive (target.nextPage), dopo aver raccolto i link
        await scansionaPagineSuccessive(browser, page, target, item.name, pageResults);
      } catch (e) {
        console.warn(`  [${item.name}] errore su ${url}: ${e.message}`);
        if (item.depth === 0) annotaPerimetro(target, 'pagina', item.name, 'errore', `${item.path}: ${e.message.split('\n')[0]}`);
      }
    }
    if (CRAWL > 0) console.log(`  crawl: ${crawlCount} pagine scoperte (depth<=${CRAWL_DEPTH}), ${visited.size} pagine scansionate in totale`);

    // Flows: navigazione scriptata per raggiungere le pagine di DETTAGLIO (JSF postback).
    if (!NO_FLOWS && (target.flows || []).length) await runFlows(browser, target, pageResults);

    await ctx.close();
  }

  await browser.close();
  // Lighthouse attivo ma sempre in errore: e' un problema di ESECUZIONE (porta CDP, timeout, URL
  // non raggiungibile), non di installazione. Va detto una volta, in chiaro, a fine run.
  if (anyLh && _lhFail && !_lhOk) {
    console.warn(`\n\u26a0 [lighthouse] modulo installato ma nessun punteggio calcolato su ${_lhFail} viste.`);
    console.warn(`  Primo errore: ${_lhFirstErr}`);
  } else if (anyLh && _lhFail) {
    console.warn(`\n\u26a0 [lighthouse] punteggi calcolati: ${_lhOk}, falliti: ${_lhFail} (primo errore: ${_lhFirstErr})`);
  }
  // Per la reportistica complessiva: un livello risulta attivo se lo è stato per almeno un target.
  DO_SR = anySr;
  DO_LH = anyLh;
  DO_EA = anyEa;
  DO_MOUSE_ONLY = targets.some(t => resolveParam(CLI_MOUSE_ONLY, t, 'mouseOnly', true) !== false);
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
  writeReport(resolve(OUT, 'axe-results.json'), JSON.stringify(slim, null, 2));
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
    writeReport(resolve(dir, file), header + pr.ariaSnapshot + '\n');
    files[i] = `aria-tree/${file}`;
  });
  return files;
}

// I report leggono l'esito dei controlli calcolato una volta (summary) o, in uso programmatico, lo ricalcolano.
function esitoControlli(results, summary) {
  return summary && summary.controlli ? { controlli: summary.controlli, gate: summary.gate } : valutaControlli(results);
}

/* Evidenze dei controlli fuori da axe, per vista: una voce per elemento o per vista, con il livello
   che il controllo ha nel gate. Le usano SARIF e Sonar. */
const REGOLE_GOVA11Y = {
  'gova11y-nameless': { titolo: 'Elemento interattivo senza nome accessibile (albero di accessibilità)', criterio: '4.1.2' },
  'gova11y-mouse-only': { titolo: 'Comando utilizzabile col solo mouse (non raggiungibile da tastiera)', criterio: '2.1.1' },
  'gova11y-sr-role-only': { titolo: 'Annuncio del virtual screen reader col solo ruolo', criterio: '4.1.2' },
  'gova11y-lighthouse-score': { titolo: 'Punteggio Lighthouse accessibilità sotto la soglia', criterio: null },
  'gova11y-lighthouse-missing': { titolo: 'Vista senza punteggio Lighthouse: soglia non verificabile', criterio: null },
  'gova11y-empty-view': { titolo: 'Vista vuota: pagina non renderizzata, esito non valido', criterio: null },
  'gova11y-http-error': { titolo: 'Vista arrivata con errore HTTP (>= 400): esito non valido', criterio: null },
  'gova11y-check-not-run': { titolo: 'Controllo non eseguito sulla vista', criterio: null },
  'gova11y-perimeter': { titolo: 'Vista prevista dal config non analizzata', criterio: null },
  'gova11y-gate': { titolo: "Esito del gate di accessibilita'", criterio: null },
};
function evidenzeControlli(results, controlli) {
  const decide = id => !!(controlli.find(c => c.id === id) || {}).decide;
  const out = [];
  const push = (pr, ruleId, bloccante, messaggio, selettore, html) => out.push({ pr, ruleId, bloccante, messaggio, selettore: selettore || null, html: html || null });
  for (const pr of results) {
    for (const n of (pr.axTree ? pr.axTree.nameless : [])) push(pr, 'gova11y-nameless', decide('nameless'), `${n.role} senza nome accessibile — ${n.context || '(radice)'}`, null);
    for (const e of (pr.soloMouse ? pr.soloMouse.elementi : [])) {
      const segno = e.id ? `#${e.id}` : (e.classe ? `.${e.classe.split(' ').join('.')}` : '');
      push(pr, 'gova11y-mouse-only', decide('mouseOnly'), `comando col solo mouse: ${e.tag}${segno}${e.role ? ` role=${e.role}` : ''}${e.testo ? ` — ${e.testo}` : ''}`, `${e.tag}${segno}`);
    }
    if (pr.soloMouse && pr.soloMouse.totale > pr.soloMouse.elementi.length) push(pr, 'gova11y-mouse-only', decide('mouseOnly'), `e altri ${pr.soloMouse.totale - pr.soloMouse.elementi.length} comandi col solo mouse (elenco limitato da mouseOnlyMax)`, null);
    for (const f of (pr.sr ? pr.sr.roleOnly : [])) push(pr, 'gova11y-sr-role-only', decide('screenReader'), `annuncio col solo ruolo: "${f}"`, null);
    if (pr.lhScore != null && MIN_SCORE != null && pr.lhScore < MIN_SCORE) push(pr, 'gova11y-lighthouse-score', decide('lighthouse'), `Lighthouse ${(pr.lhScore * 100).toFixed(0)}% < soglia ${(MIN_SCORE * 100).toFixed(0)}%`, null);
    if (pr.lhScore == null && !pr.lhEscluso && (pr.lhMotivo || DO_LH)) push(pr, 'gova11y-lighthouse-missing', decide('lighthouse'), `senza punteggio Lighthouse${pr.lhMotivo ? `: ${pr.lhMotivo}` : ''}`, null);
    if (pr.vuota) push(pr, 'gova11y-empty-view', decide('emptyViews'), 'vista vuota: nessun contenuto accessibile (pagina non renderizzata?)', null);
    if (pr.erroreHttp) push(pr, 'gova11y-http-error', decide('httpErrors'), `vista arrivata con errore HTTP ${pr.httpStatus}: e' stata esaminata la risposta d'errore, non la pagina`, null);
    for (const c of (pr.controlliNonEseguiti || [])) push(pr, 'gova11y-check-not-run', CONTROLLI_DA_RIPETERE.has(c.controllo) && decide(c.controllo), `controllo ${c.controllo} non eseguito (esito non verificabile): ${c.errore}`, null);
  }
  return out;
}

function writeSarif(results, summary) {
  const { controlli, gate } = esitoControlli(results, summary);
  const levelOf = imp => (imp === 'critical' || imp === 'serious') ? 'error' : 'warning';
  const regolaSarif = v => ({ id: v.id, name: v.id, shortDescription: { text: v.help }, fullDescription: { text: v.description || v.help }, helpUri: v.helpUrl, properties: { tags: v.tags, impact: v.impact } });
  const risultatoNodo = (pr, v, node) => {
    const selector = (node.target || []).join(' ');
    return {
      ruleId: v.id, level: levelOf(v.impact),
      message: { text: `${v.help} — ${node.failureSummary || ''}`.trim() },
      locations: [{ physicalLocation: { artifactLocation: { uri: pr.url }, region: { startLine: 1 } }, logicalLocations: [{ fullyQualifiedName: selector, kind: 'element' }] }],
      properties: { impact: v.impact, page: pr.name, target: pr.targetName, selector, html: node.html },
    };
  };
  // run 1: axe-core, le sue regole
  const regoleAxe = new Map(), risAxe = [];
  // run 2: gov-a11y, i controlli fuori da axe, le evidenze degli altri livelli e l'esito del gate
  const regoleGov = new Map(), risGov = [];
  for (const pr of results) for (const v of pr.violations) {
    const gov = String(v.id).startsWith('gova11y-');
    const [regole, ris] = gov ? [regoleGov, risGov] : [regoleAxe, risAxe];
    if (!regole.has(v.id)) regole.set(v.id, regolaSarif(v));
    for (const node of v.nodes) ris.push(risultatoNodo(pr, v, node));
  }
  const regolaGovDa = id => { if (!regoleGov.has(id)) regoleGov.set(id, { id, name: id, shortDescription: { text: id } }); };
  const regolaGov = id => { if (!regoleGov.has(id)) regoleGov.set(id, { id, name: id, shortDescription: { text: REGOLE_GOVA11Y[id].titolo }, properties: REGOLE_GOVA11Y[id].criterio ? { tags: [`wcag${REGOLE_GOVA11Y[id].criterio.replace(/\./g, '')}`] } : {} }); };
  for (const e of evidenzeControlli(results, controlli)) {
    regolaGov(e.ruleId);
    risGov.push({
      ruleId: e.ruleId, level: e.bloccante ? 'error' : 'note', message: { text: e.messaggio },
      locations: [{ physicalLocation: { artifactLocation: { uri: e.pr.url }, region: { startLine: 1 } }, ...(e.selettore ? { logicalLocations: [{ fullyQualifiedName: e.selettore, kind: 'element' }] } : {}) }],
      properties: { page: e.pr.name, target: e.pr.targetName, bloccante: e.bloccante },
    });
  }
  for (const p of PERIMETRO) {
    regolaGov('gova11y-perimeter');
    risGov.push({ ruleId: 'gova11y-perimeter', level: 'note', message: { text: `${p.tipo} '${p.nome}' ${p.esito}: ${p.motivo}` }, properties: { target: p.target, nome: p.nome, esito: p.esito } });
  }
  /* L'esito del gate e' un risultato solo se fallisce: i lettori di SARIF (Jenkins Warnings, Code Scanning)
     contano ogni risultato come una segnalazione, anche con level 'none'. Superato, sta in invocations e
     properties del run, con la sintesi di tutti i controlli. */
  if (!gate.superato) {
    regolaGov('gova11y-gate');
    risGov.push({ ruleId: 'gova11y-gate', level: 'error', kind: 'fail',
      message: { text: `Gate di accessibilita' NON superato: ${gate.motivi.join('; ')}` }, properties: { superato: false, motivi: gate.motivi } });
  }
  /* Casi da verificare (non decidono): 'note'. Falsi positivi dichiarati: risultati soppressi, con la
     motivazione del registro; restano come evidenza ma i lettori di SARIF non li contano. */
  for (const pr of results) {
    for (const v of pr.incomplete || []) {
      const gov = String(v.id).startsWith('gova11y-');
      const [regole, ris] = gov ? [regoleGov, risGov] : [regoleAxe, risAxe];
      if (!regole.has(v.id)) regole.set(v.id, regolaSarif(v));
      for (const node of v.nodes) {
        const r = risultatoNodo(pr, v, node);
        r.level = 'note';
        r.message.text = `Da verificare: ${r.message.text}${node.contrasto && node.contrasto.esito ? ` — contrasto stimato: ${node.contrasto.esito}` : ''}`;
        r.properties.tipo = 'da verificare';
        ris.push(r);
      }
    }
    for (const fp of pr.falsePositives || []) {
      const voce = FALSE_POSITIVES_USATI.find(v => v.id === fp.id) || {};
      const ea = fp.engine === 'equalAccess';
      if (!ea && !regoleAxe.has(fp.rule)) regoleAxe.set(fp.rule, { id: fp.rule, name: fp.rule, shortDescription: { text: fp.rule } });
      if (ea) { regolaGovDa(fp.rule); }
      (ea ? risGov : risAxe).push({
        ruleId: fp.rule, level: 'note',
        message: { text: `Falso positivo dichiarato (${fp.id}): ${voce.reason || ''}`.trim() },
        locations: [{ physicalLocation: { artifactLocation: { uri: pr.url }, region: { startLine: 1 } }, logicalLocations: [{ fullyQualifiedName: [].concat(fp.target || []).join(' '), kind: 'element' }] }],
        suppressions: [{ kind: 'external', status: 'accepted', justification: `${fp.id}: ${voce.verification || voce.reason || ''}`.trim() }],
        properties: { page: pr.name, target: pr.targetName, motore: ea ? 'IBM Equal Access' : 'axe-core', tipo: fp.tipo, voce: fp.id, html: fp.html },
      });
    }
  }
  /* secondo motore: un run a parte. Se decide il gate (failOnEqualAccess) le violazioni sono 'error',
     come quelle che decidono negli altri run; altrimenti 'note', che i lettori di SARIF non contano. */
  const eaBloccante = !!(controlli.find(c => c.id === 'equalAccess') || {}).decide;
  const regoleEa = new Map(), risEa = [];
  for (const pr of results) for (const x of pr.equalAccess ? pr.equalAccess.violazioni : []) {
    if (!regoleEa.has(x.regola)) regoleEa.set(x.regola, { id: x.regola, name: x.regola, shortDescription: { text: x.messaggio }, properties: { tags: (x.wcag || []).map(c => `wcag${String(c).replace(/\./g, '')}`) } });
    risEa.push({ ruleId: x.regola, level: eaBloccante ? 'error' : 'note', message: { text: x.messaggio },
      locations: [{ physicalLocation: { artifactLocation: { uri: pr.url }, region: { startLine: 1 } }, ...(x.xpath ? { logicalLocations: [{ fullyQualifiedName: x.xpath, kind: 'element' }] } : {}) }],
      properties: { page: pr.name, target: pr.targetName, html: x.snippet, bloccante: eaBloccante } });
  }
  const controlliSintesi = controlli.map(({ viste, ...c }) => ({ ...c, viste: viste.length }));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: 'axe-core', informationUri: 'https://github.com/dequelabs/axe-core', rules: [...regoleAxe.values()] } }, results: risAxe },
      { tool: { driver: { name: 'gov-a11y', informationUri: 'https://www.w3.org/WAI/WCAG22/quickref/', rules: [...regoleGov.values()] } },
        invocations: [{ executionSuccessful: true, properties: { gate, failOn: FAIL_ON, failOnEqualAccess: FAIL_ON_EQUAL_ACCESS, minScore: MIN_SCORE } }],
        properties: { gate, controlli: controlliSintesi }, results: risGov },
      ...(risEa.length ? [{ tool: { driver: { name: 'IBM Equal Access', informationUri: 'https://github.com/IBMa/equal-access', rules: [...regoleEa.values()] } }, results: risEa }] : []),
    ],
  };
  writeReport(resolve(OUT, 'a11y.sarif'), JSON.stringify(sarif, null, 2));
}

function writeSonar(results, summary) {
  // Generic Issue Import Format. filePath deve esistere nel progetto analizzato:
  // usiamo sourceHint (template della console). La posizione precisa e' nel selettore/message.
  // Le voci senza un file (perimetro, esito del gate) non sono importabili: stanno in SARIF e JUnit.
  const { controlli } = esitoControlli(results, summary);
  const sonarSevOf = imp => ({ critical: 'BLOCKER', serious: 'CRITICAL', moderate: 'MAJOR', minor: 'MINOR' }[imp] || 'MINOR');
  const issues = [];
  for (const pr of results) {
    for (const v of pr.violations) {
      for (const node of v.nodes) {
        const selector = (node.target || []).join(' ');
        issues.push({
          engineId: String(v.id).startsWith('gova11y-') ? 'gov-a11y' : 'axe-core',
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
  for (const e of evidenzeControlli(results, controlli)) {
    issues.push({
      engineId: 'gov-a11y', ruleId: e.ruleId, severity: e.bloccante ? 'CRITICAL' : 'MINOR', type: 'CODE_SMELL',
      primaryLocation: { message: `[${e.pr.targetName}] ${e.messaggio} | pagina=${e.pr.url}${e.selettore ? ` | selettore=${e.selettore}` : ''}`, filePath: e.pr.sourceHint, textRange: { startLine: 1 } },
    });
  }
  // il secondo motore solo quando decide il gate: altrimenti le sue segnalazioni restano nel report e nel SARIF
  if ((controlli.find(c => c.id === 'equalAccess') || {}).decide) {
    for (const pr of results) for (const x of pr.equalAccess ? pr.equalAccess.violazioni : []) {
      issues.push({
        engineId: 'equal-access', ruleId: x.regola, severity: 'CRITICAL', type: 'CODE_SMELL',
        primaryLocation: { message: `[${pr.targetName}] ${x.messaggio} | pagina=${pr.url}${x.xpath ? ` | xpath=${x.xpath}` : ''}`, filePath: pr.sourceHint, textRange: { startLine: 1 } },
      });
    }
  }
  writeReport(resolve(OUT, 'sonar-issues.json'), JSON.stringify({ issues }, null, 2));
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
function writeJUnit(results, summary) {
  const { controlli, gate } = esitoControlli(results, summary);
  const decide = id => !!(controlli.find(c => c.id === id) || {}).decide;
  // una suite per le viste, una per i controlli (anche quelli superati: sono evidenza), una per il gate
  const viste = [];
  let fallite = 0;
  for (const pr of results) {
    const nome = `classname="a11y.${xmlEscape(pr.targetName)}" name="${xmlEscape(pr.name)} (${xmlEscape(pr.url)})"`;
    const blocking = pr.violations.filter(v => (SEVERITY_ORDER[v.impact] || 1) >= FAIL_THRESHOLD);
    const nodes = blocking.reduce((n, v) => n + v.nodes.length, 0);
    const motivi = [], dettagli = [], note = [];
    if (pr.vuota && FAIL_ON_EMPTY) {
      // una vista non renderizzata non e' superata: il suo "nessuna violazione" non dice nulla
      motivi.push('vista vuota: nessun contenuto accessibile (pagina non renderizzata?)');
      dettagli.push("L'albero di accessibilita' della vista e' vuoto: l'analisi non ha esaminato nulla.");
    }
    if (pr.erroreHttp) (FAIL_ON_HTTP_ERROR ? (motivi.push(`errore HTTP ${pr.httpStatus}`), dettagli) : note).push(`La vista e' arrivata con stato HTTP ${pr.httpStatus}: e' stata esaminata la risposta d'errore, non la pagina.`);
    if (blocking.length && FAIL_THRESHOLD > 0) {
      motivi.push(`${blocking.length} regole, ${nodes} occorrenze >= ${FAIL_ON}`);
      dettagli.push(...blocking.map(v => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help}`));
    }
    const nameless = pr.axTree ? pr.axTree.nameless.length : 0;
    if (nameless) (decide('nameless') ? (motivi.push(`${nameless} elementi senza nome accessibile`), dettagli) : note).push(`a11y-tree: ${nameless} elementi interattivi senza nome accessibile`);
    const mo = pr.soloMouse ? pr.soloMouse.totale : 0;
    if (mo) (decide('mouseOnly') ? (motivi.push(`${mo} comandi col solo mouse`), dettagli) : note).push(`solo mouse: ${mo} comandi non raggiungibili da tastiera`);
    const ea = pr.equalAccess ? pr.equalAccess.violazioni : [];
    if (ea.length) {
      const regole = [...new Set(ea.map(x => x.regola))];
      if (decide('equalAccess')) { motivi.push(`${ea.length} violazioni IBM Equal Access`); dettagli.push(...regole.map(r => `IBM ${r} x${ea.filter(x => x.regola === r).length}: ${ea.find(x => x.regola === r).messaggio}`)); }
      else note.push(`IBM Equal Access: ${ea.length} violazioni (${regole.join(', ')})`);
    }
    const sr = pr.sr ? pr.sr.roleOnly.length : 0;
    if (sr) (decide('screenReader') ? (motivi.push(`${sr} annunci col solo ruolo`), dettagli) : note).push(`screen reader: ${sr} annunci col solo ruolo`);
    if (pr.lhScore != null && MIN_SCORE != null && pr.lhScore < MIN_SCORE) (decide('lighthouse') ? (motivi.push(`Lighthouse ${(pr.lhScore * 100).toFixed(0)}% < ${(MIN_SCORE * 100).toFixed(0)}%`), dettagli) : note).push(`Lighthouse ${(pr.lhScore * 100).toFixed(0)}%`);
    if (pr.lhScore == null && !pr.lhEscluso && (pr.lhMotivo || DO_LH)) (decide('lighthouse') ? (motivi.push('senza punteggio Lighthouse'), dettagli) : note).push(`Lighthouse senza punteggio${pr.lhMotivo ? `: ${pr.lhMotivo}` : ''}`);
    if (pr.lhScore != null) note.push(`Lighthouse: ${(pr.lhScore * 100).toFixed(0)}%`); else if (pr.lhEscluso) note.push(pr.lhMotivo ? `Lighthouse escluso: ${pr.lhMotivo}` : 'Lighthouse: escluso dal flow');
    const c = summarizeImpacts(pr.violations);
    note.push(`axe e controlli aggiuntivi: critical ${c.critical}, serious ${c.serious}, moderate ${c.moderate}, minor ${c.minor}`);
    const inc = (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
    if (inc) note.push(`da verificare (incomplete): ${inc}`);
    for (const x of pr.controlliNonEseguiti || []) {
      const riga = `controllo ${x.controllo} non eseguito (esito non verificabile): ${x.errore}`;
      if (CONTROLLI_DA_RIPETERE.has(x.controllo) && decide(x.controllo)) { motivi.push(`controllo ${x.controllo} non eseguito`); dettagli.push(riga); } else note.push(riga);
    }
    const out = `\n      <system-out>${xmlEscape(note.join('\n'))}</system-out>`;
    if (motivi.length) {
      fallite++;
      viste.push(`    <testcase ${nome}>
      <failure message="${xmlEscape(motivi.join('; '))}">${xmlEscape(dettagli.join('\n'))}</failure>${out}
    </testcase>`);
    } else viste.push(`    <testcase ${nome}>${out}\n    </testcase>`);
  }
  const casiControlli = controlli.map(c => {
    const nome = `classname="a11y.controlli" name="${xmlEscape(c.nome)}"`;
    const testo = xmlEscape(`soglia: ${c.soglia}\nrisultato: ${c.risultato}\nesito: ${c.esito}${c.decide ? '' : " (non decide l'esito)"}`);
    if (c.esito === 'non superato') return `    <testcase ${nome}>\n      <failure message="${xmlEscape(c.motivi.join('; '))}">${testo}</failure>\n    </testcase>`;
    if (c.esito === 'non eseguito') return `    <testcase ${nome}>\n      <skipped message="${xmlEscape(c.risultato)}"/>\n      <system-out>${testo}</system-out>\n    </testcase>`;
    return `    <testcase ${nome}>\n      <system-out>${testo}</system-out>\n    </testcase>`;
  });
  const perimetro = PERIMETRO.map(p => `    <testcase classname="a11y.perimetro" name="${xmlEscape(`${p.target} ${p.tipo} ${p.nome}`)}">\n      <skipped message="${xmlEscape(`${p.esito}: ${p.motivo}`)}"/>\n    </testcase>`);
  const caseGate = gate.superato
    ? `    <testcase classname="a11y.gate" name="gate di accessibilita'"/>`
    : `    <testcase classname="a11y.gate" name="gate di accessibilita'">\n      <failure message="gate NON superato">${xmlEscape(gate.motivi.join('\n'))}</failure>\n    </testcase>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="gov-a11y" tests="${results.length + controlli.length + perimetro.length + 1}" failures="${fallite + controlli.filter(c => c.esito === 'non superato').length + (gate.superato ? 0 : 1)}">
<testsuite name="accessibility-wcag21aa" tests="${results.length}" failures="${fallite}">
${viste.join('\n')}
</testsuite>
<testsuite name="controlli" tests="${controlli.length}" failures="${controlli.filter(c => c.esito === 'non superato').length}" skipped="${controlli.filter(c => c.esito === 'non eseguito').length}">
${casiControlli.join('\n')}
</testsuite>
${perimetro.length ? `<testsuite name="perimetro" tests="${perimetro.length}" failures="0" skipped="${perimetro.length}">\n${perimetro.join('\n')}\n</testsuite>\n` : ''}<testsuite name="gate" tests="1" failures="${gate.superato ? 0 : 1}">
${caseGate}
</testsuite>
</testsuites>
`;
  writeReport(resolve(OUT, 'a11y-junit.xml'), xml);
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
/* Versioni e livelli WCAG effettivamente verificati: i tag axe sono l'unica fonte di verita'
   (un target puo' ridurli, e la riga di comando pure), quindi la dichiarazione si deriva da li'
   e non resta indietro rispetto a cio' che gira davvero. */
function wcagVerificato(tags) {
  const versioni = [], livelli = new Set();
  for (const t of tags) {
    const m = String(t).toLowerCase().match(/^wcag(\d+)(a{1,3})$/);
    if (!m) continue;
    const v = m[1] === '2' ? '2.0' : `${m[1][0]}.${m[1].slice(1)}`;
    if (!versioni.includes(v)) versioni.push(v);
    livelli.add(m[2].toUpperCase());
  }
  versioni.sort();
  const liv = ['A', 'AA', 'AAA'].filter(l => livelli.has(l));
  return {
    versioni, livelli: liv,
    // forma breve per il titolo: "WCAG 2.2 AA"
    breve: versioni.length ? `WCAG ${versioni[versioni.length - 1]} ${liv[liv.length - 1] || 'A'}` : 'accessibilità',
    // forma estesa per la dichiarazione: "criteri WCAG 2.0, 2.1 e 2.2 di livello A e AA"
    esteso: versioni.length
      ? `criteri WCAG ${elenco(versioni)} di livello ${elenco(liv)}`
      : 'criteri WCAG',
  };
}
function elenco(v) { return v.length > 1 ? `${v.slice(0, -1).join(', ')} e ${v[v.length - 1]}` : (v[0] || ''); }

/* Criteri di successo WCAG di una regola, dai suoi tag axe: 'wcag143' -> '1.4.3', 'wcag1410' ->
   '1.4.10'. I tag di versione e livello ('wcag2aa', 'wcag21a') non sono criteri e si ignorano. */
function criteriWcag(tags) {
  const out = [];
  for (const t of tags || []) {
    const m = String(t).toLowerCase().match(/^wcag(\d)(\d)(\d{1,2})$/);
    if (m && !out.includes(`${m[1]}.${m[2]}.${m[3]}`)) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out;
}

/* Riferimento EN 301 549 v3.2.1 di un criterio WCAG: la clausola 9 (contenuti web) ripete i criteri
   WCAG 2.1 di livello A e AA con il prefisso '9.'. E' lo standard su cui poggiano la norma italiana e
   il monitoraggio AgID. I criteri introdotti dalle WCAG 2.2 non vi sono ancora: per loro null. */
const SOLO_WCAG22 = new Set(['2.4.11', '2.4.12', '2.4.13', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8', '3.3.9']);
const rifEn = c => (SOLO_WCAG22.has(c) ? null : `9.${c}`);
const fmtCriterio = c => (rifEn(c) ? `${c} (EN ${rifEn(c)})` : `${c} (solo WCAG 2.2)`);

/* Il componente di un'occorrenza, ripulito di cio' che cambia da una vista all'altra pur essendo lo
   stesso elemento: gli attributi di incapsulamento di Angular ('_ngcontent-ng-c894269316') e la
   posizione fra i fratelli (':nth-child(3)'). */
function selettoreComponente(target) {
  const s = Array.isArray(target) ? target.join(' ') : String(target || '');
  return s.replace(/\[_ng(?:content|host)-[^\]]*\]/g, '').replace(/:nth-(?:child|of-type)\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
}

/* Errori SISTEMATICI: la stessa regola sullo stesso componente in piu' viste. E' un difetto del
   modello di pagina (un componente condiviso, l'intestazione, il menu), da correggere una volta
   sola; elencato vista per vista sembrerebbe un problema N volte piu' grande di quello che e'. Vale
   per le violazioni e per i casi da verificare (una verifica manuale fatta sul componente vale per
   tutte le viste). */
function erroriSistematici(results, minViste = 2) {
  const gruppi = new Map();
  const aggiungi = (tipo, v, n, vista) => {
    const componente = selettoreComponente(n.target);
    if (!componente) return;
    const chiave = `${tipo}\u0000${v.id}\u0000${componente}`;
    const g = gruppi.get(chiave) || { tipo, regola: v.id, descrizione: v.help, impatto: v.impact || null, criteri: criteriWcag(v.tags), componente, viste: new Set(), occorrenze: 0 };
    g.viste.add(vista);
    g.occorrenze++;
    gruppi.set(chiave, g);
  };
  for (const pr of results) {
    for (const v of pr.violations || []) for (const n of v.nodes || []) aggiungi('violazione', v, n, pr.name);
    for (const v of pr.incomplete || []) for (const n of v.nodes || []) aggiungi('da verificare', v, n, pr.name);
  }
  return [...gruppi.values()]
    .filter(g => g.viste.size >= minViste)
    .map(g => ({ ...g, viste: [...g.viste] }))
    .sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'violazione' ? -1 : 1) || b.viste.length - a.viste.length || b.occorrenze - a.occorrenze);
}

/* Confronto fra i due motori per criterio WCAG: quanti casi trova ciascuno. Un criterio segnalato da
   un solo motore e' proprio cio' che la verifica con due strumenti serve a far emergere. */
function confrontoMotori(results) {
  const righe = new Map();
  const riga = c => righe.get(c) || righe.set(c, { criterio: c, axeViolazioni: 0, axeDaVerificare: 0, eaViolazioni: 0, eaDaVerificare: 0 }).get(c);
  for (const pr of results) {
    for (const v of pr.violations || []) for (const c of criteriWcag(v.tags)) riga(c).axeViolazioni += (v.nodes || []).length;
    for (const v of pr.incomplete || []) for (const c of criteriWcag(v.tags)) riga(c).axeDaVerificare += (v.nodes || []).length;
    for (const x of pr.equalAccess?.violazioni || []) for (const c of x.wcag) riga(c).eaViolazioni++;
    for (const x of pr.equalAccess?.daVerificare || []) for (const c of x.wcag) riga(c).eaDaVerificare++;
  }
  const num = c => c.split('.').map(Number);
  return [...righe.values()].sort((a, b) => { const x = num(a.criterio), y = num(b.criterio); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
}

/* Copertura dichiarata nel report: si costruisce sui livelli DAVVERO attivi nella scansione.
   Dichiarare una verifica non eseguita (o tacere di una eseguita) renderebbe il report inutile
   come evidenza a supporto della dichiarazione di accessibilita'. */
function buildCoverage() {
  const wcag = wcagVerificato(TAG_USATI);
  const strumenti = ['axe-core', 'albero di accessibilità'];
  if (DO_SR) strumenti.push('screen reader virtuale');
  if (DO_MOUSE_ONLY) strumenti.push('rilevazione dei comandi utilizzabili col solo mouse');
  if (DO_LH) strumenti.push('Lighthouse');
  if (DO_EA) strumenti.push('IBM Equal Access come secondo motore indipendente');
  if (CONTROLLI_USATI.has('contrastEstimate')) strumenti.push('stima del contrasto sullo sfondo reale dei casi da verificare');
  if (CONTROLLI_USATI.has('reflow')) strumenti.push('riflusso a 320px');
  if (CONTROLLI_USATI.has('textSpacing')) strumenti.push('spaziatura del testo');
  if (CONTROLLI_USATI.has('keyboardWalk')) strumenti.push('percorso col tasto Tab');
  if (CONTROLLI_USATI.has('languageParts')) strumenti.push('lingua delle parti');
  const esempi = ['contrasto colore', 'testi alternativi e label mancanti', 'attributo lang',
    'ruoli/nomi ARIA', 'ordine degli heading', "struttura dell'albero di accessibilità"];
  if ([...TAG_USATI].some(t => /^wcag22/.test(String(t).toLowerCase()))) esempi.push('dimensione minima dei bersagli');
  if (DO_MOUSE_ONLY) esempi.push('comandi utilizzabili col solo mouse');
  if ([...TAG_USATI].includes('best-practice')) esempi.push('regole di buona pratica (fuori dai criteri WCAG)');

  // Navigazione da tastiera: si dichiara cio' che hanno fatto i controlli attivi (solo mouse, percorso col Tab)
  // e cio' che resta manuale in ogni caso: l'effetto dei tasti e la logica dell'ordine di focus (2.4.3).
  const tastiera = [];
  if (DO_MOUSE_ONLY) tastiera.push('segnala i comandi con un gestore del clic non raggiungibili da tastiera');
  if (CONTROLLI_USATI.has('keyboardWalk')) tastiera.push('percorre ogni vista col tasto Tab (fuoco visibile e non coperto, '
    + "nessuna trappola) registrando l'ordine di focus, ma solo sullo stato analizzato di ogni vista");
  const manualRequired = [
    tastiera.length
      ? `Navigazione da tastiera: l'automazione ${tastiera.join(' e ')}; non verifica se i tasti attesi `
        + "facciano poi la cosa giusta, né se l'ordine di focus sia logico."
      : "Navigazione da tastiera: in questa scansione non è attivo alcun controllo da tastiera, quindi "
        + 'raggiungibilità dei comandi, fuoco visibile, ordine di focus e comportamento dei tasti vanno '
        + 'verificati a mano.',
    DO_SR
      ? "Test con screen reader reale (fedeltà d'uso, verbosità, senso degli annunci): quello "
        + "virtuale verifica che cosa viene annunciato, non com'è usare l'applicazione."
      : 'Test con screen reader: in questa scansione non è stato eseguito alcun controllo sugli '
        + 'annunci, né virtuale né reale.',
    "Qualità del testo alternativo e delle label (l'automazione vede se mancano, non se hanno senso).",
    CONTROLLI_USATI.has('reflow') && CONTROLLI_USATI.has('textSpacing')
      ? 'Ingrandimento: zoom al 200% e 400% e orientamento (riflusso a 320px e spaziatura del testo sono '
        + 'stati verificati in automatico, ma solo sullo stato analizzato di ogni vista).'
      : 'Ingrandimento e riflusso del contenuto: zoom al 200% e 400%, orientamento, spaziatura del testo.',
    "Comprensibilità di istruzioni, messaggi d'errore e suggerimenti di correzione nei moduli.",
    'Contenuti multimediali, se presenti: sottotitoli, trascrizioni, audiodescrizioni.',
  ];

  return {
    automated: `L'automazione (${strumenti.join(', ')}) copre solo una parte dei ${wcag.esteso} `
      + `(indicativamente ~30–40%): es. ${esempi.join(', ')}.`,
    manualRequired,
    note: 'Questo report è EVIDENZA a supporto della dichiarazione di accessibilità AgID, '
      + "NON una certificazione di conformità: un esito automatico pulito non implica conformità WCAG.",
    wcag: { versioni: wcag.versioni, livelli: wcag.livelli, tags: [...TAG_USATI] },
  };
}
// Landmark ARIA (per colorare la vista grafica dell'albero).
const AX_LANDMARKS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search', 'form']);

// Costruisce un albero annidato dall'ariaSnapshot (indentazione a 2 spazi) per la vista grafica.
function parseAriaTree(snapshot) {
  const roots = [];
  const stack = [{ depth: -1, children: roots }];
  for (const raw of String(snapshot || '').split('\n')) {
    const m = raw.match(/^(\s*)-\s+(.*)$/);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    const label = m[2].replace(/:\s*$/, '');   // toglie il ':' finale dei nodi-contenitore
    const node = { label, children: [], depth };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

// Classe CSS per un nodo dell'albero ARIA: rosso se interattivo-senza-nome, colori per landmark/
// heading, grigio per proprieta' (/url) e testo.
function axRoleClass(label) {
  const t = label.trim();
  if (new RegExp(`^(${INTERACTIVE_ROLES.join('|')})$`).test(t)) return 'ax-nameless';
  if (/^\//.test(t) || /^text:/.test(t)) return 'ax-muted';
  const role = (t.match(/^'?([a-z]+)/) || [])[1] || '';
  if (AX_LANDMARKS.has(role)) return 'ax-land';
  if (role === 'heading') return 'ax-head';
  return '';
}

/* Riepilogo dei tempi della scansione (vedi TEMPI): durata complessiva, login, navigazione fra le
   viste (passi dei flow, menu, ricorsione), tempo dentro le viste per fase, viste piu' lente. */
function riepilogoTempi(results) {
  const r = v => Math.round(v);
  const viste = results.filter(pr => pr.tempi);
  const durata = performance.now() - TEMPI.avvio;
  const nelleViste = viste.reduce((t, pr) => t + pr.tempi.totale, 0);
  const navigazione = viste.reduce((t, pr) => t + (pr.tempi.primaDellaVista || 0), 0);
  const fasi = Object.keys(FASI_TEMPI).map(id => {
    const v = viste.filter(pr => pr.tempi.fasi[id] != null);
    if (!v.length) return null;
    const tot = v.reduce((t, pr) => t + pr.tempi.fasi[id], 0);
    const max = v.reduce((m, pr) => (pr.tempi.fasi[id] > m.ms ? { ms: pr.tempi.fasi[id], nome: pr.name } : m), { ms: -1, nome: '' });
    return { id, nome: FASI_TEMPI[id], totaleMs: r(tot), viste: v.length, mediaMs: r(tot / v.length), massimoMs: r(max.ms), vistaPiuLenta: max.nome, quota: durata ? tot / durata : 0 };
  }).filter(Boolean).sort((a, b) => b.totaleMs - a.totaleMs);
  const perVista = viste.map(pr => ({
    nome: pr.name, url: pr.url, indice: results.indexOf(pr), inizioMs: r(pr.tempi.inizio), primaDellaVistaMs: pr.tempi.primaDellaVista == null ? null : r(pr.tempi.primaDellaVista),
    totaleMs: r(pr.tempi.totale), fasi: Object.fromEntries(Object.entries(pr.tempi.fasi).map(([k, v]) => [k, r(v)])),
  }));
  return {
    durataMs: r(durata), loginMs: r(TEMPI.login), navigazioneMs: r(navigazione), visteMs: r(nelleViste),
    altroMs: r(Math.max(0, durata - TEMPI.login - navigazione - nelleViste)),
    numeroViste: viste.length, mediaVistaMs: viste.length ? r(nelleViste / viste.length) : 0,
    fasi, visteLente: [...perVista].sort((a, b) => b.totaleMs - a.totaleMs).slice(0, 20), perVista,
  };
}

function fmtDurata(ms) {
  if (ms == null) return '-';
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

function writeSummaryAndHtml(results, ariaFiles = {}) {
  // La copertura dichiarata si costruisce ORA, quando si sa quali livelli hanno girato davvero.
  const COVERAGE = buildCoverage();
  const WCAG = wcagVerificato(TAG_USATI);
  const app = appLabel(results);
  const perTarget = {};
  const summary = { base: BASE, app, generatedFrom: 'gov-a11y', productVersion: PRODUCT_VERSION, tags: [...TAG_USATI], failOn: FAIL_ON, failOnNameless: FAIL_ON_NAMELESS, failOnMouseOnly: FAIL_ON_MOUSE_ONLY, failOnEmpty: FAIL_ON_EMPTY, failOnHttpError: FAIL_ON_HTTP_ERROR, failOnScreenReader: FAIL_ON_SCREEN_READER, failOnEqualAccess: FAIL_ON_EQUAL_ACCESS, minScore: MIN_SCORE, screenReader: DO_SR, lighthouseEnabled: DO_LH, coverage: COVERAGE, pages: [], totals: { critical: 0, serious: 0, moderate: 0, minor: 0 }, namelessTotal: 0, mouseOnlyTotal: 0, incompleteTotal: 0, falsePositivesTotal: 0, falsePositives: [], srRoleOnlyTotal: 0, emptyViews: [], httpErrorViews: [], lighthouse: [],
    equalAccess: DO_EA ? { motore: 'IBM Equal Access (accessibility-checker-engine)', versione: moduleVersion('accessibility-checker-engine'), regole: EA_RULESET, violazioni: 0, daVerificare: 0, confermatiDaTab: 0 } : null,
    perimetro: [...PERIMETRO], erroriSistematici: [], confrontoMotori: null, stimaContrasti: null };
  for (const pr of results) {
    const c = summarizeImpacts(pr.violations);
    for (const k of Object.keys(summary.totals)) if (k !== 'namelessTotal') summary.totals[k] += c[k];
    const nameless = pr.axTree ? pr.axTree.nameless.length : 0;
    summary.namelessTotal += nameless;
    const soloMouse = pr.soloMouse ? pr.soloMouse.totale : 0;
    summary.mouseOnlyTotal += soloMouse;
    const incNodes = (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
    summary.incompleteTotal += incNodes;
    summary.falsePositivesTotal += (pr.falsePositives || []).length;
    const srRoleOnly = pr.sr ? pr.sr.roleOnly.length : 0;
    summary.srRoleOnlyTotal += srRoleOnly;
    const ea = pr.equalAccess ? { violazioni: pr.equalAccess.violazioni.length, daVerificare: pr.equalAccess.daVerificare.length, confermatiDaTab: (pr.equalAccess.confermatiDaTab || []).length } : null;
    if (ea && summary.equalAccess) { summary.equalAccess.violazioni += ea.violazioni; summary.equalAccess.daVerificare += ea.daVerificare; summary.equalAccess.confermatiDaTab += ea.confermatiDaTab; }
    summary.pages.push({ target: pr.targetName, name: pr.name, url: pr.url, counts: c, incomplete: incNodes, lhScore: pr.lhScore, lhEscluso: !!pr.lhEscluso, namelessInteractive: nameless, mouseOnly: soloMouse, srStops: pr.sr ? pr.sr.stops : null, srRoleOnly, vuota: !!pr.vuota, httpStatus: pr.httpStatus ?? null, equalAccess: ea, ariaTree: ariaFiles[results.indexOf(pr)] || null });
    if (pr.vuota) summary.emptyViews.push({ target: pr.targetName, name: pr.name, url: pr.url });
    if (pr.erroreHttp) summary.httpErrorViews.push({ target: pr.targetName, name: pr.name, url: pr.url, status: pr.httpStatus });
    if (pr.lhScore != null) summary.lighthouse.push({ url: pr.url, score: pr.lhScore });
    perTarget[pr.targetName] = perTarget[pr.targetName] || [];
    perTarget[pr.targetName].push(pr);
  }
  // le deroghe finiscono anche nel riepilogo, con il conteggio delle occorrenze coperte
  summary.falsePositives = FALSE_POSITIVES_USATI.map(v => ({
    id: v.id, engine: v.engine, rule: v.rule, cause: v.cause || null, selector: v.selector || null,
    reason: v.reason, verification: v.verification, author: v.author || null,
    expires: v.expires || null, expired: !!v.expired, matches: v.matches,
  }));
  summary.erroriSistematici = erroriSistematici(results);
  const perComponente = contrastiPerComponente(results);
  if (perComponente.length) {
    const totale = e => perComponente.reduce((n, g) => n + (g.esiti[e] || 0), 0);
    summary.stimaContrasti = { nonConformi: totale('non conforme'), parziali: totale('parziale'), conformi: totale('conforme'), nonStimabili: totale('non stimabile'), perComponente };
  }
  if (DO_EA) {
    summary.confrontoMotori = confrontoMotori(results);
    // violazioni del secondo motore per regola: cosa correggere, come la tabella delle regole axe
    const perRegola = new Map();
    for (const pr of results) for (const x of pr.equalAccess?.violazioni || []) {
      const g = perRegola.get(x.regola) || { regola: x.regola, wcag: x.wcag, messaggio: x.messaggio, occorrenze: 0, viste: new Set() };
      g.occorrenze++; g.viste.add(pr.name); perRegola.set(x.regola, g);
    }
    summary.equalAccess.perRegola = [...perRegola.values()].map(g => ({ ...g, viste: g.viste.size })).sort((a, b) => b.viste - a.viste || b.occorrenze - a.occorrenze);
  }
  // esito di ogni controllo e del gate: in summary.json e in cima al report, con i motivi
  const { controlli, gate } = valutaControlli(results);
  summary.generatedAt = new Date().toISOString();
  summary.gate = gate;
  summary.controlli = controlli;
  writeReport(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  const tempi = riepilogoTempi(results);
  writeReport(resolve(OUT, 'tempi.json'), JSON.stringify(tempi, null, 2));

  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const impClass = imp => imp === 'critical' ? 'crit' : imp === 'serious' ? 'ser' : imp === 'moderate' ? 'mod' : 'min';
  // Screenshot dell'occorrenza (vedi fotografaOccorrenze): miniatura che apre l'immagine intera.
  const immagine = n => (n.screenshot ? `<a href="${esc(n.screenshot)}" target="_blank"><img class="shot" src="${esc(n.screenshot)}" alt="Posizione nella pagina dell'elemento segnalato" loading="lazy"></a>` : '');
  // Stima del contrasto (vedi stimaContrasti): una riga sotto l'occorrenza
  const fmtR = v => (v == null ? '?' : v.toFixed(2).replace('.', ','));
  const ESITI_CC = { 'non conforme': ['ser', 'sotto soglia: probabile violazione'], parziale: ['mod', 'sotto soglia in parte'], conforme: ['min', 'sopra soglia: probabile falso positivo'], 'non stimabile': ['min', 'non stimabile'] };
  const intervallo = (a, b) => `${fmtR(a)}${b != null && b > a ? `–${fmtR(b)}` : ''}:1`;
  const stimaHtml = c => (!c ? '' : c.errore
    ? `<div class="fs">Contrasto non stimato: ${esc(c.errore)}</div>`
    : `<div class="fs">Contrasto stimato sullo sfondo reale: <b>${intervallo(c.minimo, c.massimo)}</b> (richiesto ${fmtR(c.richiesto)}:1${c.grande ? ', testo grande' : ''}; testo ${esc(c.testo)}${c.alfa < 1 ? ` al ${Math.round(c.alfa * 100)}%` : ''}) → <span class="${ESITI_CC[c.esito][0]}">${ESITI_CC[c.esito][1]}</span>${c.esito === 'parziale' ? ` (${Math.round(c.sotto * 100)}% dell'area)` : ''}</div>`);
  const nodoHtml = n => `<li><code class="sel">${esc((n.target || []).join(' '))}</code>
          <pre>${esc((n.html || '').slice(0, 400))}</pre>
          ${n.failureSummary ? `<div class="fs">${esc(n.failureSummary)}</div>` : ''}${stimaHtml(n.contrasto)}${immagine(n)}</li>`;
  const rigaControllo = c => `<tr class="${ESITO_CLASSE[c.esito] || ''}"><td><b>${esc(c.nome)}</b><br><small>${esc(c.criteri || '')}</small></td>
<td>${c.decide ? 'sì' : 'no'}</td><td>${esc(c.soglia)}</td>
<td>${esc(c.risultato)}${c.viste.length ? `<details><summary>${c.viste.length} ${c.viste.length === 1 ? 'vista coinvolta' : 'viste coinvolte'}</summary><ul class="viste">${c.viste.slice(0, 200).map(v => `<li>${v.indice >= 0 ? `<a href="#pg${v.indice}">${esc(v.nome)}</a>` : `<code>${esc(v.nome)}</code>`}${v.valore !== 0 && v.valore != null ? ` — <b>${esc(v.valore)}</b>` : ''}${v.nota ? ` <small>${esc(v.nota)}</small>` : ''}</li>`).join('')}${c.viste.length > 200 ? `<li><small>… e altre ${c.viste.length - 200}</small></li>` : ''}</ul></details>` : ''}</td>
<td><span class="esito ${ESITO_CLASSE[c.esito] || ''}">${esc(c.esito)}</span></td></tr>`;
  const ESITO_CLASSE = { 'superato': 'e-ok', 'nessuna segnalazione': 'e-ok', 'non superato': 'e-ko', 'segnalazioni': 'e-warn', 'incompleto': 'e-warn', 'non eseguito': 'e-off' };
  const sistematici = summary.erroriSistematici;
  const confronto = summary.confrontoMotori;
  const perimetro = summary.perimetro;

  // Tabella riepilogo per pagina
  const righe = results.map((pr, i) => {
    const c = summarizeImpacts(pr.violations);
    const nameless = pr.axTree ? pr.axTree.nameless.length : 0;
    const soloMouse = pr.soloMouse ? pr.soloMouse.totale : 0;
    const incNodes = (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0);
    return `<tr${pr.vuota || pr.erroreHttp ? ' style="background:#fde8e8"' : ''}><td class="lungo"><a href="#pg${i}">${esc(pr.name)}</a>${pr.vuota ? ' <span class="crit">VISTA VUOTA</span>' : ''}${pr.erroreHttp ? ` <span class="crit">HTTP ${pr.httpStatus}</span>` : ''}</td><td class="lungo"><a href="${esc(pr.url)}">${esc(pr.url)}</a></td>
      <td class="crit">${c.critical}</td><td class="ser">${c.serious}</td><td>${c.moderate}</td><td>${c.minor}</td>
      <td>${pr.lhScore != null ? `<span class="${MIN_SCORE != null && pr.lhScore < MIN_SCORE ? 'ser' : ''}">${(pr.lhScore * 100).toFixed(0)}%</span>` : (pr.lhEscluso ? (pr.lhMotivo ? `<span title="${esc(pr.lhMotivo)}">escluso</span>` : 'escluso') : (pr.lhMotivo ? `<span class="ser" title="${esc(pr.lhMotivo)}">senza punteggio</span>` : '-'))}</td>
      ${SHOW_INCOMPLETE ? `<td class="${incNodes ? 'mod' : ''}">${incNodes || '-'}</td>` : ''}
      <td class="${nameless ? 'ser' : ''}">${nameless || '-'}</td>
      <td class="${soloMouse ? 'ser' : ''}">${soloMouse || '-'}</td>
      ${DO_EA ? `<td>${pr.equalAccess ? `<span class="${pr.equalAccess.violazioni.length ? 'ser' : ''}">${pr.equalAccess.violazioni.length}</span> / ${pr.equalAccess.daVerificare.length}` : 'non eseguito'}</td>` : ''}</tr>`;
  });
  // Riepilogo per pagina: una tabella per console scansionata, in un blocco richiudibile (chiuso:
  // con centinaia di viste la tabella aperta copre il resto del report). Nella riga di sintesi
  // restano i numeri che contano, cosi' una vista con problemi si nota anche a blocco chiuso.
  const gruppiPagine = [];
  results.forEach((pr, i) => {
    let g = gruppiPagine.find(x => x.nome === pr.targetName);
    if (!g) gruppiPagine.push(g = { nome: pr.targetName, righe: [], viste: 0, conViolazioni: 0, vuote: 0, eaDaVerificare: 0 });
    g.righe.push(righe[i]);
    g.viste++;
    if (pr.violations.length || (pr.equalAccess && pr.equalAccess.violazioni.length)) g.conViolazioni++;
    if (pr.vuota) g.vuote++;
    if (pr.equalAccess) g.eaDaVerificare += pr.equalAccess.daVerificare.length;
  });
  const colonnePagine = `<colgroup><col><col><col style="width:4.2rem"><col style="width:5.2rem"><col style="width:6.4rem"><col style="width:4.8rem"><col style="width:4.8rem">${SHOW_INCOMPLETE ? '<col style="width:7rem">' : ''}<col style="width:6.4rem"><col style="width:6rem">${DO_EA ? '<col style="width:8rem">' : ''}</colgroup>`;
  const intestazionePagine = `<tr><th>Pagina</th><th>URL</th><th>Crit</th><th>Serious</th><th>Moderate</th><th>Minor</th><th>LH a11y</th>${SHOW_INCOMPLETE ? '<th>Da verificare<br><small>(incomplete)</small></th>' : ''}<th>Senza nome<br><small>(a11y-tree)</small></th><th>Solo mouse<br><small>(tastiera)</small></th>${DO_EA ? '<th>IBM Equal Access<br><small>violazioni / da verificare</small></th>' : ''}</tr>`;
  const riepilogoPagine = gruppiPagine.map(g => `<details class="pagine">
<summary><h2>Riepilogo per pagina — ${esc(g.nome)}</h2> · ${g.viste} ${g.viste === 1 ? 'vista' : 'viste'}: <span class="${g.conViolazioni ? 'ser' : 'ok'}">${g.conViolazioni ? `${g.conViolazioni} con violazioni` : 'nessuna con violazioni'}</span>${g.vuote ? `, <span class="crit">${g.vuote} ${g.vuote === 1 ? 'vuota' : 'vuote'}</span>` : ''}${DO_EA ? `, IBM da verificare: ${g.eaDaVerificare}` : ''} <small>(clic per espandere; clic sulla pagina per il dettaglio)</small></summary>
<div class="scorri"><table class="pagine">${colonnePagine}
${intestazionePagine}
${g.righe.join('\n')}
</table></div>
</details>`).join('\n');

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
      <td>${criteriWcag(r.tags).map(fmtCriterio).map(esc).join(', ') || '<small>buona pratica</small>'}</td>
      <td><a href="${esc(r.helpUrl)}" target="_blank">regola ↗</a></td></tr>`).join('\n');

  // Render ricorsivo dell'albero ARIA come nodi espandibili (contenitori = <details>).
  const renderAx = nodes => '<ul class="axtree">' + nodes.map(n => {
    const lab = `<span class="${axRoleClass(n.label)}">${esc(n.label)}</span>`;
    return n.children.length
      ? `<li><details><summary>${lab}</summary>${renderAx(n.children)}</details></li>`
      : `<li>${lab}</li>`;
  }).join('') + '</ul>';

  // Drill-down per pagina: ogni violazione con elementi, selettore e snippet + elementi senza nome (a11y-tree)
  // viste con qualcosa da riportare, per il sommario della sezione di dettaglio (chiusa all'apertura)
  const conSegnalazioni = results.filter(pr => pr.violations.length || (pr.equalAccess && pr.equalAccess.violazioni.length)).length;
  const details = results.map((pr, i) => {
    const nameless = pr.axTree ? pr.axTree.nameless : [];
    const ariaLink = ariaFiles[i] ? ` — <a href="${esc(ariaFiles[i])}" download>scarica YAML ↗</a>` : '';
    // Vista grafica dell'albero ARIA (nodi espandibili), collassata di default.
    let axTreeBlock = '';
    if (pr.ariaSnapshot) {
      const nodes = pr.axTree ? pr.axTree.nodes : 0;
      axTreeBlock = `<details class="axtree-wrap"><summary><span class="mod">albero ARIA</span> ${nodes} nodi <small>— struttura letta dallo screen reader (clic per espandere)</small></summary>${renderAx(parseAriaTree(pr.ariaSnapshot))}</details>`;
    }
    let axBlock = '';
    if (nameless.length) {
      const byRole = {};
      for (const n of nameless) byRole[n.role] = (byRole[n.role] || 0) + 1;
      const roleSummary = Object.entries(byRole).map(([r, n]) => `${esc(r)}×${n}`).join(', ');
      const items = nameless.slice(0, 30).map(n => `<li><code>${esc(n.role)}</code> — <small>${esc(n.context || '(radice)')}</small></li>`).join('\n');
      axBlock = `<details><summary><span class="ser">a11y-tree</span> ${nameless.length} elementi interattivi <b>senza nome accessibile</b> (${roleSummary})
        <small>— lo screen reader li annuncia col solo ruolo</small></summary><ul class="nodes">${items}</ul></details>`;
    }
    let moBlock = '';
    const soloMouse = pr.soloMouse || { totale: 0, elementi: [] };
    if (soloMouse.totale) {
      const voci = soloMouse.elementi.map(e => {
        const segno = e.id ? `#${e.id}` : (e.classe ? `.${e.classe.split(' ').join('.')}` : '');
        return `<li><code>${esc(e.tag + segno)}</code>${e.role ? ` <small>role=${esc(e.role)}</small>` : ''}${e.testo ? ` — <small>${esc(e.testo)}</small>` : ''}</li>`;
      }).join('\n');
      const omessi = soloMouse.totale > soloMouse.elementi.length ?
        `<li><small>… e altri ${soloMouse.totale - soloMouse.elementi.length}: alzare 'mouseOnlyMax' nel target per vederli tutti</small></li>` : '';
      moBlock = `<details><summary><span class="ser">solo mouse</span> ${soloMouse.totale} comandi con un gestore del clic <b>non raggiungibili da tastiera</b>
        <small>— chi non usa il mouse non può attivarli (WCAG 2.1.1)</small></summary><ul class="nodes">${voci}${omessi}</ul></details>`;
    }
    let incBlock = '';
    const incomplete = pr.incomplete || [];
    if (SHOW_INCOMPLETE && incomplete.length) {
      const irows = incomplete.map(v => `<li><code>${esc(v.id)}</code> — ${esc(v.help)} <b>(${v.nodes.length})</b>${criteriWcag(v.tags).length ? ` <small>WCAG ${criteriWcag(v.tags).map(fmtCriterio).map(esc).join(', ')}</small>` : ''}
        <ul class="nodes">${v.nodes.map(nodoHtml).join('\n')}</ul></li>`).join('\n');
      incBlock = `<details><summary><span class="mod">da verificare</span> ${incomplete.reduce((n, v) => n + v.nodes.length, 0)} elementi che axe non ha deciso (sfondi calcolati/gradienti): NON sono un pass, verifica manuale</summary><ul class="nodes">${irows}</ul></details>`;
    }
    let eaBlock = '';
    const confermatiDaTab = pr.equalAccess?.confermatiDaTab || [];
    if (pr.equalAccess && (pr.equalAccess.violazioni.length || pr.equalAccess.daVerificare.length || confermatiDaTab.length)) {
      const voci = (lista, classe, etichetta) => lista.map(x => `<li><span class="${classe}">${etichetta}</span> <code>${esc(x.regola)}</code> — ${esc(x.messaggio)}${x.wcag.length ? ` <small>WCAG ${x.wcag.map(fmtCriterio).map(esc).join(', ')}</small>` : ''}
          <pre>${esc(x.snippet)}</pre>${x.xpath ? `<div class="fs">${esc(x.xpath)}</div>` : ''}${stimaHtml(x.contrasto)}${immagine(x)}</li>`).join('\n');
      /* I casi da verificare del secondo motore sono molti (molte sue regole chiedono una conferma
         manuale per ogni elemento focalizzabile): stanno in un blocco a parte, per non coprire le
         violazioni. */
      eaBlock = (pr.equalAccess.violazioni.length ? `<details><summary><span class="ser">IBM Equal Access</span> ${pr.equalAccess.violazioni.length} violazioni
        <small>— secondo motore, indipendente da axe; ${FAIL_ON_EQUAL_ACCESS ? 'decide il gate' : 'senza gate'}</small></summary><ul class="nodes">${voci(pr.equalAccess.violazioni, 'ser', 'violazione')}</ul></details>` : '')
        + (pr.equalAccess.daVerificare.length ? `<details><summary><span class="mod">IBM Equal Access</span> ${pr.equalAccess.daVerificare.length} da verificare
        <small>— conferme manuali chieste dal secondo motore</small></summary><ul class="nodes">${voci(pr.equalAccess.daVerificare, 'mod', 'da verificare')}</ul></details>` : '')
        /* Le conferme date dal percorso col Tab restano consultabili: chi verifica puo' rifarle. */
        + (confermatiDaTab.length ? `<details><summary><span class="ok">IBM Equal Access</span> ${confermatiDaTab.length} confermati dal percorso col Tab
        <small>— domande sul fuoco a cui ha risposto la misura sulla pagina: non servono screenshot né verifica manuale</small></summary><ul class="nodes">${confermatiDaTab.map(x => `<li><span class="ok">confermato</span> <code>${esc(x.regola)}</code> — ${esc(x.conferma)}
          <pre>${esc(x.snippet)}</pre>${x.xpath ? `<div class="fs">${esc(x.xpath)}</div>` : ''}</li>`).join('\n')}</ul></details>` : '');
    }
    let srBlock = '';
    if (pr.sr) {
      const ro = pr.sr.roleOnly.length;
      const roMark = ro ? `<span class="ser">${ro} annunci solo-ruolo</span> (elementi letti senza nome) — ` : '';
      const lines = pr.sr.phrases.map(p => `<li class="${SR_ROLE_ONLY.test(p.trim()) ? 'ser' : ''}">${esc(p)}</li>`).join('\n');
      srBlock = `<details><summary><span class="mod">screen reader</span> ${roMark}${pr.sr.stops} annunci del virtual screen reader (trascrizione)</summary><ol class="nodes">${lines}</ol></details>`;
    }
    // controlli che su questa vista non hanno dato esito: Lighthouse senza punteggio, analisi fallite
    const mancati = [...(pr.lhMotivo && !pr.lhEscluso ? [{ controllo: 'Lighthouse', errore: `senza punteggio — ${pr.lhMotivo}` }] : []), ...(pr.controlliNonEseguiti || [])];
    const neBlock = mancati.length ? `<details open><summary><span class="ser">controlli senza esito</span> ${mancati.length} <small>— su questa vista non hanno potuto decidere</small></summary><ul class="nodes">${mancati.map(c => `<li><b>${esc(c.controllo)}</b>: ${esc(c.errore)}</li>`).join('')}</ul></details>` : '';
    const tempiBlock = !pr.tempi ? '' : `<details class="tempi"><summary>Tempi: <b>${fmtDurata(pr.tempi.totale)}</b> nella vista${pr.tempi.primaDellaVista != null ? `, ${fmtDurata(pr.tempi.primaDellaVista)} per arrivarci` : ''} <small>(clic per il dettaglio delle fasi)</small></summary>
<table class="tempi"><tr><th>Fase</th><th>Durata</th><th>Quota della vista</th></tr>${Object.entries(pr.tempi.fasi).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(FASI_TEMPI[k] || k)}</td><td>${fmtDurata(v)}</td><td>${pr.tempi.totale ? Math.round(v / pr.tempi.totale * 100) : 0}%</td></tr>`).join('')}</table></details>`;
    /* Ogni vista si puo' richiudere: il titolo resta fuori dal blocco, perche' un titolo dentro un
       <summary> perde il ruolo di titolo con alcuni lettori di schermo e la navigazione per titoli
       del report si interromperebbe. Aperto se la vista ha qualcosa da riportare, chiuso se e' pulita. */
    const corpo = (aperto, contenuto, quanti) => `<details class="vista"${aperto ? ' open' : ''}><summary>${aperto ? 'Dettagli della vista' : 'Albero ARIA e tempi della vista'} <small>(${quanti} ${quanti === 1 ? 'blocco' : 'blocchi'})</small></summary>${contenuto}</details>`;
    const contaBlocchi = (...b) => b.filter(Boolean).length;
    if (!pr.violations.length && !axBlock && !moBlock && !incBlock && !srBlock && !eaBlock && !neBlock) return `<h3 id="pg${i}">${esc(pr.name)} <small>— nessuna violazione${ariaLink}</small></h3>${(axTreeBlock || tempiBlock) ? corpo(false, axTreeBlock + tempiBlock, contaBlocchi(axTreeBlock, tempiBlock)) : ''}`;
    const vs = pr.violations
      .sort((a, b) => SEVERITY_ORDER[b.impact] - SEVERITY_ORDER[a.impact])
      .map(v => {
        const nodes = v.nodes.map(nodoHtml).join('\n');
        const crit = criteriWcag(v.tags);
        return `<details><summary><span class="${impClass(v.impact)}">${esc(v.impact)}</span>
          <code>${esc(v.id)}</code> — ${esc(v.help)} <b>(${v.nodes.length})</b>${crit.length ? ` <small>WCAG ${crit.map(fmtCriterio).map(esc).join(', ')}</small>` : ''}
          <a href="${esc(v.helpUrl)}" target="_blank">↗</a></summary>
          <ul class="nodes">${nodes}</ul></details>`;
      }).join('\n');
    return `<h3 id="pg${i}">${esc(pr.name)} <small>— <a href="${esc(pr.url)}">${esc(pr.url)}</a>${ariaLink}</small></h3>${corpo(true, `${neBlock}${axTreeBlock}${axBlock}${moBlock}${incBlock}${srBlock}${vs}${eaBlock}${tempiBlock}`, contaBlocchi(neBlock, axTreeBlock, axBlock, moBlock, incBlock, srBlock, eaBlock, tempiBlock) + pr.violations.length)}`;
  }).join('\n');

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(app)} — Accessibility Report</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222;max-width:1200px}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:14px;vertical-align:top;overflow-wrap:break-word}th{background:#f4f4f4}
/* tabella dei falsi positivi: colonne a larghezza fissa, cosi' selettori ed email lunghi vanno a capo
   dentro la loro colonna senza allargare la tabella ne' schiacciare le colonne corte; sotto i 900px scorre */
.scorri{overflow-x:auto}table.fp{table-layout:fixed;min-width:900px}table.fp td{overflow-wrap:anywhere}table.fp td.nw{white-space:nowrap}
/* riepilogo per pagina: le colonne dei numeri hanno larghezza fissa, pagina e URL si dividono il resto
   e vanno a capo dentro la loro colonna */
table.pagine{table-layout:fixed;min-width:1000px;margin:.5rem 0}table.pagine td.lungo{overflow-wrap:anywhere}
details.pagine{margin:1rem 0;padding:.5rem .8rem}details.pagine>summary h2{display:inline;margin:0;font-size:1.05rem}

.crit{color:#b00;font-weight:700}.ser{color:#d60;font-weight:700}.mod{color:#a80;font-weight:600}.min{color:#666}.ok{color:#1a7f37;font-weight:600}
caption{text-align:left;font-weight:700;margin-bottom:.5rem}
details{margin:.3rem 0;border-left:3px solid #ddd;padding:.2rem .6rem;background:#fafafa}
details.vista{margin:.2rem 0 1.2rem;border-left:0;padding:0;background:none}details.vista>summary{font-size:.9rem;color:#444;cursor:pointer;margin-bottom:.3rem}
summary{cursor:pointer}ul.nodes{margin:.4rem 0}li{margin:.5rem 0}
code.sel{background:#eef;padding:1px 4px}pre{background:#f6f6f6;padding:.4rem;overflow-x:auto;font-size:12px;margin:.2rem 0;white-space:pre-wrap}
.fs{font-size:12px;color:#555;white-space:pre-wrap}h3{margin-top:1.5rem;border-bottom:1px solid #eee}
.disclaimer{border:1px solid #d9a441;background:#fff8e8;border-left:5px solid #d9a441;padding:.8rem 1rem;margin:1rem 0;border-radius:4px}
.disclaimer h2{margin:.2rem 0 .5rem;font-size:1.05rem;border:0}details.disclaimer>summary h2{display:inline;margin:0}details.disclaimer[open]>summary{margin-bottom:.5rem}.disclaimer ul{margin:.3rem 0 .3rem 1.1rem}.disclaimer .note{font-weight:600;margin-top:.5rem}
ul.axtree{list-style:none;margin:.1rem 0;padding-left:1.1rem;border-left:1px dotted #ccc}
ul.axtree li{margin:.05rem 0}.axtree details{border:0;background:none;padding:0;margin:0}.axtree summary{cursor:pointer}
.axtree span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ax-land{color:#0a7;font-weight:600}.ax-head{color:#06c;font-weight:700}.ax-nameless{color:#b00;font-weight:700}.ax-muted{color:#999}
img.shot{display:block;max-width:420px;max-height:240px;margin:.3rem 0;border:1px solid #ccc}
table.info th{width:11rem;background:#f7f7f9;font-weight:600}table.info td{background:#fff}
.gate{border:1px solid;border-left-width:6px;border-radius:4px;padding:.6rem 1rem;margin:1rem 0 1.5rem}.gate h2{margin:.2rem 0 .4rem;font-size:1.2rem;border:0}.gate ul{margin:.3rem 0 .3rem 1.2rem}.gate p{margin:.3rem 0}
.gate-ok{border-color:#2e7d32;background:#eef7ee}.gate-ko{border-color:#b00;background:#fdecec}
table.controlli td{vertical-align:top}table.controlli details{background:none;border:0;padding:0;margin:.3rem 0 0}table.controlli summary{font-size:13px;color:#444}
ul.viste{margin:.2rem 0 .2rem 1rem;padding:0;font-size:13px}ul.viste li{margin:.1rem 0}
span.esito{display:inline-block;padding:2px 8px;border-radius:10px;font-size:13px;font-weight:600;white-space:nowrap;background:#eee;color:#444}
span.esito.e-ok{background:#e3f1e4;color:#1b5e20}span.esito.e-ko{background:#fbdcdc;color:#a00}span.esito.e-warn{background:#fff1cc;color:#7a5200}span.esito.e-off{background:#eee;color:#666}
tr.e-ko td{background:#fff6f6}details.non-eseguiti{margin:-1rem 0 1.5rem;background:none;border-left:3px solid #ccc}details.non-eseguiti>summary{color:#555}details.non-eseguiti table{margin:.5rem 0 0}</style></head>
<body><h1>${esc(app)} — Report Accessibilità ${esc(WCAG.breve)}</h1>
<table class="info"><caption>Scansione</caption>
<tr><th>Applicazione</th><td>${esc(app)}</td><th>Data</th><td>${esc(new Date(summary.generatedAt).toLocaleString('it-IT'))}</td></tr>
<tr><th>Indirizzo</th><td><code>${esc(BASE)}</code></td><th>Versione in prova</th><td>${PRODUCT_VERSION ? `<code>${esc(PRODUCT_VERSION)}</code>` : '<small>non dichiarata</small>'}</td></tr>
<tr><th>Standard</th><td>${esc(WCAG.breve)}<br><small>tag: ${esc([...TAG_USATI].join(', '))}</small></td><th>Viste analizzate</th><td>${results.length}${Object.keys(perTarget).length > 1 ? `<br><small>${Object.entries(perTarget).map(([t, l]) => `${esc(t)}: ${l.length}`).join(', ')}</small>` : ''}</td></tr>
<tr><th>Soglie del gate</th><td colspan="3"><code>fail-on=${esc(FAIL_ON)}</code>${MIN_SCORE != null && DO_LH ? ` · <code>min-score=${MIN_SCORE}</code>` : ''} · senza nome: ${FAIL_ON_NAMELESS ? 'blocca' : 'non blocca'} · solo mouse: ${FAIL_ON_MOUSE_ONLY ? 'blocca' : 'non blocca'} · screen reader: ${FAIL_ON_SCREEN_READER ? 'blocca' : 'non blocca'} · viste vuote: ${FAIL_ON_EMPTY ? 'blocca' : 'non blocca'} · errori HTTP: ${FAIL_ON_HTTP_ERROR ? 'blocca' : 'non blocca'}</td></tr>
</table>

<div class="gate ${gate.superato ? 'gate-ok' : 'gate-ko'}">
<h2>${gate.superato ? '✅ Gate superato' : '❌ Gate NON superato'}</h2>
${gate.superato ? `<p>Tutti i controlli che decidono l'esito sono superati${controlli.some(c => c.esito === 'incompleto' || (c.esito === 'non eseguito' && c.decide)) ? ' (alcuni controlli sono incompleti: vedi la tabella)' : ''}.</p>`
    : `<p>Motivi del fallimento:</p><ul>${gate.motivi.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`}
</div>

<table class="controlli"><caption>Controlli eseguiti — ogni controllo con la sua soglia, il risultato e le viste coinvolte</caption>
<tr><th>Controllo</th><th>Decide l'esito</th><th>Soglia</th><th>Risultato</th><th>Esito</th></tr>
${controlli.filter(c => c.esito !== 'non eseguito').map(rigaControllo).join('\n')}
</table>
${controlli.some(c => c.esito === 'non eseguito') ? `<details class="non-eseguiti"><summary>Controlli non eseguiti in questa scansione — ${controlli.filter(c => c.esito === 'non eseguito').length} <small>(clic per vederli)</small></summary>
<table class="controlli"><tr><th>Controllo</th><th>Decide l'esito</th><th>Soglia</th><th>Motivo</th><th>Esito</th></tr>
${controlli.filter(c => c.esito === 'non eseguito').map(rigaControllo).join('\n')}
</table></details>` : ''}

${perimetro.length ? `<details class="disclaimer" style="border-left-color:#b00">
<summary><h2>Perimetro non coperto — ${perimetro.length} ${perimetro.length === 1 ? 'voce' : 'voci'}</h2> <small>(non decide l'esito: clic per espandere)</small></summary>
<p>Viste previste dal config che <b>non</b> sono state analizzate, o solo in parte. Gli esiti di questo report
<b>non</b> valgono per loro: vanno ripristinate (dati, selettori, ambiente) e la scansione rifatta, oppure
dichiarate fuori perimetro.</p>
<table><tr><th>Console</th><th>Tipo</th><th>Nome</th><th>Esito</th><th>Motivo</th></tr>
${perimetro.map(p => `<tr><td>${esc(p.target)}</td><td>${esc(p.tipo)}</td><td><code>${esc(p.nome)}</code></td><td>${esc(p.esito)}</td><td>${esc(p.motivo)}</td></tr>`).join('\n')}</table>
</details>` : ''}

${summary.emptyViews.length ? `<div class="disclaimer" style="border-left-color:#b00">
<h2>Viste vuote — ${summary.emptyViews.length}: esito non valido</h2>
<p>Queste viste sono state analizzate <b>senza alcun contenuto accessibile</b>: la pagina non si è renderizzata
(backend irraggiungibile, sessione persa, errore dell'applicazione, tempi). Su una pagina vuota nessuna regola può
fallire, quindi i loro zeri <b>non</b> indicano viste accessibili. Rifare la scansione con l'ambiente in ordine.</p>
<ul>${summary.emptyViews.map(v => `<li>${esc(v.target)} — <b>${esc(v.name)}</b> — <code>${esc(v.url)}</code></li>`).join('')}</ul>
</div>` : ''}

${summary.httpErrorViews.length ? `<div class="disclaimer" style="border-left-color:#b00">
<h2>Viste in errore HTTP — ${summary.httpErrorViews.length}: esito non valido</h2>
<p>Queste viste sono arrivate con uno stato HTTP ≥ 400: è stata esaminata la <b>risposta d'errore</b>
dell'applicazione, non la pagina che si voleva vedere (URL non più valido, contesto di navigazione mancante,
sessione persa, bug). I loro risultati non dicono nulla di quella pagina. ${FAIL_ON_HTTP_ERROR ? 'Il gate le considera bloccanti (failOnHttpError).' : 'Il gate non le considera bloccanti (failOnHttpError spento).'}</p>
<ul>${summary.httpErrorViews.map(v => `<li>${esc(v.target)} — <b>${esc(v.name)}</b> — HTTP ${v.status} — <code>${esc(v.url)}</code></li>`).join('')}</ul>
</div>` : ''}

${tempi.numeroViste ? `<details class="disclaimer">
<summary><h2>Tempi della scansione — ${fmtDurata(tempi.durataMs)}, ${tempi.numeroViste} viste</h2> <small>(clic per espandere; dati anche in tempi.json)</small></summary>
<p>Dove va il tempo: dentro le viste, fase per fase, e fra una vista e l'altra (passi dei flow, menu,
ricorsione sui collegamenti). La scrittura dei report non e' compresa.</p>
<table class="tempi"><tr><th>Parte</th><th>Durata</th><th>Quota</th></tr>
<tr><td>Analisi delle viste (${tempi.numeroViste}, in media ${fmtDurata(tempi.mediaVistaMs)} l'una)</td><td>${fmtDurata(tempi.visteMs)}</td><td>${Math.round(tempi.visteMs / tempi.durataMs * 100)}%</td></tr>
<tr><td>Navigazione fra le viste</td><td>${fmtDurata(tempi.navigazioneMs)}</td><td>${Math.round(tempi.navigazioneMs / tempi.durataMs * 100)}%</td></tr>
<tr><td>Login</td><td>${fmtDurata(tempi.loginMs)}</td><td>${Math.round(tempi.loginMs / tempi.durataMs * 100)}%</td></tr>
<tr><td>Altro (avvio del browser, preparazione)</td><td>${fmtDurata(tempi.altroMs)}</td><td>${Math.round(tempi.altroMs / tempi.durataMs * 100)}%</td></tr></table>
<table class="tempi"><caption>Fasi dell'analisi, sommate su tutte le viste</caption>
<tr><th>Fase</th><th>Totale</th><th>Quota della scansione</th><th>Viste</th><th>Media per vista</th><th>Massimo</th></tr>
${tempi.fasi.map(f => `<tr><td>${esc(f.nome)}</td><td>${fmtDurata(f.totaleMs)}</td><td>${Math.round(f.quota * 100)}%</td><td>${f.viste}</td><td>${fmtDurata(f.mediaMs)}</td><td>${fmtDurata(f.massimoMs)} <small>${esc(f.vistaPiuLenta)}</small></td></tr>`).join('\n')}</table>
<table class="tempi"><caption>Le ${tempi.visteLente.length} viste piu' lente</caption>
<tr><th>Vista</th><th>Nella vista</th><th>Per arrivarci</th><th>Fasi principali</th></tr>
${tempi.visteLente.map(v => `<tr><td><a href="#pg${v.indice}">${esc(v.nome)}</a></td><td>${fmtDurata(v.totaleMs)}</td><td>${fmtDurata(v.primaDellaVistaMs)}</td><td>${Object.entries(v.fasi).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, ms]) => `${esc(FASI_TEMPI[k] || k)} ${fmtDurata(ms)}`).join('; ')}</td></tr>`).join('\n')}</table>
</details>` : ''}

${FALSE_POSITIVES_USATI.length ? `<details class="disclaimer">
<summary><h2>Falsi positivi dichiarati — ${summary.falsePositivesTotal} occorrenze escluse dalle segnalazioni</h2> <small>(non decidono l'esito: clic per espandere)</small></summary>
<p>Occorrenze già esaminate e riconosciute come falsi positivi. Non sono nascoste: sono
elencate qui con la motivazione e la verifica che le giustificano, così da poter essere contestate.
Per axe-core valgono solo per i casi <b>da verificare</b>: le sue violazioni, che decidono l'esito
della scansione, non sono mai derogabili. Per il secondo motore (IBM Equal Access) valgono anche per le
violazioni${FAIL_ON_EQUAL_ACCESS ? ', che con <code>failOnEqualAccess</code> decidono l\'esito: le deroghe registrate le tolgono dal gate e vanno quindi dimostrate sulle specifiche' : ', che in questa scansione non decidono l\'esito'}.</p>
<div class="scorri"><table class="fp"><colgroup><col style="width:12%"><col style="width:7%"><col style="width:11%"><col style="width:8%"><col style="width:25%"><col style="width:21%"><col style="width:7%"><col style="width:9%"></colgroup>
<tr><th>Voce</th><th>Motore</th><th>Regola / causa</th><th>Occor&shy;renze</th><th>Motivo</th><th>Verifica</th><th>Autore</th><th>Scadenza</th></tr>
${FALSE_POSITIVES_USATI.filter(v => v.matches > 0 || v.expired).map(v => `<tr${v.expired ? ' style="opacity:.55"' : ''}><td><code>${esc(v.id)}</code></td>
<td>${v.engine === 'equalAccess' ? 'IBM Equal Access' : 'axe-core'}</td><td><code>${esc(v.rule)}</code>${v.cause ? ` / <code>${esc(v.cause)}</code>` : ''}</td>
<td>${v.expired ? '<b>scaduta</b>' : v.matches}</td><td>${esc(v.reason)}</td><td>${esc(v.verification)}</td>
<td>${esc(v.author || '-')}</td><td class="nw">${esc(v.expires || 'nessuna')}</td></tr>`).join('\n')}</table></div>
${FALSE_POSITIVES_USATI.filter(v => !v.expired && v.matches === 0).length ? `<p><b>Senza riscontro:</b> le voci
${FALSE_POSITIVES_USATI.filter(v => !v.expired && v.matches === 0).map(v => `<code>${esc(v.id)}</code>`).join(', ')}
non hanno corrisposto ad alcuna occorrenza e non compaiono quindi in tabella. Se la scansione è completa
la deroga non serve più e va rimossa; se è parziale (poche pagine, <code>--only</code>, crawl ridotto) può
semplicemente non essere stata attraversata.</p>` : ''}
${FALSE_POSITIVES_USATI.filter(v => v.expired).length ? `<p><b>Scadute:</b> le occorrenze coperte da
${FALSE_POSITIVES_USATI.filter(v => v.expired).map(v => `<code>${esc(v.id)}</code>`).join(', ')}
sono tornate fra quelle da verificare: la misura va rifatta e la scadenza rinnovata.</p>` : ''}
</details>` : ''}

<details class="disclaimer">
<summary><h2>⚠️ Copertura e limiti dell'automazione</h2> <small>(clic per espandere)</small></summary>
<p>${esc(COVERAGE.automated)}</p>
<p>Restano <b>necessari test manuali/assistiti</b> non delegabili all'automazione:</p>
<ul>${COVERAGE.manualRequired.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
<p class="note">${esc(COVERAGE.note)}</p>
</details>

<table><caption>Riepilogo per regola WCAG — cosa correggere (ordinato per gravità e diffusione)</caption>
<tr><th>Regola axe</th><th>Gravità</th><th>Descrizione</th><th>Occorrenze</th><th>Pagine</th><th>WCAG (EN 301 549)</th><th>Rif.</th></tr>
${ruleRows}
</table>

${sistematici.length ? `<table><caption>Errori sistematici — la stessa regola sullo stesso componente in più viste: da correggere nel modello di pagina, una volta sola</caption>
<tr><th>Tipo</th><th>Regola axe</th><th>Descrizione</th><th>Componente</th><th>Viste</th><th>Occorrenze</th><th>WCAG (EN 301 549)</th></tr>
${sistematici.map(g => `<tr><td class="${g.tipo === 'violazione' ? 'ser' : 'mod'}">${esc(g.tipo)}</td><td><code>${esc(g.regola)}</code></td><td>${esc(g.descrizione)}</td>
<td><code class="sel">${esc(g.componente)}</code></td><td>${g.viste.length} di ${results.length}<br><small>${esc(g.viste.join(', '))}</small></td><td>${g.occorrenze}</td>
<td>${g.criteri.map(fmtCriterio).map(esc).join(', ') || '<small>buona pratica</small>'}</td></tr>`).join('\n')}
</table>` : ''}

${summary.stimaContrasti ? `<table><caption>Contrasti da verificare — stima sullo sfondo reale, per componente (${summary.stimaContrasti.nonConformi} testi sotto soglia, ${summary.stimaContrasti.parziali} in parte, ${summary.stimaContrasti.conformi} conformi, ${summary.stimaContrasti.nonStimabili} non stimabili)</caption>
<tr><th>Esito</th><th>Componente</th><th>Motori</th><th>Viste</th><th>Testi</th><th>Colore del testo</th><th>Contrasto stimato</th><th>Richiesto</th></tr>
${summary.stimaContrasti.perComponente.map(g => `<tr><td class="${ESITI_CC[g.esito][0]}">${esc(g.esito)}${Object.keys(g.esiti).length > 1 ? `<br><small>${Object.entries(g.esiti).map(([e, n]) => `${esc(e)}: ${n}`).join(', ')}</small>` : ''}</td>
<td><code class="sel">${esc(g.componente)}</code>${g.errore ? `<br><small>${esc(g.errore)}</small>` : ''}</td><td>${esc(g.motori.join(', '))}</td>
<td>${g.viste.length}<br><small>${esc(g.viste.slice(0, 8).join(', '))}${g.viste.length > 8 ? ' …' : ''}</small></td><td>${g.occorrenze}</td>
<td>${esc(g.testi.join(', ') || '-')}</td><td>${g.minimo != null ? intervallo(g.minimo, g.massimo) : '-'}</td><td>${g.richiesto.map(r => fmtR(r) + ':1').join(', ') || '-'}</td></tr>`).join('\n')}
</table>
<p><small>Stima fatta sui pixel della vista, col testo reso trasparente: sfondi sfumati, immagini e pseudo-elementi compresi.
Non è una decisione: un componente sotto soglia va corretto, uno sopra soglia può diventare un falso positivo dichiarato, citando questa misura.</small></p>` : ''}

${confronto ? `<table><caption>Confronto fra i due motori per criterio WCAG — occorrenze segnalate da axe-core e da IBM Equal Access</caption>
<tr><th>Criterio WCAG (EN 301 549)</th><th>axe: violazioni</th><th>axe: da verificare</th><th>IBM: violazioni</th><th>IBM: da verificare</th></tr>
${confronto.map(c => `<tr><td>${esc(fmtCriterio(c.criterio))}</td><td class="${c.axeViolazioni ? 'ser' : ''}">${c.axeViolazioni || '-'}</td><td>${c.axeDaVerificare || '-'}</td><td class="${c.eaViolazioni ? 'ser' : ''}">${c.eaViolazioni || '-'}</td><td>${c.eaDaVerificare || '-'}</td></tr>`).join('\n') || '<tr><td colspan="5">Nessuna occorrenza da nessuno dei due motori.</td></tr>'}
</table>
<p><small>Motore IBM Equal Access ${esc(summary.equalAccess.versione || '')}, regole ${esc(summary.equalAccess.regole)} (livelli A e AA), eseguito sullo stesso stato di ogni vista analizzato da axe-core.
Un criterio segnalato da un solo motore va esaminato: i due motori hanno regole e algoritmi diversi.</small></p>
${summary.equalAccess.perRegola.length ? `<table><caption>IBM Equal Access — violazioni per regola (ordinate per diffusione)</caption>
<tr><th>Regola</th><th>Esempio di messaggio</th><th>Occorrenze</th><th>Viste</th><th>WCAG (EN 301 549)</th></tr>
${summary.equalAccess.perRegola.map(g => `<tr><td><code>${esc(g.regola)}</code></td><td>${esc(g.messaggio)}</td><td>${g.occorrenze}</td><td>${g.viste}</td><td>${g.wcag.map(fmtCriterio).map(esc).join(', ')}</td></tr>`).join('\n')}
</table>` : ''}` : ''}

${riepilogoPagine}

<details class="pagine dettaglio">
<summary><h2>Dettaglio violazioni per pagina</h2> · ${results.length} ${results.length === 1 ? 'vista' : 'viste'}: <span class="${conSegnalazioni ? 'ser' : 'ok'}">${conSegnalazioni ? `${conSegnalazioni} con violazioni` : 'nessuna con violazioni'}</span> <small>(clic per aprire o chiudere; dentro, ogni vista si apre e si chiude da sola)</small></summary>
${details}
</details>
</body></html>`;
  writeReport(resolve(OUT, 'report.html'), html);
  return summary;
}

/* ----------------------------- controlli -------------------------------- */
/* Esito di OGNI controllo eseguito (o previsto e non eseguito), con soglia, risultato e viste
   coinvolte. E' l'unica fonte per il gate, il report HTML, summary.json, SARIF, JUnit e Sonar:
   cosi' nessun report puo' tacere un controllo che ha deciso l'esito, o che non ha potuto deciderlo.
   Esiti: 'superato' / 'non superato' (controlli che decidono il gate), 'nessuna segnalazione' /
   'segnalazioni' (controlli che non decidono), 'incompleto' (non eseguito su alcune viste),
   'non eseguito'. */
const GRUPPI_GOVA11Y = [
  { id: 'reflow', nome: 'Riflusso a 320px', criteri: 'WCAG 1.4.10', usato: 'reflow', regola: r => r === 'gova11y-reflow-320' },
  { id: 'textSpacing', nome: 'Spaziatura del testo', criteri: 'WCAG 1.4.12', usato: 'textSpacing', regola: r => r === 'gova11y-text-spacing' },
  { id: 'keyboardWalk', nome: 'Percorso da tastiera', criteri: 'WCAG 2.1.2, 2.4.7, 2.4.11', usato: 'keyboardWalk', regola: r => ['gova11y-focus-visible', 'gova11y-focus-obscured', 'gova11y-keyboard-trap'].includes(r) },
  { id: 'languageParts', nome: 'Lingua delle parti', criteri: 'WCAG 3.1.2', usato: 'languageParts', regola: r => r === 'gova11y-language-of-parts' },
  { id: 'script', nome: 'Verifiche degli script dei flow', criteri: 'criteri dichiarati dagli script', usato: null, regola: r => String(r).startsWith('gova11y-script-') },
];
const ESITI_KO = new Set(['non superato']);
// controlli che decidono il gate: se falliscono su una vista si ripetono una volta (vedi prova() in recordScan)
const CONTROLLI_DA_RIPETERE = new Set(GRUPPI_GOVA11Y.map(g => g.usato).filter(Boolean));
if (FAIL_ON_EQUAL_ACCESS) CONTROLLI_DA_RIPETERE.add('equalAccess');

function valutaControlli(results) {
  const controlli = [];
  const bloccante = v => FAIL_THRESHOLD > 0 && (SEVERITY_ORDER[v.impact] || 1) >= FAIL_THRESHOLD;
  const diGova11y = v => String(v.id).startsWith('gova11y-');
  const occorrenze = (pr, f) => pr.violations.filter(f).reduce((n, v) => n + v.nodes.length, 0);
  const vista = (pr, valore, nota) => ({ indice: results.indexOf(pr), target: pr.targetName, nome: pr.name, url: pr.url, sourceHint: pr.sourceHint || null, valore, nota: nota || null });
  const somma = viste => viste.reduce((n, x) => n + (Number(x.valore) || 0), 0);
  const nViste = results.length;
  const nonEseguitoSu = id => results.flatMap(pr => (pr.controlliNonEseguiti || []).filter(c => c.controllo === id).map(c => vista(pr, 0, `non eseguito: ${c.errore}`)));
  const add = c => controlli.push({ decide: false, eseguito: true, motivi: [], viste: [], ...c });
  // "nessun elemento su 238 viste" invece di "0 elementi in 0 viste": si vede che il controllo ha lavorato
  // "su N viste analizzate", al singolare con una vista sola ("su 1 vista analizzata")
  const su = (n, verbo = 'analizzate') => `su ${n} ${n === 1 ? `vista ${verbo.replace(/e$/, 'a')}` : `viste ${verbo}`}`;
  const conteggio = (n, unita, viste, tot, verbo = 'analizzate') => n
    ? `${n} ${n === 1 && unita[2] ? unita[2] : unita[1]} in ${viste} ${viste === 1 ? 'vista' : 'viste'} ${su(tot, verbo)}`
    : `${unita[0]} ${su(tot, verbo)}`;

  // 1. regole di axe-core
  {
    const tot = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const pr of results) for (const v of pr.violations) if (!diGova11y(v)) tot[v.impact] = (tot[v.impact] || 0) + v.nodes.length;
    const viste = results.map(pr => vista(pr, occorrenze(pr, v => !diGova11y(v) && bloccante(v)))).filter(x => x.valore);
    const n = somma(viste);
    add({ id: 'axe', nome: 'Regole axe-core', criteri: `${TAG_USATI.size ? [...TAG_USATI].join(', ') : TAGS.join(', ')}`, decide: FAIL_THRESHOLD > 0,
      soglia: FAIL_THRESHOLD > 0 ? `nessuna occorrenza di gravità ≥ ${FAIL_ON}` : 'nessuna (fail-on=none)',
      risultato: `critical ${tot.critical}, serious ${tot.serious}, moderate ${tot.moderate}, minor ${tot.minor} ${su(nViste)}`,
      esito: FAIL_THRESHOLD > 0 ? (n ? 'non superato' : 'superato') : (Object.values(tot).some(Boolean) ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: n ? [`${n} ${n === 1 ? 'occorrenza' : 'occorrenze'} axe di gravita' >= ${FAIL_ON}`] : [], viste });
  }
  // 2. controlli fuori da axe (stesso formato delle violazioni, stessa soglia fail-on)
  for (const g of GRUPPI_GOVA11Y) {
    const tutte = results.map(pr => vista(pr, occorrenze(pr, v => g.regola(v.id)))).filter(x => x.valore);
    if (!g.usato && !tutte.length) continue;
    // attivo se dichiarato da un target, o se ha almeno provato a girare su una vista
    const eseguito = g.usato ? (CONTROLLI_USATI.has(g.usato) || results.some(pr => (pr.controlliNonEseguiti || []).some(c => c.controllo === g.usato))) : true;
    const ko = results.map(pr => vista(pr, occorrenze(pr, v => g.regola(v.id) && bloccante(v)))).filter(x => x.valore);
    // viste su cui il controllo ha misurato (risultati vecchi senza il dato: tutte quelle senza errore)
    const misurate = id => results.filter(pr => pr.controlliEseguiti ? pr.controlliEseguiti.includes(id) : !(pr.controlliNonEseguiti || []).some(c => c.controllo === id)).length;
    const mancati = g.usato ? nonEseguitoSu(g.usato) : [];
    const n = somma(ko);
    const decide = FAIL_THRESHOLD > 0 && eseguito;
    /* Una vista su cui il controllo non ha potuto misurare non ha un esito: come per Lighthouse senza
       punteggio, il gate non lo considera superato ("esito non verificabile", non una violazione). */
    const motivi = [];
    if (n) motivi.push(`${n} ${n === 1 ? 'occorrenza' : 'occorrenze'} del controllo '${g.nome}' (${g.criteri}) di gravita' >= ${FAIL_ON}`);
    if (decide && mancati.length) motivi.push(`controllo '${g.nome}' non eseguito su ${mancati.length} ${mancati.length === 1 ? 'vista' : 'viste'}: esito non verificabile (${mancati.map(v => v.nome).join(', ')})`);
    add({ id: g.id, nome: g.nome, criteri: g.criteri, decide, eseguito,
      soglia: FAIL_THRESHOLD > 0 ? `nessuna occorrenza di gravità ≥ ${FAIL_ON}, eseguito su ogni vista` : 'nessuna (fail-on=none)',
      risultato: !eseguito ? 'non attivo in questa esecuzione' : `${conteggio(somma(tutte), ['nessuna occorrenza', 'occorrenze', 'occorrenza'], tutte.length, misurate(g.usato), 'misurate')}${mancati.length ? `; non eseguito su ${mancati.length} ${mancati.length === 1 ? 'vista' : 'viste'}` : ''}`,
      esito: !eseguito ? 'non eseguito' : motivi.length ? 'non superato' : mancati.length ? 'incompleto' : 'superato',
      motivi, viste: [...tutte, ...mancati] });
  }
  // 3. elementi interattivi senza nome (albero di accessibilita')
  {
    const viste = results.map(pr => vista(pr, pr.axTree ? pr.axTree.nameless.length : 0)).filter(x => x.valore);
    const n = somma(viste);
    add({ id: 'nameless', nome: 'Elementi interattivi senza nome accessibile', criteri: 'WCAG 4.1.2 (albero di accessibilità)', decide: FAIL_ON_NAMELESS,
      soglia: FAIL_ON_NAMELESS ? 'nessun elemento' : 'nessuna (failOnNameless=false)', risultato: conteggio(n, ['nessun elemento', 'elementi', 'elemento'], viste.length, nViste),
      esito: FAIL_ON_NAMELESS ? (n ? 'non superato' : 'superato') : (n ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: FAIL_ON_NAMELESS && n ? [`${n} elementi interattivi senza nome accessibile (a11y-tree)`] : [], viste });
  }
  // 4. comandi utilizzabili col solo mouse
  {
    const viste = results.map(pr => vista(pr, pr.soloMouse ? pr.soloMouse.totale : 0)).filter(x => x.valore);
    const n = somma(viste);
    add({ id: 'mouseOnly', nome: 'Comandi utilizzabili col solo mouse', criteri: 'WCAG 2.1.1', decide: FAIL_ON_MOUSE_ONLY && DO_MOUSE_ONLY, eseguito: DO_MOUSE_ONLY,
      soglia: FAIL_ON_MOUSE_ONLY ? 'nessun comando' : 'nessuna (failOnMouseOnly=false)',
      risultato: DO_MOUSE_ONLY ? conteggio(n, ['nessun comando', 'comandi', 'comando'], viste.length, nViste) : 'non attivo in questa esecuzione',
      esito: !DO_MOUSE_ONLY ? 'non eseguito' : FAIL_ON_MOUSE_ONLY ? (n ? 'non superato' : 'superato') : (n ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: FAIL_ON_MOUSE_ONLY && n ? [`${n} comandi utilizzabili col solo mouse (non raggiungibili da tastiera)`] : [], viste });
  }
  // 5. screen reader virtuale
  {
    const eseguito = results.some(pr => pr.sr);
    const viste = results.map(pr => vista(pr, pr.sr ? pr.sr.roleOnly.length : 0)).filter(x => x.valore);
    const n = somma(viste);
    const decide = FAIL_ON_SCREEN_READER && eseguito;
    add({ id: 'screenReader', nome: 'Screen reader virtuale: annunci col solo ruolo', criteri: 'WCAG 4.1.2', decide, eseguito,
      soglia: FAIL_ON_SCREEN_READER ? 'nessun annuncio col solo ruolo' : 'nessuna (failOnScreenReader=false)',
      risultato: eseguito ? conteggio(n, ['nessun annuncio col solo ruolo', 'annunci', 'annuncio'], viste.length, results.filter(pr => pr.sr).length, 'lette') : (FAIL_ON_SCREEN_READER ? 'richiesto dal gate ma disattivato in questa esecuzione' : 'non attivo in questa esecuzione'),
      esito: !eseguito ? 'non eseguito' : decide ? (n ? 'non superato' : 'superato') : (n ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: decide && n ? [`${n} annunci col solo ruolo del virtual screen reader (elementi letti senza nome)`] : [], viste });
  }
  // 6. Lighthouse (un livello disattivato da riga di comando non e' valutabile: il suo gate si salta)
  {
    const eseguito = results.some(pr => pr.lhScore != null || pr.lhEscluso || pr.lhMotivo) || (DO_LH && results.length > 0);
    const decide = MIN_SCORE != null && CLI_LH !== false && eseguito;
    const conPunteggio = results.filter(pr => pr.lhScore != null);
    const sotto = MIN_SCORE != null ? conPunteggio.filter(pr => pr.lhScore < MIN_SCORE) : [];
    const senza = results.filter(pr => pr.lhScore == null && !pr.lhEscluso);
    const escluse = results.filter(pr => pr.lhEscluso);
    const minimo = conPunteggio.length ? Math.min(...conPunteggio.map(pr => pr.lhScore)) : null;
    const pct = v => `${(v * 100).toFixed(0)}%`;
    const motivi = [];
    if (decide) {
      for (const pr of sotto) motivi.push(`Lighthouse ${pct(pr.lhScore)} < soglia ${pct(MIN_SCORE)} su ${pr.url}`);
      if (senza.length) motivi.push(`${senza.length} viste senza punteggio Lighthouse: soglia --min-score non verificabile (${senza.map(pr => pr.name).join(', ')})`);
    }
    add({ id: 'lighthouse', nome: 'Lighthouse (categoria accessibilità)', criteri: 'punteggio 0–100%', decide, eseguito,
      soglia: MIN_SCORE != null ? `punteggio ≥ ${pct(MIN_SCORE)} su ogni vista` : 'nessuna (minScore non impostato)',
      risultato: eseguito ? `${conPunteggio.length} ${conPunteggio.length === 1 ? 'vista' : 'viste'} con punteggio su ${nViste} ${nViste === 1 ? 'analizzata' : 'analizzate'}${minimo != null ? ` (minimo ${pct(minimo)})` : ''}: ${sotto.length} sotto soglia, ${senza.length} senza punteggio, ${escluse.length} escluse (dal flow o perché il loro URL ripeterebbe un'azione)` : 'non attivo in questa esecuzione',
      esito: !eseguito ? 'non eseguito' : decide ? (motivi.length ? 'non superato' : 'superato') : (sotto.length || senza.length ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi, viste: [...sotto.map(pr => vista(pr, pct(pr.lhScore), 'sotto soglia')), ...(eseguito ? senza.map(pr => vista(pr, null, `senza punteggio${pr.lhMotivo ? `: ${pr.lhMotivo}` : ''}`)) : []), ...escluse.map(pr => vista(pr, 'escluso', pr.lhMotivo ? `escluso: ${pr.lhMotivo}` : "escluso dal flow ('lighthouse': false)"))] });
  }
  // 7. viste vuote (pagina non renderizzata: i loro zeri non valgono)
  {
    const vuote = results.filter(pr => pr.vuota);
    add({ id: 'emptyViews', nome: 'Viste renderizzate (non vuote)', criteri: 'validità dell\'esito', decide: FAIL_ON_EMPTY,
      soglia: FAIL_ON_EMPTY ? 'nessuna vista vuota' : 'nessuna (failOnEmpty=false)', risultato: conteggio(vuote.length, ['nessuna vista vuota', 'viste vuote', 'vista vuota'], vuote.length, nViste).replace(/ in \d+ viste? su/, ' su'),
      esito: FAIL_ON_EMPTY ? (vuote.length ? 'non superato' : 'superato') : (vuote.length ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: FAIL_ON_EMPTY && vuote.length ? [`${vuote.length} viste vuote, esito non valido (pagina non renderizzata?): ${vuote.map(v => v.name).join(', ')}`] : [],
      viste: vuote.map(pr => vista(pr, 'vuota', 'nessun contenuto accessibile')) });
  }
  // 7b. viste in errore HTTP (risposta d'errore dell'applicazione: i loro zeri non valgono)
  {
    const errate = results.filter(pr => pr.erroreHttp);
    add({ id: 'httpErrors', nome: 'Viste senza errore HTTP', criteri: 'validità dell\'esito', decide: FAIL_ON_HTTP_ERROR,
      soglia: FAIL_ON_HTTP_ERROR ? 'nessuna vista con stato HTTP ≥ 400' : 'nessuna (failOnHttpError=false)', risultato: conteggio(errate.length, ['nessuna vista in errore HTTP', 'viste in errore HTTP', 'vista in errore HTTP'], errate.length, nViste).replace(/ in \d+ viste? su/, ' su'),
      esito: FAIL_ON_HTTP_ERROR ? (errate.length ? 'non superato' : 'superato') : (errate.length ? 'segnalazioni' : 'nessuna segnalazione'),
      motivi: FAIL_ON_HTTP_ERROR && errate.length ? [`${errate.length} viste in errore HTTP, esito non valido: ${errate.map(v => `${v.name} (${v.httpStatus})`).join(', ')}`] : [],
      viste: errate.map(pr => vista(pr, `HTTP ${pr.httpStatus}`, "risposta d'errore dell'applicazione")) });
  }
  // 8. controlli che non decidono l'esito, riportati come evidenza
  {
    const viste = results.map(pr => vista(pr, (pr.incomplete || []).reduce((n, v) => n + v.nodes.length, 0))).filter(x => x.valore);
    const n = somma(viste);
    add({ id: 'incomplete', nome: 'Casi da verificare', criteri: 'verifica manuale (axe incomplete, testi gia\' troncati)', eseguito: SHOW_INCOMPLETE,
      soglia: 'non decide l\'esito', risultato: SHOW_INCOMPLETE ? conteggio(n, ['nessuna occorrenza', 'occorrenze', 'occorrenza'], viste.length, nViste) : 'non mostrati in questa esecuzione',
      esito: !SHOW_INCOMPLETE ? 'non eseguito' : n ? 'segnalazioni' : 'nessuna segnalazione', viste });
  }
  {
    const eseguito = CONTROLLI_USATI.has('contrastEstimate');
    const gruppi = eseguito ? contrastiPerComponente(results) : [];
    const conta = e => gruppi.reduce((n, g) => n + (g.esiti[e] || 0), 0);
    add({ id: 'contrastEstimate', nome: 'Stima del contrasto sullo sfondo reale', criteri: 'WCAG 1.4.3 (casi da verificare)', eseguito,
      soglia: 'non decide l\'esito', risultato: eseguito ? `${conta('non conforme')} testi sotto soglia, ${conta('parziale')} in parte, ${conta('conforme')} conformi, ${conta('non stimabile')} non stimabili` : 'nessun caso da stimare o stima disattivata',
      esito: !eseguito ? 'non eseguito' : (conta('non conforme') || conta('parziale')) ? 'segnalazioni' : 'nessuna segnalazione' });
  }
  /* IBM Equal Access: decide il gate solo con failOnEqualAccess. Come per i controlli fuori da axe,
     una vista su cui il motore non ha potuto girare non ha un esito ("esito non verificabile"). */
  {
    const mancati = nonEseguitoSu('equalAccess');
    const eseguito = results.some(pr => pr.equalAccess) || mancati.length > 0;
    const viste = results.filter(pr => pr.equalAccess).map(pr => vista(pr, pr.equalAccess.violazioni.length)).filter(x => x.valore);
    const n = somma(viste);
    const decide = FAIL_ON_EQUAL_ACCESS && eseguito;
    const motivi = [];
    if (decide && n) motivi.push(`${n} ${n === 1 ? 'violazione' : 'violazioni'} di IBM Equal Access in ${viste.length} ${viste.length === 1 ? 'vista' : 'viste'}`);
    if (decide && mancati.length) motivi.push(`IBM Equal Access non eseguito su ${mancati.length} ${mancati.length === 1 ? 'vista' : 'viste'}: esito non verificabile (${mancati.map(v => v.nome).join(', ')})`);
    add({ id: 'equalAccess', nome: 'IBM Equal Access (secondo motore)', criteri: 'WCAG A e AA', decide, eseguito,
      soglia: FAIL_ON_EQUAL_ACCESS ? 'nessuna violazione, eseguito su ogni vista' : 'non decide l\'esito (failOnEqualAccess=false)',
      risultato: eseguito ? `${conteggio(n, ['nessuna violazione', 'violazioni', 'violazione'], viste.length, results.filter(pr => pr.equalAccess).length)}, ${results.reduce((k, pr) => k + (pr.equalAccess ? pr.equalAccess.daVerificare.length : 0), 0)} da verificare${(t => t ? ` (${t} sul fuoco confermati dal percorso col Tab)` : '')(results.reduce((k, pr) => k + (pr.equalAccess?.confermatiDaTab?.length || 0), 0))}${mancati.length ? `; non eseguito su ${mancati.length} ${mancati.length === 1 ? 'vista' : 'viste'}` : ''}` : 'non attivo in questa esecuzione',
      esito: !eseguito ? 'non eseguito' : motivi.length ? 'non superato' : decide ? (mancati.length ? 'incompleto' : 'superato') : (n || mancati.length) ? 'segnalazioni' : 'nessuna segnalazione',
      motivi, viste: [...viste, ...mancati] });
  }
  {
    const nonEseguiti = results.flatMap(pr => (pr.controlliNonEseguiti || []).filter(c => c.controllo !== 'equalAccess' && !GRUPPI_GOVA11Y.some(g => g.usato === c.controllo)).map(c => vista(pr, 0, `${c.controllo}: ${c.errore}`)));
    if (nonEseguiti.length) add({ id: 'altriNonEseguiti', nome: 'Analisi accessorie non eseguite', criteri: 'stima del contrasto, screenshot, rimisura', soglia: 'non decide l\'esito',
      risultato: `${nonEseguiti.length} analisi non eseguite`, esito: 'incompleto', viste: nonEseguiti });
  }
  {
    const usate = FALSE_POSITIVES_USATI;
    const scadute = usate.filter(v => v.expired);
    const coperte = results.reduce((n, pr) => n + (pr.falsePositives || []).length, 0);
    add({ id: 'falsePositives', nome: 'Falsi positivi dichiarati', criteri: 'registro delle deroghe', eseguito: usate.length > 0,
      soglia: 'non decide l\'esito (solo casi da verificare)', risultato: usate.length ? `${coperte} occorrenze coperte da ${usate.filter(v => v.matches > 0).length} voci su ${usate.length}${scadute.length ? `; ${scadute.length} voci scadute` : ''}` : 'nessun registro caricato',
      esito: !usate.length ? 'non eseguito' : scadute.length ? 'segnalazioni' : 'nessuna segnalazione' });
  }
  add({ id: 'perimetro', nome: 'Perimetro previsto dal config', criteri: 'copertura della scansione', soglia: 'non decide l\'esito',
    risultato: PERIMETRO.length ? `${PERIMETRO.length} ${PERIMETRO.length === 1 ? 'vista o flow non analizzato' : 'viste o flow non analizzati'}, o solo in parte` : 'tutte le viste previste sono state analizzate',
    esito: PERIMETRO.length ? 'segnalazioni' : 'nessuna segnalazione',
    viste: PERIMETRO.map(p => ({ indice: -1, target: p.target, nome: p.nome, url: null, sourceHint: null, valore: p.esito, nota: p.motivo })) });

  const motivi = controlli.filter(c => ESITI_KO.has(c.esito)).flatMap(c => c.motivi);
  return { controlli, gate: { superato: motivi.length === 0, motivi } };
}

/* ----------------------------- gate ------------------------------------- */
function evaluateGate(results, summary) {
  if (FAIL_ON_SCREEN_READER && !DO_SR && CLI_SR !== false) {
    console.warn("⚠ 'failOnScreenReader' richiesto ma il virtual screen reader e' disattivato: il gate non ha nulla da valutare.");
  }
  if (FAIL_ON_EQUAL_ACCESS && !results.some(pr => pr.equalAccess || (pr.controlliNonEseguiti || []).some(c => c.controllo === 'equalAccess'))) {
    console.warn("⚠ 'failOnEqualAccess' richiesto ma IBM Equal Access non e' attivo su nessuna vista (\"equalAccess\" nel target): il gate non ha nulla da valutare.");
  }
  // summary e' accettato per compatibilita': l'esito si ricava dai risultati, come per tutti i report
  return (summary && summary.gate ? summary.gate : valutaControlli(results).gate).motivi;
}

// Esportate per test/riuso programmatico (vedi test/); l'auto-run resta sotto IS_MAIN.
export {
  analyzeAxTree, analyzeMouseOnly, valutaControlli, evidenzeControlli, INIT_SOLO_MOUSE, runScreenReader, loadSR, AX_NAMELESS_RE, SR_ROLE_ONLY,
  // pure / helper
  parseArgs, resolveParam, credsFor, loadTargets, isAbsUrl, absUrl, loginUrl, loginAltrove, defaultCtxPath, envValue, flowEnvRefs, missingEnv, maskSecrets, MIN_SECRET,
  resolveModule, moduleVersion, missingModules, featureRequested, preflightOptionalDeps, checkDeps, OPTIONAL_FEATURES, slug, normUrl, normVisit, normalizeLinks,
  summarizeImpacts, fmtCounts, xmlEscape, appLabel, wcagVerificato, buildCoverage,
  criteriWcag, rifEn, fmtCriterio, selettoreComponente, erroriSistematici, confrontoMotori, espandiEnv, PERIMETRO,
  runEqualAccess, fotografaOccorrenze,
  decodificaPng, rapportoContrasto, valutaContrasto, contrastiPerComponente, stimaContrasti, chiaveOccorrenza,
  // browser
  harvestLinks, recordScan, confermaDalTab, REGOLE_CONFERMATE_DAL_TAB, runStep, caricaScript, selectOption, analyzeReflow, analyzeTextSpacing, analyzeKeyboard, analyzeLanguageParts, violazioniDaProblemi, applyWait, runFlows, recurseFollow, login, postLogin, scan, runLighthouse, lhPreparaSessione, lhStessaVista,
  // reporters + gate
  writeAxeJson, writeAriaTrees, writeSarif, writeSonar, writeJUnit, writeSummaryAndHtml, evaluateGate, riepilogoTempi, fmtDurata,
};

/* ----------------------------- main ------------------------------------- */
if (IS_MAIN) (async () => {
  // Verifica dei prerequisiti opzionali "a secco": nessuna scansione, nessun browser.
  if (args['check-deps']) process.exit(checkDeps());

  const results = await scan();
  writeAxeJson(results);
  const ariaFiles = writeAriaTrees(results);
  // summary.json e report.html per primi: calcolano l'esito dei controlli, che gli altri report riusano
  const summary = writeSummaryAndHtml(results, ariaFiles);
  writeSarif(results, summary);
  writeSonar(results, summary);
  writeJUnit(results, summary);

  console.log(`\nReport scritti in: ${OUT}`);
  console.log(`  durata della scansione: ${fmtDurata(performance.now() - TEMPI.avvio)} (dettaglio in tempi.json e nel report)`);
  console.log(`  axe-results.json | a11y.sarif | sonar-issues.json | a11y-junit.xml | summary.json | tempi.json | report.html${Object.keys(ariaFiles).length ? ` | aria-tree/ (${Object.keys(ariaFiles).length} file)` : ''}`);

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
