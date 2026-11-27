# gov-a11y

Scanner di **accessibilità WCAG 2.x** per applicazioni web, **esterno e black-box**: pilota
l'app in esecuzione via HTTP (Playwright) ed esegue [axe-core](https://github.com/dequelabs/axe-core),
una verifica dell'**accessibility tree** e — opzionali — un **virtual screen reader** e **Lighthouse**.
Un **unico tool**, **config per-app**: si usa su più webapp (GovCat, GovPay, GovWay, …)
**senza aggiungere alcuna dipendenza** alle applicazioni testate.

## I livelli di verifica

| Livello | Dove | Come |
|---|---|---|
| **1. axe (regole WCAG)** | Linux CI | axe-core con tag WCAG configurabili |
| **2. Accessibility-tree assertions** | Linux CI, stesso flow Playwright | `ariaSnapshot` di Chromium → elementi interattivi **senza nome accessibile** (gate opz. `--fail-on-nameless`) |
| **2b. Comandi solo-mouse** | Linux CI, stesso flow Playwright | `addEventListener` strumentato → elementi con un **gestore del clic non raggiungibili da tastiera** (gate `--fail-on-mouse-only`, **attivo di default**) |
| **3. Virtual screen reader** | Linux CI (dep in più) | `@guidepup/virtual-screen-reader` → **trascrizione degli annunci** per vista, con cross-check degli annunci "solo-ruolo" |
| **Secondo motore** | Linux CI (dep in più) | [IBM Equal Access](https://github.com/IBMa/equal-access) (`accessibility-checker-engine`) sullo **stesso stato** di ogni vista: regole e algoritmi indipendenti da axe, esiti a confronto per criterio WCAG; decide il gate solo con `--fail-on-equal-access` |
| 4. NVDA/VoiceOver reali | runner Win/macOS | fuori da questo tool (guidepup reale) |
| 5. SR manuale (umano) | desktop | necessario a campione per conformità AgID |

Questo tool copre i **livelli 1–3**, tutti eseguibili su Linux CI headless. A questi si aggiunge il
punteggio **Lighthouse** (indicatore sintetico, opzionale). Il report riporta per ogni problema il
criterio WCAG e il riferimento **EN 301 549**, uno **screenshot** con l'elemento evidenziato, gli
**errori sistematici** (stesso problema sullo stesso componente in più viste) e il **perimetro non
coperto** (flow saltati o interrotti, pagine non analizzate). Cosa intercetta ciascun livello, cosa
non copre, quanto costa e quando attivarlo: **[`docs/GUIDA-livelli-di-verifica.md`](docs/GUIDA-livelli-di-verifica.md)**.

## Requisiti e installazione

- Node.js ≥ 18.
- L'app da testare **in esecuzione e raggiungibile** (locale, preview o deploy/service CI).

```bash
npm ci                 # installa deps + (postinstall) scarica Chromium
                       # le optionalDependencies (lighthouse, jsdom, virtual-screen-reader,
                       # accessibility-checker-engine) servono solo per --lighthouse /
                       # --screen-reader / --equal-access
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
console/monitor separati), `govpay/`, `govcat/`. I prodotti non pubblici tengono i loro target nel
proprio repository. Gli **esempi/template** annotati sono in [`examples/targets/`](examples/targets/).

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
| `--fail-on-equal-access` | off | **Gate del secondo motore**: fallisci se IBM Equal Access trova violazioni (i casi da verificare non contano) o non riesce a girare su una vista. Vale sulle viste dei target con `equalAccess`. Si attiva con `"failOnEqualAccess": true` nel config |
| `--fail-on-mouse-only` | **on** | **Gate livello 2b**: fallisci se esistono comandi utilizzabili col solo mouse. Si disattiva con `"failOnMouseOnly": false` nel config |
| `--fail-on-empty` | **on** | **Gate delle viste vuote**: fallisci se una vista è stata analizzata senza alcun contenuto accessibile (albero di accessibilità vuoto: pagina non renderizzata per backend irraggiungibile, sessione persa, errore dell'app). Il suo "nessuna violazione" non vale. Prima di arrendersi lo strumento attende una volta (5 s). Si disattiva con `"failOnEmpty": false` nel config |
| `--fail-on-http-error` | off | **Gate delle viste in errore HTTP**: fallisci se una vista è arrivata con stato HTTP ≥ 400. È stata esaminata la pagina d'errore dell'applicazione (URL non più valido, contesto di navigazione mancante, sessione persa, bug), che di solito è accessibile e farebbe risultare pulita una vista mai vista. Lo stato di ogni vista è comunque riportato. Si attiva anche con `"failOnHttpError": true` nel config |
| `--fail-on-skipped` | off | **Gate del perimetro**: fallisci se una vista o un flow previsto dal config non è stato analizzato, o solo in parte (flow saltato, interrotto o in errore, pagina non analizzata, login non confermato). Per la CI: un report incompleto non passa. In config `"failOnSkipped": true` |
| `--no-mouse-only` | — | Disabilita il controllo dei comandi solo-mouse (attivo di default) |
| `--reflow` | off | **1.4.10**: la vista a 320px di larghezza non deve scorrere in orizzontale |
| `--text-spacing` | off | **1.4.12**: con la spaziatura del testo aumentata nessun testo viene tagliato |
| `--keyboard-walk` | off | **2.4.7 / 2.4.11 / 2.1.2**: percorso col tasto Tab (focus visibile, non coperto, nessuna trappola) e ordine di focus |
| `--keyboard-walk-max <n>` | 45 | Fermate massime del percorso col Tab per vista |
| `--keyboard-walk-wait-ms <ms>` | 120 | Attesa dopo ogni Tab prima di leggere il fuoco e il suo aspetto: serve a transizioni e script sul `focus`, ed è il costo principale del controllo. Abbassarla solo dopo aver verificato che l'esito resti lo stesso |
| `--no-reflow` / `--no-text-spacing` / `--no-keyboard-walk` | — | Spengono i tre controlli precedenti anche se attivi in config |
| `--no-equal-access-keyboard-confirm` | — | Con `--equal-access` e `--keyboard-walk` attivi, per difetto i casi da verificare di IBM sul fuoco (si vede, non è coperto, diventa visibile) a cui il percorso col Tab ha risposto positivamente sullo stesso elemento passano fra i «confermati dal percorso col Tab» (elenco a parte nel report, `equalAccess.confermatiDaTab` in `summary.json`). Questo flag li lascia tutti da verificare |
| `--screen-reader` | off | **Livello 3**: esegui il virtual screen reader su ogni vista (richiede optional deps) |
| `--equal-access` | off | **Secondo motore**: IBM Equal Access (regole WCAG 2.2 A/AA) sullo stesso stato di ogni vista analizzato da axe. Esiti in una sezione propria e in un confronto per criterio fra i due motori; senza gate, salvo `--fail-on-equal-access` (richiede il modulo `accessibility-checker-engine`) |
| `--no-contrast-estimate` | — | Niente stima del contrasto. Per difetto ogni testo il cui contrasto è da verificare (axe) o segnalato dal secondo motore ha una misura fatta sui pixel dello sfondo reale: rapporto minimo e massimo e soglia richiesta, accanto all'occorrenza e in una tabella per componente. Non tocca il gate |
| `--no-screenshots` | — | Niente screenshot delle occorrenze. Per difetto ogni violazione e ogni caso da verificare ha un'immagine della zona della pagina con l'elemento evidenziato (al massimo `screenshotsMax` per vista, 20), in `screenshot/` |
| `--lighthouse` | off | Punteggio Lighthouse Accessibility (richiede il modulo `lighthouse`). L'audit gira in una tab separata aperta via CDP: riceve una copia dei **cookie di sessione** del context di scansione (ognuno col suo path) e del suo `sessionStorage`, e gli `extraHTTPHeaders` del target, così valuta le pagine autenticate. Se Lighthouse finisce su un'altra pagina (es. rimandato al login) il punteggio viene scartato e segnalato |
| `--min-score <0..1>` | — | Gate Lighthouse (implica `--lighthouse`) |
| `--crawl <n>` / `--crawl-depth <d>` | `0` / `2` | Dopo il login, scopre e scansiona fino a n pagine (BFS) oltre quelle in config |
| `--no-flows` | off | Non eseguire i flows scriptati |
| `--false-positives <f>` | — | File `.json` (o directory di `.json`) con i falsi positivi dichiarati: le occorrenze corrispondenti escono da "Da verificare" e finiscono in una sezione propria del report. **Per axe solo `incomplete`, mai violazioni**; le voci con `"engine": "equalAccess"` valgono anche per le violazioni del secondo motore, che non ha gate. Vedi [`docs/GUIDA-falsi-positivi.md`](docs/GUIDA-falsi-positivi.md) |
| `--no-lighthouse` / `--no-screen-reader` / `--no-equal-access` / `--no-crawl` | — | **Disabilitano** la funzione anche se attiva in config (precedenza sulla config) |
| `--product-version <v>` | — | Versione del prodotto in prova (anche env `A11Y_PRODUCT_VERSION`): dichiarativa, compare nel report e in `summary.json` |
| `--insecure` | on | Ignora errori certificato HTTPS |
| `--login-base <url>` | — | Applicazione su cui si fa il login, se non è quella di `--base`: il `loginPath` relativo si accoda a questo indirizzo. Per cambiare ambiente (sviluppo, collaudo) senza toccare il config |
| `--locale <tag>` | — | Lingua del browser (es. `it-IT`): `navigator.language` e `Accept-Language`. Per le app che scelgono la lingua dal browser, che altrimenti si vedrebbero in inglese |
| `--check-deps` | | Verifica **senza scansionare** se le dipendenze opzionali richieste da questa esecuzione sono installate (exit 1 se ne manca una) |
| `--help` | | Aiuto |

> **Parametri in config**: `tags`, `crawl`, `crawlDepth`, `lighthouse`, `screenReader`, `equalAccess`, `equalAccessKeyboardConfirm`, `screenshots`, `screenshotsMax`, `contrastEstimate`, `contrastEstimateMax`, `reflow`, `textSpacing`, `keyboardWalk`, `keyboardWalkMax`, `keyboardWalkWaitMs`, `keyboardWalkWidgetFocus`, `keyboardWalkObscuredPaintOnly`, `keyboardWalkIgnoreFocusGuards`, `pointerAside`, `equalAccessIgnoreInert`, `lighthouseRetry`, `lighthouseLocalStorage`, `flowSkipRetry`, `languageParts`, `failOn`,
> `failOnNameless`, `failOnEmpty`, `failOnHttpError`, `failOnSkipped`, `failOnEqualAccess`, `minScore`, `noFlows`, `insecure`, `locale`, `productVersion`, `falsePositives` si possono dichiarare nel file di config, nel
> blocco `defaults` (globali) e/o dentro un target (override). **Precedenza: CLI > target > defaults >
> built-in.** I flag `--no-*` servono a spegnere da CLI ciò che è acceso in config. Dettaglio in
> [`docs/GUIDA-esecuzione.md`](docs/GUIDA-esecuzione.md).

### Variabili d'ambiente
`A11Y_BASE_URL`, `A11Y_USER`, `A11Y_PASS`, `A11Y_PRODUCT_VERSION`, e per-target
`A11Y_<TARGET>_USER` / `A11Y_<TARGET>_PASS` (es. `A11Y_GOVCAT_PASS`).
Le **credenziali vanno nei secret di CI**, non nel file di config. Lo stesso vale per un'identità
passata in un'intestazione (un codice fiscale è un dato personale): nei valori di `extraHTTPHeaders`
`${NOME}` diventa il valore della variabile d'ambiente `NOME`, e se non è impostata la scansione si
ferma con exit code 2.

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
    "extraHTTPHeaders": { "X-GovCat-principal": "${A11Y_GOVCAT_PRINCIPAL}" },  // header su OGNI richiesta (auth locale/dev); ${NOME} = variabile d'ambiente
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

**Step dei flow / postLogin**: `goto`, `fill:{selector,value}`, `upload:{selector,files}`, `select:{selector,value}` (opzione
per testo, su `<select>` o tendina), `clickText`(+`exact`),
`click`, `focus`, `press`(tasto), `clearCookies`, `back`, `reload`, `script`(funzione JS accanto al config, solo nei flow),
`postMessage`(messaggio alla finestra della pagina, come dalla shell che ospita l'app), `wait`(`networkidle`|`load`|`domcontentloaded`|selettore), `waitQuietMs`(attende che il DOM
smetta di cambiare per quel tratto, es. un grafico disegnato da script), `delayMs`, `timeoutMs`,
`optional` (non interrompe il flow), `scan`, `scanTabs`, `scanOptions`, `scanCharts`, `scanFormVariants`, `scanMenu`. Gli elenchi paginati si esaminano anche oltre la prima pagina con `nextPage` nel target (selettore del comando di pagina successiva). Usa **selettori
stabili** (id non generati, `title`, testo, classe), mai id JSF `j_idNN`. In `fill` e `select` il
valore può arrivare da una **variabile d'ambiente** (`"env": "A11Y_…"` al posto di `"value"`): il flow
viene saltato se manca e il valore è mascherato con `***` in log e report.

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
| `summary.json` | riepilogo per-pagina: `counts`, `incomplete`, `lhScore`, `namelessInteractive`, `srStops`/`srRoleOnly`; totali `totals`/`incompleteTotal`/`falsePositivesTotal`/`namelessTotal`/`srRoleOnlyTotal`; elenco `falsePositives` con motivazione, verifica e occorrenze coperte; stato HTTP di ogni vista (`httpStatus`) e viste in errore HTTP (`httpErrorViews`); **`gate`** (`superato`, `motivi`) e **`controlli`** (ogni controllo con soglia, risultato, esito e viste coinvolte) |
| `tempi.json` | tempi della scansione: durata complessiva, login, navigazione fra le viste, tempo per fase (axe, IBM, Tab, riflusso, screenshot, …) con totale, media e massimo, viste più lente, dettaglio per vista. Gli stessi dati sono in `report.html`, in blocchi chiusi per default (riepilogo e, in ogni vista, «Tempi») |
| `report.html` | report leggibile: in testa i dati della scansione, l'**esito del gate con i motivi** e la tabella dei **controlli eseguiti**; poi violazioni, "da verificare", a11y-tree, **trascrizione screen reader** e, per vista, i controlli rimasti senza esito; le viste in errore HTTP sono evidenziate e raccolte in un riquadro |
| `axe-results.json` | risultati axe grezzi: `violations` **e** `incomplete` (+ `axTree`, `sr`) |
| `aria-tree/*.yaml` | **albero ARIA per vista** (Chromium `ariaSnapshot`): evidenza per la revisione manuale di ordine di lettura, ruoli e struttura |
| `a11y-junit.xml` | **gate di test** in CI: una suite per le viste (fallisce per ogni motivo del gate che riguarda la vista, con le altre evidenze in `system-out`), una per i controlli (anche quelli superati; i non eseguiti come `skipped`), una per il perimetro non coperto e una per l'esito del gate |
| `a11y.sarif` | **GitHub Code Scanning**: run `axe-core` con le sue regole e run `gov-a11y` con i controlli fuori da axe, le evidenze degli altri livelli (senza nome, solo mouse, screen reader, Lighthouse, viste vuote, viste in errore HTTP, controlli non eseguiti, perimetro, tranne le viste `optional` assenti) e l'esito del gate (solo se fallisce); casi da verificare e secondo motore a livello `note`, falsi positivi dichiarati come risultati soppressi (Jenkins Warnings e Code Scanning non li contano). Ci finiscono tutte le violazioni che decidono l'esito |
| `sonar-issues.json` | **SonarQube** external issues: regole axe (`engineId` `axe-core`) e controlli e evidenze di `gov-a11y`; perimetro ed esito del gate, che non hanno un file sorgente, stanno in SARIF e JUnit |

`summary.json` include anche `coverage` (dichiarazione esplicita di **copertura e limiti**
dell'automazione), riportata in evidenza anche in `report.html`.

> **`violations` vs `incomplete`**: gli *incomplete* sono controlli che axe **non ha potuto
> decidere da solo** (es. contrasto su sfondi calcolati/gradienti). **NON sono un pass**:
> vanno verificati manualmente. Non fanno fallire il gate (solo le `violations` lo fanno).

> **Copertura e limiti**: l'automazione copre solo ~30–40% dei criteri WCAG. Il report dichiara
> esplicitamente cosa resta ai test manuali (tastiera/focus, screen reader reale, qualità di
> alt/label, zoom e riflusso, messaggi d'errore, contenuti multimediali): è **evidenza** per la
> dichiarazione AgID, non una certificazione di conformità. La dichiarazione è **costruita
> sull'esecuzione**: elenca i livelli davvero attivi e le versioni WCAG dei tag usati, quindi
> spegnere un livello cambia il testo, non lo rende falso.

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
- **[`docs/GUIDA-falsi-positivi.md`](docs/GUIDA-falsi-positivi.md)** — il registro dei falsi positivi: quando una occorrenza "da verificare" è già stata esaminata, come registrarla con motivazione e prova, perché non si applica alle violazioni di axe, e come vale per il secondo motore.
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
