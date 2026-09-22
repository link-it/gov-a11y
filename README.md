# gov-a11y

Scanner di **accessibilità WCAG 2.x** per applicazioni web, **esterno e black-box**: pilota
l'app in esecuzione via HTTP (Playwright) ed esegue [axe-core](https://github.com/dequelabs/axe-core),
una verifica dell'**accessibility tree** e — opzionali — un **virtual screen reader** e **Lighthouse**.
Un **unico tool**, **config per-app**: si usa su più webapp (GovCat, GovPay, GovWay, GovDesk, …)
**senza aggiungere alcuna dipendenza** alle applicazioni testate.

## I livelli di verifica

| Livello | Dove | Come |
|---|---|---|
| **1. axe (regole WCAG)** | Linux CI | axe-core con tag WCAG configurabili |
| **2. Accessibility-tree assertions** | Linux CI, stesso flow Playwright | `ariaSnapshot` di Chromium → elementi interattivi **senza nome accessibile** (gate opz. `--fail-on-nameless`) |
| **2b. Comandi solo-mouse** | Linux CI, stesso flow Playwright | `addEventListener` strumentato → elementi con un **gestore del clic non raggiungibili da tastiera** (gate `--fail-on-mouse-only`, **attivo di default**) |
| **3. Virtual screen reader** | Linux CI (dep in più) | `@guidepup/virtual-screen-reader` → **trascrizione degli annunci** per vista, con cross-check degli annunci "solo-ruolo" |
| 4. NVDA/VoiceOver reali | runner Win/macOS | fuori da questo tool (guidepup reale) |
| 5. SR manuale (umano) | desktop | necessario a campione per conformità AgID |

Questo tool copre i **livelli 1–3**, tutti eseguibili su Linux CI headless. A questi si aggiunge il
punteggio **Lighthouse** (indicatore sintetico, opzionale). Cosa intercetta ciascun livello, cosa
non copre, quanto costa e quando attivarlo: **[`docs/GUIDA-livelli-di-verifica.md`](docs/GUIDA-livelli-di-verifica.md)**.

## Requisiti e installazione

- Node.js ≥ 18.
- L'app da testare **in esecuzione e raggiungibile** (locale, preview o deploy/service CI).

```bash
npm ci                 # installa deps + (postinstall) scarica Chromium
                       # le optionalDependencies (lighthouse, jsdom, virtual-screen-reader)
                       # servono solo per --lighthouse / --screen-reader
```

Per sapere **se** sono state installate (senza reinstallarle e senza lanciare una scansione):

```bash
node a11y-scan.mjs --check-deps --config ./targets/govway/targets.govway_console.json
```

Elenca modulo per modulo versione installata / `NON INSTALLATO` e quali feature richiede questa
esecuzione (CLI + config). Se una feature richiesta non ha i moduli, **la scansione si ferma subito
con exit code 2** invece di produrre punteggi vuoti.

## Uso rapido

```bash
# GovCat (Angular SPA, auth via header + select-org)
node a11y-scan.mjs --base http://localhost:6200 --config ./targets/govcat/targets.govcat.json \
  --out ./report-govcat --no-flows --screen-reader --fail-on-nameless

# GovWay (login a form, console con navigazione ricorsiva)
node a11y-scan.mjs --base http://localhost:8080 --config ./targets/govway/targets.govway.json --out ./report-govway
```

I config **reali** dei prodotti sono in [`targets/<progetto>/`](targets/) — `govway/` (target unificato +
console/monitor separati), `govpay/`, `govcat/`. Gli **esempi/template** annotati sono in
[`examples/targets/`](examples/targets/).

I report finiscono nella dir `--out`. Exit-code: **0** = gate superato, **1** = gate fallito,
**2** = errore/nessun target.

## Opzioni CLI

| Flag | Default | Descrizione |
|------|---------|-------------|
| `--base <url>` | `http://localhost:8080` (o env `A11Y_BASE_URL`) | Base URL dell'app in test |
| `--config <file>` | `./targets.json` | File di configurazione target (accetta path esterno assoluto) |
| `--out <dir>` | `./report` | Directory dei report |
| `--only <key>` | tutti | Limita a un target (chiave nel config) |
| `--user` / `--pass` | `amministratore` / `123456` | Credenziali fallback globali (form login) |
| `--tags <list>` | `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice` | Tag di axe: WCAG fino al livello AA delle 2.2, più `best-practice`. I tag AAA sono esclusi |
| `--fail-on <sev>` | `serious` | Gate axe: fallisci se violazioni ≥ gravità (`critical\|serious\|moderate\|minor\|none`) |
| `--fail-on-nameless` | **on** | **Gate livello 2**: fallisci se esistono elementi interattivi senza nome accessibile. Si disattiva con `"failOnNameless": false` nel config |
| `--fail-on-screen-reader` | off | **Gate livello 3**: fallisci se il virtual screen reader produce annunci col solo ruolo |
| `--fail-on-mouse-only` | **on** | **Gate livello 2b**: fallisci se esistono comandi utilizzabili col solo mouse. Si disattiva con `"failOnMouseOnly": false` nel config |
| `--no-mouse-only` | — | Disabilita il controllo dei comandi solo-mouse (attivo di default) |
| `--screen-reader` | off | **Livello 3**: esegui il virtual screen reader su ogni vista (richiede optional deps) |
| `--lighthouse` | off | Punteggio Lighthouse Accessibility (richiede il modulo `lighthouse`). L'audit gira in una tab separata aperta via CDP: riceve i **cookie di sessione** del context di scansione (header `Cookie`) e gli `extraHTTPHeaders` del target, così valuta le pagine autenticate |
| `--min-score <0..1>` | — | Gate Lighthouse (implica `--lighthouse`) |
| `--crawl <n>` / `--crawl-depth <d>` | `0` / `2` | Dopo il login, scopre e scansiona fino a n pagine (BFS) oltre quelle in config |
| `--no-flows` | off | Non eseguire i flows scriptati |
| `--false-positives <f>` | — | File `.json` (o directory di `.json`) con i falsi positivi dichiarati: le occorrenze corrispondenti escono da "Da verificare" e finiscono in una sezione propria del report. **Solo `incomplete`, mai violazioni.** Vedi [`docs/GUIDA-falsi-positivi.md`](docs/GUIDA-falsi-positivi.md) |
| `--no-lighthouse` / `--no-screen-reader` / `--no-crawl` | — | **Disabilitano** la funzione anche se attiva in config (precedenza sulla config) |
| `--insecure` | on | Ignora errori certificato HTTPS |
| `--check-deps` | | Verifica **senza scansionare** se le dipendenze opzionali richieste da questa esecuzione sono installate (exit 1 se ne manca una) |
| `--help` | | Aiuto |

> **Parametri in config**: `tags`, `crawl`, `crawlDepth`, `lighthouse`, `screenReader`, `failOn`,
> `failOnNameless`, `minScore`, `noFlows`, `insecure`, `falsePositives` si possono dichiarare nel file di config, nel
> blocco `defaults` (globali) e/o dentro un target (override). **Precedenza: CLI > target > defaults >
> built-in.** I flag `--no-*` servono a spegnere da CLI ciò che è acceso in config. Dettaglio in
> [`docs/GUIDA-esecuzione.md`](docs/GUIDA-esecuzione.md).

### Variabili d'ambiente
`A11Y_BASE_URL`, `A11Y_USER`, `A11Y_PASS`, e per-target `A11Y_<TARGET>_USER` / `A11Y_<TARGET>_PASS`
(es. `A11Y_GOVCAT_PASS`).
Le **credenziali vanno nei secret di CI**, non nel file di config.

## Config `targets.<app>.json`

Un file per applicazione, **creato una volta** e aggiornato solo se cambiano rotte/auth.
Ogni chiave di primo livello (che non inizia con `$`) è un **target**. Schema:

```jsonc
{
  "$app": "GovCat",                      // etichetta app nei titoli di report.html/summary.json (opz.; fallback: nomi dei target)
  "<targetKey>": {
    "name": "nomeApp",                 // etichetta nei report
    "enabled": true,
    "loginPath": "/",                  // pagina iniziale (login o landing)
    "contextPath": "/",                // prefisso path (per crawl e dedup)
    "sourceHint": "path/versionato",   // file sorgente su cui Sonar aggancia (approx) le issue

    // --- AUTENTICAZIONE (scegli UNA o combina) ---
    "extraHTTPHeaders": { "X-GovCat-principal": "utente" },  // header su OGNI richiesta (auth locale/dev)
    "login": {                         // login a FORM (omesso = no-form/SSO/header)
      "usernameSelector": "#username, input[name='username']",
      "passwordSelector": "input[type='password']",
      "submitSelector": "button[type='submit'], input[type='submit']",
      "successUrlIncludes": "app"      // stringa attesa nell'URL post-login
    },
    "user": "operatore",               // creds per-target (override via env A11Y_<KEY>_USER/PASS)
    "postLogin": {                     // step DOPO il login (es. selezione organizzazione)
      "steps": [
        { "goto": "/servizi", "wait": "domcontentloaded", "delayMs": 2000 },
        { "clickText": "Ministero Interno", "optional": true, "delayMs": 500 },
        { "clickText": "Conferma", "optional": true, "delayMs": 2000 }
      ]
    },

    // --- SPA (Angular/React): l'HMR del dev server impedisce networkidle ---
    "navWait": "domcontentloaded",     // default 'networkidle'
    "navDelayMs": 2500,                // attesa di settle prima di axe
    "viewport": { "width": 1280, "height": 720 },   // opz.: riproduce problemi da overflow

    // --- PAGINE (GET-navigabili) ---
    "pages": [
      { "name": "servizi", "path": "/servizi" },
      { "name": "dashboard", "path": "/dashboard" }
    ],

    // --- FLOWS (viste non raggiungibili via URL: dettagli, tab, grafici) ---
    "flows": [
      {
        "name": "dettaglio",
        "start": "/lista.jsf",
        "skipIfMissing": "#filtra",    // se la sentinella manca (lista vuota) salta il flow
        "steps": [
          { "click": "#filtra", "wait": "networkidle", "delayMs": 1500 },
          { "click": "div.rowItem", "wait": "networkidle", "delayMs": 2000 },
          { "scanTabs": ".rich-tab-header" },     // scopre e scansiona ogni tab
          { "scan": "risultato" }                 // scansiona lo stato corrente
        ]
      }
    ]
  }
}
```

**Step dei flow / postLogin**: `goto`, `fill:{selector,value}`, `clickText`(+`exact`),
`click`, `wait`(`networkidle`|`load`|`domcontentloaded`|selettore), `delayMs`, `timeoutMs`,
`optional` (non interrompe il flow), `scan`, `scanTabs`, `scanCharts`, `scanMenu`. Usa **selettori
stabili** (id non generati, `title`, testo, classe), mai id JSF `j_idNN`.

**Navigazione ricorsiva delle console** (`scanMenu`): enumera a runtime le voci di uno o più menù
(sinistro, dropdown utente/profili), entra nelle liste (`listRow` → primo elemento), segue matite
(`detailEdit`, incl. newTab in popup), dropdown 3-puntini (`detailMenu`), wizard CONFIGURA
(`detailConfig`) ed **esplora ricorsivamente** i link navigazionali e i tab (`recurse`) — con dedup,
limiti da config e guardia anti-logout, **solo navigazione** (mai form/SALVA). Tutto **dinamico e
non cablato**. Schema completo di ogni opzione: **[`docs/GUIDA-config.md`](docs/GUIDA-config.md)**.

Esempio completo annotato: **[`examples/targets/targets.example.json`](examples/targets/targets.example.json)**
(SPA header-auth + app a form). Config **reali** dei prodotti in **[`targets/`](targets/)**:
`targets/govcat/` (SPA header-auth + select-org), `targets/govpay/` (SPA Angular),
`targets/govway/` (JSF/RichFaces: unificato + console/monitor separati, con `scanMenu`/`recurse`).

## Output prodotti (dir `--out`)

| File | Uso |
|------|-----|
| `summary.json` | riepilogo per-pagina: `counts`, `incomplete`, `lhScore`, `namelessInteractive`, `srStops`/`srRoleOnly`; totali `totals`/`incompleteTotal`/`falsePositivesTotal`/`namelessTotal`/`srRoleOnlyTotal`; elenco `falsePositives` con motivazione, verifica e occorrenze coperte |
| `report.html` | report leggibile (violazioni + "da verificare" + a11y-tree + **trascrizione screen reader**) |
| `axe-results.json` | risultati axe grezzi: `violations` **e** `incomplete` (+ `axTree`, `sr`) |
| `aria-tree/*.yaml` | **albero ARIA per vista** (Chromium `ariaSnapshot`): evidenza per la revisione manuale di ordine di lettura, ruoli e struttura |
| `a11y-junit.xml` | **gate di test** in CI (1 testcase per pagina, fallisce ≥ `--fail-on`) |
| `a11y.sarif` | **GitHub Code Scanning** (driver axe-core) |
| `sonar-issues.json` | **SonarQube** external issues |

`summary.json` include anche `coverage` (dichiarazione esplicita di **copertura e limiti**
dell'automazione), riportata in evidenza anche in `report.html`.

> **`violations` vs `incomplete`**: gli *incomplete* sono controlli che axe **non ha potuto
> decidere da solo** (es. contrasto su sfondi calcolati/gradienti). **NON sono un pass**:
> vanno verificati manualmente. Non fanno fallire il gate (solo le `violations` lo fanno).

> **Copertura e limiti**: l'automazione copre solo ~30–40% dei criteri WCAG. Il report dichiara
> esplicitamente cosa resta ai test manuali (tastiera/focus, screen reader reale, qualità di
> alt/label): è **evidenza** per la dichiarazione AgID, non una certificazione di conformità.

## Integrare nella CI di un'app (modello consigliato)

L'app **non installa nulla**: tiene solo la propria config (es. `ci/a11y/targets.json`, senza
credenziali) e in CI invoca `gov-a11y`, che legge quel config esterno via `--config`.

- **GitHub Actions** — reusable action: `uses: link-it/gov-a11y@v1` con `base`/`config`/`out`.
  Esempio completo: [`examples/ci/consumer-github-actions.yml`](examples/ci/consumer-github-actions.yml).
- **Jenkins (Linux)** — clone + CLI. Esempio: [`examples/ci/consumer-jenkins.md`](examples/ci/consumer-jenkins.md).

SonarQube: importa `sonar-issues.json` come *external issues*
(`sonar.externalIssuesReportPaths=<out>/sonar-issues.json`); `sourceHint` nel config determina
il file su cui Sonar aggancia (approssimativamente) le issue.

## Aggiungere una nuova app

1. Crea `targets.<app>.json` (copia da [`examples/targets/targets.example.json`](examples/targets/targets.example.json)),
   imposta `loginPath`, auth (form **o** header/postLogin), `pages` e (se serve) `flows`. **Una volta.**
2. `node a11y-scan.mjs --base <url> --config ./targets.<app>.json --out ./report-<app>`.
3. Aggiungi il job in CI dell'app (Action o clone+CLI: vedi `examples/ci/`).

## Documentazione

- **[`docs/GUIDA-livelli-di-verifica.md`](docs/GUIDA-livelli-di-verifica.md)** — i quattro livelli (axe, accessibility tree, virtual screen reader, Lighthouse): cosa verificano, cosa non coprono, gate, costi, quale configurazione per quale scenario.
- **[`docs/GUIDA-esecuzione.md`](docs/GUIDA-esecuzione.md)** — esecuzione: parametri obbligatori e tutti i flag CLI (valori, default).
- **[`docs/GUIDA-config.md`](docs/GUIDA-config.md)** — riferimento completo della config (`defaults`, target, login, pages, flows, step incl. `scanMenu`/`recurse`).
- **[`docs/GUIDA-falsi-positivi.md`](docs/GUIDA-falsi-positivi.md)** — il registro dei falsi positivi: quando una occorrenza "da verificare" è già stata esaminata, come registrarla con motivazione e prova, perché non si applica alle violazioni.
- **[`docs/GUIDA-nuova-app.md`](docs/GUIDA-nuova-app.md)** — guida passo-passo per aggiungere una nuova app.
- **[`docs/config-schema.annotato.yaml`](docs/config-schema.annotato.yaml)** — struttura della config commentata.

## Sviluppo

Esegui la suite di test:

```bash
npm test
```

## Licenza

[GPL-3.0-only](LICENSE) (GNU General Public License v3.0).
Le licenze delle dipendenze di terze parti sono in [`third-party-licenses/`](third-party-licenses/)
(tutte compatibili con GPLv3).
