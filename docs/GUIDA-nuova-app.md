# Aggiungere una nuova app a gov-a11y

Guida per configurare lo scanner a11y su una webapp non ancora coperta. Il tool è
**black-box**: non si tocca il codice dell'app, si aggiunge **solo un file di config**
`targets.<app>.json`.

La guida è **generica** (vale per qualsiasi webapp: SPA Angular/React, app server-rendered
JSF/JSP, catalogo pubblico). Come riferimenti concreti usa i **config reali** in `targets/`:

- **`targets/govcat/targets.govcat.json`** — SPA Angular, auth via **header** + **select-org** (`postLogin`).
- **`targets/govpay/targets.govpay-console.json`** — SPA Angular, molte rotte, auth OAuth2/SPID/IAM (con blocco auth da adattare).
- **`targets/govway/targets.govway.json`** — app JSF/RichFaces, navigazione ricorsiva della console (`scanMenu`/`recurse`).
- **`examples/targets/targets.example.json`** — template annotato (SPA header-auth **e** app a form + flow).

> Prerequisito unico: l'app **in esecuzione e raggiungibile** (dev locale, preview o deploy).

---

## In sintesi

1. **Copia** un config esistente come base → `targets.<app>.json`.
2. **Auth**: scegli come autenticarsi (header / form / SSO / no-auth) + eventuali `postLogin`.
3. **Rotte**: elenca in `pages` le viste GET-navigabili; per quelle non raggiungibili via URL usa `flows`.
4. **SPA**: se è Angular/React in dev, imposta `navWait: "domcontentloaded"` + `navDelayMs`.
5. **Lancia** e leggi i report; poi (opzionale) aggiungi il job in CI.

Lo schema completo di tutte le chiavi è in **`docs/GUIDA-config.md`** (e in sintesi nel `README.md`).

---

## Passo 1 — Crea il file di config

Parti dal config **più vicino** al tuo caso, non dal foglio bianco:

```bash
cd <repo-gov-a11y>

# SPA con auth via header  → base GovCat
cp targets/govcat/targets.govcat.json            targets.<app>.json
# SPA con molte rotte / OAuth → base GovPay Console
cp targets/govpay/targets.govpay-console.json    targets.<app>.json
# app JSF/console con menu   → base GovWay
cp targets/govway/targets.govway.json            targets.<app>.json
# in dubbio / app a form      → template annotato
cp examples/targets/targets.example.json         targets.<app>.json
```

Ogni chiave di primo livello (che non inizia con `$`) è un **target**; tieni **un solo
target** per app salvo esigenze particolari. La chiave (es. `govpayConsole`) è usata anche per
le credenziali da env: `A11Y_<CHIAVE>_USER` / `A11Y_<CHIAVE>_PASS`.

---

## Passo 2 — Autenticazione (la scelta chiave)

**Dove capirlo, in generale:**
- apri la **pagina di login** dell'app e guarda com'è fatto il form (campi, bottone);
- per le app con config runtime, guarda il file di configurazione dell'auth (spesso
  `assets/config/app-config.json`, chiavi tipo `Auth`, `oauth`, `issuer`, `login`);
- chiedi se in **dev/test** esiste un **bypass** (header/principal, utente tecnico): è la
  strada più semplice e deterministica.

**Scegli UNA modalità** (o combinale):

| Situazione | Come configurarla |
|---|---|
| **Header di dev / principal** | `extraHTTPHeaders: { "X-...": "utente" }` — header su ogni richiesta, niente form. *(vedi `targets/govcat/targets.govcat.json`)* |
| **Login a form** (username/password: IAM, Keycloak con form, basic) | blocco `login` con i selettori del form. *(vedi `targets.example.json` → `classicFormLogin`)* |
| **SSO / OAuth con redirect a IdP esterno** | se c'è una **form IdP** scriptabile → `login` coi selettori dell'IdP; altrimenti un utente/**bypass** di test |
| **Nessuna auth** (catalogo pubblico) | ometti sia `login` sia header |

Blocco `login` a form (adatta i selettori alla pagina reale):

```jsonc
"login": {
  "usernameSelector": "#username, input[name='username']",
  "passwordSelector": "input[type='password'], input[name='password']",
  "submitSelector": "button[type='submit'], input[type='submit']",
  "successUrlIncludes": "dashboard"    // stringa attesa nell'URL DOPO il login
}
```

Se dopo il login servono passi extra (selezione organizzazione/ente/dominio, consensi), usa
`postLogin` (stessi step dei flow — vedi Passo 5). Esempio reale in `targets/govcat/targets.govcat.json`
(select-org: `clickText` "Ministero Interno" → "Conferma").

> **Regola d'oro**: le credenziali **non** vanno nel file di config. Usa i **secret di CI**
> (`A11Y_<TARGET>_USER/PASS`) o i flag `--user/--pass`.

---

## Passo 3 — Elenca le rotte (`pages`)

In `pages` metti le viste **GET-navigabili** (una lista, un form-nuovo, la dashboard). Le viste
di **dettaglio** che si aprono solo cliccando una riga vanno nei `flows` (Passo 5).

**Dove trovare le rotte, per stack:**
- **Angular**: file di routing (`app.routes.ts`, `*-routing.module.ts`, `*.routes.ts` nei
  feature module) → i `path:` di primo livello.
- **React**: definizioni `<Route path=...>` / il router centrale.
- **Server-rendered (JSF/JSP/Thymeleaf)**: le pagine sotto `src/main/webapp/**` o la mappatura
  dei controller.
- **A colpo sicuro**: naviga l'app da loggato e annota gli URL della barra indirizzi.

```jsonc
"pages": [
  { "name": "dashboard", "path": "/dashboard" },
  { "name": "lista",     "path": "/items" },
  { "name": "nuovo",     "path": "/items/new" }
]
```

> Parti da **poche rotte rappresentative**, verifica che login+navigazione funzionino, poi
> estendi. Per un elenco completo già pronto vedi `targets/govpay/targets.govpay-console.json` (19 rotte).

---

## Passo 4 — SPA (Angular/React)

Nel **dev server** l'HMR tiene aperto un websocket → l'attesa `networkidle` non scatta mai e la
navigazione va in timeout. Per le SPA in dev:

```jsonc
"navWait": "domcontentloaded",   // invece del default 'networkidle'
"navDelayMs": 2500               // attesa di settle prima di far girare axe
```

Su un **deploy** statico (senza HMR) puoi lasciare il default `networkidle`.

---

## Passo 5 (opzionale) — Flows per viste non navigabili via URL

Dettagli che si aprono cliccando una riga, tab interne, grafici: si raggiungono con uno
**script** di passi. Step disponibili (validi anche in `postLogin`):

`goto`, `fill:{selector,value}`, `clickText`(+`exact`), `click`,
`wait`(`networkidle`|`load`|`domcontentloaded`|un selettore), `delayMs`, `timeoutMs`,
`optional` (non interrompe il flow), `scan`, `scanTabs`, `scanCharts`.

```jsonc
"flows": [
  {
    "name": "dettaglio",
    "start": "/items",
    "skipIfMissing": "table tbody tr",     // se la lista è vuota, salta il flow
    "steps": [
      { "click": "table tbody tr", "wait": "domcontentloaded", "delayMs": 1500 },
      { "scanTabs": ".nav-tabs .nav-link" }
    ]
  }
]
```

> **Selettori stabili**: `id` non generati, `title`, testo, classi semantiche. Mai id volatili
> (es. `j_idNN` di JSF o hash generati). Esempi di flow reali in `targets.example.json`.

---

## Passo 6 — Lancia lo scan

```bash
cd <repo-gov-a11y>

# axe (senza Lighthouse)
node a11y-scan.mjs \
  --base <URL_APP> \
  --config ./targets.<app>.json \
  --out ./report-<app> \
  --tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa

# con Lighthouse (opt-in con --lighthouse; disattivabile da config con --no-lighthouse)
node a11y-scan.mjs --base <URL_APP> --config ./targets.<app>.json \
  --out ./report-<app> --lighthouse --tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa
```

Flag utili: `--only <targetKey>`, `--no-flows`, `--fail-on <sev>` (gate, default `serious`),
`--user/--pass`. Exit-code: **0** gate ok, **1** gate fallito, **2** errore/nessun target.

---

## Passo 7 — Leggi i report (`--out`)

- `report.html` — leggibile: violazioni + colonna **"Da verificare"** (incomplete) + a11y-tree.
- `summary.json` — per-pagina: `counts`, `incomplete`, `lhScore`, `namelessInteractive`.
- `axe-results.json` — grezzo (`violations` **e** `incomplete`, + `axTree`).
- `a11y-junit.xml` (gate CI), `a11y.sarif` (GitHub Code Scanning), `sonar-issues.json` (Sonar).

> `violations` = da correggere; `incomplete` = controlli che axe non decide da solo (es.
> contrasto su gradienti) → **verifica manuale**, non fanno fallire il gate.

---

## Passo 8 (opzionale) — CI

```yaml
- run: npm ci && npx playwright install --with-deps chromium
- run: node a11y-scan.mjs --base "$APP_URL" --config ./targets.<app>.json --out ./report --fail-on serious
- if: always()
  uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: ./report/a11y.sarif }
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: a11y-report, path: ./report }
```

---

## Esempio concreto: GovPay Console

Applicazione dei passi sopra a `govpay-console-v2-github` (Angular SPA):

- **File**: `targets/govpay/targets.govpay-console.json` (già presente, da usare come base/riferimento).
- **URL**: `npm run start` → `http://localhost:4200` (oppure `npm run start:port` → `:5300`).
- **Auth** (Passo 2): l'app usa **OAuth2/SPID/IAM** (`assets/config/app-config.json`, blocco
  `Auth`; rotta app `auth/login`). Il config parte con un blocco `login` a form da adattare; in
  alternativa, se l'ambiente di test espone un header/bypass, si passa a `extraHTTPHeaders`.
- **Rotte** (Passo 3): le 19 di primo livello da `projects/govpay-console/src/app/app.routes.ts`
  (dashboard, pendenze, ricevute, pagamenti, riscossioni, rendicontazioni, incassi,
  giornale-eventi, tracciati, domini, tipi-pendenza, entrate, applicazioni, operatori, ruoli,
  intermediari, profilo, impostazioni, about) — già elencate nel config.
- **Maschere di dettaglio**: le form di **creazione `/nuovo`** (domini, tipi-pendenza, entrate,
  applicazioni, operatori, ruoli, intermediari) sono statiche → in `pages`. Le maschere di
  **dettaglio/modifica per-id** (`:idDominio`, `:idA2A/:idPendenza`, …) non sono GET-navigabili
  → sono coperte da 15 **`flows`**: tutte le liste usano il componente condiviso
  `lnk-item-list`/`lnk-item-row`, quindi ogni flow apre il **primo elemento**
  (`click: "lnk-item-list lnk-item-row .cursor-pointer"`), scansiona il dettaglio e, dove
  esiste, apre anche la **modifica** (`clickText: "Modifica"`). `skipIfMissing` salta il flow se
  la lista è vuota.
- **SPA** (Passo 4): `navWait: "domcontentloaded"` + `navDelayMs: 2500`.

Lancio:
```bash
node a11y-scan.mjs --base http://localhost:4200 \
  --config targets/govpay/targets.govpay-console.json --out ./report-govpay-console \
  --tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa
```

---

## Troubleshooting

| Sintomo | Causa probabile / rimedio |
|---|---|
| Navigazione va in **timeout** su SPA | manca `navWait: "domcontentloaded"` (l'HMR blocca `networkidle`) |
| **Login non riesce** | selettori `login` errati, oppure serve auth via header/`postLogin`; verifica `successUrlIncludes` |
| Pagine scansionate ma **vuote / redirect a login** | sessione non autenticata: header mancante o step `postLogin` (select-org/dominio) non eseguiti |
| **Lighthouse** sempre `lhScore: null` / `lighthouse: []` | manca il flag **`--lighthouse`** (è opt-in), oppure il modulo `lighthouse` non è installato (`npm install lighthouse`) |
| Un **flow** non parte | la `skipIfMissing`/sentinella non è presente (lista vuota) → popola dati di test o rendi lo step `optional` |
| Troppi **incomplete** | normale su sfondi calcolati/gradienti: verifica a mano il contrasto |

---

## Checklist finale

- [ ] `targets.<app>.json` creato da un config esistente
- [ ] Auth configurata (header **o** form **o** SSO) + eventuale `postLogin`
- [ ] `navWait`/`navDelayMs` impostati se SPA in dev
- [ ] `pages` con le rotte GET-navigabili principali
- [ ] `flows` per le viste di dettaglio (se servono)
- [ ] Scan verde in locale (`--fail-on serious`)
- [ ] Job CI aggiunto (opzionale)

Riferimenti: `README.md` (schema completo e opzioni CLI), `targets.example.json` (template
annotato), `targets/govcat/targets.govcat.json` e `targets/govpay/targets.govpay-console.json` (esempi reali).
