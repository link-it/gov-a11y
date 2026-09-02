# gov-a11y — Falsi positivi dichiarati

Il rapporto distingue tre esiti: **violazioni** (axe ha deciso: non conforme), **da verificare**
(`incomplete`: axe **non** ha potuto decidere) e il resto. La categoria "da verificare" è utile
finché significa davvero *ancora da verificare*: quando contiene sempre le stesse occorrenze, già
esaminate e archiviate come non problematiche, smette di essere un segnale e diventa rumore — e il
rumore nasconde le novità.

Il **registro dei falsi positivi** serve a questo: registrare una volta l'esito di un esame, con la
prova che lo sostiene, perché non vada rifatto a ogni scansione.

## Il perimetro: solo gli `incomplete`

Il registro si applica **soltanto** alle occorrenze `incomplete`, **mai** alle violazioni. Non è una
limitazione tecnica ma una scelta: una violazione derogata è il modo in cui questi registri
degenerano nel posto dove si nascondono i problemi. Se axe ha deciso che qualcosa non è conforme, o
lo si corregge o si documenta la deroga fuori dallo strumento, sotto la responsabilità di chi firma
la dichiarazione di accessibilità.

## Le occorrenze derogate non spariscono

Escono da "Da verificare" ed entrano in una **sezione propria del report**, con la motivazione, la
verifica, l'autore e la scadenza. Un revisore deve poter contestare una deroga, e per farlo deve
vederla. La differenza fra una deroga e un insabbiamento sta tutta qui.

Nel riepilogo compaiono come voce distinta:

```
Totali occorrenze axe: critical 0, serious 0 — da verificare (incomplete): 0 — falsi positivi dichiarati: 29
```

## Il file

Un `.json` accanto al file di config, riferito dal target:

```jsonc
// targets/govway/targets.govway_console.json
"console": {
  "falsePositives": "falsePositives.govway_console.json",   // relativo alla dir del config, o assoluto
  ...
}
```

Da riga di comando: `--false-positives <file|dir>` (ha precedenza sul config). Se si passa una
**directory**, vengono caricati e uniti tutti i `.json` che contiene, ignorando in silenzio quelli
che non sono registri — nella stessa cartella risiedono anche i file di target.

I percorsi relativi si risolvono **rispetto alla directory corrente** se il valore arriva da riga di
comando, come per `--config` e `--out`, e **rispetto alla directory del config** se arriva dal file
di configurazione, dove il registro risiede accanto.

```jsonc
{
  "falsePositives": [
    {
      "id": "icon-font-non-e-testo",              // obbligatorio, stabile: compare nel report
      "rule": "color-contrast",                   // obbligatorio: id della regola axe
      "cause": "nonBmp",                          // opzionale: messageKey axe. Restringe molto, usalo
      "selector": "i.material-icons, i.material-symbols-outlined",   // opzionale: CSS
      "urlPattern": "ResourcesList\\.do",         // opzionale: regexp sulla URL della vista
      "reason": "Perche' non e' un difetto.",     // obbligatorio
      "verification": "Come lo si e' accertato.", // obbligatorio
      "author": "nome.cognome@ente.it",           // consigliato
      "expires": "2027-09-01"                     // consigliato
    }
  ]
}
```

Il file può anche essere direttamente un array di voci, senza l'oggetto contenitore.

### `reason` e `verification` sono entrambi obbligatori

Una voce priva di uno dei due viene **ignorata**, con un avviso. Non è pedanteria: *"è un falso
positivo"* è un'opinione, *"misurato 9.35:1 il 2026-09-01 sui colori effettivamente resi"* è un
fatto che un'altra persona può ricontrollare — ed è ciò che serve alla dichiarazione AgID, dove
quelle occorrenze vanno riportate come **verificate** e non come ignote.

### Il selettore si valuta nella pagina

Il confronto avviene con `Element.matches` **nel browser**, sull'elemento reale indicato da axe. È
l'unico modo esatto: axe restituisce un percorso CSS, non l'elemento, e riconoscere una famiglia dal
frammento HTML sarebbe un'approssimazione.

### La scadenza

Passata la data in `expires`, la voce **smette di applicarsi**: le occorrenze tornano fra quelle da
verificare e il report segnala che la misura va rifatta e la scadenza rinnovata. Una deroga senza
scadenza vale per sempre, ed è raramente ciò che si vuole: il codice cambia.

## Come si scrive una voce, in pratica

1. **Fai una scansione** e guarda le occorrenze in "Da verificare".
2. **Esaminale davvero.** Se l'esito è "non lo so", non è un falso positivo: è un lavoro da fare.
3. **Raggruppa per causa, non per nodo.** Registrare nodo per nodo produce un file che cambia a ogni
   corsa — identificativi dinamici, dati diversi, viste che compaiono e scompaiono — e marcisce in
   una settimana. La chiave stabile è **regola + causa + famiglia di elementi**.
4. **Tieni il selettore stretto.** Una deroga su una regola intera è pericolosa: il conteggio degli
   `incomplete` è anche un *segnale*. In un caso reale `target-size` è passato da 2 a 80 occorrenze
   e quello era un difetto appena introdotto: con una deroga larga sarebbe passato inosservato.
5. **Scrivi la verifica**, con data e numeri.

## Igiene del file

Il report segnala da solo due situazioni:

- **voci senza riscontro** — non hanno corrisposto ad alcuna occorrenza. Se la scansione è completa
  la deroga non serve più; se è parziale (`--only`, poche pagine, crawl ridotto) può semplicemente
  non essere stata attraversata;
- **voci scadute** — le occorrenze sono tornate fra quelle da verificare.

## Esempio reale

`targets/govway/falsePositives.govway_console.json` copre le tre famiglie della govwayConsole —
glifi di icon-font, `select` sotto l'overlay trasparente di `searchabledropdown`, piastrelle del
riepilogo API — per un totale di oltre tremila occorrenze in tre voci, ciascuna con la misura che la
giustifica.
