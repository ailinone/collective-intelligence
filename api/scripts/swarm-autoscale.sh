#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Docker Swarm horizontal autoscaler for the CI API stack.
# -----------------------------------------------------------------------------
# Scale-to-100k Phase 3 (issue #148): "horizontal autoscaling across multiple
# nodes... HPA keyed on CPU + event-loop lag + in-flight concurrency"
# (docs/audit/16-scale-to-100k-execution-plan.md). Docker Swarm has NO
# built-in autoscaler (unlike Kubernetes' HPA) — this script IS the external
# autoscaler the plan doc calls for, driving `docker service scale` off the
# same signals already exposed by this repo's existing Prometheus alert rules
# (api/monitoring/prometheus-alerts.yaml, api/grafana/ci-alert-rules.yml):
# queue backlog and p95/p99 request latency.
#
# WHAT THIS DOES NOT DO: it does not add nodes to the Swarm cluster. Scaling
# a service's replica count only helps if there is spare CPU/scheduling
# capacity across the cluster's EXISTING nodes — joining additional physical
# or cloud VM nodes to the Swarm (`docker swarm join` on each new host) is an
# infrastructure-provisioning step outside what any script run FROM inside
# this repo can do; it requires an operator with access to provision hosts
# and join them to the cluster. Run this script only once the cluster has
# more than one node with spare capacity, or scaling `api`/`worker` replicas
# will just pack more tasks onto the same single node with no real headroom
# gained (the exact single-node-Swarm limitation this phase exists to fix).
#
# ---- Usage -------------------------------------------------------------
#   ./swarm-autoscale.sh                 # one-shot check + (dry-run) scale decision
#   DRY_RUN=false ./swarm-autoscale.sh    # actually execute `docker service scale`
#
# Run on a Swarm manager node (or with DOCKER_HOST pointed at one) — only a
# manager can execute `docker service scale`. Intended to be invoked
# periodically (cron, e.g. every 1-2 minutes) or from an Alertmanager webhook
# receiver reacting to AilinQueueBacklog / AilinHighLatency / HighCPUUsage.
#
# ---- Environment ---------------------------------------------------------
# Prometheus (for the queue-depth/latency/CPU signals):
#   PROMETHEUS_URL          Prometheus base URL           (default: http://prometheus:9090)
#
# Swarm target:
#   STACK_NAME              Compose stack name            (default: ci — matches
#                              docker/docker-compose.production.yml's header comment)
#   SERVICE                 Service to scale               (default: worker — the
#                              CPU/IO-bound job processor; set to "api" for the
#                              HTTP-serving replicas instead)
#
# Scale decision thresholds (mirrors the existing Prometheus alert rules —
# see api/monitoring/prometheus-alerts.yaml's AilinQueueBacklog/HighLatency):
#   SCALE_UP_QUEUE_SIZE     Queue depth to trigger scale-up      (default: 2000)
#   SCALE_DOWN_QUEUE_SIZE   Queue depth to trigger scale-down    (default: 100)
#   SCALE_UP_P95_MS         p95 latency (ms) to trigger scale-up (default: 1500)
#   MIN_REPLICAS            Never scale below this                (default: 1)
#   MAX_REPLICAS            Never scale above this                (default: 10)
#   SCALE_STEP              Replicas to add/remove per decision    (default: 1)
#   COOLDOWN_SECONDS        Minimum time between scale actions     (default: 300)
#   COOLDOWN_FILE           Where the last-scale timestamp is kept
#                              (default: /tmp/swarm-autoscale-<STACK_NAME>-<SERVICE>.cooldown)
#
# Safety:
#   DRY_RUN                 "true" (default) logs the decision without
#                              executing `docker service scale`. Set to
#                              "false" to actually scale.
#
# Exit status: 0 on a successful check (scaled, skipped, or dry-run logged);
# non-zero only on a genuine failure to reach Prometheus or run docker.
# -----------------------------------------------------------------------------

set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus:9090}"
STACK_NAME="${STACK_NAME:-ci}"
SERVICE="${SERVICE:-worker}"

SCALE_UP_QUEUE_SIZE="${SCALE_UP_QUEUE_SIZE:-2000}"
SCALE_DOWN_QUEUE_SIZE="${SCALE_DOWN_QUEUE_SIZE:-100}"
SCALE_UP_P95_MS="${SCALE_UP_P95_MS:-1500}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-10}"
SCALE_STEP="${SCALE_STEP:-1}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-300}"
COOLDOWN_FILE="${COOLDOWN_FILE:-/tmp/swarm-autoscale-${STACK_NAME}-${SERVICE}.cooldown}"
DRY_RUN="${DRY_RUN:-true}"

SWARM_SERVICE="${STACK_NAME}_${SERVICE}"

log() { echo "[swarm-autoscale] $*"; }

# Float-safe "$1 >= $2" / "$1 <= $2" — Prometheus scalars can be non-integer
# (e.g. "1500.5"), so plain bash arithmetic isn't safe here.
num_gte() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
num_lte() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'; }

query_prometheus_scalar() {
  # $1 = PromQL query. Prints the scalar result value, or empty on no data.
  local query="$1"
  local response
  response="$(curl -sS --max-time 10 -G "${PROMETHEUS_URL}/api/v1/query" --data-urlencode "query=${query}")" || {
    log "ERROR: failed to query Prometheus at ${PROMETHEUS_URL}"
    return 1
  }
  echo "$response" | node -e '
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const result = parsed?.data?.result?.[0]?.value?.[1];
        if (result !== undefined) process.stdout.write(String(result));
      } catch {
        // no output on parse failure — treated as "no data" by the caller
      }
    });
  '
}

current_replicas() {
  docker service inspect "$SWARM_SERVICE" --format '{{.Spec.Mode.Replicated.Replicas}}'
}

seconds_since_last_scale() {
  if [ ! -f "$COOLDOWN_FILE" ]; then
    echo 999999
    return
  fi
  local last
  last="$(cat "$COOLDOWN_FILE")"
  echo $(( $(date +%s) - last ))
}

main() {
  if ! docker service inspect "$SWARM_SERVICE" >/dev/null 2>&1; then
    log "ERROR: Swarm service '${SWARM_SERVICE}' not found. Is this running on a manager node with the '${STACK_NAME}' stack deployed?"
    exit 1
  fi

  local replicas queue_size p95_ms cooldown_elapsed
  replicas="$(current_replicas)"
  queue_size="$(query_prometheus_scalar 'ailin_dev_queue_size{queue_name="chat-requests"}' || echo '')"
  p95_ms="$(query_prometheus_scalar 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) * 1000' || echo '')"
  cooldown_elapsed="$(seconds_since_last_scale)"

  log "service=${SWARM_SERVICE} replicas=${replicas} queue_size=${queue_size:-unknown} p95_ms=${p95_ms:-unknown} cooldown_elapsed=${cooldown_elapsed}s"

  if [ "$cooldown_elapsed" -lt "$COOLDOWN_SECONDS" ]; then
    log "Within cooldown window (${COOLDOWN_SECONDS}s) — no action."
    exit 0
  fi

  local target="$replicas"
  local reason=""

  if [ -n "$queue_size" ] && num_gte "$queue_size" "$SCALE_UP_QUEUE_SIZE"; then
    target=$(( replicas + SCALE_STEP ))
    reason="queue_size ${queue_size} >= ${SCALE_UP_QUEUE_SIZE}"
  elif [ -n "$p95_ms" ] && num_gte "$p95_ms" "$SCALE_UP_P95_MS"; then
    target=$(( replicas + SCALE_STEP ))
    reason="p95_ms ${p95_ms} >= ${SCALE_UP_P95_MS}"
  elif [ -n "$queue_size" ] && num_lte "$queue_size" "$SCALE_DOWN_QUEUE_SIZE" && [ "$replicas" -gt "$MIN_REPLICAS" ]; then
    target=$(( replicas - SCALE_STEP ))
    reason="queue_size ${queue_size} <= ${SCALE_DOWN_QUEUE_SIZE}"
  fi

  if [ "$target" -gt "$MAX_REPLICAS" ]; then target="$MAX_REPLICAS"; fi
  if [ "$target" -lt "$MIN_REPLICAS" ]; then target="$MIN_REPLICAS"; fi

  if [ "$target" = "$replicas" ]; then
    log "No scale action needed."
    exit 0
  fi

  log "Decision: scale ${SWARM_SERVICE} ${replicas} -> ${target} (${reason})"

  if [ "$DRY_RUN" = "true" ]; then
    log "DRY_RUN=true — not executing. Set DRY_RUN=false to actually scale."
    exit 0
  fi

  docker service scale "${SWARM_SERVICE}=${target}"
  date +%s > "$COOLDOWN_FILE"
  log "Scaled ${SWARM_SERVICE} to ${target} replicas."
}

main "$@"
