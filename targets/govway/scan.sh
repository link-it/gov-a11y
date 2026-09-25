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
# Scansione di accessibilita' delle due console GovWay (govwayMonitor e govwayConsole).
# Verifica prima le dipendenze richieste dall'esecuzione e si ferma se ne manca una;
# poi esegue le due scansioni, ciascuna con le proprie credenziali.
#
set -uo pipefail

RADICE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$RADICE/a11y-scan.mjs"
CFG_MONITOR="$RADICE/targets/govway/targets.govway_monitor.json"
CFG_CONSOLE="$RADICE/targets/govway/targets.govway_console.json"

BASE="${A11Y_BASE_URL:-http://localhost:8080}"
PREFISSO="report"
COMPLETA=0

uso() {
  cat <<'FINE'
Uso: scan.sh [--full] [--base URL] [--out PREFISSO] [--product-version VERSIONE]

  --full          Scansione COMPLETA: attiva anche Lighthouse e lo screen reader virtuale,
                  i due componenti lenti (circa un'ora per console). Da usare al rilascio.
                  Senza questa opzione la scansione e' quella rapida per l'integrazione
                  continua: axe e albero di accessibilita', pochi minuti.
  --base URL      Indirizzo delle console (default: $A11Y_BASE_URL o http://localhost:8080)
  --out PREFISSO  Prefisso delle directory dei report (default: report)
                  -> <PREFISSO>-monitor/ e <PREFISSO>-console/
  --product-version VERSIONE
                  Versione di GovWay in prova, riportata nei due report (anche da
                  variabile d'ambiente A11Y_PRODUCT_VERSION)
  -h, --help      Questo messaggio

Credenziali, dalle variabili d'ambiente (le password sono obbligatorie):
  A11Y_MONITOR_USER (default operatore)      A11Y_MONITOR_PASS
  A11Y_CONSOLE_USER (default amministratore) A11Y_CONSOLE_PASS

Esce con codice diverso da zero se manca una dipendenza o se una delle due scansioni
non supera il gate di accessibilita'.
FINE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --full)      COMPLETA=1; shift ;;
    --base)      BASE="${2:-}"; shift 2 ;;
    --out)       PREFISSO="${2:-}"; shift 2 ;;
    --product-version) A11Y_PRODUCT_VERSION="${2:-}"; export A11Y_PRODUCT_VERSION; shift 2 ;;
    -h|--help)   uso; exit 0 ;;
    *)           echo "Opzione sconosciuta: $1" >&2; uso >&2; exit 2 ;;
  esac
done

# I flag valgono sia per la verifica delle dipendenze sia per la scansione: --check-deps
# guarda cosa serve a QUESTA esecuzione, quindi con flag diversi darebbe un esito diverso.
if [ "$COMPLETA" = 1 ]; then
  MODO="completa (Lighthouse e screen reader attivi)"
  FLAG=()
else
  MODO="rapida (senza Lighthouse ne' screen reader)"
  FLAG=(--no-lighthouse --no-screen-reader)
fi

[ -f "$SCANNER" ] || { echo "Scanner non trovato: $SCANNER" >&2; exit 2; }

manca=0
for v in A11Y_MONITOR_PASS A11Y_CONSOLE_PASS; do
  if [ -z "${!v:-}" ]; then echo "Variabile d'ambiente non impostata: $v" >&2; manca=1; fi
done
[ "$manca" = 0 ] || { echo "Imposta le password e riprova ('scan.sh --help')." >&2; exit 2; }

echo "=== gov-a11y — GovWay: scansione $MODO"
echo "    base: $BASE    report: ${PREFISSO}-monitor/ e ${PREFISSO}-console/"
[ -n "${A11Y_PRODUCT_VERSION:-}" ] && echo "    versione in prova: $A11Y_PRODUCT_VERSION"
echo

echo "=== Verifica delle dipendenze"
for cfg in "$CFG_MONITOR" "$CFG_CONSOLE"; do
  echo "--- $(basename "$cfg")"
  node "$SCANNER" --check-deps --config "$cfg" "${FLAG[@]+"${FLAG[@]}"}" || {
    echo "Dipendenze mancanti per $(basename "$cfg"): scansione non avviata." >&2
    exit 1
  }
done

# Le due scansioni girano entrambe anche se la prima fallisce il gate: servono tutti e due
# i report, e l'esito complessivo e' il peggiore dei due.
esito=0

echo
echo "=== govwayMonitor"
A11Y_MONITOR_USER="${A11Y_MONITOR_USER:-operatore}" \
node "$SCANNER" --base "$BASE" --config "$CFG_MONITOR" --out "${PREFISSO}-monitor" "${FLAG[@]+"${FLAG[@]}"}"
uscita_monitor=$?
[ "$uscita_monitor" = 0 ] || esito=1

echo
echo "=== govwayConsole"
A11Y_CONSOLE_USER="${A11Y_CONSOLE_USER:-amministratore}" \
node "$SCANNER" --base "$BASE" --config "$CFG_CONSOLE" --out "${PREFISSO}-console" "${FLAG[@]+"${FLAG[@]}"}"
uscita_console=$?
[ "$uscita_console" = 0 ] || esito=1

echo
echo "=== Esito"
echo "    govwayMonitor : $([ "$uscita_monitor" = 0 ] && echo 'gate superato' || echo "FALLITO (codice $uscita_monitor)")   ->  ${PREFISSO}-monitor/report.html"
echo "    govwayConsole : $([ "$uscita_console" = 0 ] && echo 'gate superato' || echo "FALLITO (codice $uscita_console)")   ->  ${PREFISSO}-console/report.html"
exit "$esito"
