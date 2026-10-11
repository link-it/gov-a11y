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
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
  '/app/upload': page('Upload', `<h1>Carica</h1><label for="f">Archivio</label><input id="f" type="file"><div id="caricati"></div><script>document.getElementById('f').addEventListener('change', e => { const d = document.createElement('p'); d.id = 'caricato'; d.textContent = e.target.files[0].name; document.getElementById('caricati').append(d); });</script>`),
  '/app/opzioni': page('Opzioni', `<h1>Opzioni</h1><label for="tipo">Tipo</label><select id="tipo"><option value="">--</option><option value="a">Scelta uno</option><option value="b">Scelta due</option></select><div id="esito"></div><script>document.getElementById('tipo').addEventListener('change', e => { document.getElementById('esito').textContent = 'scelto ' + e.target.value; });</script>`),
  // app "incorporata": il contesto (organizzazione) arriva solo da un messaggio della shell che la ospita
  '/app/ospitata': page('Ospitata', `<h1>App ospitata</h1><p id="ctx">In attesa dell'organizzazione</p><script>window.addEventListener('message', e => { const m = e.data; if (m && m.type === 'GOVAPP' && m.payload && m.payload.action === 'ORGANIZATION') document.getElementById('ctx').textContent = 'Organizzazione ' + m.payload.data.id; });</script>`),
  // SPA che instrada sul fragment (Angular useHash): '#/riservata' rimbalza su '#/home'
  '/app/spa': page('SPA', `<main><h1 id="titolo">...</h1></main><script>function rotta() { if (location.hash === '#/riservata') { location.hash = '#/home'; return; } document.getElementById('titolo').textContent = 'Rotta ' + location.hash.slice(2); } window.addEventListener('hashchange', rotta); rotta();</script>`),
  '/app/form': page('Form', `<form><input id="q" type="text"><button type="button">Cerca</button></form><div id="risultato">pronto</div>`),
  // modulo con campo di testo, <select> nativa e combobox ARIA: i valori scelti vengono riportati a schermo
  '/app/anagrafe': page('Anagrafe', `<h1>Interrogazione</h1>
    <label for="cf">Codice fiscale</label><input id="cf" type="text">
    <label for="mot">Motivazione</label><select id="mot"><option>--</option><option>Verifica d'ufficio</option></select>
    <div id="uff" role="combobox" tabindex="0" aria-label="Ufficio" aria-controls="lst" aria-expanded="false" onclick="document.getElementById('lst').hidden=false">scegli</div>
    <ul id="lst" role="listbox" aria-label="Uffici" hidden><li role="option" onclick="document.getElementById('uff').textContent=this.textContent;this.parentNode.hidden=true">Ufficio Tributi</li></ul>
    <button id="vai" type="button" onclick="document.getElementById('esito').textContent='uff='+document.getElementById('uff').textContent+' mot='+document.getElementById('mot').value+' cf='+document.getElementById('cf').value">Esegui</button>
    <div id="esito"></div>`),
};
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  // pagina protetta: autenticata solo dal cookie impostato dal server di login, che gira su un'altra porta
  if (path === '/app2/protetta') {
    const ok = /(^|;\s*)SESS=ok(;|$)/.test(req.headers.cookie || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Protetta', ok ? '<h1>Area riservata</h1>' : '<h1>Non autenticato</h1>'));
  }
  // lingua del browser a schermo: verifica che il 'locale' del target arrivi alla pagina
  if (path === '/app2/lingua') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Lingua', `<h1>Lingua</h1><p id="lingua"></p><script>document.getElementById('lingua').textContent = 'lingua=' + navigator.language;</script>`));
  }
  // vista che non si renderizza (nessun contenuto accessibile) e vista che si disegna in ritardo
  if (path === '/app/bianca') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Bianca</title></head><body><div id="root"></div></body></html>');
  }
  if (path === '/app/tardiva') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Tardiva</title></head><body><div id="root"></div><script>setTimeout(() => { document.getElementById('root').innerHTML = '<main><h1>Arrivata</h1><p>Contenuto disegnato in ritardo</p></main>'; }, 2500);</script></body></html>`);
  }
  const html = ROUTES[path] || ROUTES[path + '/'] || page('404', `<h1>404 ${path}</h1>`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
// server di login su un'altra porta (come GovHub :5200 per le app GovDesk :52xx): imposta il cookie e
// rimanda alla sua pagina di benvenuto. I cookie dipendono dall'host, non dalla porta.
const authServer = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/do-login') { res.writeHead(302, { 'Set-Cookie': 'SESS=ok; Path=/', Location: '/benvenuto' }); return res.end(); }
  const html = path === '/login'
    ? `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Login</title></head><body><main><form method="get" action="/do-login"><label>Utente <input name="u"></label><label>Password <input type="password" name="p"></label><button type="submit">Entra</button></form></main></body></html>`
    : `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Benvenuto</title></head><body><main><h1>Benvenuto</h1></main></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(r => authServer.listen(0, '127.0.0.1', r));
const AUTH = `http://127.0.0.1:${authServer.address().port}`;

/* ------------------------- config sintetico ------------------------- */
const OUT = mkdtempSync(join(tmpdir(), 'gova11y-int-'));
const CFG = join(OUT, 'targets.json');
writeFileSync(join(OUT, 'archivio-prova.zip'), 'PK'); // risolto relativo alla directory del config
writeFileSync(CFG, JSON.stringify({
  app: {
    name: 'MockApp', enabled: true, loginPath: '/app/', contextPath: '/app/',
    login: { usernameSelector: "input[name='login']", passwordSelector: "input[type='password']", submitSelector: "input.deButton[value='Login']", successUrlIncludes: 'home' },
    postLogin: { steps: [{ clickText: 'Home', optional: true, delayMs: 20 }] },
    crawl: 5, crawlDepth: 1,
    navDelayMs: 300,   // come nei target veri: una SPA rimbalza (redirect sul fragment) dopo la navigazione
    pages: [{ name: 'home', path: '/app/home' }, { name: 'bianca', path: '/app/bianca' }, { name: 'tardiva', path: '/app/tardiva' },
      { name: 'spa-home', path: '/app/spa#/home' }, { name: 'spa-elenco', path: '/app/spa#/elenco' }, { name: 'spa-riservata', path: '/app/spa#/riservata' }],
    flows: [
      { name: 'menu', start: '/app/home', steps: [{ scanMenu: [{ item: '#menuct a.voceMenuRC', listRow: "[id^='entry_']", recurse: { depth: 2, max: 20 }, detailMenu: { open: '#divIconMenu_barraTitolo', item: '.context-menu a' }, detailConfig: "[id^='form-add-tab-link']" }], wait: 'networkidle', delayMs: 100 }] },
      { name: 'matite', start: '/app/home', steps: [{ scanMenu: [{ item: '#menuct a.voceMenuRC', listRow: "[id^='entry_']", detailEdit: 'a.edit-link' }], wait: 'networkidle', delayMs: 100 }] },
      { name: 'stat', start: '/app/charts', steps: [{ scanCharts: { grid: '/app/charts', icon: 'a.tipologia-button', generate: '#generaReport', label: 'span' }, wait: 'networkidle', delayMs: 100 }] },
      { name: 'upload', start: '/app/upload', steps: [
        { upload: { selector: '#f', files: ['archivio-prova.zip'] }, wait: '#caricato' }, { scan: 'caricato' },
      ] },
      { name: 'opzioni', start: '/app/opzioni', steps: [
        { select: { selector: '#tipo', value: 'Scelta due' }, wait: '#esito:has-text("scelto b")' }, { scan: 'scelta-singola' },
        { scanOptions: { selector: '#tipo', name: 'tipo', skip: '^--$' } },
      ] },
      { name: 'misc', start: '/app/form', steps: [
        { fill: { selector: '#q', value: 'x' } }, { clickText: 'Cerca', wait: '#risultato', delayMs: 50 },
        { scanTabs: '#menuct a' }, { scan: 'form-finale' },
      ] },
      // valori da variabili d'ambiente: fill.env, select.env su <select> nativa, select su combobox ARIA
      { name: 'anagrafe', start: '/app/anagrafe', steps: [
        { fill: { label: 'Codice fiscale', env: 'A11Y_INT_CF' } },
        { select: { label: 'Motivazione', labelExact: true, env: 'A11Y_INT_MOT' } },
        { select: { selector: '#uff', value: 'Tributi' } },
        { click: '#vai', delayMs: 100 }, { scan: 'esito' },
      ] },
      // passo postMessage: simula la shell che invia all'app il contesto
      { name: 'ospitata', start: '/app/ospitata', steps: [
        { postMessage: { type: 'GOVAPP', payload: { action: 'ORGANIZATION', data: { id: 44 } } }, wait: '#ctx:has-text("Organizzazione 44")' },
        { scan: 'con-organizzazione' },
      ] },
      // variabile non impostata: il flow va saltato prima di eseguire qualsiasi passo
      { name: 'senza-env', start: '/app/anagrafe', steps: [
        { fill: { selector: '#cf', env: 'A11Y_INT_ASSENTE' } }, { scan: 'mai' },
      ] },
    ],
  },
  // login su un'altra origine (loginPath assoluto), pagine su --base autenticate dal cookie condiviso
  app2: {
    name: 'MockApp2', enabled: true, loginPath: `${AUTH}/login`,
    login: { usernameSelector: "input[name='u']", passwordSelector: "input[name='p']", submitSelector: "button[type='submit']", successUrlIncludes: 'benvenuto' },
    locale: 'it-IT',
    pages: [{ name: 'protetta', path: '/app2/protetta' }, { name: 'lingua', path: '/app2/lingua' }],
    flows: [{ name: 'lingua', start: '/app2/lingua', steps: [{ scan: 'lingua' }] }],
  },
}, null, 2));

/* ------------------------- run scan() ------------------------- */
process.argv = [process.argv[0], process.argv[1], '--base', BASE, '--config', CFG, '--out', OUT, '--no-lighthouse', '--no-screen-reader'];
process.env.A11Y_INT_CF = 'RSSMRA80A01H501U';
process.env.A11Y_INT_MOT = "Verifica d'ufficio";
delete process.env.A11Y_INT_ASSENTE;
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
console.log('— upload (file relativo al config)');
check(hasName('flow:upload/caricato'), 'step upload: file caricato e stato successivo scansionato');
console.log('— select + scanOptions (opzioni scoperte a runtime)');
check(hasName('flow:opzioni/scelta-singola'), 'step select: opzione scelta per testo e stato scansionato');
check(hasName('flow:opzioni/tipo-scelta-uno') && hasName('flow:opzioni/tipo-scelta-due'), 'scanOptions: una vista per ogni opzione, con prefisso');
check(!hasName('flow:opzioni/tipo-opzione1'), "scanOptions: l'opzione esclusa da 'skip' non viene scansionata");
console.log('— recordScan produce dati a11y');
check(results.some(r => Array.isArray(r.violations)), 'ogni risultato ha violations[]');

console.log('— reporter + gate (end-to-end)');
M.writeAxeJson(results); M.writeSarif(results); M.writeSonar(results); M.writeJUnit(results);
const summary = M.writeSummaryAndHtml(results, M.writeAriaTrees(results));
check(existsSync(join(OUT, 'report.html')) && existsSync(join(OUT, 'a11y.sarif')), 'report generati');
console.log("— valori da variabili d'ambiente (fill.env / select.env)");
const esito = results.find(r => r.name === 'flow:anagrafe/esito');
check(!!esito, 'flow con fill.env/select.env eseguito');
check(!!esito && /uff=Ufficio Tributi/.test(esito.ariaSnapshot || ''), 'select su combobox ARIA: opzione scelta per testo');
check(!!esito && esito.ariaSnapshot.includes("mot=Verifica d'ufficio"), 'select.env su <select> nativa: opzione scelta dal valore della variabile');
check(!!esito && esito.ariaSnapshot.includes('cf=RSSMRA80A01H501U'), 'fill.env per label: campo trovato per etichetta e compilato con il valore della variabile');
check(!hasName('flow:senza-env'), 'flow con variabile mancante saltato');
console.log("— loginPath assoluto (login su un'altra origine)");
const protetta = results.find(r => r.target === 'app2' && r.url === `${BASE}/app2/protetta`);
check(!!protetta, 'pagina del target scansionata su --base dopo il login altrove');
check(!!protetta && /Area riservata/.test(protetta.ariaSnapshot || ''), 'sessione aperta sull\'origine del login valida anche su --base (cookie condiviso)');
console.log('— postMessage (contesto inviato dalla shell che ospita l\'app)');
const ospitata = results.find(r => r.name === 'flow:ospitata/con-organizzazione');
check(!!ospitata && /Organizzazione 44/.test(ospitata.ariaSnapshot || ''), "postMessage: l'app riceve il messaggio e mostra il contesto");
console.log('— dedup con routing sul fragment (SPA useHash)');
const spaHome = results.find(r => r.name === 'spa-home'), spaElenco = results.find(r => r.name === 'spa-elenco');
check(!!spaHome && !!spaElenco && /Rotta elenco/.test(spaElenco.ariaSnapshot || ''), 'due rotte nel fragment: scansionate entrambe, non collassate in una');
check(!hasName('spa-riservata'), 'la rotta che rimbalza su una gia\' vista (#/riservata -> #/home) viene saltata dal dedup');
console.log('— viste vuote (pagina non renderizzata)');
const bianca = results.find(r => r.name === 'bianca'), tardiva = results.find(r => r.name === 'tardiva');
check(!!bianca && bianca.vuota === true, 'vista senza contenuto accessibile marcata vuota');
check(!!tardiva && tardiva.vuota === false && /Arrivata/.test(tardiva.ariaSnapshot || ''), 'vista disegnata in ritardo: attesa una volta, poi analizzata piena (non vuota)');
console.log('— locale del target (lingua del browser)');
const lingua = results.find(r => r.target === 'app2' && r.name === 'lingua');
check(!!lingua && /lingua=it-IT/.test(lingua.ariaSnapshot || ''), "pagine: la pagina vede navigator.language = 'locale' del target");
const linguaFlow = results.find(r => r.name === 'flow:lingua/lingua');
check(!!linguaFlow && /lingua=it-IT/.test(linguaFlow.ariaSnapshot || ''), "flow: anche il context del flow usa il 'locale' del target");
const outFiles = readdirSync(OUT, { recursive: true }).filter(f => /\.(json|html|xml|sarif|yaml)$/.test(f));
const trapela = outFiles.filter(f => { const t = readFileSync(join(OUT, f), 'utf8');
  return t.includes('RSSMRA80A01H501U') || t.includes("Verifica d'ufficio") || t.includes('Verifica d&apos;ufficio'); });
check(outFiles.length > 3 && trapela.length === 0, `nessun file di output contiene i valori delle variabili${trapela.length ? ' (trapelano in: ' + trapela.join(', ') + ')' : ''}`);
check(M.evaluateGate(results, summary).length >= 1, 'gate rileva violazioni (button senza nome)');
check(M.evaluateGate(results, summary).some(m => /viste vuote/.test(m) && /bianca/.test(m) && !/tardiva/.test(m)), 'gate: la vista vuota (e solo lei) fra i motivi');

console.log('— runLighthouse (audit opzionale: happy-path o fallback null)');
const { chromium } = await import('playwright');
const lhBrowser = await chromium.launch({ args: ['--remote-debugging-port=9223'] });
const lh = await M.runLighthouse(lhBrowser, `${BASE}/app/home`, {});
// sessione per la tab di Lighthouse: i cookie vanno nel context di default con il LORO path (il
// cookie di sessione di GovHub ha path /govhub-reverse-proxy, diverso da quello della pagina)
const ctxSess = await lhBrowser.newContext();
await ctxSess.addCookies([{ name: 'SESS', value: 'ok', domain: '127.0.0.1', path: '/api2', httpOnly: true }, { name: 'XSRF', value: 't', domain: '127.0.0.1', path: '/' }]);
const pSess = await ctxSess.newPage(); await pSess.goto(`${BASE}/app2/lingua`);
await pSess.evaluate(() => sessionStorage.setItem('org', '44'));
const sess = await M.lhPreparaSessione(pSess, {}, 9223);
const cdpLh = await chromium.connectOverCDP('http://127.0.0.1:9223');
const nelDefault = await cdpLh.contexts()[0].cookies(`${BASE}/api2/chi`);
// una scheda nuova del context di default (come quella di Lighthouse) trova lo sessionStorage della vista
const leggiOrg = async () => { const t = await cdpLh.contexts()[0].newPage(); await t.goto(`${BASE}/app2/lingua`);
  const v = await t.evaluate(() => sessionStorage.getItem('org')); await t.close(); return v; };
const orgPrima = await leggiOrg();
await sess.rilascia();
const orgDopo = await leggiOrg();
await cdpLh.close(); await lhBrowser.close();
check(nelDefault.some(c => c.name === 'SESS' && c.path === '/api2' && c.httpOnly) && nelDefault.some(c => c.name === 'XSRF'), 'lhPreparaSessione: cookie copiati nel context di Lighthouse con path e httpOnly');
check(!sess.headers?.Cookie, "lhPreparaSessione: nessun header 'Cookie' fisso (i cookie sono veri)");
check(orgPrima === '44', 'lhPreparaSessione: la scheda nuova di Lighthouse trova lo sessionStorage della vista');
check(orgDopo === null, 'rilascia(): lo script tolto non vale per le viste successive');
check(lh === null || (typeof lh === 'number' && lh >= 0 && lh <= 1), 'runLighthouse → punteggio 0..1 oppure null (fallback se dep assente)');

server.close(); authServer.close();
console.log(failed ? `\n❌ integration: ${failed} check falliti` : '\n✅ integration: tutti i check superati');
process.exit(failed ? 1 : 0);
