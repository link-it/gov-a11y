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

/* Passi 'script' del target Keycloak (temi di login GovDesk): le viste che i passi dichiarativi
   non raggiungono. Le email (Mailpit), i codici TOTP, l'autenticatore WebAuthn virtuale, le API di
   amministrazione e le verifiche da tastiera dei menu SPID e lingua.

   Realm, client e utenti sono quelli creati da a11y/setup.py del repo dei temi, che prepara anche
   Keycloak e Mailpit; la password degli utenti di prova arriva da A11Y_KC_PASS.
   Variabili: A11Y_KC_PASS, MAILPIT_URL, A11Y_KC_ADMIN_USER, A11Y_KC_ADMIN_PASS. */

import { createHmac } from 'node:crypto';

const REALM = 'a11y-test';
const MAILPIT = (process.env.MAILPIT_URL || 'http://127.0.0.1:8025').replace(/\/$/, '');
const pausa = ms => new Promise(r => setTimeout(r, ms));

function password() {
  const v = process.env.A11Y_KC_PASS;
  if (!v) throw new Error("variabile d'ambiente A11Y_KC_PASS non impostata (password degli utenti di setup.py)");
  return v;
}

// URL di autorizzazione OIDC del realm di prova per un client (stessa forma dei path nel config).
const redirect = base => encodeURIComponent(`${base}/realms/${REALM}/.well-known/openid-configuration`);
const authUrl = (base, client = 'a11y-app', extra = '') =>
  `${base}/realms/${REALM}/protocol/openid-connect/auth?client_id=${client}&response_type=code&scope=openid&redirect_uri=${redirect(base)}${extra}`;

async function invia(page, selettore = 'input[type=submit], button[type=submit]') {
  await Promise.all([page.waitForNavigation({ timeout: 10000 }).catch(() => {}), page.locator(selettore).first().click()]);
  await page.waitForLoadState('load').catch(() => {});
}

/* Login di un utente sulla pagina corrente (o su quella del client indicato). Gestisce sia il form
   unico username+password sia i flussi in due passi (prima username, poi password). */
async function login(page, { base, user, client, extra }) {
  if (client) await page.goto(authUrl(base, client, extra || ''), { waitUntil: 'load' });
  await page.fill('#username', user);
  if (await page.locator('#password').count()) await page.fill('#password', password());
  await invia(page, '#kc-login');
  if (await page.locator('#password').count() && !(await page.locator('#username').count())) {
    await page.fill('#password', password());
    await invia(page, '#kc-login');
  }
}

// Codice TOTP (RFC 6238, SHA-1, 6 cifre, 30 s) dal segreto in base32 mostrato da Keycloak.
function codiceTotp(segreto) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bit = '';
  for (const c of segreto.replace(/\s|=/g, '').toUpperCase()) bit += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  const chiave = Buffer.from(bit.match(/.{8}/g).map(b => parseInt(b, 2)));
  const contatore = Buffer.alloc(8);
  contatore.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', chiave).update(contatore).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Sulla pagina di configurazione TOTP: legge il segreto in modalita' manuale e invia un codice valido.
async function completaTotp(page) {
  if (await page.locator('#mode-manual').count()) { await page.click('#mode-manual'); await page.waitForLoadState('load').catch(() => {}); }
  const segreto = (await page.locator('#kc-totp-secret-key').innerText()).trim();
  await page.fill('#totp', codiceTotp(segreto));
  await invia(page, '#saveTOTPBtn, input[type=submit]');
}

/* ------------------------------- Mailpit ------------------------------- */
async function mailpit(path, opzioni) {
  const r = await fetch(`${MAILPIT}/api/v1${path}`, opzioni);
  if (!r.ok) throw new Error(`Mailpit ${path}: HTTP ${r.status}`);
  return r.status === 200 && opzioni?.method !== 'DELETE' ? r.json() : null;
}

// Ultima email per il destinatario (attende fino a 10 s): { html, link } con il link 'login-actions'.
async function ultimaEmail(destinatario) {
  for (let i = 0; i < 20; i++) {
    const { messages = [] } = await mailpit('/messages');
    const m = messages.find(x => (x.To || []).some(t => t.Address === destinatario));
    if (m) {
      const completo = await mailpit(`/message/${m.ID}`);
      const l = (completo.HTML || '').match(/href="(https?:[^"]+login-actions[^"]+)"/) || (completo.Text || '').match(/(https?:\S+login-actions\S+)/);
      return { html: completo.HTML || `<pre>${completo.Text || ''}</pre>`, link: l && l[1].replace(/&amp;/g, '&') };
    }
    await pausa(500);
  }
  throw new Error(`nessuna email per ${destinatario} su Mailpit (${MAILPIT}): SMTP del realm configurato?`);
}

async function analizzaEmail({ scan, newPage, page }, destinatario, nomeEmail, nomeLink) {
  const email = await ultimaEmail(destinatario);
  const p = await newPage();
  // Solo il DOM: le immagini dell'email puntano al basePath di produzione del tema (es.
  // govdesk.nvgroup.it), che dall'ambiente di prova puo' non rispondere e bloccare 'load'.
  await p.setContent(email.html, { waitUntil: 'domcontentloaded' });
  await scan(nomeEmail, { page: p, keyboard: false });
  if (nomeLink) {
    if (!email.link) throw new Error(`l'email per ${destinatario} non contiene un link 'login-actions'`);
    await page.goto(email.link, { waitUntil: 'load' });
    await scan(nomeLink);
  }
}

/* ================================ passi ================================ */

// Svuota la casella di Mailpit: da chiamare prima di un'azione che invia un'email.
export async function svuotaPosta() {
  await mailpit('/messages', { method: 'DELETE' });
}

// args: { user, client?, extra? }. Login sulla pagina corrente, o su quella del client indicato.
export async function accedi({ page, base, args }) {
  await login(page, { base, ...args });
}

// args: { destinatario, email: <nome vista email>, link?: <nome vista del link> }
export async function email(ctx) {
  const { destinatario, email: nomeEmail = 'email', link } = ctx.args;
  await analizzaEmail(ctx, destinatario, nomeEmail, link);
}

// Sulla pagina di configurazione TOTP: completa la configurazione con un codice valido.
export async function totp({ page }) {
  await completaTotp(page);
}

/* args: { user, client? }. In una sessione separata fa il login e completa la configurazione TOTP,
   cosi' i login successivi chiedono il codice (login-otp, select-authenticator). */
export async function configuraTotp({ newPage, base, args }) {
  const p = await newPage();
  await login(p, { base, user: args.user, client: args.client || 'a11y-app' });
  if (!(await p.locator('#kc-totp-secret-key, #mode-manual').count())) throw new Error(`l'utente ${args.user} non e' sulla pagina di configurazione TOTP (gia' configurato?)`);
  await completaTotp(p);
}

/* args: { user }. In una sessione separata fa il login e conferma i codici di recupero, cosi' il
   client a11y-rc puo' chiederne uno. */
export async function confermaCodiciRecupero({ newPage, base, args }) {
  const p = await newPage();
  await login(p, { base, user: args.user, client: 'a11y-app' });
  if (await p.locator('#kcRecoveryCodesConfirmationCheck').count()) {
    await p.check('#kcRecoveryCodesConfirmationCheck');
    await invia(p, '#saveRecoveryAuthnCodesBtn, input[type=submit]');
  }
}

/* Autenticatore WebAuthn virtuale (CDP) sulla pagina del flow: le pagine webauthn-register e
   webauthn-authenticate funzionano come con una chiave vera. */
export async function autenticatoreVirtuale({ page }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
}

/* args: { user }. Registra la chiave con l'autenticatore virtuale (gia' installato), analizza la
   richiesta dell'etichetta se compare, poi rifa' il login senza cookie e analizza la pagina di
   autenticazione. In una sessione senza autenticatore analizza la pagina d'errore. */
export async function webauthnCompleto({ page, newPage, base, args, scan }) {
  await page.click('#registerWebAuthn');
  await page.waitForLoadState('load').catch(() => {});
  await pausa(1000);
  if (await page.locator('#authenticatorLabel, input[name=authenticatorLabel]').count()) await scan('webauthn-register-label');
  await page.context().clearCookies();
  await page.goto(authUrl(base, 'a11y-wa'), { waitUntil: 'load' });
  await page.fill('#username', args.user);
  await invia(page, '#kc-login');
  await scan('webauthn-authenticate');
  const q = await newPage();
  await q.goto(authUrl(base, 'a11y-wa'), { waitUntil: 'load' });
  await q.fill('#username', args.user);
  await invia(q, '#kc-login');
  await q.click('#authenticateWebAuthnButton, input[type=button], button').catch(() => {});
  await pausa(3000);
  await q.waitForLoadState('load').catch(() => {});
  await scan('webauthn-error', { page: q });
}

/* args: { user }. In una sessione separata: login, configurazione TOTP gia' fatta, codice
   sbagliato. Analizza login-otp e il suo errore. */
export async function loginOtp({ newPage, base, args, scan }) {
  const p = await newPage();
  await login(p, { base, user: args.user, client: 'a11y-app' });
  await scan('login-otp', { page: p });
  await p.fill('#otp', '000000');
  await invia(p, '#kc-login');
  await scan('login-otp-errore', { page: p });
}

/* args: { user }. Invia all'utente l'email "azioni richieste" dalle API di amministrazione, ne
   analizza il template e la pagina info.ftl a cui porta il link. */
export async function azioniRichieste(ctx) {
  const { base, args } = ctx;
  const t = await (await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.A11Y_KC_ADMIN_USER || 'admin', password: process.env.A11Y_KC_ADMIN_PASS || 'admin' }),
  })).json();
  if (!t.access_token) throw new Error('token di amministrazione non ottenuto (A11Y_KC_ADMIN_USER / A11Y_KC_ADMIN_PASS)');
  const h = { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' };
  const [utente] = await (await fetch(`${base}/admin/realms/${REALM}/users?username=${encodeURIComponent(args.user)}&exact=true`, { headers: h })).json();
  if (!utente) throw new Error(`utente ${args.user} non trovato nel realm ${REALM}`);
  await svuotaPosta();
  const r = await fetch(`${base}/admin/realms/${REALM}/users/${utente.id}/execute-actions-email?client_id=a11y-app&redirect_uri=${redirect(base)}`,
    { method: 'PUT', headers: h, body: JSON.stringify(['UPDATE_PASSWORD']) });
  if (!r.ok) throw new Error(`execute-actions-email: HTTP ${r.status}`);
  await analizzaEmail(ctx, utente.email, 'email-execute-actions', 'info-execute-actions');
}

/* args: { user }. First broker login con un utente dell'IdP che ha la stessa email di un utente del
   realm: supera la revisione del profilo se compare e analizza la conferma del collegamento e la
   pagina successiva (email o nuova autenticazione). */
export async function collegamentoAccount({ page, base, args, scan }) {
  await page.goto(authUrl(base, 'a11y-app', '&kc_idp_hint=a11y-idp'), { waitUntil: 'load' });
  await page.fill('#username', args.user);
  await page.fill('#password', password());
  await invia(page, '#kc-login');
  if (await page.locator('#kc-idp-review-profile-form').count() || (/first-broker-login/.test(page.url()) && !(await page.locator('#linkAccount').count()))) await invia(page);
  await scan('login-idp-link-confirm');
  await invia(page, 'button[value=linkAccount], #linkAccount');
  await scan('login-idp-link-email-o-reauth');
}

/* Pagina di login con le verifiche da tastiera che axe non fa.
   - Provider SPID: nei temi SPID l'elenco degli IdP arriva dalla configurazione del realm, che in
     prova e' vuota. Si iniettano tre provider nella risposta, cosi' il menu ha voci da percorrere.
   - Menu lingua: si deve aprire con Invio (aria-expanded="true", elenco visibile).
   - Menu SPID: si apre con Invio, si percorre col Tab, si chiude con Esc e il focus torna al bottone.
   Le verifiche fallite diventano violazioni delle viste analizzate (scan({ problemi })).
   args: { client? } */
export async function paginaLogin({ page, base, args, scan }) {
  const iniezione = async route => {
    const r = await route.fetch();
    const corpo = (await r.text()).replace('spidproviders: {', 'spidproviders: {"spid-aruba":"#aruba","spid-poste":"#poste","spid-infocert":"#infocert",');
    await route.fulfill({ response: r, body: corpo });
  };
  await page.route(/openid-connect\/auth/, iniezione);
  await page.goto(authUrl(base, args.client || 'a11y-app'), { waitUntil: 'load' });
  await page.unroute(/openid-connect\/auth/, iniezione);
  await scan('login');

  if (await page.locator('#kc-current-locale-link').count()) {
    await page.focus('#kc-current-locale-link');
    await page.keyboard.press('Enter');
    await pausa(300);
    const st = await page.evaluate(() => ({
      espanso: document.querySelector('#kc-current-locale-link').getAttribute('aria-expanded'),
      visibile: !!document.querySelector('#language-switch1')?.offsetParent,
    }));
    const problemi = [];
    if (st.espanso !== 'true' || !st.visibile) problemi.push({ criterio: '2.1.1', selettore: '#kc-current-locale-link', messaggio: `Il menu lingua non si apre con Invio (aria-expanded=${st.espanso}, elenco visibile=${st.visibile})` });
    await scan('menu-lingua-aperto', { problemi, keyboard: false });
    await page.keyboard.press('Escape');
    await pausa(300);
  }

  const spid = page.locator('a.button-spid, a[spid-idp-button]').first();
  if (await spid.count()) {
    await spid.focus();
    await page.keyboard.press('Enter');
    await pausa(500);
    const aperto = await page.evaluate(() => {
      const m = document.querySelector('.spid-idp-button');
      return !!m && getComputedStyle(m).display !== 'none' && !!m.offsetParent;
    });
    if (!aperto) {
      await scan('menu-spid', { keyboard: false, problemi: [{ criterio: '2.1.1', selettore: '[spid-idp-button]', messaggio: 'Il menu SPID non si apre con Invio' }] });
      return;
    }
    await scan('menu-spid-aperto', { keyboard: false });
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await pausa(300);
    const st = await page.evaluate(() => {
      const m = document.querySelector('.spid-idp-button');
      const b = document.querySelector('[spid-idp-button]');
      return {
        chiuso: !m || !m.offsetParent || getComputedStyle(m).display === 'none',
        focusSulBottone: !!b && document.activeElement === b,
        espanso: b && b.getAttribute('aria-expanded'),
      };
    });
    const problemi = [];
    if (!st.chiuso) problemi.push({ criterio: '1.4.13', selettore: '.spid-idp-button', messaggio: 'Il menu SPID non si chiude con Esc' });
    if (!st.focusSulBottone) problemi.push({ criterio: '2.4.3', selettore: '[spid-idp-button]', messaggio: 'Dopo Esc il focus non torna al bottone SPID' });
    if (st.espanso === 'true') problemi.push({ criterio: '4.1.2', selettore: '[spid-idp-button]', messaggio: 'Dopo la chiusura il bottone SPID resta aria-expanded="true"' });
    await scan('menu-spid-chiuso', { problemi, keyboard: false });
  }
}
