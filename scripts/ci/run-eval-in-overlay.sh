#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# shellcheck shell=bash
#
# run-eval-in-overlay.sh: run one api/tests/evals/*.mjs benchmark from INSIDE the
# Swarm ci_default overlay, against the ci_api VIP (http://api:3000).
#
# WHY: the post-deploy eval jobs used to run on the runner host and call
# https://api.ailin.one. Cloudflare's Bot Fight Mode answers automated clients
# with an HTML challenge there, so every case ended in an infra error (and the
# jobs stayed red for weeks behind continue-on-error). Nothing about that path
# can be fixed from the repo, and an allow-list rule in Cloudflare would weaken
# the protection of the public API for everyone. From inside the overlay the
# benchmark talks to the API the way the gateway does, with no edge in between.
#
# HOW: scripts/ci/swarm-overlay.sh (ci_api_node) starts a throwaway container of
# the ci-api image on the Swarm manager, read-only, no capabilities, resource
# limited, log driver none. The benchmark source and the bearer token travel on
# stdin (never argv, env or the container config); scripts/ci/eval-overlay-runner.cjs
# unpacks them, runs the benchmark and prints back whatever it wrote to
# eval-results/, which this script restores under --out for upload-artifact.
#
# USAGE
#   scripts/ci/run-eval-in-overlay.sh [--timeout S] [--memory M] [--out DIR] \
#       SCRIPT.mjs [-- --flag[=value]...]
#   scripts/ci/run-eval-in-overlay.sh --sweep      # remove leftovers of this run
#
# ENVIRONMENT
#   EVAL_BEARER_TOKEN       required (secret): bearer token the benchmark sends
#   CI_API_BASE_URL         default http://api:3000
#   CI_SWARM_SSH_TARGET     user@host of the Swarm manager; or DEPLOY_USER +
#                           DEPLOY_HOST (the names the deploy job already uses)
#   CI_SWARM_SSH_KEY        ssh identity file; or SSH_PRIVATE_KEY / SSH_PRIVATE_KEY_B64,
#                           written to a 0600 temp file that is removed on exit
#   CI_API_NODE_IMAGE       image of the throwaway container (default: the image
#                           of the live ci_api service, which must be on the manager)
#   EVAL_SOFT_TIMEOUT_S     seconds after which the benchmark stops itself with exit
#                           124 and still returns its results (default: --timeout
#                           minus 20, so the hard kill never gets to lose them)
#
# Exit code: the benchmark's own (1 = it reported a regression), 124 on timeout,
# 2 on usage errors, 3 when the API never answered /health.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/swarm-overlay.sh
. "$here/swarm-overlay.sh"

timeout_s=900
memory=512m
out_dir=api/eval-results
sweep=0

die() { echo "::error::run-eval-in-overlay: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) timeout_s="${2:-}"; shift 2 ;;
    --memory) memory="${2:-}"; shift 2 ;;
    --out) out_dir="${2:-}"; shift 2 ;;
    --sweep) sweep=1; shift ;;
    --) break ;;
    -*) die "unknown option '$1'" ;;
    *) break ;;
  esac
done

[[ "$timeout_s" =~ ^[0-9]+$ ]] && [ "$timeout_s" -ge 30 ] && [ "$timeout_s" -le 7200 ] || die "--timeout must be 30..7200 seconds"
[[ "$memory" =~ ^[0-9]+[mMgG]$ ]] || die "--memory must look like 512m"

# --- Manager access ----------------------------------------------------------
if [ -z "${CI_SWARM_SSH_TARGET:-}" ] && [ -n "${DEPLOY_USER:-}" ] && [ -n "${DEPLOY_HOST:-}" ]; then
  export CI_SWARM_SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"
fi
key_file=""
cleanup() {
  [ -z "$key_file" ] || rm -f "$key_file"
  [ -z "${res_file:-}" ] || rm -f "$res_file"
}
trap cleanup EXIT
if [ -n "${CI_SWARM_SSH_TARGET:-}" ] && [ -z "${CI_SWARM_SSH_KEY:-}" ] &&
  { [ -n "${SSH_PRIVATE_KEY:-}" ] || [ -n "${SSH_PRIVATE_KEY_B64:-}" ]; }; then
  key_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/swarm-manager-key.XXXXXX")"
  if [ -n "${SSH_PRIVATE_KEY:-}" ]; then
    printf '%s\n' "$SSH_PRIVATE_KEY" | tr -d '\r' > "$key_file"
  else
    printf '%s' "$SSH_PRIVATE_KEY_B64" | tr -d '\r\n' | base64 --decode > "$key_file"
  fi
  chmod 600 "$key_file"
  export CI_SWARM_SSH_KEY="$key_file"
fi

if [ "$sweep" = 1 ]; then
  ci_oneshot_sweep --this-run
  exit 0
fi

# --- Arguments ---------------------------------------------------------------
[ $# -ge 1 ] || die "usage: run-eval-in-overlay.sh [options] SCRIPT.mjs [-- --flag...]"
script="$1"
shift
if [ "${1:-}" = "--" ]; then shift; fi
[ -r "$script" ] || die "cannot read '$script'"
script_name="$(basename "$script")"
[[ "$script_name" =~ ^[A-Za-z0-9._-]+\.mjs$ ]] || die "'$script_name' is not a plain <name>.mjs file"
eval_args=""
for a in "$@"; do
  # Flags only, no spaces: they are joined with spaces and split again in the container.
  [[ "$a" =~ ^--[a-z0-9-]+(=[A-Za-z0-9._-]+)?$ ]] || die "argument '$a' is not --flag or --flag=value"
  eval_args+="${eval_args:+ }$a"
done
base_url="${CI_API_BASE_URL:-http://api:3000}"
[[ "$base_url" =~ ^https?://[A-Za-z0-9._:-]+$ ]] || die "CI_API_BASE_URL '$base_url' is not a plain http(s) origin"
ci_require_secret_env EVAL_BEARER_TOKEN "Create the EVAL_BEARER_TOKEN repo secret (the api key the benchmarks authenticate with)."

# --- Preflight ---------------------------------------------------------------
ci_swarm_preflight
CI_API_NODE_IMAGE="$(ci_api_node_image)"
export CI_API_NODE_IMAGE
echo "Eval container image: $CI_API_NODE_IMAGE"
health="$(ci_api_http GET /health --timeout 20)" || true
case "$health" in
  000 | 5??)
    echo "::error::run-eval-in-overlay: $base_url/health answered '$health' from the overlay; the API is not healthy, not running $script_name." >&2
    exit 3
    ;;
  *) echo "ci_api reachable from the overlay ($base_url/health -> HTTP $health)" ;;
esac

# --- Run ---------------------------------------------------------------------
runner_js="$(cat "$here/eval-overlay-runner.cjs")"
res_file="$(mktemp)"
rc=0
{
  printf '%s\n' "$EVAL_BEARER_TOKEN"
  gzip -9c "$script" | base64 -w0
  printf '\n'
} |
  ci_api_node --timeout "$timeout_s" --memory "$memory" \
    --env "EVAL_API_BASE_URL=$base_url" \
    --env "EVAL_SCRIPT_NAME=$script_name" \
    --env "EVAL_ARGS=$eval_args" \
    --env "EVAL_SOFT_TIMEOUT_S=${EVAL_SOFT_TIMEOUT_S:-$((timeout_s - 20))}" \
    -- "$runner_js" |
  awk -v res="$res_file" '/^@@EVAL_RESULTS@@/ { print > res; next } { print; fflush() }' || rc=$?

# --- Restore eval-results/ ---------------------------------------------------
mkdir -p "$out_dir"
restored=0
while IFS= read -r line; do
  rest="${line#@@EVAL_RESULTS@@}"
  fname="${rest%%@@*}"
  b64="${rest#*@@}"
  # Same allow-list as the container side: a plain file name, never a path.
  if ! [[ "$fname" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$fname" = "." ] || [ "$fname" = ".." ]; then
    echo "::warning::run-eval-in-overlay: ignoring a result with an unsafe name" >&2
    continue
  fi
  if printf '%s' "$b64" | base64 -d > "$out_dir/$fname" 2> /dev/null; then
    restored=$((restored + 1))
  else
    rm -f "$out_dir/$fname"
    echo "::warning::run-eval-in-overlay: could not decode result '$fname'" >&2
  fi
done < "$res_file"
echo "Restored $restored result file(s) into $out_dir"

case "$rc" in
  0) echo "$script_name finished" ;;
  1) echo "::warning::$script_name reported a regression or failed (exit 1)" ;;
  124) echo "::error::$script_name timed out after ${timeout_s}s" ;;
  *) echo "::error::$script_name exited with $rc" ;;
esac
exit "$rc"
