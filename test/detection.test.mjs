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
// Test di rilevamento (step 2 ariaSnapshot + step 3 virtual screen reader) sul CODICE REALE
// di a11y-scan.mjs. Verifica che:
//  - un elemento interattivo VISIBILE senza nome venga rilevato da entrambi i livelli;
//  - un elemento NASCOSTO (display:none) NON venga rilevato (onorare la visibilita');
//  - un elemento con nome accessibile NON produca falsi positivi.
// Uso: node test/detection.test.mjs   (exit 0 = ok, 1 = fallito)
import { chromium } from 'playwright';
import { analyzeAxTree, runScreenReader } from '../a11y-scan.mjs';

const HTML = `<body>
  <h1>Pagina di prova</h1>
  <button>Salva</button>                     <!-- named: OK -->
  <button class="icona"></button>            <!-- VISIBILE senza nome: deve emergere -->
  <a href="/x"><img alt="" src="i.png"></a>  <!-- link VISIBILE senza nome -->
  <label for="ok">Cerca</label><input id="ok" type="text">   <!-- named via label: OK -->
  <span id="lbl1">Codice fiscale</span>
  <input type="text" aria-labelledby="lbl1"> <!-- named via aria-labelledby: esercita CSS.escape -->
  <div style="display:none">
    <button></button><input type="text">     <!-- NASCOSTI: non devono emergere -->
  </div>
</body>`;

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.setContent(HTML);

console.log('Step 2 — analyzeAxTree (ariaSnapshot):');
const ax = await analyzeAxTree(page);
const axRoles = ax.nameless.map(n => n.role).sort();
check(axRoles.includes('button'), 'rileva il button visibile senza nome');
check(axRoles.includes('link'), 'rileva il link visibile senza nome');
check(ax.nameless.length === 2, `NON rileva nascosti/named (attesi 2, trovati ${ax.nameless.length}: ${JSON.stringify(axRoles)})`);

console.log('Step 3 — runScreenReader (virtual screen reader, potatura visibilita\'):');
const sr = await runScreenReader(page);
check(sr !== null, 'moduli SR disponibili ed esecuzione riuscita');
if (sr) {
  check(sr.roleOnly.length === 2, `annunci solo-ruolo attesi 2 (button+link), trovati ${sr.roleOnly.length}: ${JSON.stringify(sr.roleOnly)}`);
  check(sr.phrases.some(p => p === 'button, Salva'), 'annuncia "button, Salva" per il named');
  check(!sr.phrases.includes('textbox'), 'NON annuncia la textbox nascosta (visibilita\' onorata)');
  // regressione bug "CSS is not defined": aria-labelledby richiede CSS.escape per risolvere l'idref
  check(sr.phrases.some(p => /textbox, Codice fiscale/.test(p)), 'risolve aria-labelledby (CSS.escape ok): "textbox, Codice fiscale"');
}

await browser.close();
console.log(failed ? `\n❌ ${failed} check falliti` : '\n✅ tutti i check superati');
process.exit(failed ? 1 : 0);
