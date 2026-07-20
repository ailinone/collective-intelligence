#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# ============================================================================
# Canary Validation Script — ci/api
# Board Requirement: 48h canary single-instance with monitoring
#
# Usage: ./tests/operational/canary-validation.sh <API_URL> [DURATION_HOURS]
# Example: ./tests/operational/canary-validation.sh https://api.ailin.one 48
#
# Prerequisites:
#   - API deployed with USE_BULLMQ_CRONS=true, BANDIT_USE_REDIS=true, ARCHIVE_USE_REDIS=true
#   - Prometheus/metrics endpoint accessible
#   - curl, jq installed
# ============================================================================

set -euo pipefail

API_URL="${1:?Usage: $0 <API_URL> [DURATION_HOURS]}"
DURATION_HOURS="${2:-48}"
CHECK_INTERVAL_SECONDS=300  # 5 minutes
TOTAL_CHECKS=$(( DURATION_HOURS * 3600 / CHECK_INTERVAL_SECONDS ))

LOG_FILE="canary-results-$(date +%Y%m%d-%H%M%S).log"
PASS_COUNT=0
FAIL_COUNT=0

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }

check_health() {
  local status
  status=$(curl -sf -o /dev/null -w "%{http_code}" "${API_URL}/health/ready" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    return 0
  else
    log "FAIL: /health/ready returned $status"
    return 1
  fi
}

check_metrics() {
  local metrics
  metrics=$(curl -sf "${API_URL}/metrics" 2>/dev/null || echo "")
  if [ -z "$metrics" ]; then
    log "WARN: Cannot fetch /metrics"
    return 1
  fi

  # Extract key metrics
  local outbox_unpub dlq_size cron_exec error_rate
  outbox_unpub=$(echo "$metrics" | grep -oP 'ailin_dev_outbox_unpublished_count\s+\K[0-9.]+' || echo "N/A")
  dlq_size=$(echo "$metrics" | grep -oP 'ailin_dev_dlq_size\{[^}]*\}\s+\K[0-9.]+' | paste -sd+ | bc 2>/dev/null || echo "N/A")
  cron_exec=$(echo "$metrics" | grep -oP 'ailin_dev_cron_execution_total\{[^}]*status="completed"[^}]*\}\s+\K[0-9.]+' | paste -sd+ | bc 2>/dev/null || echo "N/A")

  log "METRICS: outbox_unpub=$outbox_unpub dlq_total=$dlq_size cron_completed=$cron_exec"

  # Alert thresholds
  if [ "$outbox_unpub" != "N/A" ] && [ "$(echo "$outbox_unpub > 100" | bc -l 2>/dev/null)" = "1" ]; then
    log "ALERT: outbox_unpublished_count=$outbox_unpub exceeds threshold (100)"
    return 1
  fi

  return 0
}

check_dlq_health() {
  local dlq_response
  dlq_response=$(curl -sf "${API_URL}/admin/queues/dlq" 2>/dev/null || echo "")
  if [ -z "$dlq_response" ]; then
    log "WARN: Cannot reach DLQ admin endpoint"
    return 0  # Non-fatal — admin may be auth-protected
  fi

  local total_dead
  total_dead=$(echo "$dlq_response" | jq -r '.totalDeadLetters // 0' 2>/dev/null || echo "0")
  log "DLQ: totalDeadLetters=$total_dead"

  if [ "$total_dead" -gt 50 ]; then
    log "ALERT: DLQ total=$total_dead exceeds threshold (50)"
    return 1
  fi
  return 0
}

# ── Main Loop ──
log "=== Canary Validation Started ==="
log "API: $API_URL"
log "Duration: ${DURATION_HOURS}h (${TOTAL_CHECKS} checks every ${CHECK_INTERVAL_SECONDS}s)"
log "Log file: $LOG_FILE"

for (( i=1; i<=TOTAL_CHECKS; i++ )); do
  log "--- Check $i/$TOTAL_CHECKS ---"

  if check_health && check_metrics && check_dlq_health; then
    PASS_COUNT=$((PASS_COUNT + 1))
    log "CHECK PASSED ($PASS_COUNT pass, $FAIL_COUNT fail)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log "CHECK FAILED ($PASS_COUNT pass, $FAIL_COUNT fail)"
  fi

  if [ $i -lt $TOTAL_CHECKS ]; then
    sleep $CHECK_INTERVAL_SECONDS
  fi
done

# ── Summary ──
log "=== Canary Validation Complete ==="
log "Total checks: $TOTAL_CHECKS"
log "Passed: $PASS_COUNT"
log "Failed: $FAIL_COUNT"

PASS_RATE=$(echo "scale=1; $PASS_COUNT * 100 / $TOTAL_CHECKS" | bc)
log "Pass rate: ${PASS_RATE}%"

if [ "$FAIL_COUNT" -eq 0 ]; then
  log "VERDICT: CANARY APPROVED — 100% pass rate over ${DURATION_HOURS}h"
  exit 0
elif [ "$(echo "$PASS_RATE >= 99.0" | bc -l)" = "1" ]; then
  log "VERDICT: CANARY APPROVED WITH NOTES — ${PASS_RATE}% pass rate (${FAIL_COUNT} transient failures)"
  exit 0
else
  log "VERDICT: CANARY FAILED — ${PASS_RATE}% pass rate below 99% threshold"
  exit 1
fi
