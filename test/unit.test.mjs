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

console.log('— evaluateGate');
const reasons = M.evaluateGate(RESULTS, summary);
check(Array.isArray(reasons) && reasons.length >= 1, 'gate fallisce con 1 serious (fail-on=serious di default)');

console.log(failed ? `\n❌ unit: ${failed} check falliti` : '\n✅ unit: tutti i check superati');
process.exit(failed ? 1 : 0);
