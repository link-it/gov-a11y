# gov-a11y — Guida rapida di esecuzione

Tool di audit accessibilità (WCAG 2.x) delle console applicative: esegue axe-core (regole WCAG),
opzionalmente Lighthouse (punteggio) e un virtual screen reader (annunci), navigando la webapp
autenticata. Stesso comando **a mano** e **in pipeline**.

## Prerequisiti

```bash
cd gov-a11y
npm install            # installa dipendenze e scarica Chromium
```

### Dipendenze opzionali (Lighthouse e screen reader)

Le funzionalità `--lighthouse` e `--screen-reader` usano pacchetti dichiarati come
**`optionalDependencies`**. Un `npm install` normale prova a installarli, ma se falliscono o si è usato
`--no-optional` restano fuori; in quel caso, all'uso del flag, il tool dà un errore tipo
`Cannot find module`. Installali esplicitamente:

```bash
npm install lighthouse                              # per --lighthouse
npm install @guidepup/virtual-screen-reader jsdom   # per --screen-reader
```

> Nota: le config `govway*` hanno `lighthouse` e `screenReader` attivi in `defaults`, quindi questi
> pacchetti servono per farle girare complete. Per una prova rapida senza installarli, disabilita le
> due funzioni da CLI: `--no-lighthouse --no-screen-reader`.

Un'istanza dell'applicazione da testare, raggiungibile via HTTP.

## Esecuzione minima (parametri obbligatori)

Servono tre cose: **quale config**, **quale istanza** (base URL) e **le credenziali**.

```bash
# credenziali via env (consigliato: mai nel file di config)
export A11Y_CONSOLE_USER=amministratore
export A11Y_CONSOLE_PASS='********'

node a11y-scan.mjs \
  --config targets/govway/targets.govway.json \
  --base   http://127.0.0.1:8080
```

- `--config <file>` — il file dei target (quale app/console scansionare). *(Se omesso: `./targets.json`.)*
- `--base <url>` — URL base dell'istanza in test. *(Se omesso: `http://localhost:8080`.)*
- **Credenziali** — via env `A11Y_<TARGET>_USER/PASS` (es. `A11Y_CONSOLE_USER`), oppure globali
  `A11Y_USER/PASS`, oppure i flag `--user/--pass`. *(Default demo: `amministratore` / `123456`.)*

Tutto il resto (tag WCAG, crawl, screen-reader, Lighthouse, gate…) può stare **nel file di config**
(blocco `defaults` e/o per-target) — vedi `GUIDA-config.md`. In tal caso il comando resta minimale.

I report finiscono in `--out` (default `./report`): `report.html`, `axe-results.json`, `a11y.sarif`,
`sonar-issues.json`, `a11y-junit.xml`, `summary.json`, `aria-tree/` (alberi ARIA per vista).

## Parametri da riga di comando (tutti opzionali)

La CLI ha sempre la **precedenza** sulla config. Ordine di risoluzione:
**CLI > target (config) > defaults (config) > built-in**.

| Flag | Valori | Default | Descrizione |
|---|---|---|---|
| `--base <url>` | URL | `http://localhost:8080` | Base URL dell'istanza (o env `A11Y_BASE_URL`) |
| `--config <file>` | percorso | `./targets.json` | File di configurazione dei target |
| `--out <dir>` | percorso | `./report` | Directory di output dei report |
| `--only <key>` | chiave target | *(tutti)* | Limita la scansione a un solo target del config |
| `--user <u>` | stringa | `amministratore` | Utenza globale (o env `A11Y_USER`) |
| `--pass <p>` | stringa | `123456` | Password globale (o env `A11Y_PASS`) |
| `--tags <list>` | csv di tag axe | `wcag2a,wcag2aa,wcag21a,wcag21aa` | Regole WCAG da applicare (es. aggiungi `wcag22aa`) |
| `--crawl <n>` | intero ≥ 0 | `0` | Dopo il login, scopre e scansiona fino a n pagine per target (0 = solo `pages[]`) |
| `--crawl-depth <d>` | intero ≥ 1 | `2` | Profondità di navigazione del crawl (BFS) |
| `--lighthouse` | flag | off | Calcola il punteggio Lighthouse Accessibility (**lento**) |
| `--min-score <0..1>` | decimale | *(nessuno)* | Gate Lighthouse: fallisce se un punteggio < soglia (es. `0.90`). Implica `--lighthouse` |
| `--screen-reader` | flag | off | Esegue il virtual screen reader (annunci) su ogni vista |
| `--fail-on <sev>` | `critical`\|`serious`\|`moderate`\|`minor`\|`none` | `serious` | Gate axe: fallisce se esistono violazioni ≥ gravità |
| `--fail-on-nameless` | flag | off | Gate screen-reader: fallisce se ci sono elementi interattivi senza nome accessibile |
| `--no-flows` | flag | off | Non esegue i `flows` (navigazione scriptata delle viste di dettaglio) |
| `--no-incomplete` | flag | off | Nasconde la colonna/sezione "Da verificare" (incomplete axe) dal report HTML |
| `--no-lighthouse` | flag | — | **Disabilita** Lighthouse anche se attivo in config (precede la config) |
| `--no-screen-reader` | flag | — | **Disabilita** il virtual screen reader anche se attivo in config |
| `--no-crawl` | flag | — | **Disabilita** il crawl anche se attivo in config (equivale a `--crawl 0`) |
| `--insecure` | flag / `false` | `true` | Ignora errori certificato HTTPS |
| `--help` | flag | — | Mostra l'aiuto |

### Disabilitare da CLI ciò che è attivo in config

I flag positivi (`--lighthouse`, `--screen-reader`, `--crawl N`) **attivano** una funzionalità; i flag
`--no-*` la **disattivano** anche quando è accesa nel file di config. Servono per run veloci senza dover
modificare la config. Esempio: la config govway ha `lighthouse` e `screenReader` a `true`; per una prova
rapida di solo axe:

```bash
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080 \
     --no-lighthouse --no-screen-reader
```

### Note sui gate

- Il **gate axe** (`--fail-on`) e il **gate Lighthouse** (`--min-score`) e `--fail-on-nameless` sono
  **globali** (valutati sull'insieme di tutti i target). Vanno passati da CLI o dichiarati in
  `defaults` — vedi `GUIDA-config.md`.
- Exit code ≠ 0 se un gate non è rispettato (utile per far fallire la pipeline).

## Esempi

```bash
# 1) Tutto dichiarato in config (comando minimale)
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080

# 2) Solo la console, con crawl e screen reader forzati da CLI
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080 \
     --only console --crawl 300 --crawl-depth 2 --screen-reader

# 3) Run "ufficiale" con punteggio Lighthouse e gate a soglia (lenta)
node a11y-scan.mjs --config targets/govway/targets.govway.json --base https://gw-staging.example.it \
     --lighthouse --min-score 0.90 --fail-on serious

# 4) Solo report, nessun blocco (adozione graduale)
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080 --fail-on none
```

> **Attenzione a `--lighthouse` + `--crawl`**: Lighthouse gira su **ogni** pagina scoperta → tempi
> molto lunghi. Per le esplorazioni col crawl, tienilo spento; usalo su `pages[]` curate.
