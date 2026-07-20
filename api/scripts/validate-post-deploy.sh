#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Post-deploy validation script
# Runs smoke checks against a deployed CI API endpoint.
# Usage: ./scripts/validate-post-deploy.sh <API_URL>

set -euo pipefail

API_URL="${1:-http://localhost:3000}"

if [[ -z "$API_URL" ]]; then
  echo "Error: API URL is required."
  echo "Usage: ./scripts/validate-post-deploy.sh <API_URL>"
  echo "Example: ./scripts/validate-post-deploy.sh https://api.ailin.one"
  exit 1
fi

echo "Post-deploy validation"
echo "API URL: $API_URL"
echo

check_endpoint() {
  local method="$1"
  local path="$2"
  local expected_codes="$3"
  local payload="${4:-}"
  local url="${API_URL}${path}"
  local body_file
  local code

  body_file="$(mktemp)"

  if [[ -n "$payload" ]]; then
    code="$(curl -sS -o "$body_file" -w "%{http_code}" --connect-timeout 5 --max-time 20 -X "$method" "$url" -H "content-type: application/json" --data "$payload" || true)"
  else
    code="$(curl -sS -o "$body_file" -w "%{http_code}" --connect-timeout 5 --max-time 20 -X "$method" "$url" || true)"
  fi

  if [[ " $expected_codes " != *" $code "* ]]; then
    echo "FAIL: ${method} ${path} returned HTTP ${code} (expected one of: ${expected_codes})"
    head -c 600 "$body_file" || true
    rm -f "$body_file"
    return 1
  fi

  echo "OK: ${method} ${path} -> ${code}"
  rm -f "$body_file"
}

echo "1) Base health checks"
check_endpoint GET /health "200"

# /ready is used by current gateway profile; keep as warning-only.
if ! check_endpoint GET /ready "200"; then
  echo "WARN: /ready is not available in this environment."
fi

echo
echo "2) Public contract smoke"
check_endpoint GET /v1/models/list "200"
check_endpoint GET /v1/models "200 401"
check_endpoint GET /v1/provider-capabilities "200 401"
check_endpoint POST /v1/chat/completions "200 202 400 401 403 422 429" '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
check_endpoint POST /v1/responses "200 202 400 401 403 422 429" '{"model":"auto","input":"ping"}'
check_endpoint POST /v1/embeddings "200 400 401 403 422 429" '{"model":"text-embedding-3-small","input":"ping"}'
check_endpoint GET /.well-known/jwks.json "200 503"

echo
echo "Post-deploy validation completed successfully."
