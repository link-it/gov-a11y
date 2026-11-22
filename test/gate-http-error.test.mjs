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

// Gate delle viste in errore HTTP (--fail-on-http-error), su dati sintetici e senza browser.
// Suite a parte: le opzioni del gate si leggono all'import del modulo, e la suite 'integration'
// verifica il comportamento predefinito (opzione spenta).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = mkdtempSync(join(tmpdir(), 'gova11y-gate-http-'));
process.argv = [process.argv[0], process.argv[1], '--out', OUT, '--no-lighthouse', '--no-screen-reader', '--fail-on-http-error'];
const M = await import('../a11y-scan.mjs');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };

const vista = (name, httpStatus) => ({ target: 'app', targetName: 'App', name, url: `http://h/app/${name}`, violations: [], incomplete: [],
  lhScore: null, axTree: { nodes: 12, nameless: [] }, ariaSnapshot: '- main', sr: null, vuota: false, equalAccess: null,
  httpStatus, erroreHttp: httpStatus != null && httpStatus >= 400, controlliEseguiti: [] });

console.log('— vista in errore HTTP con failOnHttpError');
const VISTE = [vista('elenco', 200), vista('spostata', 503), vista('locale', null)];
const summary = M.writeSummaryAndHtml(VISTE, M.writeAriaTrees(VISTE));
const c = summary.controlli.find(x => x.id === 'httpErrors');
check(c.decide === true && c.esito === 'non superato', `controllo httpErrors: decide e non superato (${c.esito})`);
check(summary.gate.superato === false && summary.gate.motivi.some(m => /1 viste in errore HTTP, esito non valido: spostata \(503\)/.test(m)), `gate: motivo con la vista e lo stato (${summary.gate.motivi})`);
check(summary.failOnHttpError === true && summary.httpErrorViews.length === 1, 'summary.json: opzione e vista in errore');
check(summary.pages.find(p => p.name === 'locale').httpStatus === null, 'stato non noto (null): non e\' un errore');
check(/errori HTTP: blocca/.test(readFileSync(join(OUT, 'report.html'), 'utf8')), 'report.html: soglie del gate con gli errori HTTP');
M.writeSarif(VISTE, summary);
const sarif = JSON.parse(readFileSync(join(OUT, 'a11y.sarif'), 'utf8'));
check(sarif.runs.find(r => r.tool.driver.name === 'gov-a11y').results.some(r => r.ruleId === 'gova11y-http-error' && r.level === 'error' && /503/.test(r.message.text)), 'SARIF: vista in errore HTTP a livello error');
M.writeJUnit(VISTE, summary);
const junit = readFileSync(join(OUT, 'a11y-junit.xml'), 'utf8');
check(/name="spostata [^"]*">\s*<failure message="errore HTTP 503"/.test(junit), 'JUnit: la vista in errore HTTP fallisce');
check(!/name="elenco[^"]*">\s*<failure/.test(junit), 'JUnit: la vista con stato 200 non fallisce');

console.log('— nessuna vista in errore: gate superato');
const esito = M.valutaControlli([VISTE[0], VISTE[2]]);
check(esito.gate.superato && esito.controlli.find(x => x.id === 'httpErrors').esito === 'superato', 'nessun errore HTTP: controllo superato');

console.log(failed ? `\n❌ gate-http-error: ${failed} check falliti` : '\n✅ gate-http-error: tutti i check superati');
process.exit(failed ? 1 : 0);
