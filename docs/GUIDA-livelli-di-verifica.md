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
| — **secondo motore** | regole WCAG di IBM Equal Access, indipendenti da axe, sullo stesso DOM | `equalAccess` / `--equal-access` | violazioni e casi da verificare per vista, confronto per criterio |

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

**Contrasti fuori vista**: axe misura il contrasto su quel che è a schermo, e un testo sotto il bordo
di un contenitore che scorre (lo stato vuoto in fondo a una colonna, "scorri per caricare altri
risultati"), o coperto in parte da una barra fissa come il campo di scrittura di una chat, esce come
`incomplete` (`elmPartiallyObscured`). Per questi casi lo strumento porta l'elemento al centro della vista, rimisura il solo `color-contrast` e rimette lo scorrimento com'era:
l'occorrenza diventa un passato o una violazione, e resta da verificare solo se è coperta anche in vista.
Durante la rimisura gli scroll infiniti sono in pausa (callback degli `IntersectionObserver` ed eventi
`scroll`, fermati in cattura prima dei gestori della pagina), così la lista non carica altre righe. Gira per ultima sulla vista, dopo gli altri controlli.

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

## Controlli di presentazione e tastiera (`reflow`, `textSpacing`, `keyboardWalk`, `languageParts`)

Criteri che axe non verifica perché richiedono di **cambiare lo stato della pagina**: la
larghezza della finestra, la spaziatura del testo, il focus.

| Controllo | Criterio | Come |
|---|---|---|
| `reflow` | 1.4.10 Reflow | finestra a 320px: il documento non deve essere più largo; segnala gli elementi che sbordano |
| `textSpacing` | 1.4.12 Text Spacing | spaziature aumentate via CSS: nessun testo che entrava nel suo contenitore (`overflow: hidden`, ellissi) deve venire tagliato. Si confronta con la spaziatura normale: un testo **già** troncato prima è un caso da verificare (`gova11y-text-truncated`, con screenshot, derogabile nel registro), non una violazione; i testi nascosti di proposito (per screen reader, sostituiti da un'icona) si riconoscono dallo stile e si ignorano |
| `keyboardWalk` | 2.4.7, 2.4.11, 2.1.2 | tasto Tab dall'inizio della vista, o dalla finestra modale aperta: indicatore del focus (outline, box-shadow o cambio d'aspetto dell'elemento o dei due contenitori più vicini; con `keyboardWalkWidgetFocus` anche più in alto, fino al componente che marca il proprio fuoco con una classe, come `ng-select-focused`, gli elementi del contenitore di un comando trasparente steso sopra un pulsante, come l'input file invisibile, e l'icona dentro un comando piccolo), focus nascosto del tutto da un elemento visibile (con `keyboardWalkObscuredPaintOnly` solo da un elemento che in quel punto disegna qualcosa: non conta un contenitore vuoto e senza sfondo), focus bloccato; registra l'ordine di focus |
| `languageParts` | 3.1.2 Language of Parts | espressioni dichiarate dal target, per lingua: testo in una lingua dentro una parte di pagina dichiarata in un'altra |

**Cosa aspettarsi**: difetti di CSS e di markup che axe non vede (un `outline: none` senza
alternativa, un contenitore a larghezza fissa, un testo fisso non tradotto). Le violazioni hanno
id `gova11y-…` e il tag del criterio WCAG, e contano per il gate come quelle di axe.

**Limiti**: euristiche. Un indicatore del focus disegnato solo con pseudo-elementi (`::before`,
`::after`) non viene riconosciuto (falso positivo su `keyboardWalk`); un componente aperto col mouse
da un flow (un calendario, un menu) va escluso dal percorso col Tab con `"keyboard": false` sul passo
`scan`, perché il percorso parte dall'inizio della pagina e non dal componente, a meno che il
componente non si dichiari modale (`aria-modal="true"`): allora il percorso parte dentro di lui; `languageParts` trova solo i testi che il
target dichiara. Il riflusso è verificato solo sullo stato analizzato di ogni vista, non a ogni
livello di zoom.

**Costo**: `reflow` e `textSpacing` meno di un secondo per vista; `keyboardWalk` fino a ~6 s
per vista con le 45 fermate predefinite (`keyboardWalkMax`) e i 120 ms di attesa dopo ogni Tab
(`keyboardWalkWaitMs`, che pesa più di tutto il resto: fermate × attesa). Il percorso finisce prima
se torna a un elemento già visitato o esce dalla pagina, e su una vista senza nulla da raggiungere
dopo 10 Tab a vuoto. Se il fuoco cade sulla pagina perché l'elemento appena raggiunto è stato
sostituito da un aggiornamento AJAX (un'icona di stato ridisegnata periodicamente), il percorso
attende la rete, rimette il fuoco sul sostituto (stesso id, o stessa descrizione se unica) e
prosegue, fino a 3 volte per vista: prima si fermava lì, come se la pagina fosse finita. Una copertura del fuoco trovata mentre una richiesta è in corso (l'indicatore
di caricamento steso sopra la pagina) si rilegge a rete ferma e conta solo se resta. I tempi reali,
per fase e per vista, sono in `tempi.json` e nel report. Spenti di default.

---

## Lighthouse (`lighthouse`)

Calcola il **punteggio della categoria "accessibility"** di Lighthouse per ogni vista, da 0 a 100.

**Cosa aspettarsi**: Lighthouse usa a sua volta axe-core, quindi le *scoperte* si sovrappongono in
larga parte al livello 1. Il valore aggiunto non è la copertura, è avere **un numero sintetico e
comparabile**: un trend in CI, un indicatore in un report di direzione ("da 85 a 92"), una soglia
contrattuale.

**Come è integrato** (dettaglio utile quando qualcosa non torna): il browser della scansione viene
lanciato con `--remote-debugging-port` su una porta libera scelta a ogni scansione; Lighthouse **non riusa la pagina** della scansione, apre
una propria tab via CDP nel context di default del browser. Poiché la scansione naviga in un
`browser.newContext()` isolato, i cookie di sessione non sarebbero condivisi: il tool li rilegge dal
context corrente e li copia nel context di default, ognuno col suo path, insieme allo `sessionStorage`
della vista; gli `extraHTTPHeaders` del
target arrivano come header. Senza questo, su una console autenticata Lighthouse analizzerebbe la
pagina di login o un errore applicativo; se succede comunque (Lighthouse finisce su un'altra
pagina), il punteggio viene scartato e segnalato.

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

## Secondo motore — IBM Equal Access (`equalAccess`)

Esegue il motore di [IBM Equal Access](https://github.com/IBMa/equal-access) (pacchetto
`accessibility-checker-engine`, Apache-2.0) sullo **stesso stato** di ogni vista, subito dopo axe:
stessa sessione, stesso DOM, flow compresi. Usa l'insieme di regole `WCAG_2_2`, che contiene i soli
criteri di livello A e AA.

**Perché un secondo motore**: le linee guida che chiedono di verificare le pagine "con almeno due
strumenti diversi" (per esempio quelle di Regione Toscana, Sezione D, cap. 13) lo fanno perché
strumenti diversi trovano problemi diversi. Lighthouse non basta allo scopo: usa a sua volta
axe-core. IBM Equal Access ha regole e algoritmi propri (contrasto compreso), ed è lo stesso motore
dell'estensione per browser e del checker di IBM, senza il loro contorno (browser proprio,
telemetria): uno script iniettato nella pagina, come axe.

**Cosa produce**: per ogni vista le violazioni (esito `FAIL`) e i casi da verificare (`POTENTIAL`),
con regola, messaggio, criteri WCAG, snippet e XPath dell'elemento; nel report una colonna nella
tabella delle viste, una sezione per vista e il **confronto per criterio WCAG** fra i due motori. Un
criterio segnalato da un solo motore è quello da esaminare. Raccomandazioni e verifiche manuali del
motore non sono riportate.

**Gate**: spento di default. Finché non se ne conosce il rumore su un'applicazione, gli esiti del
secondo motore sono evidenza da confrontare. Con `failOnEqualAccess` (globale) le sue violazioni
decidono l'esito come quelle di axe, e lo stesso vale per una vista su cui il motore non riesce a
girare; i casi da verificare restano fuori. Si accende quando i difetti che trova sono stati
corretti, perché non ne tornino.

**Casi da verificare sul fuoco confermati dal percorso col Tab** (`equalAccessKeyboardConfirm`,
attiva di default, con effetto solo se sono accesi sia `equalAccess` sia `keyboardWalk`): molti casi
da verificare del motore sono domande sul fuoco, ripetute per ogni elemento raggiungibile
(`style_focus_visible`: il fuoco si vede? `element_tabbable_unobscured`: è coperto?
`element_tabbable_visible`: diventa visibile?). Il percorso col Tab misura proprio questo sulla
pagina vera. Gli elementi su cui IBM fa la domanda si individuano con il suo XPath prima del
percorso; se il Tab li raggiunge e la misura è positiva (l'aspetto cambia, nessun elemento visibile
li copre, il riquadro è nella finestra) il caso passa fra i **confermati dal percorso col Tab**: un
elenco a parte nella vista, con la misura che lo conferma, e `equalAccess.confermatiDaTab` in
`summary.json`. Non serve screenshot né verifica manuale. Gli elementi che il Tab non raggiunge
(oltre `keyboardWalkMax`, dentro un componente chiuso) o con misura negativa restano da verificare;
con misura negativa c'è anche la violazione del percorso col Tab. Limite: il criterio è quello del
percorso col Tab, "l'aspetto cambia in modo misurabile", e non giudica se l'indicatore è ben
visibile.

**Costo**: basso, uno o due secondi per vista. **Dipendenze**: `accessibility-checker-engine` è una
`optionalDependency`; se la feature è richiesta e il modulo manca la scansione si ferma con exit 2.

---

## Cosa accompagna ogni problema nel report

- **Criterio WCAG e riferimento EN 301 549**: la clausola 9 della EN 301 549 v3.2.1 (la norma
  tecnica su cui poggiano la normativa italiana e il monitoraggio AgID) ripete i criteri WCAG 2.1 A
  e AA con il prefisso `9.` (1.4.3 → 9.1.4.3). I criteri introdotti dalle WCAG 2.2 non vi sono
  ancora e sono marcati "solo WCAG 2.2".
- **Screenshot** (`screenshots`, attivo di default): la zona della vista intorno all'elemento,
  evidenziato con un bordo rosso, per ogni violazione, caso da verificare ed esito del secondo
  motore (al massimo `screenshotsMax` per vista). File in `screenshot/`, miniature nel report.
- **Stima del contrasto** (`contrastEstimate`, attiva di default): axe lascia "da verificare" il
  contrasto di un testo quando non sa ricavarne lo sfondo (gradiente, immagine, pseudo-elemento,
  elemento sovrapposto) o quando il testo è di uno o due caratteri; il secondo motore ne segnala
  altri. Lo sfondo vero però è sullo schermo: il testo si rende trasparente per un attimo (anche
  negli pseudo-elementi), si fotografa l'area delle sue righe e si confronta il suo colore con ogni
  pixel. Ne escono il rapporto minimo e massimo, la soglia (4,5:1, o 3:1 per il testo grande) e un
  esito: *sotto soglia*, *in parte* (un gradiente che passa la soglia a metà), *sopra soglia*. Il 2%
  dei pixel per parte si scarta. È una stima: non considera filtri, ombre e contenuti in movimento.
  Non decide nulla e non tocca il gate; è il punto di partenza della verifica manuale e la misura da
  citare in un falso positivo (vedi [GUIDA-falsi-positivi.md](GUIDA-falsi-positivi.md)). Nel report:
  accanto all'occorrenza e in una tabella per componente; in `summary.json`: `stimaContrasti`.
- **Errori sistematici**: la stessa regola sullo stesso componente in più viste. Il componente si
  riconosce dal selettore, ripulito di ciò che cambia da una vista all'altra (attributi di
  incapsulamento di Angular, posizione fra i fratelli). È un difetto del modello di pagina, da
  correggere una volta sola; vale anche per i casi da verificare, dove una verifica manuale fatta sul
  componente vale per tutte le viste. In `summary.json`: `erroriSistematici`.
- **Perimetro non coperto**: flow saltati (dati mancanti, variabili non impostate) o interrotti da
  un passo non riuscito, pagine in errore o che rimandano a una vista già analizzata, login non
  confermato. Prima finivano solo nel log; ora stanno in un riquadro del report e in
  `summary.json` (`perimetro`), perché gli esiti del report non valgono per le viste che non sono
  state analizzate.

---

## Cosa nessun livello copre

L'automazione, sommando tutti i livelli, copre **indicativamente il 30-40%** dei criteri WCAG 2.1
AA (la stima è riportata anche nel campo `coverage` di `summary.json`). Restano necessariamente
manuali:

- navigazione da tastiera: l'effetto dei tasti nei componenti e la logica dell'ordine di focus
  (`keyboardWalk` verifica fuoco visibile, non coperto e senza trappole, e registra l'ordine, ma non
  lo giudica);
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
| secondo motore | `equalAccess.violazioni[]`, `equalAccess.daVerificare[]`, `equalAccess.confermatiDaTab[]` | `equalAccess` (motore, versione, totali compreso `confermatiDaTab`), `confrontoMotori[]`, `equalAccess` per vista | colonna, sezione per vista e confronto nel `report.html` |
| screenshot | `screenshot` su ogni nodo fotografato | — | `screenshot/v<vista>-<n>.png`, miniature nel `report.html` |
| errori sistematici, perimetro | — | `erroriSistematici[]`, `perimetro[]` | tabella e riquadro nel `report.html` |
| stato HTTP della vista | — | `httpStatus` per vista, `httpErrorViews[]` | riga evidenziata e riquadro nel `report.html`, SARIF; con `failOnHttpError` anche gate e JUnit |
| tempi | `tempi` per vista (fasi in ms) | — | `tempi.json` (durata, login, navigazione, fasi, viste più lente); blocchi «Tempi» chiusi nel `report.html` |
