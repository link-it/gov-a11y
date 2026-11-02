# Temi di login Keycloak (GovDesk)

Scansione di accessibilità dei temi Keycloak del repository **govdesk-kc-theme**:
`govdesk`, `govdesk-noviservice`, `govdesk-spid`, `govdesk-spid-cie`, `govdesk-okta`.

Come per gli altri target, gov-a11y **scansiona soltanto** un'applicazione già avviata altrove.
Keycloak con i temi montati, Mailpit e i realm di prova li prepara il repo dei temi
(`govdesk-kc-theme/a11y/`) con le stesse credenziali del `.env`. Questa cartella contiene solo
il target:

| File | Contenuto |
|---|---|
| `scan.sh` | scansione di un tema già attivo nel realm di prova: legge `.env`, verifica che l'ambiente sia pronto, lancia lo scanner |
| `targets.keycloak.json` | temi completi: tutte le pagine e i template email |
| `targets.keycloak-login.json` | varianti che cambiano solo `login.ftl`: pagina di login |
| `keycloak.steps.mjs` | passi `script`: email (Mailpit), TOTP, WebAuthn virtuale, API admin, menu SPID e lingua |

---

## 1. Cosa serve (una volta sola)

| Cosa | Versione | Verifica |
|---|---|---|
| Docker | qualsiasi recente | `docker ps` funziona senza sudo |
| Node.js | ≥ 18 | `node --version` |
| Python 3 | ≥ 3.8 | `python3 --version` (solo libreria standard, per `setup.py`) |
| curl | — | `curl --version` |
| gov-a11y | — | `npm ci` nella radice di gov-a11y (scarica anche Chromium) |
| Repo dei temi | — | `govdesk-kc-theme`, con dentro `govdesk/login/theme.properties` e `a11y/` |

Le porte **8090** (Keycloak) e **8025** (Mailpit) di `127.0.0.1` devono essere libere.

Negli esempi i due repository stanno qui (adattare i percorsi):

```bash
GOVA11Y=~/Documenti/Project/gov-a11y
TEMI=~/Documenti/Keycloak/govdesk-kc-theme
```

## 2. Credenziali (`.env`)

Come per gli altri target, le credenziali stanno nel `.env` della radice di gov-a11y (gitignorato,
**mai committarlo**) o nell'ambiente, che ha la precedenza. Devono essere **le stesse** con cui il
repo dei temi ha avviato Keycloak e creato gli utenti di prova (`container.sh` usa di default
`admin` / `admin` e `Pwd12345!`).

```
A11Y_KC_ADMIN_USER=admin       # admin del realm master di Keycloak
A11Y_KC_ADMIN_PASS=...
A11Y_KC_PASS=...               # password degli utenti di prova creati da setup.py
```

| Variabile | Chi la usa | Se manca |
|---|---|---|
| `A11Y_KC_ADMIN_USER` / `A11Y_KC_ADMIN_PASS` | passi di `keycloak.steps.mjs` (API admin) | `scan.sh` si ferma |
| `A11Y_KC_PASS` | scansione (login degli utenti di prova) | `scan.sh` si ferma |
| `MAILPIT_URL` | passi delle email | `http://127.0.0.1:8025` |

## 3. Preparare l'ambiente (repo dei temi)

gov-a11y non avvia container. Keycloak con i temi montati, Mailpit e i realm di prova per un tema
li prepara il repo dei temi:

```bash
cd "$TEMI"
a11y/container.sh govdesk       # avvia (o riusa) Keycloak e Mailpit, ricrea i realm per govdesk
a11y/container.sh --pulisci     # a fine lavoro: cancella i realm e spegne i container
```

Per cambiare tema si rilancia `container.sh <tema>`: i container restano, i realm vengono ricreati.
Va rilanciato anche **dopo ogni scansione completa**, perché le azioni richieste completate dagli
utenti non si ripetono. Dettagli (realm, flussi, client, utenti, porte): `a11y/README.md` del repo
dei temi.

## 4. Scansionare

### 4.1 Un tema

Con l'ambiente pronto per quel tema:

```bash
cd "$GOVA11Y"
targets/keycloak/scan.sh --out report-keycloak-govdesk                       # tema completo
targets/keycloak/scan.sh --solo-login --out report-keycloak-govdesk-spid     # variante (solo login.ftl)
```

Temi completi: `govdesk`, `govdesk-noviservice`. Varianti con `--solo-login`: `govdesk-spid`,
`govdesk-spid-cie`, `govdesk-okta`.

Opzioni: `--full` (Lighthouse e screen reader, prima di un rilascio), `--base URL` (default
`http://127.0.0.1:8090`, anche `A11Y_BASE_URL`), `--product-version V`; `scan.sh --help`.
Esce con **0** gate superato, **1** gate fallito, **2** credenziali mancanti o ambiente non
pronto (realm `a11y-test` non raggiungibile).

I report vanno nella radice di gov-a11y, accanto a quelli degli altri target:
`report-keycloak-<tema>/report.html`. Ci vogliono circa 5–10 minuti per un tema completo, meno di
uno per una variante.

### 4.2 Tutti i temi

Un tema alla volta: prepara, scansiona, passa al successivo.

```bash
cd "$GOVA11Y"
for t in govdesk govdesk-noviservice govdesk-spid govdesk-spid-cie govdesk-okta; do
  "$TEMI/a11y/container.sh" "$t" || break
  case "$t" in govdesk|govdesk-noviservice) solo=() ;; *) solo=(--solo-login) ;; esac
  targets/keycloak/scan.sh "${solo[@]}" --out "report-keycloak-$t"
done
"$TEMI/a11y/container.sh" --pulisci
```

### 4.3 Guardare le pagine nel browser

Con l'ambiente acceso (`container.sh <tema>`). Password degli utenti: `A11Y_KC_PASS`.

| Pagina | URL / come arrivarci |
|---|---|
| Login | `http://127.0.0.1:8090/realms/a11y-test/protocol/openid-connect/auth?client_id=a11y-app&response_type=code&scope=openid&redirect_uri=http%3A%2F%2F127.0.0.1%3A8090%2Frealms%2Fa11y-test%2F.well-known%2Fopenid-configuration` (aggiungere `&ui_locales=en` per l'inglese) |
| Registrazione | lo stesso URL con `/registrations` al posto di `/auth` |
| Password dimenticata | `http://127.0.0.1:8090/realms/a11y-test/login-actions/reset-credentials?client_id=a11y-app` |
| Email ricevute | `http://127.0.0.1:8025` (Mailpit) |
| Azioni richieste | login con `u-updpwd`, `u-totp`, `u-profile`, `u-verify`, `u-terms`, `u-email`, `u-recovery`, `u-delete` (una sola volta: poi rilanciare `container.sh <tema>`) |
| Username e password separati | l'URL di login con `client_id=a11y-uf` |
| Device flow | `http://127.0.0.1:8090/realms/a11y-test/device` |
| Pagina d'errore | `http://127.0.0.1:8090/realms/a11y-test/protocol/openid-connect/auth?client_id=inesistente&response_type=code&redirect_uri=x` |

### 4.4 Spegnere tutto

```bash
"$TEMI/a11y/container.sh" --pulisci     # cancella i realm di prova e spegne i container
```

### 4.5 Anteprima grafica delle email

Senza Keycloak: ricostruisce le email (reset password, verifica email, azioni richieste) di
`govdesk` e `govdesk-noviservice` dai template del repo dei temi, con testi italiani e valori di
esempio, e copia accanto le immagini del tema.

```bash
cd "$GOVA11Y"
python3 targets/keycloak/email-preview.py "$TEMI"     # -> report-keycloak-email/index.html
```

È un'anteprima della grafica, non l'email inviata davvero (quella si vede in Mailpit).

## 5. Cosa viene verificato

Su ogni vista:

| Controllo | Criteri | Fonte |
|---|---|---|
| Regole axe-core WCAG 2.0/2.1/2.2 A e AA + best practice | molti | axe |
| Elementi interattivi senza nome accessibile | 4.1.2 | albero di accessibilità |
| Comandi utilizzabili col solo mouse | 2.1.1 | gov-a11y |
| Riflusso a 320px: niente scorrimento orizzontale | 1.4.10 | gov-a11y (`reflow`) |
| Spaziatura del testo aumentata: niente testo tagliato | 1.4.12 | gov-a11y (`textSpacing`) |
| Percorso col Tab: focus visibile, non coperto, nessuna trappola; ordine di focus registrato | 2.4.7, 2.4.11, 2.1.2 | gov-a11y (`keyboardWalk`) |
| Testi italiani fissi fuori da `lang="it"`, parole inglesi nelle pagine italiane | 3.1.2 | gov-a11y (`languageParts`) |
| Menu lingua e menu SPID da tastiera (Invio apre, Esc chiude, il focus torna al bottone) | 2.1.1, 1.4.13, 2.4.3, 4.1.2 | `keycloak.steps.mjs#paginaLogin` |
| Annunci dello screen reader virtuale, punteggio Lighthouse | — | solo con `--screen-reader` / `--lighthouse` (`--full`) |

### Pagine analizzate (temi completi)

| Gruppo | Viste |
|---|---|
| Login | login (con 3 provider SPID iniettati), login in inglese, errore di login, menu lingua aperto, menu SPID aperto/chiuso |
| Registrazione | modulo, errori |
| Password dimenticata | modulo, errore, email inviata, **email** di reset, pagina dal link dell'email |
| Azioni richieste | aggiorna password (+ errore policy), configura TOTP (+ errore, modalità manuale), aggiorna profilo (+ errori), verifica email (+ **email**), termini, aggiorna email, codici di recupero, eliminazione account |
| Secondo fattore | login OTP (+ errore), scelta del metodo ("Prova un altro metodo"), codice di recupero (+ errore) |
| WebAuthn | registrazione, etichetta, autenticazione, errore, registrazione passwordless (autenticatore virtuale) |
| Username e password separati | username (+ errore), password (+ errore) |
| Altro | consenso OAuth, device flow (+ errore), conferma logout, logout eseguito, logout front-channel, sessione scaduta, pagina d'errore, **email** "azioni richieste" e `info.ftl` |
| Broker | revisione profilo (+ errori), conferma collegamento account, pagina successiva |

### Non coperte

Richiedono un'infrastruttura che il Keycloak di prova non ha: `login-x509-info` (certificato
client), `saml-post-form` (client SAML), `select-organization` (organizzazioni),
`email-code-form`, `login-reset-otp`, passkey in "conditional UI", `code.ftl` (flusso OOB).
Ereditano comunque `template.ftl` e la card generica del tema.

## 6. Leggere i risultati

- Apri `report.html` nel browser: violazioni per vista, elemento coinvolto, criterio WCAG,
  "da verificare" (controlli che axe non sa decidere da solo), albero di accessibilità.
- Le violazioni dei controlli di gov-a11y hanno id che cominciano con `gova11y-`
  (`gova11y-reflow-320`, `gova11y-focus-visible`, `gova11y-script-211`, …).
- Le regole con il tag `best-practice` non sono criteri WCAG, ma difetti concreti
  (es. `tabindex` maggiore di 0, contenuto fuori dai landmark): fanno comunque fallire il gate
  se di gravità `serious` o superiore.
- `summary.json`, `a11y-junit.xml`, `a11y.sarif`, `sonar-issues.json`: per CI, GitHub, Sonar.

Codice d'uscita: **0** gate superato, **1** gate fallito, **2** ambiente non pronto.

## 7. Aggiungere una pagina

- **Pagina raggiungibile da URL**: una voce in `pages` di `targets.keycloak.json`.
- **Pagina dentro un flusso**: un flow con i passi `fill` / `click` / `scan`
  (guida: `docs/GUIDA-config.md`). Se serve logica (email, codici, API), una funzione in
  `keycloak.steps.mjs` richiamata con il passo `script`.
- **Nuovo utente, client o tema di prova**: in `a11y/setup.py` del repo dei temi (e, per un tema, in `a11y/container.sh`).

## 8. Problemi noti

| Sintomo | Causa / soluzione |
|---|---|
| Pagine con il tema vecchio | Il Keycloak usato monta un'altra cartella, oppure FreeMarker ha la cache: `docker restart <container>` |
| `Manca A11Y_KC_...` | Aggiungerla al `.env` (stesso valore usato per preparare Keycloak) |
| `Realm a11y-test non raggiungibile` | Ambiente non pronto: `container.sh <tema>` nel repo dei temi (§3) |
| `Avvio di Keycloak non riuscito (porta 8090 occupata?)` | Un altro servizio usa la porta: `KC_PORT=8091 a11y/container.sh <tema>` e `--base http://127.0.0.1:8091` con `scan.sh` |
| `Conflict` / `already exists` da `setup.py` | Realm rimasti da un run interrotto: `a11y/container.sh --pulisci` nel repo dei temi |
| `token di amministrazione non ottenuto` | `A11Y_KC_ADMIN_*` diverse da quelle con cui è stato avviato Keycloak |
| `nessuna email per ... su Mailpit` | Mailpit non avviato o `SMTP_HOST` sbagliato in `setup.py`: vedi il repo dei temi |
| Flow `login-errore` "saltato: sentinella '#username' assente" | Normale nelle varianti che mostrano solo i bottoni degli IdP |
