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

// Gate del secondo motore (--fail-on-equal-access), su dati sintetici e senza browser.
// Suite a parte: le opzioni del gate si leggono all'import del modulo, e la suite 'unit'
// verifica il comportamento predefinito (opzione spenta).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = mkdtempSync(join(tmpdir(), 'gova11y-gate-ea-'));
process.argv = [process.argv[0], process.argv[1], '--out', OUT, '--no-lighthouse', '--no-screen-reader', '--fail-on-equal-access'];
const M = await import('../a11y-scan.mjs');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };

const ea = (regola, xpath) => ({ regola, motivo: 'Fail_1', messaggio: `messaggio ${regola}`, snippet: '<table>', xpath, wcag: ['1.3.1'] });
const vista = (name, equalAccess, extra = {}) => ({ target: 'app', targetName: 'App', name, url: `http://h/app/${name}`, violations: [], incomplete: [],
  lhScore: null, axTree: { nodes: 12, nameless: [] }, ariaSnapshot: '- main', sr: null, vuota: false, equalAccess, controlliEseguiti: equalAccess ? ['equalAccess'] : [], ...extra });

console.log('— violazioni del secondo motore con failOnEqualAccess');
const CON_VIOLAZIONI = [
  vista('lista', { violazioni: [ea('table_headers_exists', '/html/body/table[1]'), ea('table_headers_exists', '/html/body/table[2]')], daVerificare: [] }),
  vista('dettaglio', { violazioni: [], daVerificare: [ea('text_block_heading', '/html/body/p[1]')] }),
];
const summary = M.writeSummaryAndHtml(CON_VIOLAZIONI, M.writeAriaTrees(CON_VIOLAZIONI));
const cEa = summary.controlli.find(c => c.id === 'equalAccess');
check(cEa.decide === true && cEa.esito === 'non superato', `controllo IBM: decide e non superato (${cEa.esito})`);
check(summary.gate.superato === false && summary.gate.motivi.some(m => /2 violazioni di IBM Equal Access in 1 vista/.test(m)), `gate: motivo con le violazioni IBM (${summary.gate.motivi})`);
check(summary.failOnEqualAccess === true, 'summary.json porta failOnEqualAccess');
check(/decide il gate/.test(readFileSync(join(OUT, 'report.html'), 'utf8')), 'report.html: la sezione IBM della vista dice che decide il gate');
M.writeSarif(CON_VIOLAZIONI, summary);
const sarif = JSON.parse(readFileSync(join(OUT, 'a11y.sarif'), 'utf8'));
const runEa = sarif.runs.find(r => r.tool.driver.name === 'IBM Equal Access');
check(runEa && runEa.results.length === 2 && runEa.results.every(r => r.level === 'error'), 'SARIF: violazioni IBM a livello error');
check(sarif.runs.find(r => r.tool.driver.name === 'gov-a11y').results.some(r => r.ruleId === 'gova11y-gate' && /IBM Equal Access/.test(r.message.text)), 'SARIF: esito del gate con il motivo IBM');
M.writeSonar(CON_VIOLAZIONI, summary);
const sonar = JSON.parse(readFileSync(join(OUT, 'sonar-issues.json'), 'utf8'));
check(sonar.issues.filter(i => i.engineId === 'equal-access').length === 2, 'Sonar: violazioni IBM importate');
M.writeJUnit(CON_VIOLAZIONI, summary);
const junit = readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8');
check(/<testcase classname="a11y.App" name="lista [^"]*">\s*<failure message="2 violazioni IBM Equal Access"/.test(junit), 'JUnit: la vista con violazioni IBM fallisce');
check(!/name="dettaglio[^"]*">\s*<failure/.test(junit), 'JUnit: i casi da verificare IBM non fanno fallire la vista');

console.log('— solo casi da verificare: gate superato');
const SOLO_DA_VERIFICARE = [CON_VIOLAZIONI[1]];
const esitoDv = M.valutaControlli(SOLO_DA_VERIFICARE);
check(esitoDv.gate.superato && esitoDv.controlli.find(c => c.id === 'equalAccess').esito === 'superato', 'i casi da verificare IBM non decidono');

console.log('— motore non eseguito su una vista');
const NON_ESEGUITO = [vista('live', null, { controlliNonEseguiti: [{ controllo: 'equalAccess', errore: 'Execution context was destroyed (anche al secondo tentativo)' }] })];
const esitoNe = M.valutaControlli(NON_ESEGUITO);
const cNe = esitoNe.controlli.find(c => c.id === 'equalAccess');
check(cNe.eseguito && cNe.esito === 'non superato' && cNe.viste.some(v => /secondo tentativo/.test(v.nota)), 'IBM non eseguito: non superato, con il motivo per vista');
check(esitoNe.gate.motivi.some(m => /IBM Equal Access non eseguito su 1 vista: esito non verificabile \(live\)/.test(m)), 'gate: esito non verificabile');
check(!esitoNe.controlli.some(c => c.id === 'altriNonEseguiti'), 'IBM non eseguito non finisce fra le analisi accessorie');

console.log('— target senza secondo motore: nulla da valutare');
const SENZA = [vista('home', null)];
const esitoSenza = M.valutaControlli(SENZA);
check(esitoSenza.gate.superato && esitoSenza.controlli.find(c => c.id === 'equalAccess').esito === 'non eseguito', 'nessuna vista con IBM: controllo non eseguito, gate superato');

console.log(failed ? `\n❌ gate-equal-access: ${failed} check falliti` : '\n✅ gate-equal-access: tutti i check superati');
process.exit(failed ? 1 : 0);
