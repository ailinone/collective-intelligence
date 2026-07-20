#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Live validation of the Phase 1-5 operability runtime.
# Hits the actual /v1/admin/operability/* endpoints + measures real timings.

set -u
KEY="${OPERABILITY_ADMIN_KEY:-$(cat "$(dirname "$0")/../.session_admin_key" 2>/dev/null)}"
URL="${API_URL:-http://localhost:3002}"

if [ -z "$KEY" ]; then
  echo "ERROR: no admin key — set OPERABILITY_ADMIN_KEY env or write to .session_admin_key"
  exit 1
fi

echo "=== Operability Live Validation ==="
echo "API URL: $URL"
echo "Key prefix: ${KEY:0:16}..."
echo ""

# ─── Helper ─────────────────────────────────────────────────────────────
fetch() {
  local path="$1"
  local method="${2:-GET}"
  curl -s -X "$method" -H "Authorization: Bearer $KEY" --max-time 30 "$URL$path"
}

# ─── 1. Boot logs ────────────────────────────────────────────────────────
echo "[1] Boot log markers"
docker logs ci-api 2>&1 | grep -E "(Provider health sync bus active|Operability discovery scheduler active|DiscoveryScheduler started|Operability admin routes registered)" | head -6
echo ""

# ─── 2. Discovery snapshot ───────────────────────────────────────────────
echo "[2] /v1/admin/operability/discovery"
DISCOVERY=$(fetch /v1/admin/operability/discovery)
echo "$DISCOVERY" | python -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception as e:
  print(f'  ERROR parsing response: {e}')
  print(f'  Raw: {sys.stdin.read()[:200]}')
  sys.exit(0)
print(f'  isRunning:        {d.get(\"isRunning\")}')
print(f'  generatedAt:      {d.get(\"generatedAt\")}')
print(f'  durationMs:       {d.get(\"durationMs\")}')
print(f'  totalConfigured:  {d.get(\"totalConfigured\")}')
print(f'  totalAvailable:   {d.get(\"totalAvailable\")}')
print(f'  totalUnavailable: {d.get(\"totalUnavailable\")}')
results = d.get('results', [])
if results:
  by_conf = {}
  by_state = {}
  for r in results:
    by_conf[r.get('discoveryConfidence','?')] = by_conf.get(r.get('discoveryConfidence','?'), 0) + 1
    by_state[r.get('healthState','?')] = by_state.get(r.get('healthState','?'), 0) + 1
  print(f'  byConfidence:     {by_conf}')
  print(f'  byHealthState:    {by_state}')
"
echo ""

# ─── 3. Pool ─────────────────────────────────────────────────────────────
echo "[3] /v1/admin/operability/pool"
POOL=$(fetch '/v1/admin/operability/pool?sample=5')
echo "$POOL" | python -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception as e:
  print(f'  ERROR: {e}')
  sys.exit(0)
print(f'  builtAtMs:    {d.get(\"builtAtMs\")}')
print(f'  size:         {d.get(\"size\")}')
print(f'  byTier:       {d.get(\"byTier\")}')
bp = d.get('byProvider', {})
print(f'  byProvider:   {len(bp)} distinct providers')
top5 = sorted(bp.items(), key=lambda x: x[1], reverse=True)[:5]
for p, c in top5:
  print(f'    {p}: {c}')
"
echo ""

# ─── 4. Health registry ──────────────────────────────────────────────────
echo "[4] /v1/admin/operability/health"
HEALTH=$(fetch /v1/admin/operability/health)
echo "$HEALTH" | python -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)
print(f'  totalRecords: {d.get(\"totalRecords\")}')
records = d.get('records', [])
by_state = {}
for r in records:
  by_state[r.get('state','?')] = by_state.get(r.get('state','?'), 0) + 1
print(f'  byState:      {by_state}')
"
echo ""

# ─── 5. Semantic index ───────────────────────────────────────────────────
echo "[5] /v1/admin/operability/semantic-index"
fetch /v1/admin/operability/semantic-index | python -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)
print(f'  indexSize:               {d.get(\"indexSize\")}')
print(f'  lastEntryCount:          {d.get(\"lastEntryCount\")}')
print(f'  lastRunAt:               {d.get(\"lastRunAt\")}')
print(f'  teiHealthy:              {d.get(\"teiHealthy\")}')
print(f'  teiUrl:                  {d.get(\"teiUrl\")}')
print(f'  semanticRetryEnabled:    {d.get(\"semanticRetryEnabled\")}')
"
echo ""

# ─── 6. Recent traces ────────────────────────────────────────────────────
echo "[6] /v1/admin/operability/traces (sample stages)"
fetch '/v1/admin/operability/traces?limit=200' | python -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)
print(f'  count: {d.get(\"count\")}')
traces = d.get('traces', [])
by_stage = {}
by_included = {'true':0, 'false':0}
by_reason = {}
for t in traces:
  s = t.get('stage','?')
  by_stage[s] = by_stage.get(s, 0) + 1
  i = 'true' if t.get('included') else 'false'
  by_included[i] = by_included.get(i, 0) + 1
  r = t.get('reason','none')
  by_reason[r] = by_reason.get(r, 0) + 1
print(f'  byStage:    {by_stage}')
print(f'  byIncluded: {by_included}')
top_reasons = sorted(by_reason.items(), key=lambda x: x[1], reverse=True)[:5]
print(f'  top reasons:')
for r, c in top_reasons:
  print(f'    {r}: {c}')
"
echo ""
echo "=== Live Validation Done ==="
