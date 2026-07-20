<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Database Restore Drill & Disaster-Recovery Notes (REL-06)

This document covers how to *prove* the CI API database can be recovered from a
backup, the recommended recovery targets, and the honest gaps between what is
implemented in this repo and what still needs infrastructure provisioning
outside it.

Related:
- `docker/backup/restore-drill.sh` — the runnable drill (this doc's subject).
- `api/scripts/backup-database.sh` — takes the backups the drill restores.
- `api/scripts/restore-database.sh` — the real (destructive) production restore.
- `docker/docker-compose.production.yml` — the **`ci-db-backup` service** that now
  runs scheduled, off-host, encrypted backups in the deployed stack (see §5.1),
  plus the `ci-db` / `ci-redis` SPOF comments.
- `api/scripts/setup-cron-backups.sh` — HOST-cron **fallback** for scheduling
  backups on a non-swarm host (the compose service is the primary mechanism).

---

## 1. Why this exists

Production Postgres (`ci-db`) and Redis (`ci-redis`) are **single instances on
one host's local volume** — a single point of failure. See the `WARNING` blocks
on those services in `docker/docker-compose.production.yml`. Until they are moved
to a managed, replicated service, the only durability guarantee is:

1. the local named volume `ci-db-data`, and
2. logical backups (`pg_dump` custom format) produced by
   `api/scripts/backup-database.sh`.

A backup you have never restored is not a backup. The restore drill exercises
path (2) end-to-end against a real, recent backup so recoverability is a tested
fact, not an assumption.

---

## 2. What the drill does

`docker/backup/restore-drill.sh`:

1. Finds the **newest** backup matching `ailin_dev_*.sql.gz` in `BACKUP_DIR`
   (or takes an explicit file as `$1`).
2. Verifies it is a valid gzip archive.
3. Starts an **ephemeral, throwaway** Postgres container
   (`pgvector/pgvector:pg16`, matching production so the `vector` extension in
   the dump restores). It publishes **no host port** and mounts **no named
   volume** — all state is discarded when the container is removed.
4. Restores the backup into that container with `pg_restore`.
5. Runs sanity `SELECT count(*)` queries on the key business tables:
   `organizations`, `api_keys`, `request_logs`, `invoices`.
6. Prints a **PASS/FAIL** summary.
7. Tears the ephemeral container down (always, via an `EXIT` trap).

**It never touches production.** The script only talks to the throwaway
container it created, over that container's loopback interface. It does not read
`DATABASE_URL`, `DB_HOST`, or any production connection setting.

---

## 3. How to run it

Prerequisites: Docker running, and at least one backup present.

```bash
# Drill the newest backup in the default dir (/var/backups/ailin-dev):
docker/backup/restore-drill.sh

# Drill a specific backup file:
docker/backup/restore-drill.sh /var/backups/ailin-dev/ailin_dev_20260716_020000.sql.gz

# Override defaults if your environment differs. The scheduled `ci-db-backup`
# service stages its local dumps in /var/backups/ci-db (its named volume), so
# point BACKUP_DIR there when drilling those — or pass an explicit file, or one
# pulled from S3:
BACKUP_DIR=/var/backups/ci-db \
DRILL_DB=ci_db DRILL_USER=ci_user \
DRILL_TABLES="organizations api_keys request_logs invoices" \
  docker/backup/restore-drill.sh
```

Exit status is `0` on PASS, `1` on FAIL — so it can gate CI or a scheduled job.

### Producing a backup to drill

In the deployed stack backups are produced **automatically** by the
`ci-db-backup` service (see §5.1) — you normally drill the newest of those. To
produce one **on demand** (e.g. right before a risky migration), on the
production host or anywhere with network access to `ci-db`:

```bash
# Defaults now target prod ci-db (DB_NAME=ci_db, DB_USER=ci_user, DB_HOST=ci-db),
# so those can be omitted on a host that can resolve `ci-db`. The backup file is
# named ailin_dev_<timestamp>.sql.gz — a legacy label kept so restore-drill.sh's
# default glob matches; the DATABASE dumped is DB_NAME (ci_db).
DB_HOST=<db-host> DB_PORT=5432 \
DB_NAME=ci_db DB_USER=ci_user \
DB_PASSWORD_FILE=/run/secrets/ci_db_password \
BACKUP_DIR=/var/backups/ci-db \
S3_BUCKET=<your-backup-bucket> \
  api/scripts/backup-database.sh
```

`backup-database.sh` now **fails fast** rather than silently doing the wrong
thing: it refuses `DB_NAME=ailin_dev` (the old dev default) unless
`ALLOW_DEV_DB=true`, requires a password source, and — when `S3_BUCKET` is set —
**fails the run if the encrypted S3 upload fails** instead of quietly keeping
only an on-host copy. With `S3_BUCKET` unset it still runs but logs a loud
`LOCAL-ONLY` warning (an RPO risk).

### Interpreting the result

```
  TABLE                        ROWS   RESULT
  --------------------  ------------   ------
  organizations                  128   OK
  api_keys                       342   OK
  request_logs               1048576   OK
  invoices                       119   OK

[PASS] Restore drill succeeded — all key tables restored with queryable data.
```

- **PASS** — every key table restored and returns a numeric row count
  (including a legitimate `0`).
- **FAIL** — a key table is missing or unqueryable after restore. Investigate
  the backup and the dump/restore flags before trusting the backup for real DR.
- `pg_restore` non-fatal notices (e.g. re-declaring an extension) are logged but
  do **not** fail the drill; the row-count queries are the real gate.

---

## 4. Recovery targets (RTO / RPO)

These are **recommended targets to be validated**, not guarantees the current
setup meets. Treat them as the bar to design toward and to confirm by timing an
actual drill + restore.

| Metric | Current capability (logical dumps) | Recommended target | What it needs |
| --- | --- | --- | --- |
| **RPO** (max data loss) | **≤ 24h** — the `ci-db-backup` service now runs a `pg_dump` every 24h by default (`BACKUP_INTERVAL_SECONDS`), so at most a day of writes is lost between backups. Lower the interval (e.g. 6h) to tighten it. | ≤ 15m | WAL archiving / PITR, or a managed DB with continuous backup |
| **RTO** (time to restore) | Restore of a dump into a fresh instance; scales with DB size (validate by timing the drill) | ≤ 1h | Pre-provisioned standby / managed failover; rehearsed runbook |

- **RPO ≤ 24h is achieved today** by the scheduled `ci-db-backup` service (§5.1)
  — an automated, encrypted, off-host `pg_dump` runs every 24h without any
  manual step. (Before that service existed, no backup ran automatically in the
  deployed stack and the effective RPO was "whenever someone last ran the
  script" — i.e. unbounded.) Tighten RPO below 24h by lowering
  `BACKUP_INTERVAL_SECONDS`; reach minutes-level RPO only with WAL/PITR below.
- **RPO ≤ 15m** requires **WAL/PITR** — continuous WAL archiving so you can
  replay to a point in time. That is not configured on the single-host `ci-db`
  and requires either `archive_mode=on` + an `archive_command` shipping WAL
  off-host, or a managed database that does it for you.
- **RTO ≤ 1h** requires a rehearsed procedure and enough headroom to stand up a
  target instance quickly. Time a full drill on a production-sized backup to see
  where you actually land, then close the gap.

Validate both numbers by running the drill regularly and recording how long the
restore takes on a production-sized backup.

---

## 5. Known gaps (be honest about these)

### 5.1 Scheduled backups ARE now wired into the deploy (`ci-db-backup`)

**Status: FIXED for logical dumps (OPS-02).** `docker/docker-compose.production.yml`
now includes a first-class **`ci-db-backup`** service that runs
`api/scripts/backup-database.sh` on a schedule inside the swarm stack — no manual
host step. What it does:

| Aspect | Value |
| --- | --- |
| **Image** | `postgres:16-alpine` (pg16 client, matches the server; `bash`/`gzip`/`aws-cli` provisioned once at container start) |
| **Schedule** | loop with `sleep`; **every 24h** by default (`BACKUP_INTERVAL_SECONDS`, default `86400`) → **RPO ≤ 24h** |
| **Database** | the **same** DB as `ci-db` — `DB_NAME=ci_db`, `DB_USER=ci_user`, password from the **same** `ci_db_password` swarm secret via `DB_PASSWORD_FILE`. No `ailin_dev`. |
| **Encryption / offsite** | `pg_dump` custom format + gzip, uploaded to `s3://$S3_BUCKET/$S3_PREFIX/` with server-side encryption (`S3_SSE`, default `AES256`; set `aws:kms` + `S3_SSE_KMS_KEY_ID` for KMS) |
| **Retention** | local rotation via `RETENTION_DAYS` (default 30); off-host retention should be an **S3 lifecycle policy** on the bucket |
| **No duplicate runs** | `replicas: 1`, pinned to the manager node next to `ci-db` (`placement: node.role == manager`) so it never runs duplicated across tasks |
| **On failure** | a failed cycle logs `ERROR: backup cycle FAILED` and retries after `BACKUP_RETRY_SECONDS` (default 1800s); the scheduler stays alive |

**Enabling off-host (do this in the deploy env)** — the service runs even
without it, but then backups are **local-only** (logged as an RPO risk). Set:

```bash
BACKUP_S3_BUCKET=<your-backup-bucket>        # -> S3_BUCKET for the backup script
AWS_ACCESS_KEY_ID=...                         # S3 credentials
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=<region>
# Optional: BACKUP_S3_SSE=aws:kms BACKUP_S3_SSE_KMS_KEY_ID=<key-arn>
# Optional: BACKUP_INTERVAL_SECONDS=21600 (every 6h) BACKUP_RETENTION_DAYS=30
```

**How to verify a backup actually ran:**
- **S3 object** — a fresh key appears under `s3://$S3_BUCKET/$S3_PREFIX/` named
  `ailin_dev_<timestamp>.sql.gz` (legacy label; the DB is `ci_db`). Check with:
  `aws s3 ls s3://$S3_BUCKET/backups/ --recursive | tail`.
- **Log line** — the service logs a distinctive success line per cycle:
  `BACKUP SUCCESS db=ci_db file=... offsite=yes`. Check with:
  `docker service logs ci_ci-db-backup 2>&1 | grep "BACKUP SUCCESS"`.
- **Service health** — `docker service ps ci_ci-db-backup` shows the task
  `Running`/healthy (the healthcheck confirms the scheduler loop is alive; it is
  **not** a staleness check — see below).

**Still recommended (infra-side, outside this repo):**
- **Alert on staleness** — the healthcheck only proves the loop is running, not
  that a recent backup *succeeded*. Alert when no new S3 object / no
  `BACKUP SUCCESS` log line has appeared in > N hours; a silently failing backup
  is indistinguishable from none.
- **Alert on `ERROR: backup cycle FAILED`** in the service logs.
- Add an **S3 lifecycle policy** for off-host retention/expiry.
- Run this **drill on a schedule** against the newest off-host backup and alert
  on a `FAIL`.
- (Non-swarm hosts) `api/scripts/setup-cron-backups.sh` is the host-cron
  fallback; it sources an env file (`/etc/ci-db-backup.env`) so cron runs with
  the correct prod DB/S3 settings.

### 5.2 No HA and no PITR on the single-host DB/Redis

`ci-db` and `ci-redis` are single instances (see the `WARNING` comments in the
compose file). They **must stay at `replicas: 1`** — scaling them on a single
local volume would corrupt data (multiple primaries) or split queues/locks.

True production high availability and point-in-time recovery **cannot be done
inside this repo**. They require infrastructure provisioning outside it:

- **Postgres**: a managed, replicated service with automated failover and
  continuous backups/PITR (e.g. **Cloud SQL for PostgreSQL** in HA/regional
  config), or a self-managed primary/standby with streaming replication + WAL
  archiving.
- **Redis**: a managed, replicated service (e.g. **Memorystore for Redis** HA)
  or Redis Sentinel/Cluster.

Until then, this drill + off-host encrypted dumps are the DR backstop — good
enough to recover from data loss with bounded RPO, **not** a substitute for HA.

---

## 6. What is REAL vs. documented-scaffolding

**Real and runnable today (in this repo):**
- `docker/backup/restore-drill.sh` — actually spins up an ephemeral Postgres,
  restores the newest backup, runs the sanity queries, prints PASS/FAIL, and
  cleans up. Runnable now given Docker + a backup file.
- `api/scripts/backup-database.sh` / `restore-database.sh` — working logical
  backup/restore scripts (custom-format `pg_dump`, encrypted S3 upload). The
  backup script now targets prod (`ci_db`) by default, refuses the dev DB, and
  fails the run if a requested off-host upload fails.
- **`ci-db-backup` service** in `docker/docker-compose.production.yml` — a
  scheduled (default 24h), off-host, encrypted backup job wired into the deployed
  stack, using the same DB creds/secret as `ci-db` and running at `replicas: 1`
  so it never duplicates. This is what makes RPO **bounded (≤ 24h)** today (§5.1).
- The 2-replica stateless `api` service + `USE_BULLMQ_CRONS=true` (single cron
  execution across replicas) in `docker/docker-compose.production.yml`.

**Documented recommendations — require infra provisioning outside this repo:**
- Managed, replicated Postgres HA + PITR (Cloud SQL HA or equivalent).
- Managed, replicated Redis HA (Memorystore HA or Sentinel/Cluster).
- **WAL archiving / PITR to reach the ≤15m RPO target — still MANUAL / not done.**
  The scheduled `ci-db-backup` service gives ≤24h RPO with logical dumps but
  **no** point-in-time recovery. Continuous WAL archiving (`archive_mode=on` +
  an `archive_command` shipping WAL off-host, or a managed DB that does it) is a
  separate follow-up not covered by the backup service.
- Backup **staleness/failure alerting** and an **S3 lifecycle policy** for
  off-host retention (see §5.1) — operational glue outside the compose file.

Do not read the presence of this document as evidence that HA/PITR exist. They
do not yet; the drill proves the backstop works while that infrastructure is
provisioned.
