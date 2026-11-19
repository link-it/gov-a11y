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
  // comando da tastiera: Invio apre il menu, Esc lo chiude e riporta il focus al bottone
  '/app/tasti': page('Tasti', `<main><h1>Tasti</h1><button id="apri" type="button" aria-expanded="false">Menu</button><ul id="voci" hidden><li><a href="/app/home">Voce</a></li></ul></main><script>const b = document.getElementById('apri'), v = document.getElementById('voci'); b.addEventListener('click', () => { v.hidden = false; b.setAttribute('aria-expanded', 'true'); }); document.addEventListener('keydown', e => { if (e.key === 'Escape') { v.hidden = true; b.setAttribute('aria-expanded', 'false'); b.focus(); } });</script>`),
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
  // controlli fuori da axe (target app3): riflusso, spaziatura, focus, lingua delle parti
  const app3 = {
    '/app3/ok': `<main><h1>Pulita</h1><p>Testo breve.</p><a href="/app3/larga">Collegamento</a></main>`,
    '/app3/larga': `<main><h1>Larga</h1><div id="larga" style="width:600px">contenuto largo</div></main>`,
    // il testo (circa 200px) entra nei 230px con la spaziatura normale e non con quella aumentata (circa 275px)
    '/app3/taglio': `<main><h1>Taglio</h1><div id="stretta" style="width:230px;height:18px;overflow:hidden;white-space:nowrap">testo che con la spaziatura esce</div></main>`,
    // testi nascosti di proposito (icona al posto del testo, testo per screen reader): ignorati;
    // testo gia' troncato con la spaziatura normale: caso da verificare, non violazione 1.4.12
    '/app3/troncato': `<main><h1>Troncato</h1><a href="#p" id="icona" style="display:block;width:16px;height:16px;overflow:hidden;text-indent:-99999px">Prec</a><div id="annuncio" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">18 Novembre 2026</div><div id="puntini" style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">nome molto lungo che non entra nella card</div><div id="riquadro" style="width:300px;height:60px;overflow:hidden"><style>.riquadro-regola-di-stile-molto-lunga-che-non-si-legge{color:inherit}</style><p style="margin:0">Testo che si legge per intero</p><div style="height:80px"></div></div></main>`,
    // finestra modale aperta con un solo comando, sopra una pagina con collegamenti: il percorso parte nella finestra
    '/app3/modale': `<header><a href="#a">Primo</a> <a href="#b">Secondo</a></header><main><h1>Modale</h1><p>Contenuto</p></main><div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div><div role="dialog" aria-modal="true" aria-label="Avviso" style="position:fixed;top:0;left:0;width:100%;height:200px;background:#fff"><p>Selezionare un elemento.</p><button id="chiudi" type="button">Chiudi</button></div><script>document.addEventListener('keydown', e => { if (e.key === 'Tab' && document.activeElement.id === 'chiudi') e.preventDefault(); });</script>`,
    // trappola vera, fuori da una finestra modale: il campo trattiene il Tab
    '/app3/coperto': `<div style="position:fixed;top:0;left:0;width:100%;height:60px;background:#333;z-index:9"></div><main style="padding-top:80px"><h1>Coperto</h1><button id="coperto" type="button" style="position:absolute;top:10px;left:10px">Sotto la barra</button><span style="position:relative;display:inline-block"><select id="velato" aria-label="Scelta"><option>uno</option></select><div style="position:absolute;inset:0;opacity:0;background:#fff"></div></span><p style="width:130px"><a id="prec" href="#p">Settimana prec.</a> <a id="attuale" href="#a">Settimana attuale.</a></p><span style="position:relative;display:inline-block"><input id="campo-meta" aria-label="Valori" style="width:80px"><span style="position:absolute;top:0;right:0;width:45px;height:100%;background:#ccc"></span></span></main>`,
    '/app3/bloccato': `<main><h1>Bloccato</h1><input id="blocca" aria-label="Campo" onkeydown="if (event.key === 'Tab') event.preventDefault()"><a href="#dopo">Dopo</a></main>`,
    '/app3/focus': `<style>#nofocus:focus{outline:none;box-shadow:none}.voce a:focus{outline:none}.voce:focus-within{background:#373741;border-left:12px solid #c85000}</style><main><h1>Focus</h1><button id="nofocus" type="button">Senza focus</button><button id="confocus" type="button">Con focus</button><div class="voce"><a id="voce" href="#v">Voce di menu</a></div></main>`,
    '/app3/lingua': `<main><h1>Login</h1><p id="frase">Accedendo accetti i termini</p><p lang="it">Accedendo accetti, ma con lang</p></main>`,
    // testi sotto il bordo di un contenitore che scorre; la sentinella, se vista (IntersectionObserver)
    // o raggiunta scorrendo (evento scroll, come ngx-infinite-scroll), "carica altro" e scende ancora
    // testi su sfondo sfumato: axe non sa decidere (bgGradient), la stima sui pixel si'
    '/app3/sfumato': `<main><h1>Sfumato</h1><div style="display:inline-block;background:linear-gradient(90deg,#084298,#cfe2ff);padding:0"><p id="chiaro-sfumato" style="color:#fff;margin:0">Etichetta chiara su sfondo blu che schiarisce</p></div><div style="background:linear-gradient(90deg,#000,#333);padding:12px"><p id="bianco-scuro" style="color:#fff;margin:0">Testo bianco su sfondo scuro</p></div></main>`,
    // dialog con gli ancoraggi del focus trap (come Angular CDK): focalizzabili dentro aria-hidden per
    // costruzione, coperti dal registro; il collegamento nascosto e' invece un difetto vero
    '/app3/trappola': `<main><h1>Trappola</h1><div aria-hidden="true"><a href="#x" id="vero-nascosto">Collegamento nascosto</a></div><div class="cdk-overlay-pane"><div tabindex="0" class="cdk-visually-hidden cdk-focus-trap-anchor" aria-hidden="true"></div><div role="dialog" aria-modal="true" aria-label="Prova"><button type="button">Chiudi</button></div><div tabindex="0" class="cdk-visually-hidden cdk-focus-trap-anchor" aria-hidden="true"></div></div></main>`,
    '/app3/sotto': `<main><h1>Sotto</h1><div id="scorre" style="height:300px;overflow:auto"><div style="height:600px"></div><p id="leggibile">Testo leggibile in fondo</p><p id="chiaro" style="color:#c8c8c8">Testo troppo chiaro</p><p id="sentinella">Scorri per caricare altri risultati</p></div><script>new IntersectionObserver(v => { if (v[0].isIntersecting) { const p = document.createElement('p'); p.style.height = '400px'; p.textContent = 'caricato altro'; document.getElementById('scorre').insertBefore(p, document.getElementById('sentinella')); } }).observe(document.getElementById('sentinella')); const scorre = document.getElementById('scorre'); scorre.addEventListener('scroll', () => { if (scorre.scrollTop + scorre.clientHeight > scorre.scrollHeight - 100) { const p = document.createElement('p'); p.style.height = '400px'; p.textContent = 'caricato allo scroll'; scorre.insertBefore(p, document.getElementById('sentinella')); } });</script></main>`,
  };
  if (app3[path]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const lang = path === '/app3/lingua' ? 'en' : 'it';
    return res.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>App3</title></head><body>${app3[path]}</body></html>`);
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
  // login lento (app appena avviata): il form resta in attesa e la sessione arriva dopo 2,5 s
  if (path === '/login-lento') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Login</title></head><body><main><form method="get" action="/attesa"><label>Utente <input name="u"></label><label>Password <input type="password" name="p"></label><button type="submit">Entra</button></form></main></body></html>`); }
  if (path === '/attesa') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Attesa</title></head><body><main><p>Accesso in corso</p></main><script>setTimeout(() => { location.href = '/do-login'; }, 2500);</script></body></html>`); }
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
// script per i passi 'script': due viste dalla stessa funzione, la seconda in una sessione separata
writeFileSync(join(OUT, 'passi.mjs'), `export async function dueViste({ page, scan, newPage, base, args }) {
  await scan('prima');
  const altra = await newPage();
  await altra.goto(base + args.path);
  await scan('seconda', { page: altra });
}
export async function conProblemi({ scan }) {
  await scan('problemi', { problemi: [{ criterio: '2.1.1', messaggio: 'il menu non si apre con Invio', selettore: '#apri' }] });
}
export default async function ({ page }) { await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'Eseguito default'; document.body.append(p); }); }
`);
// registro dei falsi positivi del target app3: una voce per axe, una per il secondo motore, una con
// un motore sconosciuto (ignorata)
writeFileSync(join(OUT, 'fp-app3.json'), JSON.stringify({ falsePositives: [
  { id: 'trappola-axe', rule: 'aria-hidden-focus', selector: '.cdk-focus-trap-anchor', reason: 'Ancoraggi del focus trap.', verification: 'Prova.' },
  { id: 'trappola-ibm', engine: 'equalAccess', rule: 'aria_hidden_nontabbable', selector: '.cdk-focus-trap-anchor', reason: 'Ancoraggi del focus trap.', verification: 'Prova.' },
  { id: 'motore-ignoto', engine: 'wave', rule: 'x', reason: 'r', verification: 'v' },
] }));
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
      // passi da tastiera: focus + Invio apre il menu, Esc lo chiude
      { name: 'tasti', start: '/app/tasti', steps: [
        { focus: '#apri' }, { press: 'Enter', wait: '#voci:not([hidden])' }, { scan: 'menu-aperto' },
        { press: 'Escape', wait: '#apri[aria-expanded="false"]' }, { scan: 'menu-chiuso' },
      ] },
      // storia di navigazione e goto assoluto (altra origine)
      { name: 'storia', start: '/app/home', steps: [
        { goto: '/app/cfg' }, { back: true }, { reload: true }, { clearCookies: true }, { scan: 'tornato' },
        { goto: `${AUTH}/login` }, { scan: 'altra-origine' },
      ] },
      // passo 'script': funzione con nome e due viste, export default, script fuori dalla directory del config
      { name: 'script', start: '/app/home', steps: [
        { script: './passi.mjs#dueViste', args: { path: '/app/cfg' } },
        { script: 'passi.mjs' }, { scan: 'default' },
        { script: 'passi.mjs#conProblemi' },
      ] },
      { name: 'script-fuori', start: '/app/home', steps: [{ script: '../fuori.mjs' }, { scan: 'mai' }] },
      // variabile non impostata: il flow va saltato prima di eseguire qualsiasi passo
      { name: 'senza-env', start: '/app/anagrafe', steps: [
        { fill: { selector: '#cf', env: 'A11Y_INT_ASSENTE' } }, { scan: 'mai' },
      ] },
      // sentinella assente: flow saltato, e il salto deve risultare nel perimetro del report
      { name: 'senza-dati', start: '/app/home', skipIfMissing: '#nessun-dato', skipIfMissingTimeoutMs: 300, steps: [{ scan: 'mai' }] },
    ],
  },
  // controlli fuori da axe, accesi dal config del target; secondo motore (IBM Equal Access)
  app3: {
    name: 'MockApp3', enabled: true, loginPath: '/app3/ok',
    reflow: true, textSpacing: true, keyboardWalk: true, equalAccess: true, falsePositives: 'fp-app3.json',
    languageParts: { it: ['Accedendo accetti'] },
    pages: [{ name: 'ok', path: '/app3/ok' }, { name: 'larga', path: '/app3/larga' }, { name: 'taglio', path: '/app3/taglio' }, { name: 'troncato', path: '/app3/troncato' },
      { name: 'focus', path: '/app3/focus' }, { name: 'modale', path: '/app3/modale' }, { name: 'bloccato', path: '/app3/bloccato' }, { name: 'coperto', path: '/app3/coperto' }, { name: 'lingua', path: '/app3/lingua' }, { name: 'sotto', path: '/app3/sotto' },
      { name: 'sfumato', path: '/app3/sfumato' }, { name: 'trappola', path: '/app3/trappola' }],
  },
  // login su un'altra origine (loginPath assoluto), pagine su --base autenticate dal cookie condiviso
  app2: {
    name: 'MockApp2', enabled: true, loginPath: `${AUTH}/login`,
    login: { usernameSelector: "input[name='u']", passwordSelector: "input[name='p']", submitSelector: "button[type='submit']", successUrlIncludes: 'benvenuto' },
    locale: 'it-IT',
    pages: [{ name: 'protetta', path: '/app2/protetta' }, { name: 'lingua', path: '/app2/lingua' }],
    flows: [{ name: 'lingua', start: '/app2/lingua', steps: [{ scan: 'lingua' }] }],
  },
  // come app2, ma con loginPath relativo e l'applicazione di login in 'loginBase'
  app4: {
    name: 'MockApp4', enabled: true, loginPath: '/login', loginBase: AUTH,
    falsePositives: 'fp-app3.json',   // stesso registro di app3: va caricato una volta sola
    login: { usernameSelector: "input[name='u']", passwordSelector: "input[name='p']", submitSelector: "button[type='submit']", successUrlIncludes: 'benvenuto' },
    pages: [{ name: 'protetta-base', path: '/app2/protetta' }],
  },
  // login che conferma la sessione solo dopo qualche secondo: si aspetta l'URL atteso
  app5: {
    name: 'MockApp5', enabled: true, loginPath: '/login-lento', loginBase: AUTH,
    login: { usernameSelector: "input[name='u']", passwordSelector: "input[name='p']", submitSelector: "button[type='submit']", successUrlIncludes: 'benvenuto' },
    pages: [{ name: 'protetta-lenta', path: '/app2/protetta' }],
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
console.log('— passi da tastiera (focus/press)');
const aperto = results.find(r => r.name === 'flow:tasti/menu-aperto'), chiuso = results.find(r => r.name === 'flow:tasti/menu-chiuso');
check(!!aperto && /Voce/.test(aperto.ariaSnapshot || ''), 'focus + Invio: menu aperto e scansionato');
check(!!chiuso && !/Voce/.test(chiuso.ariaSnapshot || ''), 'Esc: menu chiuso nello stato scansionato');
console.log('— storia di navigazione e goto assoluto');
const tornato = results.find(r => r.name === 'flow:storia/tornato');
check(!!tornato && tornato.url === `${BASE}/app/home`, 'back + reload + clearCookies: tornato alla pagina precedente');
const altra = results.find(r => r.name === 'flow:storia/altra-origine');
check(!!altra && altra.url === `${AUTH}/login`, "goto con URL assoluto: aperto fuori da --base");
console.log("— passo 'script'");
const prima = results.find(r => r.name === 'flow:script/prima'), seconda = results.find(r => r.name === 'flow:script/seconda');
check(!!prima && prima.url === `${BASE}/app/home`, 'scan() dallo script: stato corrente della pagina del flow');
check(!!seconda && seconda.url === `${BASE}/app/cfg`, 'scan({ page }) su una sessione aperta con newPage()');
const daDefault = results.find(r => r.name === 'flow:script/default');
check(!!daDefault && /Eseguito default/.test(daDefault.ariaSnapshot || ''), "senza '#': eseguito l'export default");
check(!hasName('flow:script-fuori/mai'), 'script fuori dalla directory del config: flow interrotto');
const problemi = results.find(r => r.name === 'flow:script/problemi');
check(!!problemi && problemi.violations.some(v => v.id === 'gova11y-script-211' && v.tags.includes('wcag2a') && v.nodes[0].failureSummary === 'il menu non si apre con Invio'),
  "scan({ problemi }): la verifica dello script diventa una violazione 2.1.1");
console.log('— controlli fuori da axe (reflow, spaziatura, Tab, lingua)');
const app3 = n => results.find(r => r.target === 'app3' && r.name === n);
const ids = n => (app3(n)?.violations || []).filter(v => v.id.startsWith('gova11y-')).map(v => v.id);
check(!!app3('ok') && ids('ok').length === 0, `vista pulita: nessuna violazione aggiuntiva (${ids('ok')})`);
check(ids('larga').includes('gova11y-reflow-320'), '1.4.10: elemento largo 600px a 320px segnalato');
check(app3('larga')?.violations.find(v => v.id === 'gova11y-reflow-320')?.nodes.some(n => n.target[0] === 'div#larga'), "1.4.10: indicato l'elemento che sborda");
check(ids('taglio').includes('gova11y-text-spacing'), '1.4.12: testo tagliato con spaziatura aumentata segnalato');
check(!ids('troncato').includes('gova11y-text-spacing'), `1.4.12: testi nascosti di proposito e gia' troncati non sono violazioni (${ids('troncato')})`);
const troncati = (app3('troncato')?.incomplete || []).filter(v => v.id === 'gova11y-text-truncated').flatMap(v => v.nodes.map(n => n.target[0]));
check(troncati.length === 1 && troncati[0] === 'div#puntini', `1.4.12: il testo gia' troncato e' un caso da verificare, icona, testo per screen reader e contenitore che taglia solo spazio vuoto ignorati (${troncati})`);
check(ids('focus').includes('gova11y-focus-visible'), '2.4.7: bottone senza indicatore del focus segnalato');
const fv = app3('focus')?.violations.find(v => v.id === 'gova11y-focus-visible');
check(!!fv && fv.nodes.length === 1 && fv.nodes[0].target[0] === 'button#nofocus', '2.4.7: segnalato solo il bottone senza focus, non quello con outline ne\' la voce evidenziata dal contenitore');
check(JSON.stringify(app3('focus')?.tabOrder || []).includes('button#confocus'), 'ordine di focus registrato (tabOrder)');
check(!ids('modale').some(i => /gova11y-(focus-obscured|keyboard-trap)/.test(i)) && JSON.stringify(app3('modale')?.tabOrder || []) === JSON.stringify(['button#chiudi "Chiudi"']),
  `2.1.2/2.4.11: con una finestra modale aperta il percorso parte nella finestra; un solo comando non e' una trappola (${ids('modale')} ${JSON.stringify(app3('modale')?.tabOrder)})`);
const coperti = (app3('coperto')?.violations.find(v => v.id === 'gova11y-focus-obscured')?.nodes || []).map(n => n.target[0]);
check(JSON.stringify(coperti) === JSON.stringify(['button#coperto']),
  `2.4.11: segnalato solo il comando nascosto del tutto, non quello sotto uno strato trasparente, il link che va a capo ne' il campo coperto a meta' (${coperti})`);
check(ids('bloccato').includes('gova11y-keyboard-trap'), `2.1.2: il campo che trattiene il Tab fuori da una finestra modale e' una trappola (${ids('bloccato')})`);
check(ids('lingua').includes('gova11y-language-of-parts'), '3.1.2: testo italiano in pagina inglese segnalato');
check(app3('lingua')?.violations.find(v => v.id === 'gova11y-language-of-parts')?.nodes.length === 1, '3.1.2: il testo con lang="it" non viene segnalato');
check(!(results.find(r => r.target === 'app' && r.name === 'home')?.violations || []).some(v => v.id.startsWith('gova11y-')), 'target senza i controlli accesi: nessuna violazione aggiuntiva');
// contrasti fuori vista: rimisurati portando l'elemento in vista, con lo scroll infinito in pausa
const sotto = app3('sotto');
check(!!sotto && !(sotto.incomplete || []).some(r => r.id === 'color-contrast'), 'contrasto fuori vista: rimisurato in vista, niente resta da verificare (sentinella compresa)');
check(!!sotto && sotto.violations.some(v => v.id === 'color-contrast' && v.nodes.some(n => /Testo troppo chiaro/.test(n.html))), 'contrasto fuori vista: il testo troppo chiaro diventa una violazione');
check(!!sotto && !sotto.violations.some(v => v.id === 'color-contrast' && v.nodes.some(n => /leggibile|Scorri/.test(n.html))), 'contrasto fuori vista: i testi conformi non sono violazioni');
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
console.log('— loginBase (loginPath relativo, login su un\'altra applicazione)');
const protetta4 = results.find(r => r.target === 'app4' && r.url === `${BASE}/app2/protetta`);
const protetta5 = results.find(r => r.target === 'app5' && r.url === `${BASE}/app2/protetta`);
check(!!protetta5 && /Area riservata/.test(protetta5.ariaSnapshot || ''), 'login lento: si aspetta l\'URL atteso, la pagina dopo trova la sessione pronta');
check(!!protetta4 && /Area riservata/.test(protetta4.ariaSnapshot || ''), 'login su loginBase + loginPath, pagine su --base autenticate');
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
console.log('— perimetro non coperto (nel report, non solo nel log)');
const per = summary.perimetro || [];
check(per.some(p => p.nome === 'senza-dati' && p.esito === 'saltato' && /#nessun-dato/.test(p.motivo)), 'flow saltato per sentinella assente registrato nel perimetro');
check(per.some(p => p.nome === 'senza-env' && p.esito === 'saltato' && /A11Y_INT_ASSENTE/.test(p.motivo)), 'flow saltato per variabile mancante registrato nel perimetro');
check(per.some(p => p.nome === 'script-fuori' && p.esito === 'interrotto'), 'flow interrotto da un passo fallito registrato nel perimetro');
check(per.some(p => p.nome === 'spa-riservata' && p.esito === 'non analizzata'), 'pagina che rimbalza su una vista già analizzata registrata nel perimetro');
const html = readFileSync(join(OUT, 'report.html'), 'utf8');
check(/Perimetro non coperto/.test(html) && html.includes('senza-dati'), 'report.html: sezione del perimetro non coperto');
console.log('— screenshot delle occorrenze');
const conImg = results.flatMap(r => r.violations).flatMap(v => v.nodes).filter(n => n.screenshot);
check(conImg.length > 0 && conImg.every(n => existsSync(join(OUT, n.screenshot))), `occorrenze con screenshot, file presenti (${conImg.length})`);
check(/<img class="shot" src="screenshot\//.test(html), 'report.html: screenshot accanto alle occorrenze');
console.log('— errori sistematici');
const sist = summary.erroriSistematici || [];
check(sist.some(g => g.regola === 'button-name' && g.tipo === 'violazione' && g.viste.length >= 2), 'button-name sullo stesso componente in più viste: errore sistematico');
check(/Errori sistematici/.test(html), 'report.html: tabella degli errori sistematici');
console.log('— secondo motore (IBM Equal Access)');
const conEa = results.filter(r => r.target === 'app3');
check(conEa.length > 0 && conEa.every(r => r.equalAccess && Array.isArray(r.equalAccess.violazioni)), 'IBM Equal Access eseguito su ogni vista del target che lo chiede');
check(results.filter(r => r.target === 'app').every(r => r.equalAccess === null), 'IBM Equal Access non eseguito sui target che non lo chiedono');
const eaContrasto = sotto?.equalAccess?.violazioni.filter(x => x.wcag.includes('1.4.3')) || [];
check(eaContrasto.length > 0, `IBM Equal Access trova il contrasto insufficiente (1.4.3) anche lui (${eaContrasto.length})`);
check(Array.isArray(summary.confrontoMotori) && summary.confrontoMotori.some(c => c.criterio === '1.4.3' && c.axeViolazioni > 0 && c.eaViolazioni > 0), 'confronto fra motori per criterio nel riepilogo');
check(/Confronto fra i due motori/.test(html) && /EN 9\.1\.4\.3/.test(html), 'report.html: confronto fra motori e riferimenti EN 301 549');
console.log('— stima del contrasto sui casi da verificare');
const sfumato = app3('sfumato');
const ccNodi = (sfumato?.incomplete || []).filter(v => v.id === 'color-contrast').flatMap(v => v.nodes);
const ccDi = id => ccNodi.find(n => n.html.includes(id))?.contrasto;
check(ccNodi.length >= 2 && ccNodi.every(n => n.contrasto), `testi su sfondo sfumato da verificare per axe, e tutti stimati (${ccNodi.length})`);
check(ccDi('chiaro-sfumato')?.esito === 'parziale' && ccDi('chiaro-sfumato').minimo < 4.5 && ccDi('chiaro-sfumato').massimo > 1, `bianco su blu che schiarisce: sotto soglia nella parte chiara (${JSON.stringify(ccDi('chiaro-sfumato'))})`);
check(ccDi('bianco-scuro')?.esito === 'conforme' && ccDi('bianco-scuro').minimo >= 12, `bianco su sfondo scuro: conforme (${JSON.stringify(ccDi('bianco-scuro'))})`);
check(/^#ffffff$/.test(ccDi('bianco-scuro')?.testo || '') && ccDi('bianco-scuro').richiesto === 4.5, 'stima: colore del testo e soglia del testo normale');
const ccComp = summary.stimaContrasti?.perComponente || [];
check(ccComp.some(g => g.esito === 'parziale' && /p/.test(g.componente)) && ccComp.some(g => g.esito === 'conforme'), 'summary.json: stime raggruppate per componente');
check(/Contrasti da verificare — stima sullo sfondo reale/.test(html) && /Contrasto stimato sullo sfondo reale/.test(html), 'report.html: tabella per componente e stima accanto all\'occorrenza');
console.log('— falsi positivi del secondo motore');
const trappola = app3('trappola');
const eaTrap = [...(trappola?.equalAccess?.violazioni || []), ...(trappola?.equalAccess?.daVerificare || [])].filter(x => x.regola === 'aria_hidden_nontabbable');
const fpTrap = trappola?.falsePositives || [];
check(fpTrap.some(d => d.engine === 'equalAccess' && d.id === 'trappola-ibm' && d.tipo === 'violazione'), `IBM: violazione sugli ancoraggi del focus trap derogata dal registro (${JSON.stringify(fpTrap.map(d => [d.engine, d.id, d.tipo]))})`);
check(eaTrap.length > 0 && eaTrap.every(x => !/cdk-focus-trap-anchor/.test(x.snippet)), `IBM: il collegamento dentro aria-hidden resta segnalato, gli ancoraggi no (${eaTrap.map(x => x.snippet.slice(0, 40)).join(' | ')})`);
check(!fpTrap.some(d => d.engine === 'equalAccess' && /vero-nascosto/.test(d.html || '')), 'IBM: il selettore della voce non copre il difetto vero');
check(fpTrap.filter(d => d.engine === 'axe').every(d => d.tipo === 'da verificare' && /cdk-focus-trap-anchor/.test(d.html)), 'axe: derogati solo casi da verificare, sugli ancoraggi');
const vociFp = summary.falsePositives || [];
check(vociFp.find(v => v.id === 'trappola-ibm')?.engine === 'equalAccess' && vociFp.find(v => v.id === 'trappola-ibm').matches > 0, 'summary.json: voce del secondo motore con motore e riscontri');
check(!vociFp.some(v => v.id === 'motore-ignoto'), 'voce con motore sconosciuto ignorata');
check(vociFp.filter(v => v.id === 'trappola-ibm').length === 1 && vociFp.filter(v => v.id === 'trappola-axe').length === 1, `registro usato da due target: voci caricate una volta (${vociFp.map(v => v.id).join(', ')})`);
check(!/Senza riscontro:<\/b> le voci\s*<code>trappola/.test(html), 'report.html: le voci con riscontro non compaiono anche "senza riscontro"');
check(/<td>IBM Equal Access<\/td><td><code>aria_hidden_nontabbable/.test(html), 'report.html: tabella dei falsi positivi con il motore');
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
