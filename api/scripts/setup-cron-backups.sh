#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Setup automated database backups via HOST cron.
# -----------------------------------------------------------------------------
# This is the HOST-LEVEL FALLBACK for scheduling backups. The PRIMARY, deployed
# mechanism is the `ci-db-backup` service in docker/docker-compose.production.yml,
# which runs backup-database.sh on a schedule inside the swarm stack (no manual
# host step). Use THIS script only when you deliberately want the backup driven
# by the host's crontab instead of the compose service (e.g. a non-swarm host).
#
# It installs a crontab entry that runs backup-database.sh. Because cron does not
# inherit your shell environment, point it at an ENV FILE that exports the DB /
# S3 settings (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD_FILE, S3_BUCKET, ...).
#
# Environment overrides (all optional):
#   BACKUP_ENV_FILE   File sourced before each run (default: /etc/ci-db-backup.env)
#   BACKUP_SCHEDULE   Cron schedule fields         (default: "0 2 * * *" — 02:00 daily)
#   BACKUP_LOG        Log file for backup output   (default: /var/log/ci-db-backup.log)
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-database.sh"

BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/ci-db-backup.env}"
BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"
BACKUP_LOG="${BACKUP_LOG:-/var/log/ci-db-backup.log}"

[ -f "$BACKUP_SCRIPT" ] || { echo "ERROR: backup script not found: $BACKUP_SCRIPT" >&2; exit 1; }
chmod +x "$BACKUP_SCRIPT"

# Cron runs with a bare environment, so source the env file (if present) before
# invoking the backup. The `. "$FILE"` is guarded so a missing file logs loudly
# rather than silently running with wrong (dev) defaults.
CRON_CMD="[ -f ${BACKUP_ENV_FILE} ] && . ${BACKUP_ENV_FILE}; ${BACKUP_SCRIPT} >> ${BACKUP_LOG} 2>&1"
CRON_JOB="${BACKUP_SCHEDULE} ${CRON_CMD}"

if crontab -l 2>/dev/null | grep -qF "$BACKUP_SCRIPT"; then
  echo "Cron job for ${BACKUP_SCRIPT} already exists — leaving it as-is."
  echo "Remove it with 'crontab -e' first if you want to change the schedule."
else
  ( crontab -l 2>/dev/null || true; echo "$CRON_JOB" ) | crontab -
  echo "Cron job added: '${BACKUP_SCHEDULE}' -> ${BACKUP_SCRIPT}"
fi

echo
echo "Current crontab:"
crontab -l

echo
echo "Automated HOST-cron backups configured."
echo "  schedule: ${BACKUP_SCHEDULE}"
echo "  env file: ${BACKUP_ENV_FILE} (must export DB_* / S3_BUCKET; see backup-database.sh)"
echo "  logs:     ${BACKUP_LOG}"
if [ ! -f "$BACKUP_ENV_FILE" ]; then
  echo
  echo "WARNING: ${BACKUP_ENV_FILE} does not exist yet. Create it and export at least:" >&2
  echo "  DB_HOST, DB_NAME=ci_db, DB_USER=ci_user, DB_PASSWORD_FILE, S3_BUCKET" >&2
  echo "Otherwise the backup falls back to script defaults and (without S3_BUCKET) stays LOCAL-ONLY." >&2
fi
