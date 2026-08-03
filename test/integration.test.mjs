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

// Test di INTEGRAZIONE end-to-end: un mock server locale modella una console (login → menu →
// lista → dettaglio con matite/newTab/3-puntini/CONFIGURA/count-link/tab, + griglia charts).
// Lancia scan() per esercitare login, pages, crawl, flows, scanMenu (+listRow/detailEdit/
// detailMenu/detailConfig), recurse, scanTabs, scanCharts, recordScan, reporter e gate.

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------- mock server (console sintetica) ------------------------- */
const MENU = `<div id="menuct"><a class="voceMenuRC" href="/app/list">Lista</a><a class="voceMenuRC" href="/app/cfg">Config</a></div>`;
const NAMELESS = `<button></button>`; // violazione a11y deterministica (button-name)
const page = (title, body) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title></head><body>${MENU}${body}</body></html>`;
const ROUTES = {
  '/app/': page('Login', `<form method="get" action="/app/home"><input name="login"><input type="password" name="password"><input class="deButton" type="submit" value="Login"></form>`),
  '/app/home': page('Home', `<h1>Home</h1><a href="/app/extra">Extra</a>${NAMELESS}`),
  '/app/extra': page('Extra', `<h1>Extra</h1>${NAMELESS}`),
  '/app/cfg': page('Config', `<h1>Config</h1>`),
  '/app/list': page('Lista', `<h1>Lista</h1><a id="entry_0" href="/app/detail">Primo record</a><a id="entry_1" href="/app/detail">Secondo</a>`),
  '/app/detail': page('Dettaglio', `<h1>Dettaglio</h1>
    <a class="edit-link" title="Modifica Generali" href="/app/edit">e</a>
    <a class="edit-link" title="Apri scheda" target="_blank" href="/app/popup">n</a>
    <div id="divIconMenu_barraTitolo">menu</div>
    <div class="context-menu"><a href="/app/action1">Azione Uno</a></div>
    <a href="/app/sub">Soggetti (0)</a>
    <ul class="ui-tabs-nav"><li><a href="#t0">test</a></li><li><a href="#t1">Predefinito</a></li></ul>
    <input id="form-add-tab-link_0" type="button" value="Configura" onclick="location.href='/app/wizard'">`),
  '/app/edit': page('Modifica', `<h1>Modifica</h1>${NAMELESS}`),
  '/app/popup': page('Popup', `<h1>Popup API</h1>`),
  '/app/action1': page('Azione', `<h1>Azione Uno</h1>`),
  '/app/sub': page('Sub', `<h1>Soggetti</h1><a href="/app/subdetail">Dettaglio soggetto</a>`),
  '/app/subdetail': page('SubDetail', `<h1>Dettaglio soggetto</h1>${NAMELESS}`),
  '/app/wizard': page('Wizard', `<h1>Configurazione</h1><a class="edit-link" title="Controllo Accessi" href="/app/edit">c</a>`),
  '/app/charts': page('Charts', `<h1>Analisi</h1><fieldset><legend>Distribuzione</legend><a class="tipologia-button" href="#"><span>Line chart</span></a></fieldset><input id="generaReport" type="button" value="Genera" onclick="location.href='/app/report'">`),
  '/app/report': page('Report', `<h1>Report generato</h1>${NAMELESS}`),
  '/app/form': page('Form', `<form><input id="q" type="text"><button type="button">Cerca</button></form><div id="risultato">pronto</div>`),
};
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const html = ROUTES[path] || ROUTES[path + '/'] || page('404', `<h1>404 ${path}</h1>`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ------------------------- config sintetico ------------------------- */
const OUT = mkdtempSync(join(tmpdir(), 'gova11y-int-'));
const CFG = join(OUT, 'targets.json');
writeFileSync(CFG, JSON.stringify({
  app: {
    name: 'MockApp', enabled: true, loginPath: '/app/', contextPath: '/app/',
    login: { usernameSelector: "input[name='login']", passwordSelector: "input[type='password']", submitSelector: "input.deButton[value='Login']", successUrlIncludes: 'home' },
    postLogin: { steps: [{ clickText: 'Home', optional: true, delayMs: 20 }] },
    crawl: 5, crawlDepth: 1,
    pages: [{ name: 'home', path: '/app/home' }],
    flows: [
      { name: 'menu', start: '/app/home', steps: [{ scanMenu: [{ item: '#menuct a.voceMenuRC', listRow: "[id^='entry_']", recurse: { depth: 2, max: 20 }, detailMenu: { open: '#divIconMenu_barraTitolo', item: '.context-menu a' }, detailConfig: "[id^='form-add-tab-link']" }], wait: 'networkidle', delayMs: 100 }] },
      { name: 'matite', start: '/app/home', steps: [{ scanMenu: [{ item: '#menuct a.voceMenuRC', listRow: "[id^='entry_']", detailEdit: 'a.edit-link' }], wait: 'networkidle', delayMs: 100 }] },
      { name: 'stat', start: '/app/charts', steps: [{ scanCharts: { grid: '/app/charts', icon: 'a.tipologia-button', generate: '#generaReport', label: 'span' }, wait: 'networkidle', delayMs: 100 }] },
      { name: 'misc', start: '/app/form', steps: [
        { fill: { selector: '#q', value: 'x' } }, { clickText: 'Cerca', wait: '#risultato', delayMs: 50 },
        { scanTabs: '#menuct a' }, { scan: 'form-finale' },
      ] },
    ],
  },
}, null, 2));

/* ------------------------- run scan() ------------------------- */
process.argv = [process.argv[0], process.argv[1], '--base', BASE, '--config', CFG, '--out', OUT, '--no-lighthouse', '--no-screen-reader'];
const M = await import('../a11y-scan.mjs');

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`); if (!cond) failed++; };

const results = await M.scan();
const urls = results.map(r => r.url);
const names = results.map(r => r.name);
const hasUrl = s => urls.some(u => u.includes(s));
const hasName = s => names.some(n => n.includes(s));

console.log(`\n(${results.length} pagine scansionate)`);
console.log('— login + pagine');
check(hasUrl('/app/home'), 'login riuscito e landing /app/home scansionata');
console.log('— crawl (harvestLinks/normalizeLinks/BFS)');
check(hasName('crawl-') || hasUrl('/app/extra'), 'crawl ha scoperto un link (/app/extra)');
console.log('— scanMenu (enumerazione voci)');
check(hasUrl('/app/list') && hasUrl('/app/cfg'), 'ha navigato le voci di menu (Lista + Config)');
console.log('— listRow (primo elemento → dettaglio)');
check(hasName('/dettaglio') && hasUrl('/app/detail'), 'entrato nel dettaglio del primo record');
console.log('— recurse (link navigazionali, count-link, ricorsione)');
check(hasUrl('/app/sub'), 'recurse ha seguito il count-link "Soggetti (0)"');
check(hasUrl('/app/subdetail'), 'recurse è sceso di un livello (sub → subdetail)');
console.log('— recurse: espansione tab');
check(hasName('/tab-'), 'ha espanso e scansionato i tab');
console.log('— detailMenu (3-puntini)');
check(hasUrl('/app/action1'), 'dropdown 3-puntini → azione seguita');
console.log('— detailConfig (CONFIGURA → wizard, con ricorsione)');
check(hasUrl('/app/wizard'), 'entrato nel wizard CONFIGURA');
console.log('— detailEdit + newTab (flow senza recurse)');
check(hasUrl('/app/edit'), 'matita (edit-link) seguita');
check(hasUrl('/app/popup'), 'newTab (target=_blank) scansionato');
console.log('— scanCharts');
check(hasUrl('/app/report'), 'scanCharts: icona → Genera → report scansionato');
console.log('— runStep (fill/clickText/wait/scan)');
check(hasName('flow:misc/form-finale'), 'step misti (fill+clickText+scan) eseguiti');
console.log('— recordScan produce dati a11y');
check(results.some(r => Array.isArray(r.violations)), 'ogni risultato ha violations[]');

console.log('— reporter + gate (end-to-end)');
M.writeAxeJson(results); M.writeSarif(results); M.writeSonar(results); M.writeJUnit(results);
const summary = M.writeSummaryAndHtml(results, M.writeAriaTrees(results));
check(existsSync(join(OUT, 'report.html')) && existsSync(join(OUT, 'a11y.sarif')), 'report generati');
check(M.evaluateGate(results, summary).length >= 1, 'gate rileva violazioni (button senza nome)');

console.log('— runLighthouse (audit opzionale: happy-path o fallback null)');
const { chromium } = await import('playwright');
const lhBrowser = await chromium.launch({ args: ['--remote-debugging-port=9223'] });
const lh = await M.runLighthouse(lhBrowser, `${BASE}/app/home`, {});
await lhBrowser.close();
check(lh === null || (typeof lh === 'number' && lh >= 0 && lh <= 1), 'runLighthouse → punteggio 0..1 oppure null (fallback se dep assente)');

server.close();
console.log(failed ? `\n❌ integration: ${failed} check falliti` : '\n✅ integration: tutti i check superati');
process.exit(failed ? 1 : 0);
