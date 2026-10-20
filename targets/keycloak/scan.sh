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
# Scansione di accessibilita' di un tema di login Keycloak GovDesk (repo govdesk-kc-theme).
# Scansiona soltanto: Keycloak con i temi montati, Mailpit e i realm di prova (a11y-test,
# a11y-idp) devono essere gia' pronti: li prepara il repo dei temi (a11y/container.sh <tema>).
# Guida: README.md.
#
# Variabili lette da .env (gitignorato) o dall'ambiente: MAI committarle. Devono essere le stesse
# usate per preparare Keycloak.
#   A11Y_KC_ADMIN_USER=...     admin del realm master (API di amministrazione)
#   A11Y_KC_ADMIN_PASS=...
#   A11Y_KC_PASS=...           password degli utenti di prova creati da setup.py
#
set -uo pipefail

QUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RADICE="$(cd "$QUI/../.." && pwd)"
SCANNER="$RADICE/a11y-scan.mjs"

BASE="${A11Y_BASE_URL:-http://127.0.0.1:8090}"
CONFIG="$QUI/targets.keycloak.json"
OUT="report-keycloak"
COMPLETA=0
VERSIONE=""

uso() {
  cat <<'FINE'
Uso: scan.sh [--solo-login] [--full] [--out DIR] [--base URL] [--product-version VERSIONE]

  --solo-login    Solo la pagina di login (targets.keycloak-login.json): per le varianti che
                  cambiano solo login.ftl (govdesk-spid, govdesk-spid-cie, govdesk-okta).
                  Senza: tutte le pagine (targets.keycloak.json), per i temi completi
  --full          Anche Lighthouse e lo screen reader virtuale (lenti)
  --out DIR       Directory del report (default: report-keycloak)
  --base URL      Keycloak (default http://127.0.0.1:8090, anche A11Y_BASE_URL)
  --product-version VERSIONE
                  Versione riportata nel report (anche A11Y_PRODUCT_VERSION)
  -h, --help      Questo messaggio

Credenziali (da .env o dall'ambiente): A11Y_KC_ADMIN_USER, A11Y_KC_ADMIN_PASS, A11Y_KC_PASS.
Mailpit: MAILPIT_URL (default http://127.0.0.1:8025).

Esce con 0 se il gate e' superato, 1 se non lo e', 2 se l'ambiente non e' pronto.
FINE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --solo-login) CONFIG="$QUI/targets.keycloak-login.json"; shift ;;
    --full)       COMPLETA=1; shift ;;
    --out)        OUT="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
    --base)       BASE="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
    --product-version) VERSIONE="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
    -h|--help)    uso; exit 0 ;;
    *)            echo "Opzione sconosciuta: $1" >&2; uso >&2; exit 2 ;;
  esac
done
BASE="${BASE%/}"

# Le variabili gia' nell'ambiente hanno la precedenza su .env.
if [ -f "$RADICE/.env" ]; then
  while IFS='=' read -r nome valore; do
    [ -z "${!nome:-}" ] && export "$nome=$valore"
  done < <(grep -E '^A11Y_[A-Z0-9_]+=' "$RADICE/.env")
fi
for v in A11Y_KC_ADMIN_USER A11Y_KC_ADMIN_PASS A11Y_KC_PASS; do
  [ -n "${!v:-}" ] || { echo "Manca $v (in .env o nell'ambiente)" >&2; exit 2; }
done
export A11Y_KC_ADMIN_USER A11Y_KC_ADMIN_PASS A11Y_KC_PASS

[ -f "$SCANNER" ] || { echo "Scanner non trovato: $SCANNER" >&2; exit 2; }
[ -d "$RADICE/node_modules" ] || { echo "Dipendenze di gov-a11y non installate: esegui 'npm ci' in $RADICE" >&2; exit 2; }

if [ "$COMPLETA" = 1 ]; then FLAG=(--lighthouse --screen-reader); else FLAG=(--no-lighthouse --no-screen-reader); fi

# --- ambiente pronto? ---
curl -sf -o /dev/null -m 5 "$BASE/realms/a11y-test" || {
  echo "Realm a11y-test non raggiungibile su $BASE: Keycloak e i realm di prova vanno preparati" >&2
  echo "dal repo dei temi: govdesk-kc-theme/a11y/container.sh <tema>." >&2
  exit 2
}
curl -sf -o /dev/null -m 5 "${MAILPIT_URL:-http://127.0.0.1:8025}/api/v1/messages" \
  || echo "Attenzione: Mailpit non risponde, le viste delle email non saranno analizzate." >&2

VER=(); [ -n "$VERSIONE" ] && VER=(--product-version "$VERSIONE")
exec node "$SCANNER" --base "$BASE" --config "$CONFIG" --out "$OUT" "${VER[@]+"${VER[@]}"}" "${FLAG[@]}"
