# gov-a11y — Cosa verifica, con quali livelli e con quale valore

Questo documento spiega **i quattro livelli di verifica** del tool: cosa intercetta ciascuno, cosa
NON intercetta, quanto costa, dove finisce il risultato e quando conviene attivarlo. Serve a chi
deve interpretare un report o decidere la configurazione di una pipeline; per il "come si lancia"
vedi [`GUIDA-esecuzione.md`](GUIDA-esecuzione.md), per le chiavi di configurazione
[`GUIDA-config.md`](GUIDA-config.md).

## Il quadro d'insieme

| Livello | Cosa guarda | Attivazione | Output |
|---|---|---|---|
| 1. **axe-core** | regole WCAG applicate al DOM renderizzato | sempre | violazioni puntuali (nodo + regola) |
| 2. **accessibility tree** | l'albero che le tecnologie assistive consumano | sempre | elementi interattivi senza nome accessibile |
| 3. **virtual screen reader** | gli annunci effettivamente prodotti | `screenReader` / `--screen-reader` | sequenza di annunci + annunci "solo-ruolo" |
| — **Lighthouse** | un punteggio aggregato della categoria accessibility | `lighthouse` / `--lighthouse` | un numero 0-100 per vista |

I livelli 1-3 producono **problemi localizzabili**, su cui si può aprire una issue. Lighthouse
produce **un indicatore**: utile per il trend, non per capire cosa correggere.

I livelli sono **complementari, non alternativi**: guardano lo stesso stato della pagina da tre
punti di osservazione diversi (le regole, la struttura, l'output percepito). Ogni vista raggiunta —
pagina in config, pagina scoperta dal crawl, stato raggiunto da un `flow` — attraversa tutti i
livelli attivi.

---

## Livello 1 — axe-core (sempre attivo)

Esegue il motore di regole axe-core sul DOM **già renderizzato** dal browser (quindi anche su
contenuto generato da JavaScript), limitato ai tag WCAG scelti con `--tags` /
`"tags"` in config (default `wcag2a,wcag2aa,wcag21a,wcag21aa`; le config GovWay/GovCat aggiungono
`wcag22aa`).

**Intercetta**: contrasto colore insufficiente, immagini senza alternativa testuale, campi senza
label, `lang` mancante o errato, ruoli/attributi ARIA usati male, ordine degli heading, tabelle
senza intestazioni, e in generale tutto ciò che è verificabile meccanicamente su un nodo.

**Non intercetta**: se un testo alternativo o una label sono *sensati* (axe vede se mancano, non se
significano qualcosa), la navigabilità da tastiera reale, la gestione del focus, la comprensibilità
di un flusso.

**Due categorie di esito**, entrambe nel report:

- `violations` — problemi accertati, con gravità `critical|serious|moderate|minor`;
- `incomplete` — casi che axe non riesce a decidere da solo e che richiedono verifica umana
  (tipicamente il contrasto su sfondi calcolati o gradienti). Sono la colonna "Da verificare" del
  report HTML, nascondibile con `--no-incomplete`. Le occorrenze gia' esaminate e riconosciute come
  falsi positivi si possono registrare, con la prova che le giustifica, così che "da verificare"
  continui a significare *ancora da verificare*: vedi [`GUIDA-falsi-positivi.md`](GUIDA-falsi-positivi.md).

**Gate**: `--fail-on <gravità>` (default `serious`) fa fallire la run se esistono violazioni di
gravità pari o superiore. È il gate principale, quello adatto a bloccare una pipeline.

---

## Livello 2 — accessibility tree (sempre attivo)

Legge l'**accessibility tree** della vista tramite `ariaSnapshot` di Playwright, cioè la
rappresentazione che il motore di accessibilità di Chromium espone alle tecnologie assistive (e che
onora la visibilità CSS). Su quell'albero cerca gli elementi con un **ruolo interattivo**
(`button`, `link`, `textbox`, `combobox`, `checkbox`, `tab`, `slider`, …) **privi di nome
accessibile**.

**Perché non basta il livello 1**: axe verifica regole su singoli nodi e conosce i pattern noti; qui
si guarda il risultato semantico dell'albero, il che intercetta anche i **widget custom** che axe
non riconosce come controlli. Un pulsante-icona senza `aria-label` compare in questo livello con
certezza, indipendentemente da come è stato costruito.

**Output**: il conteggio per vista (`a11y-tree: N elem. interattivi senza nome` nel log,
`namelessInteractive` in `summary.json`) e, come **evidenza per la revisione manuale**, l'albero
completo di ogni vista in `aria-tree/<vista>.yaml` — ordine di lettura, ruoli e nomi così come li
riceve una tecnologia assistiva. Il report HTML ne offre anche una vista grafica navigabile.

**Gate**: `--fail-on-nameless` fa fallire la run se esiste almeno un elemento interattivo senza
nome. È un gate severo ma su un difetto oggettivo e sempre reale.

---

## Livello 3 — virtual screen reader (`screenReader`)

Un virtual screen reader ([`@guidepup/virtual-screen-reader`](https://www.npmjs.com/package/@guidepup/virtual-screen-reader))
percorre la vista e produce la **sequenza di annunci** che un utente non vedente sentirebbe.

Come funziona qui, in ordine:

1. nel browser (dove il layout esiste) vengono **potati** i sottoalberi non visibili — `hidden`,
   `aria-hidden="true"`, `display:none`, `visibility:hidden|collapse`: senza questo passaggio il
   virtual SR annuncerebbe anche i pannelli filtri collassati, generando falsi positivi;
2. l'HTML risultante viene dato a **jsdom** (nessuno screen reader di sistema: gira in CI headless,
   su Linux, senza display);
3. il cursore del virtual SR avanza di elemento in elemento raccogliendo `lastSpokenPhrase()` fino a
   `end of document`, con un **cap di 1500 annunci** come salvagente anti-loop.

**Output** (`sr` in `axe-results.json`):

- `stops` — quante fermate ha fatto il cursore (`SR: 489 annunci` nel log);
- `phrases` — il testo di ogni annuncio, nell'ordine: è **l'evidenza dell'ordine di lettura reale**;
- `roleOnly` — gli annunci composti dal **solo ruolo** (`"button"`, `"link"`): un utente sente
  "pulsante" e non sa cosa fa. Nel log è `1 solo-ruolo`, in `summary.json` `srRoleOnlyTotal`.

**Cosa aggiunge rispetto al livello 2**: il livello 2 ispeziona l'albero *grezzo*, il livello 3
verifica l'*output*. Un elemento può avere un nome nell'albero ed essere comunque annunciato in modo
inutile o fuori ordine; e la sequenza di frasi è l'unico artefatto che mostra cosa succede
davvero, in che ordine.

**Limiti da dichiarare in un audit**: non è uno screen reader reale (nessun NVDA / JAWS /
VoiceOver), non verifica tastiera né ordine di focus, e jsdom non ha layout né CSS — la fedeltà è
quella dell'albero di accessibilità, non dell'esperienza d'uso. Se il log mostra `SR: 1500 annunci`
il cap è stato raggiunto: su quella vista la sequenza è **troncata** e va considerata parziale.

**Gate**: nessuno. È evidenza a supporto della revisione manuale. Il gate
"screen-reader-oriented" è quello del livello 2 (`--fail-on-nameless`).

**Costo**: significativo ma lineare — potatura, serializzazione e cammino su ogni vista. Su
centinaia di viste è il secondo costo dopo Lighthouse.

---

## Lighthouse (`lighthouse`)

Calcola il **punteggio della categoria "accessibility"** di Lighthouse per ogni vista, da 0 a 100.

**Cosa aspettarsi**: Lighthouse usa a sua volta axe-core, quindi le *scoperte* si sovrappongono in
larga parte al livello 1. Il valore aggiunto non è la copertura, è avere **un numero sintetico e
comparabile**: un trend in CI, un indicatore in un report di direzione ("da 85 a 92"), una soglia
contrattuale.

**Come è integrato** (dettaglio utile quando qualcosa non torna): il browser della scansione viene
lanciato con `--remote-debugging-port=9222`; Lighthouse **non riusa la pagina** della scansione, apre
una propria tab via CDP nel context di default del browser. Poiché la scansione naviga in un
`browser.newContext()` isolato, i cookie di sessione non sarebbero condivisi: il tool li rilegge dal
context corrente e li passa a Lighthouse come header `Cookie`, insieme agli `extraHTTPHeaders` del
target. Senza questo, su una console autenticata Lighthouse analizzerebbe la pagina di login o un
errore applicativo.

**Quando non produce punteggio**: una run Lighthouse che non riesce a caricare la pagina **non
solleva un'eccezione**, completa con `lhr.runtimeError` e `score: null`. Questi casi sono segnalati
per vista con il codice Lighthouse, es. `[lighthouse] ERRORED_DOCUMENT_REQUEST su <url>: …` o
`NO_FCP`, più un riepilogo a fine run. `summary.json` riporta in `lighthouseEnabled` se la feature
era attiva, così un elenco `lighthouse: []` vuoto si distingue da "feature mai richiesta".

**Gate**: `--min-score <0..1>` (es. `0.90`) fa fallire la run se un punteggio scende sotto la
soglia — e implica `--lighthouse`. Se una vista **non ha punteggio** la soglia su quella vista non è
verificabile: il gate fallisce anche in quel caso, per non restituire un verde privo di significato.

> Una soglia percentuale **non è un criterio di conformità** e non è chiesta da nessuna specifica: la
> conformità WCAG è binaria e per criterio. Perché il punteggio è un gate debole e cosa usare al suo
> posto: [`GUIDA-esecuzione.md` → "Il punteggio Lighthouse NON è un criterio di conformità"](GUIDA-esecuzione.md#il-punteggio-lighthouse-non-è-un-criterio-di-conformità).

**Costo**: alto. Ogni audit sono diversi secondi e apre una tab dedicata; su un centinaio di viste
domina il tempo della run. È anche il livello più fragile, perché ricarica l'URL in una tab nuova:
gli stati non ripetibili (postback JSF, URL con token di sessione o `__tabKey__`) possono non
riprodursi.

**Dipendenze**: `lighthouse` è una `optionalDependency`. Se la feature è richiesta e il modulo non
c'è, la scansione si ferma con exit 2 prima di aprire il browser. Verifica a secco:
`node a11y-scan.mjs --check-deps --config <file>`.

---

## Cosa nessun livello copre

L'automazione, sommando tutti i livelli, copre **indicativamente il 30-40%** dei criteri WCAG 2.1
AA (la stima è riportata anche nel campo `coverage` di `summary.json`). Restano necessariamente
manuali:

- navigazione da tastiera e ordine di focus reale;
- test con uno screen reader reale (verbosità, fedeltà, senso degli annunci in contesto);
- qualità di testi alternativi, label e messaggi di errore (l'automazione vede se mancano, non se
  hanno senso);
- comprensibilità dei flussi, gestione del tempo, contenuti in movimento.

Il report è **evidenza a supporto della dichiarazione di accessibilità AgID**, non una
certificazione di conformità: un esito automatico pulito non implica conformità WCAG.

---

## Quale configurazione, quando

| Scenario | Livelli | Comando |
|---|---|---|
| **Quality gate in CI** | 1 + 2 | `--fail-on serious --fail-on-nameless --no-lighthouse` |
| **Audit periodico / evidenza AgID** | 1 + 2 + 3 | `screenReader` attivo su tutte le viste (le frasi servono al revisore) |
| **Indicatore per la direzione** | + Lighthouse | `--lighthouse` su un sottoinsieme rappresentativo, oppure `--min-score 0.90` come soglia |
| **Prova rapida / debug di un flow** | 1 + 2 | `--no-flows --no-crawl --no-screen-reader --fail-on none` |

Motivazione della prima riga: i livelli 1-2 sono veloci, deterministici e falliscono solo su
difetti accertati — le proprietà che si vogliono in un gate. Il livello 3 e Lighthouse costano tempo
e, essendo evidenza o indicatore, non sono ciò che deve bloccare una pipeline.

I parametri si possono dichiarare in config nel blocco `defaults` (globali) o dentro un target
(override), e i flag `--no-lighthouse` / `--no-screen-reader` spengono da CLI ciò che è acceso in
config. Precedenza: **CLI > target > defaults > built-in**.

## Dove finisce cosa

| Livello | `axe-results.json` | `summary.json` | Altro |
|---|---|---|---|
| 1. axe | `violations[]`, `incomplete[]` | `totals`, `incompleteTotal` | `a11y.sarif`, `sonar-issues.json`, `a11y-junit.xml`, colonne del `report.html` |
| 2. albero | `axTree.nameless[]` | `namelessTotal`, `namelessInteractive` per vista | `aria-tree/<vista>.yaml` + vista grafica nel `report.html` |
| 3. screen reader | `sr.stops`, `sr.phrases[]`, `sr.roleOnly[]` | `screenReader`, `srRoleOnlyTotal`, `srStops` per vista | — |
| Lighthouse | `lhScore` | `lighthouseEnabled`, `lighthouse[]` (url + score) | colonna nel `report.html` |
