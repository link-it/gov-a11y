#!/usr/bin/env bash
#
# gov-a11y - Accessibility (WCAG) scanner for Link.it web consoles
# https://github.com/link-it/gov-a11y
#
# Copyright (c) 2025-2026 Link.it srl (https://link.it).
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 3, as published by
# the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
#
# Scansione di accessibilita' delle applicazioni GovDesk in sviluppo locale: GovHub e le app che
# ospita, ognuna sulla sua porta. Scansiona le app avviate e salta le altre. Per ogni app legge
# dall'app stessa la versione (about-config.json) e la modalita' (STANDALONE in app-config.json):
# un'app incorporata si autentica con la sessione di GovHub, che deve essere avviato; un'app
# standalone usa il proprio login e il target "-standalone", se esiste.
#
set -uo pipefail

RADICE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$RADICE/a11y-scan.mjs"
DIR_TARGET="$RADICE/targets/govdesk"
HOST="http://localhost"
PORTA_GOVHUB=5200

# app:porta, nell'ordine di scansione. Il config e' targets.<app>.json (e targets.<app>-standalone.json
# per la modalita' standalone). Le porte sono quelle di 'npm run start-<app>-proxy'.
APP=(govhub:5200 govanis:5212 govanist:5213 govdurc:5218 govtitcatasto:5217 govwaas:5216 govanpr:5209 govinad:5201 govisee:5207 govregistroimprese:5215 govcasellariogiudiziale:5219 govaudit:5203 govregistry:5208 govcatalogo:5220)

PREFISSO="report"
COMPLETA=0
ESEGUI=0
SOLO=""
VERSIONE_CLI=""

uso() {
  cat <<'FINE'
Uso: scan.sh [--full] [--solo app,app] [--out PREFISSO] [--product-version VERSIONE] [--esegui]

  --full          Scansione COMPLETA: attiva anche Lighthouse e lo screen reader virtuale,
                  i due componenti lenti. Da usare al rilascio. Senza questa opzione la
                  scansione e' quella rapida: axe e albero di accessibilita'.
  --solo LISTA    Solo queste app, separate da virgola (es. govhub,govanis). Un'app chiesta
                  qui e non avviata conta come errore; senza --solo le app non avviate
                  vengono saltate.
                  App: govhub govanis govanist govdurc govtitcatasto govwaas govanpr govinad
                       govisee govregistroimprese govcasellariogiudiziale govaudit
                       govregistry govcatalogo
  --out PREFISSO  Prefisso delle directory dei report (default: report) -> <PREFISSO>-<app>/
  --product-version VERSIONE
                  Versione riportata nei report. Senza, ogni app usa la sua (letta da
                  assets/config/about-config.json dell'app avviata)
  --esegui        Lascia eseguire i flow che interrogano davvero i servizi (dossier di GovHub,
                  accertamenti e verifiche delle app), se ne sono impostate le variabili
                  (A11Y_GOVANIS_CF, A11Y_GOVHUB_DURC_CF, ...). Senza questa opzione quelle
                  variabili vengono ignorate e i flow saltati: nessuna interrogazione vera.
  -h, --help      Questo messaggio

Credenziali, dalle variabili d'ambiente (obbligatorie), valide per tutte le app:
  A11Y_GOVDESK_USER   A11Y_GOVDESK_PASS
(un'app puo' averne di proprie con A11Y_<CHIAVE TARGET>_USER / _PASS, es. A11Y_GOVWAAS_USER)

Prerequisiti: VPN Link.it, le app avviate con 'npm run start-<app>-proxy'; per le app
incorporate (STANDALONE: false) anche GovHub su :5200.

Esce con 0 se tutte le app scansionate superano il gate, 1 se almeno una non lo supera,
2 se mancano credenziali o dipendenze, se un'app chiesta con --solo non e' avviata o se
non c'e' nessuna app da scansionare.
FINE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --full)      COMPLETA=1; shift ;;
    --solo)      SOLO="${2:-}"; shift 2 ;;
    --out)       PREFISSO="${2:-}"; shift 2 ;;
    --product-version) VERSIONE_CLI="${2:-}"; shift 2 ;;
    --esegui)    ESEGUI=1; shift ;;
    -h|--help)   uso; exit 0 ;;
    *)           echo "Opzione sconosciuta: $1" >&2; uso >&2; exit 2 ;;
  esac
done

if [ "$COMPLETA" = 1 ]; then
  MODO="completa (Lighthouse e screen reader attivi)"
  FLAG=()
else
  MODO="rapida (senza Lighthouse ne' screen reader)"
  FLAG=(--no-lighthouse --no-screen-reader)
fi

[ -f "$SCANNER" ] || { echo "Scanner non trovato: $SCANNER" >&2; exit 2; }
command -v curl >/dev/null || { echo "Serve curl per verificare quali app sono avviate." >&2; exit 2; }

manca=0
for v in A11Y_GOVDESK_USER A11Y_GOVDESK_PASS; do
  if [ -z "${!v:-}" ]; then echo "Variabile d'ambiente non impostata: $v" >&2; manca=1; fi
done
[ "$manca" = 0 ] || { echo "Imposta le credenziali e riprova ('scan.sh --help')." >&2; exit 2; }
# Lo scanner usa A11Y_USER / A11Y_PASS per ogni target che non abbia credenziali proprie.
export A11Y_USER="$A11Y_GOVDESK_USER" A11Y_PASS="$A11Y_GOVDESK_PASS"

# Senza --esegui si tolgono dall'ambiente i dati dei flow che interrogano i servizi: sono le
# variabili A11Y_GOV* che non sono credenziali. Un ambiente che le contiene per altri motivi
# non deve far partire interrogazioni vere senza una richiesta esplicita.
if [ "$ESEGUI" = 0 ]; then
  for v in $(compgen -e | grep -E '^A11Y_GOV[A-Z0-9]*_' | grep -vE '_(USER|PASS)$'); do
    unset "$v"
  done
fi

# --solo: controlla i nomi prima di cominciare
if [ -n "$SOLO" ]; then
  for a in ${SOLO//,/ }; do
    trovata=0
    for voce in "${APP[@]}"; do [ "${voce%%:*}" = "$a" ] && trovata=1; done
    [ "$trovata" = 1 ] || { echo "App sconosciuta in --solo: $a" >&2; exit 2; }
  done
fi
richiesta() {   # 0 se l'app va scansionata
  [ -z "$SOLO" ] && return 0
  case ",$SOLO," in *",$1,"*) return 0 ;; esac
  return 1
}

avviata() {     # 0 se l'app risponde sulla porta
  local codice
  codice=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HOST:$1/")
  [ "${codice:0:1}" = 2 ] || [ "${codice:0:1}" = 3 ]
}

# Valore di una chiave da un JSON servito dall'app (vuoto se assente o illeggibile).
# STANDALONE e' annidato (AppConfig.STANDALONE): si cerca la chiave a qualunque livello.
leggi_json() {  # porta, percorso, chiave
  curl -s -m 5 "$HOST:$1/$2" 2>/dev/null | node -e '
    let t = ""; process.stdin.on("data", d => t += d).on("end", () => {
      try {
        const cerca = o => { if (!o || typeof o !== "object") return undefined;
          if (process.argv[1] in o) return o[process.argv[1]];
          for (const v of Object.values(o)) { const r = cerca(v); if (r !== undefined) return r; } };
        const v = cerca(JSON.parse(t)); if (v !== undefined) process.stdout.write(String(v));
      } catch {}
    });' "$3"
}

standalone() {  # 0 se l'app gira in modalita' standalone (app-config-local.json vince su app-config.json)
  local v locale
  v=$(leggi_json "$1" assets/config/app-config.json STANDALONE)
  locale=$(leggi_json "$1" assets/config/app-config-local.json STANDALONE)
  [ -n "$locale" ] && v="$locale"
  [ "$v" = true ]
}

echo "=== gov-a11y — GovDesk: scansione $MODO"
echo "    host: $HOST    report: ${PREFISSO}-<app>/"
[ "$ESEGUI" = 1 ] && echo "    --esegui: i flow con le variabili impostate INTERROGANO DAVVERO i servizi"
echo

govhub_avviato=0
avviata "$PORTA_GOVHUB" && govhub_avviato=1

# Piano: per ogni app richiesta, config da usare o motivo per cui si salta.
PIANO=()      # app|porta|config|modalita'|versione
SALTATE=()    # app|motivo
errore_solo=0
for voce in "${APP[@]}"; do
  app="${voce%%:*}"; porta="${voce##*:}"
  richiesta "$app" || continue
  if ! avviata "$porta"; then
    SALTATE+=("$app|non avviata su :$porta")
    [ -n "$SOLO" ] && errore_solo=1
    continue
  fi
  versione="${VERSIONE_CLI:-$(leggi_json "$porta" assets/config/about-config.json version)}"
  if [ "$app" = govhub ]; then
    PIANO+=("$app|$porta|$DIR_TARGET/targets.govhub.json|-|$versione")
  elif standalone "$porta"; then
    cfg="$DIR_TARGET/targets.$app-standalone.json"
    if [ -f "$cfg" ]; then
      PIANO+=("$app|$porta|$cfg|standalone|$versione")
    else
      SALTATE+=("$app|in modalita' standalone, ma targets.$app-standalone.json non esiste")
      [ -n "$SOLO" ] && errore_solo=1
    fi
  elif [ "$govhub_avviato" = 1 ]; then
    PIANO+=("$app|$porta|$DIR_TARGET/targets.$app.json|incorporata|$versione")
  else
    SALTATE+=("$app|incorporata: serve GovHub avviato su :$PORTA_GOVHUB per il login")
    [ -n "$SOLO" ] && errore_solo=1
  fi
done

echo "=== Piano"
for voce in "${PIANO[@]+"${PIANO[@]}"}"; do
  IFS='|' read -r app porta cfg modalita versione <<< "$voce"
  printf '    %-14s :%s  %-11s %-8s %s\n' "$app" "$porta" "$modalita" "${versione:-?}" "$(basename "$cfg")"
done
for voce in "${SALTATE[@]+"${SALTATE[@]}"}"; do
  printf '    %-14s saltata: %s\n' "${voce%%|*}" "${voce#*|}"
done
echo

[ "${#PIANO[@]}" -gt 0 ] || { echo "Nessuna app da scansionare: avviale con 'npm run start-<app>-proxy'." >&2; exit 2; }

echo "=== Verifica delle dipendenze"
for voce in "${PIANO[@]}"; do
  IFS='|' read -r app porta cfg modalita versione <<< "$voce"
  node "$SCANNER" --check-deps --config "$cfg" "${FLAG[@]+"${FLAG[@]}"}" >/dev/null || {
    node "$SCANNER" --check-deps --config "$cfg" "${FLAG[@]+"${FLAG[@]}"}"
    echo "Dipendenze mancanti per $(basename "$cfg"): scansione non avviata." >&2
    exit 2
  }
done
echo "    ok"

# Le scansioni girano tutte anche se una fallisce il gate: servono tutti i report, e l'esito
# complessivo e' il peggiore.
esito=0
ESITI=()
for voce in "${PIANO[@]}"; do
  IFS='|' read -r app porta cfg modalita versione <<< "$voce"
  out="${PREFISSO}-$app"; [ "$modalita" = standalone ] && out="$out-standalone"
  echo
  echo "=== $app ($modalita, :$porta)"
  VER=(); [ -n "$versione" ] && VER=(--product-version "$versione")
  node "$SCANNER" --base "$HOST:$porta" --config "$cfg" --out "$out" "${VER[@]+"${VER[@]}"}" "${FLAG[@]+"${FLAG[@]}"}"
  uscita=$?
  [ "$uscita" = 0 ] || esito=1
  ESITI+=("$app|$uscita|$out")
done

echo
echo "=== Esito"
for voce in "${ESITI[@]}"; do
  IFS='|' read -r app uscita out <<< "$voce"
  if [ "$uscita" = 0 ]; then stato='gate superato'; else stato="FALLITO (codice $uscita)"; fi
  printf '    %-14s %-22s ->  %s/report.html\n' "$app" "$stato" "$out"
done
for voce in "${SALTATE[@]+"${SALTATE[@]}"}"; do
  printf '    %-14s saltata\n' "${voce%%|*}"
done
[ "$errore_solo" = 1 ] && { echo "Almeno un'app chiesta con --solo non e' stata scansionata." >&2; exit 2; }
exit "$esito"
