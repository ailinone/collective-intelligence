#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# HCRA local activation + verification.
#
# Runs the full Caminho-C activation chain, with stop-on-first-failure semantics
# and a clear delta report between pre-state and post-state.
#
# Prerequisites:
#   - Container `ci-api` rebuilt + recreated with the new image
#   - DATABASE_URL pointing at host port 5434 (NOT 5432)
#   - HCRA_EMBEDDER_URL pointing at host port 8085
#
# Usage:
#   cd api
#   ./scripts/hcra-activate-and-verify.sh
#
# Exit codes:
#   0 — full success
#   1 — pre-flight DB unreachable
#   2 — reseed-ontology failed
#   3 — embeddings failed
#   4 — bootstrap failed
#   5 — materialise failed
#   6 — verification failed
set -euo pipefail

PG_DOCKER="docker exec ${DB_CONTAINER:-ci-postgres} psql -U ${DB_USER:-ci_user} -d ${DB_NAME:-ci_db} -tAc"
HOST_DB="${DATABASE_URL:-postgresql://ci_user:ci_password@localhost:5434/ci_db}"
EMBEDDER="http://localhost:8085"
EMBEDDER_MODEL="BAAI/bge-small-en-v1.5"

echo "=== HCRA ACTIVATION & VERIFICATION ==="
echo "[0/6] pre-flight..."
if ! $PG_DOCKER "SELECT 1;" >/dev/null 2>&1; then
  echo "  FAIL: ci-postgres unreachable" >&2
  exit 1
fi

# Capture pre-state
PRE_ONTOLOGY=$($PG_DOCKER "SELECT COUNT(*) FROM capability_ontology;" | tr -d ' ')
PRE_EMBEDDINGS=$($PG_DOCKER "SELECT COUNT(*) FROM capability_ontology WHERE embedding IS NOT NULL;" | tr -d ' ')
PRE_ASSERTIONS=$($PG_DOCKER "SELECT COUNT(*) FROM model_capability_assertions WHERE superseded_at IS NULL;" | tr -d ' ')
PRE_MODELS_HCRA=$($PG_DOCKER "SELECT COUNT(*) FROM models WHERE capability_uris IS NOT NULL AND array_length(capability_uris, 1) > 0;" | tr -d ' ')
echo "  pre-state: ontology=$PRE_ONTOLOGY embeddings=$PRE_EMBEDDINGS assertions=$PRE_ASSERTIONS models_with_hcra=$PRE_MODELS_HCRA"

echo
echo "[1/6] reseed ontology (push new slugs)..."
DATABASE_URL="$HOST_DB" pnpm tsx scripts/hcra-reseed-ontology.ts || { echo "FAIL: reseed"; exit 2; }

POST_ONTOLOGY=$($PG_DOCKER "SELECT COUNT(*) FROM capability_ontology;" | tr -d ' ')
echo "  delta: ontology $PRE_ONTOLOGY -> $POST_ONTOLOGY (expected +6 to reach 66)"

echo
echo "[2/6] run embeddings (incremental for new ontology rows)..."
DATABASE_URL="$HOST_DB" HCRA_EMBEDDER_URL="$EMBEDDER" HCRA_EMBEDDER_MODEL="$EMBEDDER_MODEL" \
  pnpm tsx scripts/hcra-run-embeddings.ts --skip-models || { echo "FAIL: embeddings"; exit 3; }

POST_EMBEDDINGS=$($PG_DOCKER "SELECT COUNT(*) FROM capability_ontology WHERE embedding IS NOT NULL;" | tr -d ' ')
echo "  delta: embeddings $PRE_EMBEDDINGS -> $POST_EMBEDDINGS"

echo
echo "[3/6] bootstrap assertions from legacy capabilities (writes to model_capability_assertions)..."
DATABASE_URL="$HOST_DB" pnpm tsx scripts/hcra-sprint1-bootstrap.ts || { echo "FAIL: bootstrap"; exit 4; }

POST_ASSERTIONS=$($PG_DOCKER "SELECT COUNT(*) FROM model_capability_assertions WHERE superseded_at IS NULL;" | tr -d ' ')
POST_MODELS_HCRA_AFTER_BOOTSTRAP=$($PG_DOCKER "SELECT COUNT(*) FROM models WHERE capability_uris IS NOT NULL AND array_length(capability_uris, 1) > 0;" | tr -d ' ')
echo "  delta: assertions $PRE_ASSERTIONS -> $POST_ASSERTIONS, models_with_hcra $PRE_MODELS_HCRA -> $POST_MODELS_HCRA_AFTER_BOOTSTRAP"

echo
echo "[4/6] materialise (re-fuse with Bayesian noisy-OR)..."
DATABASE_URL="$HOST_DB" pnpm tsx scripts/hcra-materialise.ts || { echo "FAIL: materialise"; exit 5; }

POST_MODELS_HCRA_FINAL=$($PG_DOCKER "SELECT COUNT(*) FROM models WHERE capability_uris IS NOT NULL AND array_length(capability_uris, 1) > 0;" | tr -d ' ')
echo "  delta: models_with_hcra after materialise = $POST_MODELS_HCRA_FINAL"

echo
echo "[5/6] verification — capability_ontology coverage..."
$PG_DOCKER "SELECT category, COUNT(*) FROM capability_ontology GROUP BY category ORDER BY category;"
echo
echo "  per-source assertion breakdown:"
$PG_DOCKER "SELECT source, COUNT(*) FROM model_capability_assertions WHERE superseded_at IS NULL GROUP BY source ORDER BY 2 DESC;"

echo
echo "[6/6] verification — ontology search via Caminho-C singleton..."
KEY=$(cat .bootstrap-key.tmp 2>/dev/null || echo "MISSING_KEY")
if [ "$KEY" = "MISSING_KEY" ]; then
  echo "  WARN: no .bootstrap-key.tmp; skipping HTTP verification"
else
  for term in "vision" "reranking" "safety" "long_context"; do
    HTTP=$(curl -sS -o /tmp/cap-search.json -w "%{http_code}" \
      -H "x-api-key: $KEY" \
      "http://localhost:3002/v1/capabilities/ontology/search?q=$term&limit=3")
    COUNT=$(node -e "console.log((JSON.parse(require('fs').readFileSync('/tmp/cap-search.json'))).count || 'err')" 2>/dev/null || echo "json-err")
    echo "  q=$term  HTTP=$HTTP count=$COUNT"
  done
fi

echo
echo "=== DONE ==="
echo "FINAL pre/post state:"
echo "  ontology       : $PRE_ONTOLOGY -> $POST_ONTOLOGY"
echo "  embeddings     : $PRE_EMBEDDINGS -> $POST_EMBEDDINGS"
echo "  assertions     : $PRE_ASSERTIONS -> $POST_ASSERTIONS"
echo "  models_with_hcra: $PRE_MODELS_HCRA -> $POST_MODELS_HCRA_FINAL"
