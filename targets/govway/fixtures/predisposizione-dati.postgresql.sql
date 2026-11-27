-- Predisposizione della base dati GovWay (PostgreSQL) per la scansione gov-a11y del monitor.
--
-- Alcuni flow del target 'targets.govway_monitor.json' raggiungono le loro viste solo se esistono
-- certi dati; senza, vengono saltati e finiscono nel perimetro non coperto:
--   - modale-nessuna-selezione, modale-conferma-eliminazione: almeno una ricerca utente salvata
--     dall'utente della scansione ('operatore'), altrimenti l'elenco delle Ricerche Utente è vuoto
--     e i comandi Esporta / Elimina selezionati non compaiono;
--   - modale-stato-api: il permesso di operatività sulle API ('O' in users.permessi), senza il
--     quale il comando di cambio stato delle API non è disegnato.
--
-- e del target 'targets.govway_console.json':
--   - elimina-archivio e le voci di menu Elimina, Cache, Cache PDND, Coda messaggi: l'interfaccia
--     avanzata per l'utente 'amministratore' (users.tipo_interfaccia), che nell'installazione è
--     'STANDARD'. In standard quelle voci non sono nel menu: il flow elimina-archivio si interrompe
--     e le viste del menu, scoperte a runtime, mancano senza comparire nel perimetro. La voce
--     'Modalità avanzata' del menu utente, cliccata dal flow menu, cambia l'interfaccia solo per
--     la sessione: non basta per i flow successivi.
--
-- Lo script è idempotente (si può eseguire a ogni build) e non fa nulla se l'utente non esiste.
-- I permessi sono letti al login: va eseguito prima di avviare la scansione.
--
-- Uso:  psql <db> <utente> -f predisposizione-dati.postgresql.sql

-- Permesso di operatività sulle API
UPDATE users SET permessi = permessi || 'O'
 WHERE login = 'operatore' AND permessi NOT LIKE '%O%';

-- Interfaccia avanzata per l'utente della scansione della console
UPDATE users SET tipo_interfaccia = 'AVANZATA'
 WHERE login = 'amministratore' AND tipo_interfaccia <> 'AVANZATA';

-- Ricerca utente di prova (la stessa ricerca statistica di 'ricerche-esempio.json', profilo SPCoop)
INSERT INTO users_ricerche (id_utente, label, descrizione, modulo, modalita_ricerca, visibilita, ricerca, protocollo)
SELECT u.id, 'gov-a11y', 'Ricerca di prova per la scansione di accessibilità', 'STATISTICHE', 'esiti', 'privata',
       '{"filtri":{"numeroDimensioni":"2d","tipoIdMessaggio":"Richiesta","tipoRicercaSPCoop":"spcoop","mittenteMatchingType":"EQUALS","periodo":"Ultima settimana","labelAzione":"Azione","tipoStatistica":"andamentoTemporale","tipoReport":"tabella","tipoBanda":"Banda Complessiva","distribuzionePerImplementazioneApi":true,"mittenteCaseSensitiveType":"SENSITIVE","esitoGruppo":-1,"tipoVisualizzazione":"numeroTransazioni","modalitaTemporale":"GIORNALIERA","esitoDettaglio":-1,"esitoContesto":"-","clientAddressMode":"--","tipoDistribuzione":"esiti","protocollo":"spcoop","tipoLatenza":"Latenza Totale","tipiLatenza":["0",null,null]}}',
       'spcoop'
  FROM users u
 WHERE u.login = 'operatore'
   AND NOT EXISTS (SELECT 1 FROM users_ricerche r
                    WHERE r.id_utente = u.id AND r.label = 'gov-a11y'
                      AND r.modulo = 'STATISTICHE' AND r.modalita_ricerca = 'esiti');
