#!/bin/bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Database Restore Script for Ailin Dev API
# Restore from backup with safety checks

set -e

# Configuration
BACKUP_FILE="${1:-}"
DB_NAME="${DB_NAME:-ailin_dev}"
DB_USER="${DB_USER:-ailin_dev}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

if [ -z "$BACKUP_FILE" ]; then
  echo "❌ Error: Backup file not specified"
  echo "Usage: ./restore-database.sh <backup-file>"
  echo "Example: ./restore-database.sh /var/backups/ailin-dev/ailin_dev_20251104_120000.sql.gz"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Safety check: Confirm restore
echo "⚠️  WARNING: This will REPLACE the current database: $DB_NAME"
echo "Backup file: $BACKUP_FILE"
echo ""
read -p "Are you sure you want to continue? (type 'yes' to confirm): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo "Starting database restore from: $BACKUP_FILE"

# Verify backup file integrity
echo "Verifying backup file integrity"
gunzip -t "$BACKUP_FILE"
echo "✅ Backup file is valid"

# Drop and recreate database
echo "Recreating database"
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d postgres \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;"

echo "✅ Database recreated"

# Restore from backup
echo "Restoring from backup"
gunzip -c "$BACKUP_FILE" | PGPASSWORD="$DB_PASSWORD" pg_restore \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --verbose \
  --no-owner \
  --no-acl

echo "✅ Database restored successfully"

# Verify restore
echo "Verifying restore"
ROW_COUNT=$(PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")

echo "✅ Restore verified: $ROW_COUNT tables found"
echo "✅ Database restore completed successfully"

