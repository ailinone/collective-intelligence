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
# verifies it, ships it OFF-HOST to S3 with server-side encryption, and rotates
# old local copies. This is the backstop that bounds RPO for the single-host
# old-db-host (see docker/docker-compose.production.yml and
# docs/hardening/RESTORE_DRILL.md).
#
# PRODUCTION DEFAULTS are aligned to the `db` service in
# docker/docker-compose.production.yml:
#     POSTGRES_DB=app_db   POSTGRES_USER=app_user   port 5432
# The historical dev defaults (ailin_dev / ailin_dev) are GONE: running this
# against the wrong database silently produced a useless "backup". A guard below
# refuses DB_NAME=ailin_dev unless ALLOW_DEV_DB=true.
#
# ---- How a run can end (incident 2026-09-23) ---------------------------------
# A pg_dump started at 19:06 kept waiting on its socket for 2+ hours after the
# database task behind it was stopped, the scheduler loop waited on it, and no
# retry ran for ~45 h. Several truncated dumps were also left under final
# backup names. So, per run:
#   * pg_dump connects with a conninfo string that turns on TCP keepalives and
#     tcp_user_timeout, so a peer that vanishes without a FIN/RST is detected
#     in about 2 minutes instead of never.
#   * pg_dump runs under a hard wall-clock limit (BACKUP_TIMEOUT_SECONDS):
#     TERM when it expires, KILL BACKUP_KILL_GRACE_SECONDS later.
#   * The dump is written to a hidden temp name in BACKUP_DIR
#     (.inprogress.<prefix>_<timestamp>.<pid>.partial). That name never matches
#     the retention glob (<prefix>_*.sql.gz), the restore-drill glob, or any
#     other *.sql.gz / *.gz glob. It is renamed (same directory, atomic) to
#     <prefix>_<timestamp>.sql.gz only after verification passes.
#   * Verification: pg_dump and gzip both exit 0, the file is not empty,
#     `pg_restore -l` reads the archive's TOC and lists at least one TABLE DATA
#     entry, the whole gzip stream decompresses with a valid CRC, and the
#     archive ends with pg_dump's end-of-data marker. The last two checks exist
#     because `pg_restore -l` only reads the TOC at the start of the archive:
#     run on the real truncated files of 2026-09-23 it listed all 102 TABLE
#     DATA entries and exited 0 (see the verify_archive comment).
#   * Any failure, timeout or TERM/INT/HUP deletes the partial file (no
#     quarantine copy: a truncated archive cannot be restored, the log line
#     records its size and the failing stage, and each partial is up to the
#     size of a full dump). Final-named backups are never touched, except by
#     the RETENTION_DAYS rotation that has always existed.
#   * One run at a time per BACKUP_DIR: the run holds an flock on
#     $BACKUP_DIR/.backup-database.lock (pg_dump and gzip inherit it), and a
#     second run exits non-zero (reason=locked) instead of dumping twice.
#     While this run holds the lock no other run can be alive, so every
#     leftover partial belongs to a dead run and is deleted at once. That is
#     the usual way a partial is orphaned in production: a container stop
#     sends TERM only to PID 1 (the scheduler loop, which has no trap) and then
#     KILLs this script, so its own cleanup never runs. Without flock on PATH,
#     only partials older than any live run could be are deleted.
#   * Exit status is non-zero on every failure (124 on timeout, 128+N on a
#     signal) so the scheduler loop takes its BACKUP_RETRY_SECONDS path, and
#     BACKUP_SUCCESS_MARKER is touched only after the verified rename and every
#     later step succeeded. Every failure, configuration errors included, logs
#     one `BACKUP FAILED reason=...` line.
#
# ---- Updating this file while it runs ----------------------------------------
# The db-backup service bind-mounts this file, and an update is a copy over it
# in place (same inode, or the container would not see it). bash reads a
# script lazily, so a rewrite during a ~45 min dump used to make the running
# shell resume in the NEW file at the OLD byte offset: in tests that produced
# syntax errors, a pg_dump relaunched without its timeout that blocked
# forever, and an exit 0 right after the dump was deleted. So every
# executable statement lives in main() and the last line is
# `main "$@"; exit $?`, on ONE line: bash parses the whole file before the
# first command runs and never reads it again. Keep it that way.
#
# ---- Environment -------------------------------------------------------------
# Connection (defaults target prod old-db-host):
#   DB_HOST            Postgres host                 (default: old-db-host)
#   DB_PORT            Postgres port                 (default: 5432)
#   DB_NAME            Database to dump              (default: app_db)
#   DB_USER            Database user                 (default: app_user)
#   DB_PASSWORD        Password (inline)             (one password source required)
#   DB_PASSWORD_FILE   Password file (swarm secret), e.g. /run/secrets/app_db_password
#   PGPASSWORD         Password (already exported), last-resort fallback
#   The password reaches pg_dump only through its PGPASSWORD environment
#   variable, never through argv, the conninfo string or the log.
#
# Dead-peer detection (libpq conninfo keywords, seconds unless noted):
#   BACKUP_PG_CONNECT_TIMEOUT      connect_timeout      (default: 15)
#   BACKUP_PG_KEEPALIVES_IDLE      keepalives_idle      (default: 60)
#   BACKUP_PG_KEEPALIVES_INTERVAL  keepalives_interval  (default: 10)
#   BACKUP_PG_KEEPALIVES_COUNT     keepalives_count     (default: 6)
#   BACKUP_PG_TCP_USER_TIMEOUT_MS  tcp_user_timeout, ms (default: 120000)
#
# Time limits:
#   BACKUP_TIMEOUT_SECONDS         Wall-clock limit for pg_dump (default: 10800).
#                                  Full dumps of app_db took 40m20s to 50m51s
#                                  (11 runs, 2026-09-15..23, ~15.7 GB each), so
#                                  3 h is ~3.5x the slowest one and still 1/8
#                                  of the 24 h interval.
#   BACKUP_KILL_GRACE_SECONDS      Wait after TERM before KILL (default: 60).
#                                  On TERM pg_dump first sends a cancel request
#                                  to the server, which can itself hang on a
#                                  dead peer.
#   BACKUP_VERIFY_TIMEOUT_SECONDS  Limit for each verification pass
#                                  (default: 1800; gunzip -t of a full dump
#                                  took ~40 s).
#   The db-backup service in docker-compose.production.yml does not pass
#   these (nor BACKUP_PG_*) through its environment yet, so there the
#   defaults above apply; overriding them needs a compose change.
#
# Local storage / rotation:
#   BACKUP_DIR         Local backup directory        (default: /var/backups/old-db-host)
#   BACKUP_PREFIX      Backup filename prefix        (default: ailin_dev)
#                        NOTE: kept as "ailin_dev" ONLY so that the default glob
#                        in docker/backup/restore-drill.sh (ailin_dev_*.sql.gz)
#                        keeps matching with zero config. It is a legacy FILE
#                        LABEL; the DATABASE actually dumped is DB_NAME (app_db).
#   RETENTION_DAYS     Days of local backups to keep (default: 30)
#   BACKUP_SUCCESS_MARKER  File touched after a fully successful run
#                      (default: $BACKUP_DIR/.last-backup-success, the marker
#                      the db-backup scheduler's restart guard reads)
#
# Off-host (S3) upload, set S3_BUCKET to ship encrypted dumps off the host:
#   S3_BUCKET          Target bucket (empty => LOCAL-ONLY, logged as an RPO risk)
#   S3_PREFIX          Key prefix within the bucket  (default: backups)
#   S3_STORAGE_CLASS   S3 storage class              (default: STANDARD_IA)
#   S3_SSE             Server-side encryption mode   (default: AES256; or aws:kms)
#   S3_SSE_KMS_KEY_ID  KMS key id (required only when S3_SSE=aws:kms)
#   AWS_*              Standard AWS CLI credentials/region env vars
#
# Safety:
#   ALLOW_DEV_DB       Set "true" to permit DB_NAME=ailin_dev (default: false)
#
# Tools: bash, pg_dump, pg_restore, gzip, gunzip, timeout, mkfifo, mktemp, od,
# tail, find, stat, and flock when available. Busybox and GNU coreutils
# variants both work (the postgres:16-alpine service image uses busybox
# timeout, which reports 143/137 instead of GNU's 124, so a timeout is
# recognised by elapsed time).
#
# Exit status: 0 on a fully successful backup (incl. off-host upload when
# S3_BUCKET is set); 124 when pg_dump hit BACKUP_TIMEOUT_SECONDS; 128+N when
# stopped by signal N; 1 on any other failure. The backup is never quietly
# downgraded to a local-only copy when an upload was requested.
#
# Tests: scripts/ci/test_backup_database.py runs this script with stub
# pg_dump/pg_restore binaries (CI step "Deploy script tests (scripts/ci)").
# -----------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers. Definitions only: everything that runs is in main() below.
# ---------------------------------------------------------------------------
log()  { printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*"; }
warn() { printf '%s WARNING: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >&2; }
err()  { printf '%s ERROR: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >&2; }
die()  { err "$*"; exit 1; }

require_int() {
  # require_int NAME VALUE MIN
  case "$2" in
    ''|*[!0-9]*) die "$1 must be a non-negative integer (got '$2')" ;;
    0[0-9]*) die "$1 must not have leading zeros (got '$2'; shell arithmetic reads them as octal)" ;;
  esac
  [ "$2" -ge "$3" ] || die "$1 must be >= $3 (got $2)"
}

require_conninfo_safe() {
  # Values are interpolated into a libpq conninfo string, so only allow
  # characters that need no quoting there (hostnames, identifiers, numbers).
  case "$2" in
    ''|*[!A-Za-z0-9._-]*) die "$1 must match [A-Za-z0-9._-]+ (got '$2')" ;;
  esac
}

file_size() { stat -c %s -- "$1" 2>/dev/null || echo 0; }

# ---------------------------------------------------------------------------
# Run state and cleanup. PARTIAL_FILE is non-empty exactly while a temp dump
# exists that has not been promoted, so the EXIT trap deletes it on every
# abnormal exit path (die, set -e, signal).
# ---------------------------------------------------------------------------
discard_partial() {
  # discard_partial REASON
  local f="$PARTIAL_FILE" size
  [ -n "$f" ] || return 0
  PARTIAL_FILE=""
  if [ -e "$f" ]; then
    size="$(file_size "$f")"
    if rm -f -- "$f"; then
      log "Removed partial dump ${f} (${size} bytes; reason: $1)"
    else
      err "could not remove partial dump ${f} (${size} bytes); the next run deletes it"
    fi
  fi
}

list_partials() {
  # list_partials MIN_AGE_MINUTES (0 = any age)
  if [ "$1" -gt 0 ]; then
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PARTIAL_GLOB" -mmin "+$1"
  else
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PARTIAL_GLOB"
  fi
}

clear_dead_partials() {
  # clear_dead_partials MIN_AGE_MINUTES WHY: delete partial dumps left behind
  # by runs that are gone (SIGKILL, OOM, container stop).
  local stale size
  list_partials "$1" 2>/dev/null \
    | while IFS= read -r stale; do
        size="$(file_size "$stale")"
        if rm -f -- "$stale"; then
          log "Removed stale partial dump from an interrupted run: ${stale} (${size} bytes; $2)"
        fi
      done \
    || warn "could not scan ${BACKUP_DIR} for stale partial dumps"
}

stop_children() {
  # TERM whatever is still running, KILL it after the grace period, reap it.
  local pids="" alive p waited=0
  for p in "$DUMP_PID" "$GZIP_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      pids="$pids $p"
    fi
  done
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086 # pids is a list of plain integers
  kill -TERM $pids 2>/dev/null || true
  alive="$pids"
  while [ -n "$alive" ] && [ "$waited" -lt "$BACKUP_KILL_GRACE_SECONDS" ]; do
    sleep 1
    waited=$(( waited + 1 ))
    alive=""
    for p in $pids; do
      if kill -0 "$p" 2>/dev/null; then alive="$alive $p"; fi
    done
  done
  if [ -n "$alive" ]; then
    warn "still running ${BACKUP_KILL_GRACE_SECONDS}s after TERM, sending KILL to:${alive}"
    # shellcheck disable=SC2086
    kill -KILL $alive 2>/dev/null || true
  fi
  for p in $pids; do wait "$p" 2>/dev/null || true; done
  DUMP_PID=""
  GZIP_PID=""
}

on_exit() {
  local rc=$?
  trap - EXIT TERM INT HUP
  stop_children
  if [ "$rc" -eq 0 ] && [ -n "$PARTIAL_FILE" ]; then
    # Ending with a dump that was never promoted is not a success. Without
    # this, the scheduler loop would take the 0 as one and sleep a whole
    # interval with no new backup.
    FAILURE_LOGGED=1
    rc=1
    err "BACKUP FAILED reason=unexpected_exit db=${DB_NAME} the run ended before the dump was verified and promoted"
  fi
  if [ "$rc" -ne 0 ] && [ "$FAILURE_LOGGED" -eq 0 ]; then
    err "BACKUP FAILED reason=${FAIL_REASON} db=${DB_NAME} exit=${rc}"
  fi
  discard_partial "run exited with status ${rc}"
  if [ -n "$WORK_DIR" ]; then rm -rf -- "$WORK_DIR"; fi
  exit "$rc"
}

on_signal() {
  # on_signal NAME EXIT_CODE
  trap - TERM INT HUP
  FAILURE_LOGGED=1
  err "BACKUP FAILED reason=signal signal=SIG$1 db=${DB_NAME}; stopping pg_dump and removing the partial dump"
  exit "$2"
}

fail_backup() {
  # fail_backup REASON EXIT_CODE DETAIL
  FAILURE_LOGGED=1
  err "BACKUP FAILED reason=$1 db=${DB_NAME} $3"
  discard_partial "$1"
  exit "$2"
}

# ---------------------------------------------------------------------------
# Verification (step 2 of main).
#
# `pg_restore -l` alone is not enough. pg_dump writes the whole TOC first and
# the table data after it, and `pg_restore -l` stops after the TOC. Measured
# on the real truncated dumps of 2026-09-23 (1.2 GB, 2.9 GB and 5.4 GB, all
# cut during table data): each listed 1035 TOC entries and 102 TABLE DATA
# entries and exited 0, same as a complete dump. Only the empty 20-byte one
# failed ("input file is too short"). So a second pass reads the whole file:
# gunzip checks the gzip CRC and length (the 1.2 GB and 2.9 GB files, whose
# gzip was killed mid-stream, fail with "unexpected end of file"), and the
# archive must end with pg_dump's end-of-data marker (the 5.4 GB file, cut by
# "terminating connection due to administrator command", decompresses with a
# valid CRC but ends in 18 eb 44 14 d9 instead of five zero bytes).
# ---------------------------------------------------------------------------
verify_archive() {
  local f="$1" toc="" toc_rc=0 tail_hex="" stream_rc=0 started

  if [ ! -s "$f" ]; then
    VERIFY_ERROR="archive is empty"
    return 1
  fi

  # Pass 1: TOC listing. gunzip is cut off by SIGPIPE once pg_restore has read
  # the TOC, so only pg_restore's status counts here.
  started="$(date +%s)"
  toc="$(gunzip -c -- "$f" 2>/dev/null \
    | timeout -k "$BACKUP_KILL_GRACE_SECONDS" "$BACKUP_VERIFY_TIMEOUT_SECONDS" pg_restore -l; \
    exit "${PIPESTATUS[1]}")" || toc_rc=$?
  if [ "$toc_rc" -ne 0 ]; then
    if [ $(( $(date +%s) - started )) -ge "$BACKUP_VERIFY_TIMEOUT_SECONDS" ]; then
      VERIFY_ERROR="pg_restore -l timed out after ${BACKUP_VERIFY_TIMEOUT_SECONDS}s (rc=${toc_rc})"
    else
      VERIFY_ERROR="pg_restore -l could not read the archive TOC (rc=${toc_rc})"
    fi
    return 1
  fi
  TOC_ENTRIES="$(printf '%s\n' "$toc" | grep -c '^[0-9][0-9]*;' || true)"
  TOC_TABLE_DATA="$(printf '%s\n' "$toc" | grep -c ' TABLE DATA ' || true)"
  if [ "$TOC_TABLE_DATA" -lt 1 ]; then
    VERIFY_ERROR="archive TOC lists no TABLE DATA entries (${TOC_ENTRIES} entries)"
    return 1
  fi

  # Pass 2: the whole stream. gunzip's status covers the gzip CRC/length
  # trailer; the last 5 decompressed bytes must be the end-of-data marker.
  started="$(date +%s)"
  tail_hex="$(timeout -k "$BACKUP_KILL_GRACE_SECONDS" "$BACKUP_VERIFY_TIMEOUT_SECONDS" gunzip -c -- "$f" \
    | tail -c 5 | od -An -tx1 | tr -d ' \n'; \
    exit "${PIPESTATUS[0]}")" || stream_rc=$?
  if [ "$stream_rc" -ne 0 ]; then
    if [ "$stream_rc" -eq 124 ] || [ $(( $(date +%s) - started )) -ge "$BACKUP_VERIFY_TIMEOUT_SECONDS" ]; then
      VERIFY_ERROR="full gzip read timed out after ${BACKUP_VERIFY_TIMEOUT_SECONDS}s (rc=${stream_rc})"
    else
      VERIFY_ERROR="gzip stream is corrupt or truncated (gunzip rc=${stream_rc})"
    fi
    return 1
  fi
  if [ "$tail_hex" != "$END_OF_DATA_MARKER_HEX" ]; then
    VERIFY_ERROR="archive does not end with pg_dump's end-of-data marker (last bytes: ${tail_hex:-none}); the custom archive inside the gzip stream is truncated"
    return 1
  fi
  return 0
}

main() {
  # -------------------------------------------------------------------------
  # Configuration (plain defaults, nothing here can fail)
  # -------------------------------------------------------------------------
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/old-db-host}"
  BACKUP_PREFIX="${BACKUP_PREFIX:-ailin_dev}"
  RETENTION_DAYS="${RETENTION_DAYS:-30}"
  BACKUP_SUCCESS_MARKER="${BACKUP_SUCCESS_MARKER:-${BACKUP_DIR}/.last-backup-success}"

  BACKUP_TIMEOUT_SECONDS="${BACKUP_TIMEOUT_SECONDS:-10800}"
  BACKUP_KILL_GRACE_SECONDS="${BACKUP_KILL_GRACE_SECONDS:-60}"
  BACKUP_VERIFY_TIMEOUT_SECONDS="${BACKUP_VERIFY_TIMEOUT_SECONDS:-1800}"

  BACKUP_PG_CONNECT_TIMEOUT="${BACKUP_PG_CONNECT_TIMEOUT:-15}"
  BACKUP_PG_KEEPALIVES_IDLE="${BACKUP_PG_KEEPALIVES_IDLE:-60}"
  BACKUP_PG_KEEPALIVES_INTERVAL="${BACKUP_PG_KEEPALIVES_INTERVAL:-10}"
  BACKUP_PG_KEEPALIVES_COUNT="${BACKUP_PG_KEEPALIVES_COUNT:-6}"
  BACKUP_PG_TCP_USER_TIMEOUT_MS="${BACKUP_PG_TCP_USER_TIMEOUT_MS:-120000}"

  S3_BUCKET="${S3_BUCKET:-}"
  S3_PREFIX="${S3_PREFIX:-backups}"
  S3_STORAGE_CLASS="${S3_STORAGE_CLASS:-STANDARD_IA}"
  S3_SSE="${S3_SSE:-AES256}"
  S3_SSE_KMS_KEY_ID="${S3_SSE_KMS_KEY_ID:-}"

  DB_NAME="${DB_NAME:-app_db}"
  DB_USER="${DB_USER:-app_user}"
  DB_HOST="${DB_HOST:-old-db-host}"
  DB_PORT="${DB_PORT:-5432}"

  ALLOW_DEV_DB="${ALLOW_DEV_DB:-false}"

  # Hidden, never matches <prefix>_*.sql.gz, *.sql.gz or *.gz (see the header).
  PARTIAL_GLOB='.inprogress.*.partial'
  # The last 5 bytes of every complete custom-format archive: pg_dump closes
  # each data block with WriteInt(0), a sign byte plus a 4-byte zero integer.
  END_OF_DATA_MARKER_HEX='0000000000'

  # -------------------------------------------------------------------------
  # Run state, set before the traps that read it. Until the configuration is
  # validated a failure is reported as reason=config.
  # -------------------------------------------------------------------------
  PARTIAL_FILE=""
  WORK_DIR=""
  DUMP_PID=""
  GZIP_PID=""
  FAILURE_LOGGED=0
  FAIL_REASON="config"
  VERIFY_ERROR=""
  TOC_ENTRIES=0
  TOC_TABLE_DATA=0

  trap on_exit EXIT
  trap 'on_signal TERM 143' TERM
  trap 'on_signal INT 130' INT
  trap 'on_signal HUP 129' HUP

  # -------------------------------------------------------------------------
  # Resolve the DB password: explicit DB_PASSWORD wins, then a *_FILE (swarm
  # secret), then an already-exported PGPASSWORD. Fail fast if none is
  # present: an unauthenticated pg_dump would otherwise error out mid-run.
  # -------------------------------------------------------------------------
  DB_PASSWORD="${DB_PASSWORD:-}"
  if [ -z "$DB_PASSWORD" ] && [ -n "${DB_PASSWORD_FILE:-}" ]; then
    [ -r "$DB_PASSWORD_FILE" ] || die "DB_PASSWORD_FILE=$DB_PASSWORD_FILE is not readable"
    DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
  fi
  DB_PASSWORD="${DB_PASSWORD:-${PGPASSWORD:-}}"
  [ -n "$DB_PASSWORD" ] || die "no DB password set (use DB_PASSWORD, DB_PASSWORD_FILE, or PGPASSWORD)"

  # -------------------------------------------------------------------------
  # Fail-fast guards on the target database. Defaults already point at prod
  # (app_db/app_user); this stops a stray dev name from silently backing up the
  # WRONG database in production.
  # -------------------------------------------------------------------------
  [ -n "$DB_NAME" ] || die "DB_NAME is empty, refusing to guess the database to back up"
  [ -n "$DB_USER" ] || die "DB_USER is empty, refusing to guess the database user"
  if [ "$DB_NAME" = "ailin_dev" ] && [ "$ALLOW_DEV_DB" != "true" ]; then
    die "DB_NAME=ailin_dev is the DEV database. Refusing to back it up as production. Set DB_NAME=app_db (prod) or, only if you truly mean the dev DB, ALLOW_DEV_DB=true."
  fi
  require_conninfo_safe DB_HOST "$DB_HOST"
  require_conninfo_safe DB_PORT "$DB_PORT"
  require_conninfo_safe DB_NAME "$DB_NAME"
  require_conninfo_safe DB_USER "$DB_USER"

  require_int BACKUP_TIMEOUT_SECONDS "$BACKUP_TIMEOUT_SECONDS" 1
  require_int BACKUP_KILL_GRACE_SECONDS "$BACKUP_KILL_GRACE_SECONDS" 1
  require_int BACKUP_VERIFY_TIMEOUT_SECONDS "$BACKUP_VERIFY_TIMEOUT_SECONDS" 1
  require_int BACKUP_PG_CONNECT_TIMEOUT "$BACKUP_PG_CONNECT_TIMEOUT" 1
  require_int BACKUP_PG_KEEPALIVES_IDLE "$BACKUP_PG_KEEPALIVES_IDLE" 1
  require_int BACKUP_PG_KEEPALIVES_INTERVAL "$BACKUP_PG_KEEPALIVES_INTERVAL" 1
  require_int BACKUP_PG_KEEPALIVES_COUNT "$BACKUP_PG_KEEPALIVES_COUNT" 1
  require_int BACKUP_PG_TCP_USER_TIMEOUT_MS "$BACKUP_PG_TCP_USER_TIMEOUT_MS" 0

  # The scheduler loop exports BACKUP_INTERVAL_SECONDS; a limit that eats the
  # whole interval would let one stuck run swallow the next cycle.
  if [ -n "${BACKUP_INTERVAL_SECONDS:-}" ] && [ "${BACKUP_INTERVAL_SECONDS}" -gt 0 ] 2>/dev/null; then
    local worst_case=$(( BACKUP_TIMEOUT_SECONDS + BACKUP_KILL_GRACE_SECONDS + 2 * BACKUP_VERIFY_TIMEOUT_SECONDS ))
    if [ "$worst_case" -ge "$BACKUP_INTERVAL_SECONDS" ]; then
      warn "BACKUP_TIMEOUT_SECONDS=${BACKUP_TIMEOUT_SECONDS} (+ grace and verification, ${worst_case}s worst case) is not below BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS}; a stuck run can consume a whole cycle"
    fi
  fi

  local tool
  for tool in pg_dump pg_restore gzip gunzip timeout mkfifo mktemp od tail find stat; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' is not on PATH"
  done

  # The libpq connection string. No password here: it goes through PGPASSWORD.
  CONNINFO="host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME} user=${DB_USER}"
  CONNINFO="${CONNINFO} connect_timeout=${BACKUP_PG_CONNECT_TIMEOUT}"
  CONNINFO="${CONNINFO} keepalives=1 keepalives_idle=${BACKUP_PG_KEEPALIVES_IDLE}"
  CONNINFO="${CONNINFO} keepalives_interval=${BACKUP_PG_KEEPALIVES_INTERVAL}"
  CONNINFO="${CONNINFO} keepalives_count=${BACKUP_PG_KEEPALIVES_COUNT}"
  CONNINFO="${CONNINFO} tcp_user_timeout=${BACKUP_PG_TCP_USER_TIMEOUT_MS}"
  CONNINFO="${CONNINFO} application_name=old-db-host-backup"

  FAIL_REASON="error"

  # -------------------------------------------------------------------------
  # Prepare paths, take the single-run lock, clear partials of dead runs
  # -------------------------------------------------------------------------
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
  BACKUP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}_${TIMESTAMP}.sql.gz"
  PARTIAL_PATH="${BACKUP_DIR}/.inprogress.${BACKUP_PREFIX}_${TIMESTAMP}.$$.partial"
  LOCK_FILE="${BACKUP_DIR}/.backup-database.lock"
  # No live run is older than this: it keeps writing, or its own timeout ends
  # it after BACKUP_TIMEOUT_SECONDS + grace.
  STALE_PARTIAL_MINUTES=$(( (BACKUP_TIMEOUT_SECONDS + BACKUP_KILL_GRACE_SECONDS + 600 + 59) / 60 ))

  if command -v flock >/dev/null 2>&1; then
    # fd 9 stays open in this shell and in every child, so the lock is held
    # until the last process of this run is gone.
    exec 9>>"$LOCK_FILE"
    if ! flock -n 9; then
      fail_backup locked 1 "another backup run holds ${LOCK_FILE}; not starting a second dump"
    fi
    clear_dead_partials 0 "no other run can be alive while this one holds ${LOCK_FILE}"
  else
    warn "flock is not on PATH: running without the single-run lock; only partial dumps older than ${STALE_PARTIAL_MINUTES} min are removed"
    clear_dead_partials "$STALE_PARTIAL_MINUTES" "older than any live run can be"
  fi

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/old-db-host-backup.XXXXXX")"
  FIFO="${WORK_DIR}/pg_dump.fifo"
  mkfifo "$FIFO"

  RUN_STARTED="$(date +%s)"
  log "BACKUP START db=${DB_NAME} host=${DB_HOST}:${DB_PORT} timeout=${BACKUP_TIMEOUT_SECONDS}s keepalives=${BACKUP_PG_KEEPALIVES_IDLE}/${BACKUP_PG_KEEPALIVES_INTERVAL}/${BACKUP_PG_KEEPALIVES_COUNT} tcp_user_timeout=${BACKUP_PG_TCP_USER_TIMEOUT_MS}ms temp=${PARTIAL_PATH} final=${BACKUP_FILE}"

  # -------------------------------------------------------------------------
  # 1. Dump + compress into the temp file. Both sides run in the background
  #    and this shell `wait`s on them, because bash defers a trapped TERM
  #    until a FOREGROUND command returns (which is how a hung pg_dump used to
  #    hold the whole run). The FIFO keeps pg_dump and gzip as direct
  #    children, so each exit status is known and each can be stopped by PID.
  # -------------------------------------------------------------------------
  PARTIAL_FILE="$PARTIAL_PATH"
  gzip -c < "$FIFO" > "$PARTIAL_FILE" &
  GZIP_PID=$!
  PGPASSWORD="$DB_PASSWORD" timeout -k "$BACKUP_KILL_GRACE_SECONDS" "$BACKUP_TIMEOUT_SECONDS" \
    pg_dump \
      -d "$CONNINFO" \
      --format=custom \
      --no-owner \
      --no-acl \
      --verbose \
    > "$FIFO" &
  DUMP_PID=$!

  local dump_rc=0 gzip_rc=0
  wait "$DUMP_PID" || dump_rc=$?
  DUMP_PID=""
  wait "$GZIP_PID" || gzip_rc=$?
  GZIP_PID=""

  DUMP_SECONDS=$(( $(date +%s) - RUN_STARTED ))
  PARTIAL_BYTES="$(file_size "$PARTIAL_FILE")"

  if [ "$dump_rc" -ne 0 ]; then
    # GNU timeout exits 124 on expiry. Busybox timeout execs pg_dump in place,
    # so the status is pg_dump's own: 1 from its TERM handler, 143 or 137.
    # Elapsed time is the one signal both agree on.
    if [ "$dump_rc" -eq 124 ] || [ "$DUMP_SECONDS" -ge "$BACKUP_TIMEOUT_SECONDS" ]; then
      fail_backup timeout 124 "pg_dump did not finish within ${BACKUP_TIMEOUT_SECONDS}s (elapsed=${DUMP_SECONDS}s pg_dump_rc=${dump_rc} gzip_rc=${gzip_rc} partial_bytes=${PARTIAL_BYTES}); raise BACKUP_TIMEOUT_SECONDS only if dumps legitimately take this long"
    fi
    fail_backup pg_dump_error 1 "pg_dump exited ${dump_rc} after ${DUMP_SECONDS}s (gzip_rc=${gzip_rc} partial_bytes=${PARTIAL_BYTES})"
  fi
  if [ "$gzip_rc" -ne 0 ]; then
    fail_backup gzip_error 1 "gzip exited ${gzip_rc} after ${DUMP_SECONDS}s (partial_bytes=${PARTIAL_BYTES})"
  fi
  log "pg_dump finished in ${DUMP_SECONDS}s: ${PARTIAL_BYTES} bytes ($(( PARTIAL_BYTES / 1048576 )) MiB)"

  # -------------------------------------------------------------------------
  # 2. Verify BEFORE the file gets a backup name or leaves the host (see the
  #    comment above verify_archive for why pg_restore -l is not enough).
  # -------------------------------------------------------------------------
  log "Verifying archive: pg_restore -l TOC listing, full gzip read, end-of-data marker"
  local verify_started
  verify_started="$(date +%s)"
  if ! verify_archive "$PARTIAL_FILE"; then
    fail_backup verify_failed 1 "${VERIFY_ERROR} (bytes=${PARTIAL_BYTES} dump_seconds=${DUMP_SECONDS})"
  fi
  log "Archive verified in $(( $(date +%s) - verify_started ))s: ${TOC_ENTRIES} TOC entries, ${TOC_TABLE_DATA} TABLE DATA entries, gzip stream and end-of-data marker OK"

  # -------------------------------------------------------------------------
  # 3. Promote: same-directory rename, so the final name only ever points at
  #    a complete, verified archive.
  # -------------------------------------------------------------------------
  if [ -e "$BACKUP_FILE" ]; then
    fail_backup name_collision 1 "${BACKUP_FILE} already exists; refusing to overwrite it"
  fi
  mv -- "$PARTIAL_FILE" "$BACKUP_FILE"
  PARTIAL_FILE=""
  log "Promoted verified dump to ${BACKUP_FILE}"

  # -------------------------------------------------------------------------
  # 4. Off-host upload (encrypted). If S3_BUCKET is set the upload MUST
  #    succeed: a backup that only lives on the same host as the DB does not
  #    survive that host's loss, so we FAIL the run rather than pretend a
  #    local copy is enough.
  # -------------------------------------------------------------------------
  UPLOADED="no"
  if [ -n "$S3_BUCKET" ]; then
    FAIL_REASON="upload"
    S3_KEY="s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "$BACKUP_FILE")"

    # Build the server-side-encryption arguments.
    local sse_args=(--server-side-encryption "$S3_SSE")
    if [ "$S3_SSE" = "aws:kms" ]; then
      [ -n "$S3_SSE_KMS_KEY_ID" ] || die "S3_SSE=aws:kms requires S3_SSE_KMS_KEY_ID"
      sse_args+=(--ssekms-key-id "$S3_SSE_KMS_KEY_ID")
    fi

    command -v aws >/dev/null 2>&1 || die "S3_BUCKET is set but the aws CLI is not installed, cannot ship off-host"

    log "Uploading off-host (SSE=${S3_SSE}, class=${S3_STORAGE_CLASS}): ${S3_KEY}"
    if aws s3 cp "$BACKUP_FILE" "$S3_KEY" \
         --storage-class "$S3_STORAGE_CLASS" \
         "${sse_args[@]}"; then
      UPLOADED="yes"
      log "Off-host upload succeeded"
    else
      die "off-host S3 upload FAILED for ${S3_KEY}: backup is NOT safely stored. Refusing to keep only the on-host copy (RPO would silently regress)."
    fi
    FAIL_REASON="error"
  else
    warn "S3_BUCKET is not set: this backup is LOCAL-ONLY on $(hostname). It will NOT survive loss of this host. Set S3_BUCKET (+ AWS creds) to bound RPO."
  fi

  # -------------------------------------------------------------------------
  # 5. Rotate local copies. Off-host (S3) retention should be handled by an
  #    S3 lifecycle policy on the bucket, see docs/hardening/RESTORE_DRILL.md.
  #    Partial dumps never match this pattern.
  # -------------------------------------------------------------------------
  log "Pruning local backups older than ${RETENTION_DAYS} days"
  find "$BACKUP_DIR" -name "${BACKUP_PREFIX}_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
  log "Local rotation complete"

  # -------------------------------------------------------------------------
  # 6. Done. The marker is touched only here, after the verified rename and
  #    every later step; the distinctive line below is the one to grep in
  #    logs / alerting.
  # -------------------------------------------------------------------------
  touch "$BACKUP_SUCCESS_MARKER"
  BACKUP_BYTES="$(file_size "$BACKUP_FILE")"
  log "BACKUP SUCCESS db=${DB_NAME} file=${BACKUP_FILE} offsite=${UPLOADED} bytes=${BACKUP_BYTES} dump_seconds=${DUMP_SECONDS} total_seconds=$(( $(date +%s) - RUN_STARTED ))"
}

# Must stay the last line, with the exit on it (see "Updating this file while
# it runs" in the header).
main "$@"; exit $?
