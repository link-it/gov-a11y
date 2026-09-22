# gov-a11y — Guida alla configurazione (targets JSON)

Il file di config (`--config`) descrive **cosa** scansionare e **come**. È un JSON con:

- chiavi che iniziano con `$` → **ignorate** (commenti/metadati, es. `$app`, `$comment`);
- un blocco opzionale **`defaults`** → parametri validi per tutti i target;
- una o più chiavi di **target** (ogni chiave di primo livello non-`$` e diversa da `defaults`).

Precedenza dei parametri: **CLI > target > defaults > built-in**. Le funzionalità booleane accese in
config (`lighthouse`, `screenReader`, `crawl`) si possono **disabilitare da CLI** con i flag
`--no-lighthouse`, `--no-screen-reader`, `--no-crawl` (vedi `GUIDA-esecuzione.md`).

```jsonc
{
  "$app": "Etichetta app (mostrata nei titoli dei report)",
  "defaults": { ... },        // parametri globali (vedi sotto)
  "console":  { ... },        // un target
  "monitor":  { ... }         // un altro target
}
```

## Blocco `defaults` (e override per-target)

Queste chiavi si possono mettere in `defaults` (globali) **oppure** dentro un singolo target (override).
Tutte hanno un default built-in, quindi sono opzionali.

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `tags` | stringa csv | `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice` | Tag axe da applicare: WCAG fino al livello AA delle 2.2, più le regole di buona pratica. I tag AAA sono esclusi di proposito |
| `crawl` | intero | `0` | Pagine da scoprire/scansionare dopo il login (0 = solo `pages[]`) |
| `crawlDepth` | intero | `2` | Profondità BFS del crawl |
| `screenReader` | booleano | `false` | Esegue il virtual screen reader su ogni vista |
| `lighthouse` | booleano | `false` | Calcola il punteggio Lighthouse (lento) |
| `mouseOnly` | booleano | `true` | Cerca i comandi con un gestore del clic **non raggiungibili da tastiera** |
| `mouseOnlyIgnore` | selettore CSS | — | Esclusioni dal controllo precedente, dichiarate dall'applicazione (es. contenitori con gestione delegata che non sono comandi) |
| `mouseOnlyMax` | intero | `40` | Quanti elementi elencare per vista nel report (il conteggio resta completo) |
| `failOn` | stringa | `serious` | Gate axe (`critical`\|`serious`\|`moderate`\|`minor`\|`none`) — **globale** |
| `failOnNameless` | booleano | `true` | Gate: fallisce se elementi interattivi senza nome — **globale**. Attivo di suo: un comando annunciato col solo ruolo è inservibile a chi non vede lo schermo. Si spegne con `false` |
| `failOnScreenReader` | booleano | `false` | Gate: fallisce se il virtual screen reader produce annunci col solo ruolo — **globale**. Richiede `screenReader` |
| `failOnMouseOnly` | booleano | `true` | Gate: fallisce se esistono comandi utilizzabili col solo mouse — **globale**. È l'unico gate attivo di suo: un comando che risponde al clic ma non alla tastiera è un difetto oggettivo. Si spegne con `false` |
| `minScore` | 0..1 | *(nessuno)* | Gate Lighthouse a soglia — **globale** |
| `noFlows` | booleano | `false` | Non eseguire i `flows` |
| `falsePositives` | stringa | — | File `.json` (o directory di `.json`) con i falsi positivi dichiarati; percorso relativo alla dir del config, oppure assoluto. Si applica **solo** agli `incomplete`. Vedi [`GUIDA-falsi-positivi.md`](GUIDA-falsi-positivi.md) |
| `showIncomplete` | booleano | `true` | Mostra la colonna/sezione "Da verificare" (incomplete axe) nel report HTML — **globale** (equiv. CLI `--no-incomplete`) |
| `insecure` | booleano | `true` | Ignora errori certificato HTTPS |

> `failOn`, `failOnNameless`, `failOnMouseOnly`, `failOnScreenReader`, `minScore`, `showIncomplete` sono **globali**: il gate è complessivo e il
> report è aggregato su tutti i target, quindi vanno in `defaults`; un override per-target non si applica.

## Oggetto target

```jsonc
"console": {
  "name": "govwayConsole",              // etichetta del target nei report
  "enabled": true,                       // false = target saltato
  "loginPath": "/govwayConsole/",       // path della pagina di login (relativo a --base)
  "contextPath": "/govwayConsole/",     // prefisso per il crawl (segue solo link di questo path)
  "sourceHint": "…/loginAS.jsp",        // file sorgente su cui Sonar aggancia (approssimato) le issue

  "user": "amministratore",              // utenza (meglio via env A11Y_<TARGET>_USER)
  "pass": "…",                            // password — SCONSIGLIATO nel file: usa env/secret

  "login":   { … },                      // selettori del form di login (vedi sotto)
  "postLogin": { "steps": [ … ] },       // azioni dopo il login (es. selezione organizzazione)

  "navWait": "networkidle",              // waitUntil per goto: networkidle|load|domcontentloaded
  "navDelayMs": 0,                        // attesa extra (ms) dopo ogni navigazione
  "viewport": { "width": 1366, "height": 900 },
  "extraHTTPHeaders": { "X-Auth": "…" }, // header aggiuntivi (es. auth di test SPA)

  "pages": [ … ],                        // viste da scansionare sempre (deterministiche)
  "flows": [ … ]                         // navigazioni scriptate (dettagli/report)
  // + eventuali override dei parametri del blocco defaults (tags, crawl, screenReader, …)
}
```

### `login`

| Chiave | Descrizione |
|---|---|
| `usernameSelector` | selettore CSS del campo utente (lista separata da virgola = fallback) |
| `passwordSelector` | selettore CSS del campo password |
| `submitSelector` | selettore CSS del bottone di invio |
| `successUrlIncludes` | sottostringa attesa nell'URL post-login (check soft) |
| `waitMs` | timeout (ms) di attesa del campo utente (default 8000) |

Se il campo utente non viene trovato, il login viene **saltato** (utile se già autenticati/SSO).
Usa **selettori stabili** (name/id/classe), non id generati dai framework.

### `postLogin.steps[]`

Azioni eseguite subito dopo il login, prima delle scansioni (es. una SPA che chiede di scegliere
un'organizzazione). Stessi tipi di step dei `flows` (vedi sotto). Con `optional: true` un fallimento
non interrompe.

### `pages[]`

Elenco esplicito e versionato delle viste da scansionare sempre (copertura **deterministica**, ideale
per il gate in CI).

```jsonc
"pages": [
  { "name": "welcome", "path": "/app/welcome" }
]
```

### `flows[]` — navigazione scriptata

Raggiungono viste **non navigabili via URL** (dietro postback/AJAX): dettagli, report generati, tab.

```jsonc
"flows": [
  {
    "name": "dettaglio",                 // etichetta (compare come flow:<name>/… nei report)
    "start": "/app/lista",               // URL di partenza (onora navWait/navDelayMs del target)
    "skipIfMissing": "#tabella",         // se il selettore manca sulla start page, salta il flow
    "skipIfMissingTimeoutMs": 8000,      // attesa max per la sentinella (liste async); default 8000
    "sourceHint": "…/dettaglio.xhtml",   // opzionale: override del sourceHint per questo flow
    "steps": [ … ]                        // sequenza di azioni + scansioni
  }
]
```

#### Tipi di `step`

| Step | Effetto |
|---|---|
| `{ "goto": "<path>" }` | Naviga a un URL |
| `{ "click": "<selettore CSS>" }` | Click (supporta `:has()`, `:text-is()` di Playwright) |
| `{ "clickText": "<testo>", "exact": true }` | Click sul primo elemento con quel testo |
| `{ "fill": { "selector": "…", "value": "…" } }` | Compila un campo |
| `{ "wait": "networkidle" \| "<selettore>" }` | Attesa (load-state o comparsa selettore) |
| `{ "scan": "<etichetta>" }` | **Scansiona lo stato corrente** (permette più scan in un flow) |
| `{ "scanTabs": "<selettore>" }` | Scopre i tab a runtime, clicca e scansiona ognuno |
| `{ "scanCharts": { … } }` | Enumera icone-report di una griglia, genera e scansiona ognuna |
| `{ "scanMenu": [ … ] }` | Enumera a runtime le voci di uno o più menù, naviga e scansiona ognuna |

Modificatori comuni per ogni step: `delayMs` (attesa extra), `timeoutMs`, `optional: true` (se
fallisce non interrompe il flow), `desc` (etichetta nei log), `sourceHint`.

Se un flow non ha step `scan`/`scanTabs`/`scanCharts`, scansiona lo **stato finale**.

#### Config di `scanCharts`

| Chiave | Descrizione |
|---|---|
| `grid` | URL della griglia con le icone-report |
| `icon` | **obbligatorio**: selettore delle icone da cliccare |
| `generate` | **obbligatorio**: selettore del pulsante "genera report" |
| `label` | selettore del testo-tipo dentro l'icona (per l'etichetta); default `span` |
| `field` | come si riconoscono i campi del form e come se ne aprono le opzioni (vedi sotto). Obbligatorio **solo** se si dichiarano assi da iterare |
| `productAxes` | assi **incrociati fra loro**: pattern confrontati con etichetta e valore del campo, oppure il token `required` che designa ogni campo obbligatorio |
| `linearAxes` | assi variati **una voce alla volta**, con gli altri campi al valore predefinito: per ciò che cambia i dati ma non l'impaginazione (incrociarlo moltiplicherebbe il tempo senza produrre strutture nuove) |
| `maxViews` | tetto di viste generate dallo step; default 400 |
| `limit` | opzionale: scansiona solo i primi N report (campionamento in sviluppo) |
| `dimensionField`, `dimensionSkip`, `dimensionOption` | nomi precedenti, un solo asse incrociato; `dimensionOption` equivale a `field.option` |

I campi del form si scoprono **a runtime** da etichetta, valore corrente e obbligatorietà: nulla è
cablato. Il blocco `field` dice soltanto *come sono fatti* i campi nell'applicazione in prova —
dipende dalla libreria di componenti (comboBox di una libreria, `select` nativa, widget proprietario),
non da questo strumento, e per questo non ha valori predefiniti.

| Chiave di `field` | Descrizione |
|---|---|
| `selector` | selettore dei campi del form da variare |
| `idSuffix` | parte finale dell'id da togliere per ottenere la **radice** dell'id del campo |
| `toggle` | selettore del comando che apre l'elenco delle opzioni; `#{base}` = radice dell'id |
| `list` | selettore del contenitore delle opzioni; `#{base}` = radice dell'id |
| `option` | selettore della singola opzione dentro `list` |
| `group` | opzionale: blocco che racchiude etichetta e campo (per leggere l'etichetta) |
| `label` | opzionale: selettore dell'etichetta dentro `group`; default `label` |
| `requiredMarker` | opzionale: selettore del marcatore di obbligatorietà dentro `group` (es. l'asterisco) |

```jsonc
"field": {
  "selector": "input[id$=comboboxField]",   // comboBox RichFaces
  "idSuffix": "comboboxField",
  "group": "div.prop",
  "requiredMarker": "label em",
  "toggle": "##{base}comboboxButton",       // '#' del selettore + segnaposto '#{base}'
  "list":   "##{base}list",
  "option": ".rich-combobox-item"
}
```

Senza assi da iterare (`productAxes` e `linearAxes` assenti) non c'è nulla da scoprire nel form: lo
step apre ogni report e lo scansiona, e `field` non serve. Se invece gli assi ci sono e manca una
chiave obbligatoria, lo step viene **saltato** con un avviso che la nomina: meglio una lacuna
dichiarata che un selettore di un'altra applicazione usato come ripiego.

#### Config di `scanMenu`

Naviga **dinamicamente** le voci di uno o più menù (nessuna label/URL cablata: enumera a runtime).
Valore: una stringa (selettore voci), un oggetto, o un **array** di menù. Ogni menù:

| Chiave | Descrizione |
|---|---|
| `item` (o `menuItem`) | selettore delle voci del menù (es. `#menuct a.voceMenuRC`) |
| `open` | opzionale: selettore da cliccare per **aprire un dropdown** prima di enumerare/cliccare |
| `listRow` | opzionale: selettore del **primo elemento** di una lista → entra nel dettaglio (es. `[id^='entry_']`) |
| `detailEdit` | opzionale: dal dettaglio, segue ogni **matita/edit-link** e scansiona il form di modifica (es. `a.edit-link`). I link con `target=_blank` (**newTab**) sono gestiti come popup: scansiona la nuova scheda e la chiude |
| `detailMenu` | opzionale: dropdown **3-puntini** sul dettaglio: `{ open, item }` → segue ogni azione (enumerate a runtime, variano per oggetto) |
| `detailConfig` | opzionale: bottone **CONFIGURA** → entra nel wizard e lo scansiona; se `recurse` è attivo, **esplora ricorsivamente** anche il wizard (Controllo Accessi, Validazione, Trasformazioni…). Non avanza tra gli step né salva |
| `recurse` | opzionale: dal dettaglio, **esplorazione ricorsiva "solo navigazione"**: `{ depth, max, skip, tabs }` → segue i link `<a href>` (matite, count-link tipo Soggetti(0)/Ruoli(0)…) ovunque, con dedup su URL normalizzato (token di sessione ignorati); su ogni pagina **espande e scansiona i tab client-side** (`tabs`, default `.ui-tabs-nav a`; `false` per disattivare). **Non** tocca form/checkbox/SALVA. `depth` = profondità, `max` = tetto pagine per dettaglio, `skip` = regex azioni da escludere. Copre anche il wizard CONFIGURA (vedi `detailConfig`) |
| `skip` | opzionale: regex di voci da saltare (per testo o href) |

Le voci di **logout** sono **sempre saltate** (guardia universale: non deautenticarsi). Ogni voce →
`flow:<nome>/<slug-etichetta>`. Esempio (menù sinistro + menù utente e Profili come dropdown):

```jsonc
"scanMenu": [
  { "item": "#menuct a.voceMenuRC" },
  { "open": "#menuUtente",   "item": "#menuUtente_menu a" },
  { "open": "#menuModalita", "item": "#menuModalita_menu a" }
]
```

> **Principio:** non cablare etichette testuali dove è possibile **scoprirle a runtime**
> (`scanTabs`, `scanCharts`, `scanMenu`), così il tool resta robusto ai cambi di label o all'aggiunta
> di viste/voci.

## Credenziali e sicurezza

Non mettere password nel file. Ordine di risoluzione credenziali:
**env per-target** `A11Y_<TARGET>_USER/PASS` **>** `user`/`pass`
in config **>** globali `--user/--pass` / `A11Y_USER/PASS`. In CI usa i secret.

Vedi anche: `GUIDA-esecuzione.md` (parametri CLI) e `config-schema.annotato.yaml` (struttura commentata).
