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

// Gate del perimetro (--fail-on-skipped), su dati sintetici e senza browser.
// Suite a parte: le opzioni del gate si leggono all'import del modulo, e la suite 'integration'
// verifica il comportamento predefinito (opzione spenta).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = mkdtempSync(join(tmpdir(), 'gova11y-gate-skipped-'));
process.argv = [process.argv[0], process.argv[1], '--out', OUT, '--no-lighthouse', '--no-screen-reader', '--fail-on-skipped'];
const M = await import('../a11y-scan.mjs');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };

const vista = name => ({ target: 'app', targetName: 'App', name, url: `http://h/app/${name}`, violations: [], incomplete: [],
  lhScore: null, axTree: { nodes: 12, nameless: [] }, ariaSnapshot: '- main', sr: null, vuota: false, equalAccess: null,
  httpStatus: 200, erroreHttp: false, controlliEseguiti: [] });
const VISTE = [vista('elenco')];

console.log('— perimetro completo: gate superato');
M.PERIMETRO.length = 0;
let esito = M.valutaControlli(VISTE);
check(esito.gate.superato && esito.controlli.find(x => x.id === 'perimetro').esito === 'superato', 'nessuna voce: controllo perimetro superato');

console.log('— flow saltato con failOnSkipped');
M.PERIMETRO.push({ target: 'App', tipo: 'flow', nome: 'dettaglio', esito: 'saltato', motivo: "elemento '.riga' assente in /elenco" });
const summary = M.writeSummaryAndHtml(VISTE, M.writeAriaTrees(VISTE));
const c = summary.controlli.find(x => x.id === 'perimetro');
check(c.decide === true && c.esito === 'non superato', `controllo perimetro: decide e non superato (${c.esito})`);
check(summary.gate.superato === false && summary.gate.motivi.some(m => /perimetro incompleto, 1 voce: flow dettaglio saltato/.test(m)), `gate: motivo con il flow (${summary.gate.motivi})`);
check(summary.failOnSkipped === true && summary.perimetro.length === 1, 'summary.json: opzione e voce del perimetro');
const html = readFileSync(join(OUT, 'report.html'), 'utf8');
check(/perimetro incompleto: blocca/.test(html) && /blocca il gate \(failOnSkipped\)/.test(html), 'report.html: soglie del gate e riquadro del perimetro');
M.writeSarif(VISTE, summary);
const sarif = JSON.parse(readFileSync(join(OUT, 'a11y.sarif'), 'utf8'));
check(sarif.runs.find(r => r.tool.driver.name === 'gov-a11y').results.some(r => r.ruleId === 'gova11y-perimeter' && r.level === 'error'), 'SARIF: voce del perimetro a livello error');
M.writeJUnit(VISTE, summary);
const junit = readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8');
check(/<testsuite name="perimetro" tests="1" failures="1" skipped="0">/.test(junit), 'JUnit: suite del perimetro con la voce fallita');
check(/classname="a11y.perimetro" name="App flow dettaglio">\s*<failure message="saltato: /.test(junit), 'JUnit: il flow saltato fallisce');

console.log('— vista opzionale assente con failOnSkipped');
M.PERIMETRO.length = 0;
M.PERIMETRO.push({ target: 'App', tipo: 'flow', nome: 'modulo', esito: 'saltato', motivo: "elemento '.riga' assente in /modulo", opzionale: true });
esito = M.valutaControlli(VISTE);
check(esito.gate.superato && esito.controlli.find(x => x.id === 'perimetro').esito === 'superato', 'la vista opzionale assente non blocca il gate');
M.writeJUnit(VISTE, M.writeSummaryAndHtml(VISTE, M.writeAriaTrees(VISTE)));
check(/<testsuite name="perimetro" tests="1" failures="0" skipped="1">/.test(readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8')), 'JUnit: la vista opzionale assente resta saltata, non fallita');
M.PERIMETRO.push({ target: 'App', tipo: 'flow', nome: 'dettaglio', esito: 'saltato', motivo: "elemento '.riga' assente in /elenco" });
esito = M.valutaControlli(VISTE);
check(!esito.gate.superato && esito.gate.motivi.some(m => /1 voce: flow dettaglio saltato$/.test(m)), `con una voce non opzionale il gate fallisce solo per lei (${esito.gate.motivi})`);

console.log(failed ? `\n❌ gate-skipped: ${failed} check falliti` : '\n✅ gate-skipped: tutti i check superati');
process.exit(failed ? 1 : 0);
