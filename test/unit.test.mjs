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
eq(M.loginUrl({ loginPath: '/auth/realmdb' }, 'https://collaudo.example.it/govhub/'), 'https://collaudo.example.it/govhub/auth/realmdb', 'loginBase: il loginPath relativo si accoda (anche a un percorso), senza doppia barra');
eq(M.loginUrl({ loginPath: 'http://localhost:5200/auth/realmdb' }, 'https://altro'), 'http://localhost:5200/auth/realmdb', 'loginBase: un loginPath assoluto resta com\'e\'');
check(M.loginUrl({ loginPath: '/auth' }, null).startsWith('http') && M.loginUrl({ loginPath: '/auth' }, null).endsWith('/auth'), 'senza loginBase il loginPath relativo va su --base');
eq(M.defaultCtxPath({ loginPath: '/auth/realmdb' }, 'http://localhost:5200'), '/', 'contextPath di default: radice di --base anche con il login su loginBase');
check(M.loginAltrove({ loginPath: '/auth' }, 'http://h') && !M.loginAltrove({ loginPath: '/auth' }, null), 'loginAltrove: login altrove con loginBase, non senza');

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

console.log('— criteri WCAG ed EN 301 549');
eq(M.criteriWcag(['cat.color', 'wcag2aa', 'wcag21a', 'wcag143', 'wcag1410', 'wcag2411', 'wcag143']), ['1.4.3', '1.4.10', '2.4.11'], 'criteri dai tag axe (livelli ignorati, niente doppioni)');
eq(M.rifEn('1.4.3'), '9.1.4.3', 'EN 301 549: clausola 9 + criterio');
eq(M.rifEn('2.5.8'), null, 'criterio introdotto dalle WCAG 2.2: assente in EN 301 549 v3.2.1');
eq(M.fmtCriterio('4.1.2'), '4.1.2 (EN 9.4.1.2)', 'forma per il report');

console.log('— errori sistematici');
eq(M.selettoreComponente(['.col-6[_ngcontent-ng-c894269316=""]:nth-child(3) > .summary-card-value']), '.col-6 > .summary-card-value', 'componente senza attributi Angular né posizione');
const vRiga = (id, sel) => ({ id, help: id, impact: 'serious', tags: ['wcag143'], nodes: [{ target: [sel] }] });
const SIST = [
  { name: 'a', violations: [vRiga('color-contrast', '.card[_ngcontent-ng-c1]:nth-child(1) > h2')], incomplete: [] },
  { name: 'b', violations: [vRiga('color-contrast', '.card[_ngcontent-ng-c2]:nth-child(4) > h2')], incomplete: [vRiga('color-contrast', '.chip')] },
  { name: 'c', violations: [vRiga('color-contrast', '.altro')], incomplete: [vRiga('color-contrast', '.chip')] },
];
const sist = M.erroriSistematici(SIST);
eq(sist.map(g => [g.tipo, g.componente, g.viste.length]), [['violazione', '.card > h2', 2], ['da verificare', '.chip', 2]], 'stessa regola sullo stesso componente in più viste; violazioni prima');
check(!sist.some(g => g.componente === '.altro'), 'un componente presente in una sola vista non è sistematico');
const conf = M.confrontoMotori([{ violations: [vRiga('color-contrast', 'p')], incomplete: [], equalAccess: { violazioni: [{ wcag: ['1.4.3'] }, { wcag: ['1.1.1'] }], daVerificare: [] } }]);
eq(conf.map(c => [c.criterio, c.axeViolazioni, c.eaViolazioni]), [['1.1.1', 0, 1], ['1.4.3', 1, 1]], 'confronto fra motori per criterio, in ordine di criterio');

console.log("— variabili d'ambiente nelle intestazioni");
process.env.A11Y_TEST_PRINCIPAL = 'utente.prova';
delete process.env.A11Y_TEST_NON_IMPOSTATA;
eq(M.espandiEnv({ 'X-Principal': '${A11Y_TEST_PRINCIPAL}', 'X-Fisso': 'abc' }), { valori: { 'X-Principal': 'utente.prova', 'X-Fisso': 'abc' }, mancanti: [] }, '${NOME} sostituito, valori fissi invariati');
eq(M.espandiEnv({ 'X-Principal': '${A11Y_TEST_NON_IMPOSTATA}' }).mancanti, ['A11Y_TEST_NON_IMPOSTATA'], 'variabile non impostata segnalata');

console.log('— stima del contrasto');
eq(Math.round(M.rapportoContrasto([0, 0, 0], [255, 255, 255]) * 100) / 100, 21, 'nero su bianco: 21:1');
eq(Math.round(M.rapportoContrasto([118, 118, 118], [255, 255, 255]) * 100) / 100, 4.54, '#767676 su bianco: 4,54:1');
// PNG costruito a mano, con un filtro diverso per ogni riga: la decodifica deve ridare i pixel
const { deflateSync } = await import('node:zlib');
const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const pezzo = (nome, dati) => { const l = Buffer.alloc(4); l.writeUInt32BE(dati.length); const t = Buffer.concat([Buffer.from(nome, 'ascii'), dati]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([l, t, c]); };
const PIX = [[[10, 20, 30], [200, 100, 50], [0, 255, 0]], [[1, 2, 3], [250, 250, 250], [9, 99, 199]], [[40, 40, 40], [41, 42, 43], [255, 0, 255]], [[7, 7, 7], [128, 64, 32], [16, 32, 64]], [[100, 0, 0], [0, 100, 0], [0, 0, 100]]];
const filtra = (riga, prec, f) => riga.map((v, i) => { const a = i >= 3 ? riga[i - 3] : 0, b = prec[i], c = i >= 3 ? prec[i - 3] : 0; const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); const pr = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]; return (v - pr) & 255; });
let precRiga = new Array(9).fill(0);
const righe = PIX.map((r, y) => { const riga = r.flat(); const out = [y, ...filtra(riga, precRiga, y)]; precRiga = riga; return out; });
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(5, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pezzo('IHDR', ihdr), pezzo('IDAT', deflateSync(Buffer.from(righe.flat()))), pezzo('IEND', Buffer.alloc(0))]);
const dec = M.decodificaPng(png);
eq([dec.larghezza, dec.altezza], [3, 5], 'PNG: dimensioni');
eq([...dec.dati].filter((_, i) => i % 4 !== 3), PIX.flat(2), 'PNG: pixel ricostruiti con tutti i filtri (0-4)');
const bianco = M.valutaContrasto([118, 118, 118, 1], [[[255, 255, 255], 100]], 4.5);
eq([bianco.minimo, bianco.esito], [4.54, 'conforme'], 'testo #767676 su bianco: conforme');
const sfumato = M.valutaContrasto([255, 255, 255, 1], [[[0, 0, 0], 50], [[200, 200, 200], 50]], 4.5);
eq([sfumato.esito, sfumato.sotto], ['parziale', 0.5], 'gradiente che passa la soglia a metà: parziale, 50% sotto');
eq(M.valutaContrasto([255, 255, 255, 1], [[[200, 200, 200], 99], [[0, 0, 0], 1]], 4.5).esito, 'non conforme', 'un pixel scuro isolato (1%) non cambia l\'esito');
eq(M.valutaContrasto([255, 255, 255, 0.85], [[[13, 110, 253], 10]], 4.5).minimo < M.valutaContrasto([255, 255, 255, 1], [[[13, 110, 253], 10]], 4.5).minimo, true, 'testo semitrasparente: composto sullo sfondo, contrasto più basso');
eq(M.valutaContrasto([0, 0, 0, 1], [[[255, 255, 255], 1]], 4.5).minimo, 21, 'minimo per difetto, senza superare il valore vero');
const stimaA = { componente: 'a.chip > span.num', testo: '#6c757d', alfa: 1, minimo: 4.48, massimo: 4.48, richiesto: 4.5, esito: 'non conforme' };
const stimaB = { componente: 'span.hint', testo: '#333333', alfa: 1, minimo: 12.6, massimo: 12.6, richiesto: 4.5, esito: 'conforme' };
const nodoCc = c => ({ target: ['x'], contrasto: c });
const gruppiCc = M.contrastiPerComponente([
  { name: 'v1', incomplete: [{ id: 'color-contrast', nodes: [nodoCc(stimaB), nodoCc(stimaA)] }], equalAccess: { violazioni: [{ regola: 'text_contrast_sufficient', contrasto: stimaA }], daVerificare: [] } },
  { name: 'v2', incomplete: [{ id: 'color-contrast', nodes: [nodoCc({ ...stimaA })] }], equalAccess: null },
]);
eq(gruppiCc.map(g => [g.componente, g.esito, g.viste.length, g.occorrenze, g.motori.join('+')]), [['a.chip > span.num', 'non conforme', 2, 2, 'axe+IBM'], ['span.hint', 'conforme', 1, 1, 'axe']], 'stime per componente: sotto soglia prima; lo stesso elemento visto dai due motori conta una volta');

console.log(failed ? `\n❌ unit: ${failed} check falliti` : '\n✅ unit: tutti i check superati');
process.exit(failed ? 1 : 0);
