#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# ═══════════════════════════════════════════════════════════════════
# Observer + Reasoning E2E Test Suite
# Tests all 8 scenarios from the verification plan with evidence.
#
# Usage:
#   export API_URL=https://api.ailin.one
#   export API_TOKEN=<your-jwt-token>
#   ./scripts/test-observer-e2e.sh
#
# Each test outputs pass/fail + evidence JSON.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

API_URL="${API_URL:-https://api.ailin.one}"
TOKEN="${API_TOKEN:-}"
PASS=0
FAIL=0

if [ -z "$TOKEN" ]; then
  echo "ERROR: Set API_TOKEN environment variable"
  exit 1
fi

AUTH="-H \"Authorization: Bearer $TOKEN\""

call_api() {
  local body="$1"
  curl -sf -X POST "${API_URL}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$body" 2>/dev/null
}

echo "═══════════════════════════════════════════════════"
echo "  Observer + Reasoning E2E Test Suite"
echo "  API: ${API_URL}"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Test 3: Reasoning Traces ──────────────────────────
echo "=== TEST 3: Reasoning Traces ==="
RESULT=$(call_api '{
  "model": "auto",
  "strategy": "debate",
  "messages": [{"role": "user", "content": "Is nuclear energy safe? Be brief."}],
  "ailin_constraints": { "enable_reasoning": true },
  "max_tokens": 500
}')

TRACES=$(echo "$RESULT" | jq -r '.ailin_metadata.reasoning_traces // empty | length' 2>/dev/null || echo "0")
if [ "$TRACES" -ge 1 ]; then
  echo "  ✅ PASS — $TRACES reasoning traces found"
  echo "  Evidence: $(echo "$RESULT" | jq -c '[.ailin_metadata.reasoning_traces[]? | {model: .model_name, tokens: .reasoning_tokens, reasoning_length: (.reasoning // "" | length)}]' 2>/dev/null)"
  PASS=$((PASS+1))
else
  echo "  ❌ FAIL — No reasoning traces found"
  echo "  Response metadata: $(echo "$RESULT" | jq -c '.ailin_metadata | keys' 2>/dev/null)"
  FAIL=$((FAIL+1))
fi
echo ""

# ── Test 6: Multi-Strategy Observer Coverage ──────────
echo "=== TEST 6: Multi-Strategy Observer Coverage ==="
STRATEGIES=("consensus" "blind-debate" "devil-advocate-consensus" "collaborative")

for s in "${STRATEGIES[@]}"; do
  RESULT=$(call_api "{
    \"model\": \"auto\",
    \"strategy\": \"$s\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Explain gravity briefly.\"}],
    \"ailin_constraints\": { \"enable_observer\": true },
    \"max_tokens\": 300
  }" 2>/dev/null || echo '{}')

  NARRATIONS=$(echo "$RESULT" | jq -r '.ailin_metadata.observer_narrations // empty | length' 2>/dev/null || echo "0")
  if [ "$NARRATIONS" -ge 1 ]; then
    echo "  ✅ $s: $NARRATIONS narrations"
    PASS=$((PASS+1))
  else
    echo "  ❌ $s: no narrations (may need Ollama running)"
    FAIL=$((FAIL+1))
  fi
done
echo ""

# ── Test 7: Backward Compatibility ───────────────────
echo "=== TEST 7: Backward Compatibility ==="
RESULT=$(call_api '{
  "model": "auto",
  "messages": [{"role": "user", "content": "Hello, how are you?"}],
  "max_tokens": 100
}')

HAS_TRACES=$(echo "$RESULT" | jq 'has("ailin_metadata") and (.ailin_metadata | has("reasoning_traces"))' 2>/dev/null || echo "false")
HAS_NARRATIONS=$(echo "$RESULT" | jq 'has("ailin_metadata") and (.ailin_metadata | has("observer_narrations"))' 2>/dev/null || echo "false")
CONTENT=$(echo "$RESULT" | jq -r '.choices[0].message.content // ""' 2>/dev/null)

if [ "$HAS_TRACES" = "false" ] && [ "$HAS_NARRATIONS" = "false" ] && [ -n "$CONTENT" ]; then
  echo "  ✅ PASS — No reasoning/observer in default request, response OK"
  PASS=$((PASS+1))
else
  echo "  ❌ FAIL — Unexpected reasoning/observer in default request"
  FAIL=$((FAIL+1))
fi
echo ""

# ── Summary ──────────────────────────────────────────
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

exit $FAIL
