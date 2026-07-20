#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Database Backup Script for the CI API (api.ailin.one)
# -----------------------------------------------------------------------------
# Takes a logical PostgreSQL backup (pg_dump CUSTOM format), gzip-compresses it,
# verifies its integrity, ships it OFF-HOST to S3 with server-side encryption,
# and rotates old local copies. This is the backstop that bounds RPO for the
# single-host ci-db (see docker/docker-compose.production.yml and
# docs/hardening/RESTORE_DRILL.md).
#
# PRODUCTION DEFAULTS are aligned to the `ci-db` service in
# docker/docker-compose.production.yml:
#     POSTGRES_DB=ci_db   POSTGRES_USER=ci_user   host alias ci-db:5432
# The historical dev defaults (ailin_dev / ailin_dev) are GONE — running this
# against the wrong database silently produced a useless "backup". A guard below
# refuses DB_NAME=ailin_dev unless ALLOW_DEV_DB=true.
#
# ---- Environment -------------------------------------------------------------
# Connection (defaults target prod ci-db):
#   DB_HOST            Postgres host                 (default: ci-db)
#   DB_PORT            Postgres port                 (default: 5432)
#   DB_NAME            Database to dump              (default: ci_db)
#   DB_USER            Database user                 (default: ci_user)
#   DB_PASSWORD        Password (inline)             — one password source required
#   DB_PASSWORD_FILE   Password file (swarm secret)  — e.g. /run/secrets/ci_db_password
#   PGPASSWORD         Password (already exported)   — last-resort fallback
#
# Local storage / rotation:
#   BACKUP_DIR         Local backup directory        (default: /var/backups/ci-db)
#   BACKUP_PREFIX      Backup filename prefix        (default: ailin_dev)
#                        NOTE: kept as "ailin_dev" ONLY so that the default glob
#                        in docker/backup/restore-drill.sh (ailin_dev_*.sql.gz)
#                        keeps matching with zero config. It is a legacy FILE
#                        LABEL — the DATABASE actually dumped is DB_NAME (ci_db).
#   RETENTION_DAYS     Days of local backups to keep (default: 30)
#
# Off-host (S3) upload — set S3_BUCKET to ship encrypted dumps off the host:
#   S3_BUCKET          Target bucket (empty => LOCAL-ONLY, logged as an RPO risk)
#   S3_PREFIX          Key prefix within the bucket  (default: backups)
#   S3_STORAGE_CLASS   S3 storage class              (default: STANDARD_IA)
#   S3_SSE             Server-side encryption mode    (default: AES256; or aws:kms)
#   S3_SSE_KMS_KEY_ID  KMS key id (required only when S3_SSE=aws:kms)
#   AWS_*              Standard AWS CLI credentials/region env vars
#
# Safety:
#   ALLOW_DEV_DB       Set "true" to permit DB_NAME=ailin_dev (default: false)
#
# Exit status: 0 on a fully successful backup (incl. off-host upload when
# S3_BUCKET is set); non-zero on ANY failure — the backup is never quietly
# downgraded to a local-only copy when an upload was requested.
# -----------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ci-db}"
BACKUP_PREFIX="${BACKUP_PREFIX:-ailin_dev}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-backups}"
S3_STORAGE_CLASS="${S3_STORAGE_CLASS:-STANDARD_IA}"
S3_SSE="${S3_SSE:-AES256}"
S3_SSE_KMS_KEY_ID="${S3_SSE_KMS_KEY_ID:-}"

DB_NAME="${DB_NAME:-ci_db}"
DB_USER="${DB_USER:-ci_user}"
DB_HOST="${DB_HOST:-ci-db}"
DB_PORT="${DB_PORT:-5432}"

ALLOW_DEV_DB="${ALLOW_DEV_DB:-false}"

log()  { printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*"; }
warn() { printf '%s WARNING: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >&2; }
die()  { printf '%s ERROR: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Resolve the DB password: explicit DB_PASSWORD wins, then a *_FILE (swarm
# secret), then an already-exported PGPASSWORD. Fail fast if none is present —
# an unauthenticated pg_dump would otherwise error out mid-run.
# ---------------------------------------------------------------------------
DB_PASSWORD="${DB_PASSWORD:-}"
if [ -z "$DB_PASSWORD" ] && [ -n "${DB_PASSWORD_FILE:-}" ]; then
  [ -r "$DB_PASSWORD_FILE" ] || die "DB_PASSWORD_FILE=$DB_PASSWORD_FILE is not readable"
  DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
fi
DB_PASSWORD="${DB_PASSWORD:-${PGPASSWORD:-}}"
[ -n "$DB_PASSWORD" ] || die "no DB password set (use DB_PASSWORD, DB_PASSWORD_FILE, or PGPASSWORD)"

# ---------------------------------------------------------------------------
# Fail-fast guards on the target database. Defaults already point at prod
# (ci_db/ci_user); this stops a stray dev name from silently backing up the
# WRONG database in production.
# ---------------------------------------------------------------------------
[ -n "$DB_NAME" ] || die "DB_NAME is empty — refusing to guess the database to back up"
[ -n "$DB_USER" ] || die "DB_USER is empty — refusing to guess the database user"
if [ "$DB_NAME" = "ailin_dev" ] && [ "$ALLOW_DEV_DB" != "true" ]; then
  die "DB_NAME=ailin_dev is the DEV database. Refusing to back it up as production. \
Set DB_NAME=ci_db (prod) or, only if you truly mean the dev DB, ALLOW_DEV_DB=true."
fi

# ---------------------------------------------------------------------------
# Prepare paths
# ---------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}_${TIMESTAMP}.sql.gz"

log "Starting backup of database '${DB_NAME}' on ${DB_HOST}:${DB_PORT} -> ${BACKUP_FILE}"

# ---------------------------------------------------------------------------
# 1. Dump + compress. `set -o pipefail` (above) means a pg_dump failure in this
#    pipe now aborts the script instead of leaving a valid-looking, empty .gz.
# ---------------------------------------------------------------------------
PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=custom \
  --no-owner \
  --no-acl \
  --verbose \
  | gzip > "$BACKUP_FILE"

log "Dump written: $(ls -lh "$BACKUP_FILE" | awk '{print $5}')"

# ---------------------------------------------------------------------------
# 2. Verify integrity BEFORE we ship it off-host — never upload a corrupt dump.
# ---------------------------------------------------------------------------
log "Verifying gzip integrity"
gunzip -t "$BACKUP_FILE" || die "backup failed integrity check (corrupt gzip): $BACKUP_FILE"
log "Integrity check passed"

# ---------------------------------------------------------------------------
# 3. Off-host upload (encrypted). If S3_BUCKET is set the upload MUST succeed —
#    a backup that only lives on the same host as the DB does not survive that
#    host's loss, so we FAIL the run rather than pretend a local copy is enough.
# ---------------------------------------------------------------------------
UPLOADED="no"
if [ -n "$S3_BUCKET" ]; then
  S3_KEY="s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "$BACKUP_FILE")"

  # Build the server-side-encryption arguments.
  sse_args=(--server-side-encryption "$S3_SSE")
  if [ "$S3_SSE" = "aws:kms" ]; then
    [ -n "$S3_SSE_KMS_KEY_ID" ] || die "S3_SSE=aws:kms requires S3_SSE_KMS_KEY_ID"
    sse_args+=(--ssekms-key-id "$S3_SSE_KMS_KEY_ID")
  fi

  command -v aws >/dev/null 2>&1 || die "S3_BUCKET is set but the aws CLI is not installed — cannot ship off-host"

  log "Uploading off-host (SSE=${S3_SSE}, class=${S3_STORAGE_CLASS}): ${S3_KEY}"
  if aws s3 cp "$BACKUP_FILE" "$S3_KEY" \
       --storage-class "$S3_STORAGE_CLASS" \
       "${sse_args[@]}"; then
    UPLOADED="yes"
    log "Off-host upload succeeded"
  else
    die "off-host S3 upload FAILED for ${S3_KEY} — backup is NOT safely stored. \
Refusing to keep only the on-host copy (RPO would silently regress)."
  fi
else
  warn "S3_BUCKET is not set — this backup is LOCAL-ONLY on $(hostname). \
It will NOT survive loss of this host. Set S3_BUCKET (+ AWS creds) to bound RPO."
fi

# ---------------------------------------------------------------------------
# 4. Rotate local copies. Off-host (S3) retention should be handled by an S3
#    lifecycle policy on the bucket — see docs/hardening/RESTORE_DRILL.md.
# ---------------------------------------------------------------------------
log "Pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name "${BACKUP_PREFIX}_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
log "Local rotation complete"

# ---------------------------------------------------------------------------
# 5. Done. This distinctive line is the one to grep in logs / alerting.
# ---------------------------------------------------------------------------
log "BACKUP SUCCESS db=${DB_NAME} file=${BACKUP_FILE} offsite=${UPLOADED}"
