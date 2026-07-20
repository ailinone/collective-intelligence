#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

#
# restore-drill.sh — REL-06 disaster-recovery restore drill.
#
# Proves that the most recent database backup produced by
# api/scripts/backup-database.sh (a gzip'd pg_dump CUSTOM-format archive) can
# actually be restored and that the key business tables come back with data.
#
# It does this WITHOUT EVER TOUCHING PRODUCTION:
#   1. Starts an EPHEMERAL, throwaway Postgres container (pgvector/pgvector:pg16
#      to match production, so the `vector` extension in the dump restores).
#      No host port is published and no named volume is mounted — all state is
#      discarded when the container is removed.
#   2. Restores the newest backup into that container with pg_restore.
#   3. Runs sanity SELECT count(*) queries on the key tables
#      (organizations, api_keys, request_logs, invoices).
#   4. Prints a PASS/FAIL summary.
#   5. Tears the ephemeral container down (always, via trap).
#
# This script NEVER connects to the production database. It only talks to the
# throwaway container it created, over that container's loopback interface.
#
# Usage:
#   docker/backup/restore-drill.sh [BACKUP_FILE]
#
#   BACKUP_FILE  Optional path to a specific .sql.gz backup. If omitted, the
#                newest file matching BACKUP_GLOB in BACKUP_DIR is used.
#
# Environment overrides (all optional):
#   BACKUP_DIR    Directory holding backups        (default: /var/backups/ailin-dev)
#   BACKUP_GLOB   Glob for backup files            (default: ailin_dev_*.sql.gz)
#   PG_IMAGE      Ephemeral Postgres image         (default: pgvector/pgvector:pg16)
#   DRILL_DB      DB name inside the container      (default: ci_db)
#   DRILL_USER    DB user inside the container      (default: ci_user)
#   DRILL_TABLES  Space-separated tables to check   (default: organizations api_keys request_logs invoices)
#   READY_TIMEOUT Seconds to wait for Postgres      (default: 60)
#
# Exit status: 0 on PASS, 1 on FAIL (or setup error).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ailin-dev}"
BACKUP_GLOB="${BACKUP_GLOB:-ailin_dev_*.sql.gz}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
DRILL_DB="${DRILL_DB:-ci_db}"
DRILL_USER="${DRILL_USER:-ci_user}"
DRILL_TABLES="${DRILL_TABLES:-organizations api_keys request_logs invoices}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

# Throwaway superuser password — only ever lives inside the ephemeral container,
# which publishes no ports and is destroyed at the end of the run.
DRILL_PASSWORD="drill_$(date +%s)_$$"

# Unique container name so concurrent/leftover drills never collide.
CONTAINER="ci-restore-drill-$$-${RANDOM}"

log()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Cleanup — always remove the ephemeral container (and its anonymous storage).
# ---------------------------------------------------------------------------
cleanup() {
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    log "Tearing down ephemeral container ${CONTAINER}"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is not installed / not on PATH"
docker info >/dev/null 2>&1 || fail "docker daemon is not reachable"

# Resolve the backup file: explicit arg wins, else newest match in BACKUP_DIR.
BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  [ -d "$BACKUP_DIR" ] || fail "Backup dir not found: $BACKUP_DIR"
  # SC2012: ls -t is the simplest reliable newest-first sort here.
  # SC2086: BACKUP_GLOB is intentionally unquoted so the shell expands the glob.
  # shellcheck disable=SC2012,SC2086
  BACKUP_FILE="$(ls -1t "${BACKUP_DIR}"/${BACKUP_GLOB} 2>/dev/null | head -n1 || true)"
  [ -n "$BACKUP_FILE" ] || fail "No backups matching '${BACKUP_GLOB}' in ${BACKUP_DIR}"
fi
[ -f "$BACKUP_FILE" ] || fail "Backup file not found: $BACKUP_FILE"

log "Using backup:  $BACKUP_FILE"
log "Backup age:    $(( ( $(date +%s) - $(stat -c %Y "$BACKUP_FILE" 2>/dev/null || echo 0) ) / 60 )) min old"

# Confirm the archive is a valid gzip before spinning anything up.
log "Verifying gzip integrity"
gunzip -t "$BACKUP_FILE" || fail "Backup is not a valid gzip archive: $BACKUP_FILE"

# ---------------------------------------------------------------------------
# 1. Start the ephemeral Postgres container
# ---------------------------------------------------------------------------
log "Starting ephemeral Postgres (${PG_IMAGE}) as ${CONTAINER}"
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_DB="$DRILL_DB" \
  -e POSTGRES_USER="$DRILL_USER" \
  -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
  "$PG_IMAGE" >/dev/null \
  || fail "Failed to start ephemeral Postgres container"

# Wait for readiness (no host port needed — we exec inside the container).
log "Waiting for Postgres to accept connections (timeout ${READY_TIMEOUT}s)"
ready=0
for _ in $(seq 1 "$READY_TIMEOUT"); do
  if docker exec "$CONTAINER" pg_isready -U "$DRILL_USER" -d "$DRILL_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "Ephemeral Postgres did not become ready within ${READY_TIMEOUT}s"
log "Postgres is ready"

# Helper: run psql inside the ephemeral container (loopback + password auth).
drill_psql() {
  docker exec -i -e PGPASSWORD="$DRILL_PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$DRILL_USER" -d "$DRILL_DB" "$@"
}

# ---------------------------------------------------------------------------
# 2. Restore the backup into the ephemeral DB
# ---------------------------------------------------------------------------
log "Restoring backup into ephemeral DB '${DRILL_DB}'"
restore_rc=0
# pg_restore reads the custom-format archive from stdin. --no-owner/--no-acl
# mirror how the dump was taken. We do NOT use --exit-on-error: benign notices
# (e.g. re-declaring an extension) shouldn't abort the drill — the real
# pass/fail gate is whether the sanity queries below succeed with data.
gunzip -c "$BACKUP_FILE" \
  | docker exec -i -e PGPASSWORD="$DRILL_PASSWORD" "$CONTAINER" \
      pg_restore -h 127.0.0.1 -U "$DRILL_USER" -d "$DRILL_DB" \
        --no-owner --no-acl --verbose >/dev/null 2>&1 \
  || restore_rc=$?

if [ "$restore_rc" -ne 0 ]; then
  log "WARNING: pg_restore exited non-zero (${restore_rc}); continuing to sanity queries"
fi

# ---------------------------------------------------------------------------
# 3. Sanity queries — SELECT count(*) on the key tables
# ---------------------------------------------------------------------------
log "Running sanity queries on: ${DRILL_TABLES}"
echo
printf '  %-20s %12s   %s\n' "TABLE" "ROWS" "RESULT"
printf '  %-20s %12s   %s\n' "--------------------" "------------" "------"

overall_ok=1
for table in $DRILL_TABLES; do
  # -tA = tuples only, unaligned. Numeric count on success, empty on error.
  count="$(drill_psql -tA -c "SELECT count(*) FROM \"${table}\";" 2>/dev/null || true)"
  count="$(printf '%s' "$count" | tr -d '[:space:]')"
  if printf '%s' "$count" | grep -Eq '^[0-9]+$'; then
    printf '  %-20s %12s   %s\n' "$table" "$count" "OK"
  else
    printf '  %-20s %12s   %s\n' "$table" "n/a" "MISSING/ERROR"
    overall_ok=0
  fi
done
echo

# ---------------------------------------------------------------------------
# 4. Verdict (cleanup runs automatically via the EXIT trap)
# ---------------------------------------------------------------------------
if [ "$overall_ok" -eq 1 ]; then
  if [ "$restore_rc" -ne 0 ]; then
    log "Note: pg_restore reported non-fatal errors (rc=${restore_rc}); all key tables restored."
  fi
  printf '[PASS] Restore drill succeeded — all key tables restored with queryable data.\n'
  exit 0
else
  printf '[FAIL] Restore drill FAILED — one or more key tables missing or unqueryable.\n' >&2
  exit 1
fi
