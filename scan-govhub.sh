#!/usr/bin/env bash
# Scansione a11y completa di GovHub (app v2 in locale), servizi inclusi.
# Variabili lette da .env (gitignorato) o dall'ambiente: MAI committarle.
#   A11Y_GOVHUB_USER=...               login
#   A11Y_GOVHUB_PASS=...
#   A11Y_GOVHUB_DURC_CF=...            dati di prova DURC
#   A11Y_GOVHUB_DURC_MOTIVAZIONE=...
#   A11Y_GOVHUB_DURC_PROTOCOLLO=...
#   A11Y_GOVHUB_ANPR_SOGGETTO=...      dati di prova ANPR
#   A11Y_GOVHUB_ANPR_MOTIVAZIONE=...
#   A11Y_GOVHUB_ANIS_CF=...            dati di prova ANIS
#   A11Y_GOVHUB_ANIS_MOTIVAZIONE=...
#   A11Y_PRODUCT_VERSION=6.2.0         versione riportata nel report
# Argomenti extra passati ad a11y-scan.mjs. Base URL diversa: A11Y_BASE_URL=http://localhost:4200 ./scan-govhub.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

for v in A11Y_GOVHUB_USER A11Y_GOVHUB_PASS \
         A11Y_GOVHUB_DURC_CF A11Y_GOVHUB_DURC_MOTIVAZIONE A11Y_GOVHUB_DURC_PROTOCOLLO \
         A11Y_GOVHUB_ANPR_SOGGETTO A11Y_GOVHUB_ANPR_MOTIVAZIONE \
         A11Y_GOVHUB_ANIS_CF A11Y_GOVHUB_ANIS_MOTIVAZIONE; do
  [[ -n "${!v:-}" ]] || { echo "Manca $v (in .env o nell'ambiente)" >&2; exit 1; }
done

exec node a11y-scan.mjs \
  --config ./targets/govdesk/targets.govhub.json \
  --base "${A11Y_BASE_URL:-http://localhost:5200}" \
  --out ./report-govhub-completo \
  --product-version "${A11Y_PRODUCT_VERSION:-6.2.0}" \
  "$@"
