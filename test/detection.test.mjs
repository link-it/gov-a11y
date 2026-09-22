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
import { analyzeAxTree, analyzeMouseOnly, INIT_SOLO_MOUSE, runScreenReader } from '../a11y-scan.mjs';

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

/* ---- comandi utilizzabili col solo mouse (gestore del clic senza tastiera) ---- */
const HTML_CLIC = `<body>
  <div id="comando-nudo">Apri</div>                      <!-- clic e non focalizzabile: deve emergere -->
  <img id="icona" alt="" style="width:16px;height:16px">  <!-- come il bottone del calendario: deve emergere -->
  <button id="vero">Salva</button>                       <!-- gia' raggiungibile: no -->
  <div id="con-tabindex" tabindex="0">Ok</div>           <!-- gia' raggiungibile: no -->
  <form id="contenitore"><a href="/x">vai</a></form>     <!-- contenitore con delega: no -->
  <div id="nascosto" style="display:none">X</div>        <!-- non visibile: no -->
  <div id="escluso" class="da-ignorare">Y</div>          <!-- escluso dal target: no -->
  <div id="senza-gestore">Z</div>                        <!-- nessun gestore: no -->
  <div role="grid"><span id="voce-composita" role="gridcell" tabindex="-1">3</span></div>  <!-- roving tabindex: no -->
</body>`;

console.log('\nComandi utilizzabili col solo mouse:');
const ctxClic = await browser.newContext();
await ctxClic.addInitScript(INIT_SOLO_MOUSE);
const pagClic = await ctxClic.newPage();
await pagClic.setContent(HTML_CLIC);
await pagClic.evaluate(() => {
  ['comando-nudo', 'icona', 'vero', 'con-tabindex', 'contenitore', 'nascosto', 'escluso', 'voce-composita']
    .forEach(id => document.getElementById(id).addEventListener('click', () => {}));
});
const mo = await analyzeMouseOnly(pagClic, { ignora: '.da-ignorare' });
const idsMo = mo.elementi.map(e => e.id).sort();
check(idsMo.includes('comando-nudo'), 'rileva il <div> con gestore del clic non focalizzabile');
check(idsMo.includes('icona'), "rileva l'<img> con gestore del clic (comando finto)");
check(!idsMo.includes('vero') && !idsMo.includes('con-tabindex'), "NON segnala cio' che e' gia' raggiungibile da tastiera");
check(!idsMo.includes('contenitore'), 'NON segnala il contenitore che racchiude un comando focalizzabile');
check(!idsMo.includes('nascosto'), 'NON segnala gli elementi non visibili');
check(!idsMo.includes('escluso'), "onora l'esclusione dichiarata nel target ('mouseOnlyIgnore')");
check(!idsMo.includes('senza-gestore'), 'NON segnala elementi senza gestore del clic');
check(!idsMo.includes('voce-composita'), "NON segnala le voci di un widget composito (role + tabindex=-1)");
check(mo.totale === idsMo.length, `totale coerente con l'elenco (${mo.totale} vs ${idsMo.length}): ${JSON.stringify(idsMo)}`);
await ctxClic.close();

await browser.close();
console.log(failed ? `\n❌ ${failed} check falliti` : '\n✅ tutti i check superati');
process.exit(failed ? 1 : 0);
