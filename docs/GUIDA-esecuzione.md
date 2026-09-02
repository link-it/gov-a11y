# gov-a11y — Guida rapida di esecuzione

Tool di audit accessibilità (WCAG 2.x) delle console applicative: esegue axe-core (regole WCAG),
opzionalmente Lighthouse (punteggio) e un virtual screen reader (annunci), navigando la webapp
autenticata. Stesso comando **a mano** e **in pipeline**.

> Cosa verifica ciascun livello e quale configurazione conviene per quale scenario:
> [`GUIDA-livelli-di-verifica.md`](GUIDA-livelli-di-verifica.md).

## Prerequisiti

```bash
cd gov-a11y
npm install            # installa dipendenze e scarica Chromium
```

### Dipendenze opzionali (Lighthouse e screen reader)

Le funzionalità `--lighthouse` e `--screen-reader` usano pacchetti dichiarati come
**`optionalDependencies`**. Un `npm install` normale prova a installarli, ma se falliscono o si è usato
`--no-optional` restano fuori. Installali esplicitamente:

```bash
npm install lighthouse                              # per --lighthouse
npm install @guidepup/virtual-screen-reader jsdom   # per --screen-reader
```

**Verifica senza installare né scansionare** (stesso `--config` della scansione, così tiene conto di
`defaults`/override per-target):

```bash
node a11y-scan.mjs --check-deps --config ./targets/govway/targets.govway_console.json
```

```
[Lighthouse] richiesto da questa esecuzione: SI
   ✓ lighthouse                       12.8.2
[virtual screen reader] richiesto da questa esecuzione: SI
   ✓ @guidepup/virtual-screen-reader  0.30.1
   ✓ jsdom                            25.0.1
```

Exit code: **0** se tutto il richiesto è installato, **1** altrimenti (usabile come step di CI).
Verifiche equivalenti senza il tool: `npm ls lighthouse jsdom @guidepup/virtual-screen-reader`
(elenca le versioni installate, `(empty)`/`missing` se assenti) oppure
`node --input-type=module -e "import.meta.resolve('lighthouse')"` (esce con errore
`ERR_MODULE_NOT_FOUND` se il modulo non c'è). Nessuna delle due installa nulla.

**Prerequisito mancante = errore, non degrado silenzioso.** Se una feature è richiesta (da CLI o da
config) e i suoi moduli non ci sono, la scansione si interrompe **prima** di aprire il browser con
exit code **2**:

```
❌ Dipendenza opzionale mancante: la scansione e' stata richiesta con una feature non installata.
   - Lighthouse (richiesto da: --lighthouse / --min-score / "lighthouse": true in config)
     moduli assenti: lighthouse
     installa con:   npm install lighthouse
   Alternativa: disabilita la feature con --no-lighthouse
```

> Attenzione a non confondere i due casi: **modulo assente** → errore bloccante come sopra;
> **modulo presente ma audit in errore** (pagina non raggiungibile, errore HTTP, timeout, porta CDP
> occupata) → `lhScore: null` con warning per vista e, a fine run, il riepilogo
> `⚠ [lighthouse] modulo installato ma nessun punteggio calcolato su N viste`.

### Lighthouse: sessione e audit senza punteggio

Lighthouse non usa la pagina della scansione: apre una **propria tab** via CDP (porta 9222) nel
context di default del browser, mentre la scansione naviga in un `browser.newContext()` isolato. I
cookie di sessione non sono condivisi per costruzione: il tool li rilegge dal context corrente e li
passa a Lighthouse come header `Cookie` (insieme agli `extraHTTPHeaders` del target), altrimenti la
console risponde con la pagina di login o un errore applicativo e l'audit non produce punteggio.

Una run Lighthouse che non riesce a caricare la pagina **non solleva un'eccezione**: completa con
`lhr.runtimeError` e `score: null`. Questi casi vengono ora segnalati per vista con il codice
Lighthouse, es.:

```
[lighthouse] ERRORED_DOCUMENT_REQUEST su http://…/pagina: Lighthouse was unable to reliably load
the page you requested… (Status code: 500)
[lighthouse] NO_FCP su http://…/pagina: The page did not paint any content…
```

`summary.json` riporta in `lighthouseEnabled` se la feature era attiva, così un `lighthouse: []`
vuoto si distingue da "feature mai richiesta".

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
| `--false-positives` | file/dir | — | Registro dei falsi positivi gia' esaminati: le occorrenze corrispondenti escono da "Da verificare" ed entrano in una sezione propria del report, con motivazione e verifica. **Solo `incomplete`, mai violazioni.** Vedi [`GUIDA-falsi-positivi.md`](GUIDA-falsi-positivi.md) |
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
- Con `--min-score`, una vista **senza punteggio** (audit Lighthouse non completato) fa fallire il
  gate: su quella vista la soglia non è verificabile, e passare il gate sarebbe un falso ok.

### Il punteggio Lighthouse NON è un criterio di conformità

Domanda ricorrente: "quale soglia mettiamo, 90%?". **Nessuna specifica chiede una percentuale.**

La conformità WCAG è **binaria e per criterio**: una pagina è conforme AA se soddisfa *tutti* i
criteri A e AA, più i requisiti di conformità (pagine intere, processi completi, non-interferenza).
Non esiste un "90% conforme": esistono "conforme", "parzialmente conforme", "non conforme" — le tre
voci della dichiarazione di accessibilità AgID. La catena normativa (Direttiva UE 2016/2102 → norma
armonizzata EN 301 549 → Linee Guida AgID, art. 3-bis CAD) rimanda a criteri, non a punteggi; anche
la metodologia europea di monitoraggio verifica criteri. Nella dichiarazione si elencano i criteri
non soddisfatti: **non si cita una percentuale**.

Va aggiunto che il punteggio non pretende di misurare l'accessibilità nemmeno secondo Lighthouse: è
la **media pesata degli audit automatici superati**, e 100 non implica accessibile (l'automazione non
vede tastiera, focus, senso dei testi). Usarlo come soglia di conformità è un errore di categoria.

Anche come gate tecnico è debole, per quattro motivi concreti:

1. **non è comparabile fra pagine** — essendo una media pesata, lo stesso difetto sposta il punteggio
   di molti punti su una pagina povera di elementi e di pochi su una lista ricca;
2. **deriva con la versione** — aggiornando `lighthouse` cambiano audit e pesi, quindi il numero si
   muove senza che il codice sia cambiato;
3. **non è azionabile** — dice "85 < 90", non cosa correggere: serve comunque l'analisi dei livelli
   1-2;
4. **è governato dalla vista peggiore** — `--min-score` fallisce se *una qualsiasi* vista è sotto
   soglia, quindi su centinaia di viste decide il caso più rumoroso (e le viste con audit fallito,
   tipici gli stati da postback ricaricati in una tab nuova, fanno fallire il gate).

**Come impostare il gate, allora:**

| Ruolo | Strumento | Perché |
|---|---|---|
| Gate che blocca | `--fail-on serious` + `--fail-on-nameless` | deterministici, per-occorrenza, azionabili, indipendenti da tool esterni |
| Indicatore da tracciare | `lighthouse` (senza `--min-score`) | serie storica del punteggio: `summary.lighthouse[]` |
| Soglia opzionale | `--min-score` su un insieme **curato** di `pages[]`, con `--no-flows` | evita la fragilità della tab CDP sugli stati non ripetibili |

Per le pagine **nuove** l'obiettivo sensato è 100, non 90: il punteggio automatico è un pavimento,
non un tetto.

> **Console con debito preesistente.** Su un'applicazione legacy con centinaia di violazioni già
> presenti, un gate assoluto ha due soli esiti: blocca tutto dal primo giorno, o è tarato così lasco
> da non scattare mai. In quel caso l'approccio corretto non è abbassare la soglia ma il **ratchet**:
> fotografare lo stato attuale come baseline e fallire sull'**incremento** ("nessuna nuova
> violazione"), stringendo la baseline mano a mano che si bonifica — la logica del "new code" di
> Sonar. Il tool oggi **non** ha una baseline: nel frattempo la via praticabile è `--fail-on none`
> (report senza blocco) sulla run completa e un gate stretto su un sottoinsieme già bonificato.

## Esempi

```bash
# 1) Tutto dichiarato in config (comando minimale)
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080

# 2) Solo la console, con crawl e screen reader forzati da CLI
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080 \
     --only console --crawl 300 --crawl-depth 2 --screen-reader

# 3) Run "ufficiale" con punteggio Lighthouse e gate a soglia (lenta; la soglia e' una scelta
#    interna, non un requisito di conformita' - vedi "Il punteggio Lighthouse NON e' un criterio
#    di conformita'")
node a11y-scan.mjs --config targets/govway/targets.govway.json --base https://gw-staging.example.it \
     --lighthouse --min-score 0.90 --fail-on serious

# 4) Solo report, nessun blocco (adozione graduale)
node a11y-scan.mjs --config targets/govway/targets.govway.json --base http://127.0.0.1:8080 --fail-on none
```

> **Attenzione a `--lighthouse` + `--crawl`**: Lighthouse gira su **ogni** pagina scoperta → tempi
> molto lunghi. Per le esplorazioni col crawl, tienilo spento; usalo su `pages[]` curate.
