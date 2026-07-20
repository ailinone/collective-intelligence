#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Sequential probe of ALL providers in PROVIDER_CATALOG.
# Reads (provider, representative model) tuples from the live DB and
# runs one chat completion per provider with inter-probe gap.
# Categorizes results into:
#   PASS    — orchestrator returned non-empty content with cost > 0
#   PARTIAL — non-empty content but cost = 0 (cross-provider fallback gave reply)
#   QUOTA   — provider returned 402/quota
#   AUTH    — our admin auth failed (Prisma pool starvation) — retried once
#   AUTH_F  — provider auth_failed (no env var) — skipped near-zero
#   ERROR   — other failure
set -u

KEY="${ADMIN_API_KEY:-$(cat "$(dirname "$0")/../.session_admin_key")}"
BASE="http://localhost:3002"
GAP_SECONDS="${GAP_SECONDS:-12}"   # longer gap to let pool recover
TIMEOUT="${TIMEOUT:-30}"
OUT="/tmp/probe-71-results.tsv"
echo -e "provider\tmodel\thttp\tdur\tstatus\tcost\terror" > "$OUT"

mapfile -t ROWS < <(docker exec "${DB_CONTAINER:-postgres}" psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" -t -A -F'|' -c "
SELECT DISTINCT ON (provider_id) provider_id, id
FROM models WHERE status='active'
ORDER BY provider_id, usage_count DESC NULLS LAST, id ASC;
" 2>/dev/null)

TOTAL=${#ROWS[@]}
echo "Probing $TOTAL providers (gap=${GAP_SECONDS}s, timeout=${TIMEOUT}s)..."
echo

PASS=0; PARTIAL=0; AUTH=0; AUTH_F=0; QUOTA=0; ERROR=0; idx=0

probe_once() {
  local prov="$1" model="$2"
  curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    --max-time "$TIMEOUT" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"strategy\":\"single\",\"max_tokens\":3}" \
    -w "HTTP=%{http_code}" \
    "$BASE/v1/chat/completions" 2>&1
}

for row in "${ROWS[@]}"; do
  idx=$((idx+1))
  prov=$(echo "$row" | cut -d'|' -f1)
  model=$(echo "$row" | cut -d'|' -f2)

  start=$(date +%s)
  resp=$(probe_once "$prov" "$model")
  end=$(date +%s)
  dur=$((end-start))

  http=$(echo "$resp" | grep -oE 'HTTP=[0-9]+' | tail -1 | cut -d= -f2)
  content_len=$(echo "$resp" | grep -oE '"content":"[^"]*"' | head -1 | wc -c | tr -d ' ')
  cost=$(echo "$resp" | grep -oE '"cost_usd":[0-9.e+-]*' | head -1 | cut -d: -f2)
  err_msg=$(echo "$resp" | grep -oE '"message":"[^"]*"' | head -1 | cut -c1-80 | tr -d '\n')

  # If we hit our own auth pool starvation, wait + retry once
  if [ "$http" = "401" ] && echo "$resp" | grep -q "Invalid or expired"; then
    sleep 30
    resp=$(probe_once "$prov" "$model")
    http=$(echo "$resp" | grep -oE 'HTTP=[0-9]+' | tail -1 | cut -d= -f2)
    content_len=$(echo "$resp" | grep -oE '"content":"[^"]*"' | head -1 | wc -c | tr -d ' ')
    cost=$(echo "$resp" | grep -oE '"cost_usd":[0-9.e+-]*' | head -1 | cut -d: -f2)
    err_msg=$(echo "$resp" | grep -oE '"message":"[^"]*"' | head -1 | cut -c1-80 | tr -d '\n')
    end=$(date +%s)
    dur=$((end-start))
  fi

  status="ERROR"
  if [ "$http" = "200" ] && [ "$content_len" -gt 25 ]; then
    cost_num=$(echo "${cost:-0}" | awk '{print ($1 > 0) ? 1 : 0}')
    if [ "$cost_num" = "1" ]; then
      status="PASS"; PASS=$((PASS+1))
    else
      status="PARTIAL"; PARTIAL=$((PARTIAL+1))
    fi
  elif [ "$http" = "200" ]; then
    status="EMPTY"; ERROR=$((ERROR+1))
  elif [ "$http" = "401" ]; then
    if echo "$resp" | grep -q "Invalid or expired API key"; then
      status="AUTH"; AUTH=$((AUTH+1))
    else
      status="AUTH_F"; AUTH_F=$((AUTH_F+1))
    fi
  elif [ "$http" = "402" ] || echo "$err_msg" | grep -qiE "quota|insufficient|credit"; then
    status="QUOTA"; QUOTA=$((QUOTA+1))
  else
    ERROR=$((ERROR+1))
  fi

  printf "[%2d/%d] %-20s %-8s http=%-4s dur=%2ss cost=%-10s\n" \
    "$idx" "$TOTAL" "$prov" "$status" "$http" "$dur" "${cost:-0}"

  echo -e "${prov}\t${model}\t${http}\t${dur}\t${status}\t${cost:-0}\t${err_msg:-}" >> "$OUT"

  sleep "$GAP_SECONDS"
done

echo
echo "=== SUMMARY ==="
echo "Total:    $TOTAL"
echo "PASS:     $PASS  (real cost > 0)"
echo "PARTIAL:  $PARTIAL  (response via fallback, cost=0)"
echo "QUOTA:    $QUOTA  (provider quota/402)"
echo "AUTH:     $AUTH  (our pool starvation, retry-able)"
echo "AUTH_F:   $AUTH_F  (provider 401, no env)"
echo "ERROR:    $ERROR"
echo
echo "Full TSV: $OUT"
