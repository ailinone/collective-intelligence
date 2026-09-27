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
- `docker/docker-compose.production.yml` — the **`db-backup` service** that now
  runs scheduled, off-host, encrypted backups in the deployed stack (see §5.1),
  plus the `db` / `redis` SPOF comments.
- `api/scripts/setup-cron-backups.sh` — HOST-cron **fallback** for scheduling
  backups on a non-swarm host (the compose service is the primary mechanism).

---

## 1. Why this exists

Production Postgres (`db`) and Redis (`redis`) are **single instances on
one host's local volume** — a single point of failure. See the `WARNING` blocks
on those services in `docker/docker-compose.production.yml`. Until they are moved
to a managed, replicated service, the only durability guarantee is:

1. the local named volume `db-data`, and
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
2. Reads the whole file: the gzip stream must decompress with a valid CRC and
   the archive must end with pg_dump's end-of-data marker (5 zero bytes), so a
   truncated dump fails here, before any container starts (see the 2026-09-23
   incident in §5.1 for why `gunzip -t` alone is not enough).
3. Starts an **ephemeral, throwaway** Postgres container
   (`pgvector/pgvector:pg16`, matching production so the `vector` extension in
   the dump restores). It publishes **no host port** and mounts **no named
   volume** — all state is discarded when the container is removed.
4. Restores the backup into that container with `pg_restore`.
5. Runs sanity `SELECT count(*)` queries on the key business tables:
   `organizations`, `api_keys`, `request_logs`, `invoices`. Each one must
   exist and hold at least one row (a dump cut during table data still
   creates every table, empty).
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

# Override defaults if your environment differs. The scheduled `db-backup`
# service stages its local dumps in /var/backups/db (its named volume), so
# point BACKUP_DIR there when drilling those — or pass an explicit file, or one
# pulled from S3:
BACKUP_DIR=/var/backups/db \
DRILL_DB=app_db DRILL_USER=app_user \
DRILL_TABLES="organizations api_keys request_logs invoices" \
  docker/backup/restore-drill.sh
```

Exit status is `0` on PASS, `1` on FAIL — so it can gate CI or a scheduled job.

### Producing a backup to drill

In the deployed stack backups are produced **automatically** by the
`db-backup` service (see §5.1) — you normally drill the newest of those. To
produce one **on demand** (e.g. right before a risky migration), on the
production host or anywhere with network access to `db`:

```bash
# Defaults now target prod db (DB_NAME=app_db, DB_USER=app_user, DB_HOST=db),
# so those can be omitted on a host that can resolve `db`. The backup file is
# named ailin_dev_<timestamp>.sql.gz — a legacy label kept so restore-drill.sh's
# default glob matches; the DATABASE dumped is DB_NAME (app_db).
DB_HOST=<db-host> DB_PORT=5432 \
DB_NAME=app_db DB_USER=app_user \
DB_PASSWORD_FILE=/run/secrets/db_password \
BACKUP_DIR=/var/backups/db \
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
| **RPO** (max data loss) | **≤ 24h** — the `db-backup` service now runs a `pg_dump` every 24h by default (`BACKUP_INTERVAL_SECONDS`), so at most a day of writes is lost between backups. Lower the interval (e.g. 6h) to tighten it. | ≤ 15m | WAL archiving / PITR, or a managed DB with continuous backup |
| **RTO** (time to restore) | Restore of a dump into a fresh instance; scales with DB size (validate by timing the drill) | ≤ 1h | Pre-provisioned standby / managed failover; rehearsed runbook |

- **RPO ≤ 24h is achieved today** by the scheduled `db-backup` service (§5.1)
  — an automated, encrypted, off-host `pg_dump` runs every 24h without any
  manual step. (Before that service existed, no backup ran automatically in the
  deployed stack and the effective RPO was "whenever someone last ran the
  script" — i.e. unbounded.) Tighten RPO below 24h by lowering
  `BACKUP_INTERVAL_SECONDS`; reach minutes-level RPO only with WAL/PITR below.
- **RPO ≤ 15m** requires **WAL/PITR** — continuous WAL archiving so you can
  replay to a point in time. That is not configured on the single-host `db`
  and requires either `archive_mode=on` + an `archive_command` shipping WAL
  off-host, or a managed database that does it for you.
- **RTO ≤ 1h** requires a rehearsed procedure and enough headroom to stand up a
  target instance quickly. Time a full drill on a production-sized backup to see
  where you actually land, then close the gap.

Validate both numbers by running the drill regularly and recording how long the
restore takes on a production-sized backup.

---

## 5. Known gaps (be honest about these)

### 5.1 Scheduled backups ARE now wired into the deploy (`db-backup`)

**Status: FIXED for logical dumps (OPS-02).** `docker/docker-compose.production.yml`
now includes a first-class **`db-backup`** service that runs
`api/scripts/backup-database.sh` on a schedule inside the swarm stack — no manual
host step. What it does:

| Aspect | Value |
| --- | --- |
| **Image** | `postgres:16-alpine` (pg16 client, matches the server; `bash`/`gzip`/`aws-cli` provisioned once at container start) |
| **Schedule** | loop with `sleep`; **every 24h** by default (`BACKUP_INTERVAL_SECONDS`, default `86400`) → **RPO ≤ 24h** |
| **Database** | the **same** DB as `db` — `DB_NAME=app_db`, `DB_USER=app_user`, password from the **same** `db_password` swarm secret via `DB_PASSWORD_FILE`. No `ailin_dev`. |
| **Encryption / offsite** | `pg_dump` custom format + gzip, uploaded to `s3://$S3_BUCKET/$S3_PREFIX/` with server-side encryption (`S3_SSE`, default `AES256`; set `aws:kms` + `S3_SSE_KMS_KEY_ID` for KMS) |
| **Retention** | local rotation via `RETENTION_DAYS` (script default 30; the service sets 7 through `BACKUP_RETENTION_DAYS`); off-host retention should be an **S3 lifecycle policy** on the bucket |
| **No duplicate runs** | `replicas: 1`, pinned to the dedicated ci node that also runs `db` (`placement: node.labels.ci-dedicated==true`); on top of that the script holds an `flock` on `BACKUP_DIR/.backup-database.lock`, so a second run (manual or scheduled) exits with `BACKUP FAILED reason=locked` instead of dumping twice |
| **Script delivery** | the container reads `/usr/local/bin/backup-database.sh` from a bind mount of `/opt/ailin/api/scripts/backup-database.sh` **on the node that runs the task** (the ci-dedicated node). The deploy workflow copies that file to the manager (`DEPLOY_HOST`) only, and warns on every deploy that changes it, so a change to the script reaches the service only through the manual in-place copy described below |
| **On failure** | a failed cycle logs `ERROR: backup cycle FAILED` and retries after `BACKUP_RETRY_SECONDS` (default 1800s); the scheduler stays alive |
| **Hung dump** | `pg_dump` connects with TCP keepalives and `tcp_user_timeout` (dead peer detected in ~2 min) and runs under `BACKUP_TIMEOUT_SECONDS` (default 10800 = 3h; full dumps take 40 to 51 min), then TERM, then KILL after `BACKUP_KILL_GRACE_SECONDS`; the run exits 124 and the retry path above takes over. These knobs (and `BACKUP_PG_*`) are script defaults: the service does not pass them through its environment yet, so changing them needs a compose change |
| **Partial dumps** | written as `.inprogress.<prefix>_<timestamp>.<pid>.partial` in `BACKUP_DIR` and renamed to `<prefix>_<timestamp>.sql.gz` only after verification; deleted on any failure, timeout or TERM/INT/HUP. A container stop KILLs the script (TERM only reaches the loop, PID 1), and the partial it leaves is deleted by the next run as soon as that run holds the lock |
| **Verification** | `pg_dump` and `gzip` exit 0, `pg_restore -l` lists at least one `TABLE DATA` entry, the whole gzip stream decompresses, and the archive ends with pg_dump's end-of-data marker; `.last-backup-success` is touched only after that |
| **Script updates while it runs** | the script's body is one `main()` function called from its last line, so bash parses the whole file before running anything and an in-place copy during a dump cannot make the running shell execute a mix of old and new code |

#### Incident 2026-09-23: hung pg_dump and truncated dumps under final names

A `pg_dump` started at 19:06 kept waiting on its socket for 2+ hours after the
`db` task behind it was stopped (the dump file stopped growing at 19:15:22), and
the scheduler loop waited on it, so no retry ran and the newest successful
backup was ~45 h old. Earlier failed runs had also left truncated files under
final backup names (1.2 GB, 20 bytes, 5.4 GB, 2.9 GB), because the old script
wrote straight to `<prefix>_<timestamp>.sql.gz` and never removed it on
failure. The current `api/scripts/backup-database.sh` handles this as the
table above describes, once it is the copy on the ci node (see "Script
delivery"). Its header documents every knob, and
`scripts/ci/test_backup_database.py` exercises success, a hang past the
timeout, a `pg_dump` error, truncated or empty archives, SIGTERM during the
dump, leftover partials, the lock and an in-place rewrite of the running
script with stub binaries.

Why `pg_restore -l` alone is not a sufficient check: pg_dump writes the whole
TOC before the table data, and `pg_restore -l` stops after the TOC. On the real
truncated files of 2026-09-23 it listed 1035 TOC entries and 102 `TABLE DATA`
entries and exited 0 for the 1.2 GB, 2.9 GB and 5.4 GB files (exactly like a
complete dump); only the 20-byte file failed. `pg_restore -l` run directly on
a `.sql.gz` file always fails ("input file does not appear to be a valid
archive"), complete or not, because the archive is gzip-wrapped, so the script
feeds it through `gunzip -c`. What the two other checks gave on the real files
(read on the manager, 2026-09-24):

| File | Full gzip read | Last 5 bytes of the archive | Caught by |
| --- | --- | --- | --- |
| `ailin_dev_20260923_175024` (20 B) | OK (valid empty gzip) | none | `pg_restore -l` ("input file is too short") |
| `ailin_dev_20260923_015154` (1.2 GB) | "unexpected end of file" | n/a | gzip CRC/length |
| `ailin_dev_20260923_190640` (2.9 GB) | "unexpected end of file" | n/a | gzip CRC/length |
| `ailin_dev_20260923_182024` (5.4 GB) | OK | `18 eb 44 14 d9` | end-of-data marker |
| `ailin_dev_20260915_215930` (8.9 GB) | OK | `96 6e e8 ac a3` | end-of-data marker |
| `ailin_dev_20260920_223243` (17.5 GB, complete) | OK | `00 00 00 00 00` | passes |

Truncated files written before this fix keep their final names. Retention
only runs on the node where the service runs, so the ones on the manager's
`app_db-backups` volume (the four 2026-09-23 files) are never pruned, and
`ailin_dev_20260915_215930` is truncated on both nodes. `restore-drill.sh` now
refuses all of them before starting a container.

**Updating the backup script on the ci node** (until the deploy syncs it):

1. Make sure no run is in progress, because the copy being replaced may be
   the old script, which is not safe to rewrite mid-run:
   `docker exec <app_db-backup container> ps -o pid,etime,args` must show only
   the loop and `sleep`, no `bash /usr/local/bin/backup-database.sh`. Runs
   start about 24 h after the last `.last-backup-success`, and every
   `BACKUP_RETRY_SECONDS` after a failure.
2. Copy the file from the merged commit over the existing one **in place**,
   for example `sudo cp /tmp/backup-database.sh
   /opt/ailin/api/scripts/backup-database.sh`. A single-file bind mount pins
   the inode, so `mv`, or any tool that writes a new file and renames it,
   would not reach the running container. `stat -c %i` must print the same
   inode before and after.
3. Check that `sha256sum /opt/ailin/api/scripts/backup-database.sh` on the
   node and `docker exec <container> sha256sum /usr/local/bin/backup-database.sh`
   both match `git show origin/main:api/scripts/backup-database.sh | sha256sum`.
4. After the next cycle the log shows
   `BACKUP START ... keepalives=60/10/6 tcp_user_timeout=120000ms`, then
   `Archive verified` and `BACKUP SUCCESS`.

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
  `ailin_dev_<timestamp>.sql.gz` (legacy label; the DB is `app_db`). Check with:
  `aws s3 ls s3://$S3_BUCKET/backups/ --recursive | tail`.
- **Log line** — the service logs a distinctive success line per cycle:
  `BACKUP SUCCESS db=app_db file=... offsite=yes`. Check with:
  `docker service logs app_db-backup 2>&1 | grep "BACKUP SUCCESS"`.
- **Service health** — `docker service ps app_db-backup` shows the task
  `Running`/healthy (the healthcheck confirms the scheduler loop is alive; it is
  **not** a staleness check — see below).

**Still recommended (infra-side, outside this repo):**
- **Alert on staleness** — the healthcheck only proves the loop is running, not
  that a recent backup *succeeded*. Alert when no new S3 object / no
  `BACKUP SUCCESS` log line has appeared in > N hours; a silently failing backup
  is indistinguishable from none.
- **Alert on `ERROR: backup cycle FAILED`** in the service logs. The script's
  own line just before it says why: `BACKUP FAILED reason=timeout`,
  `pg_dump_error`, `gzip_error`, `verify_failed`, `signal`, `locked`,
  `name_collision`, `unexpected_exit`, `upload`, `config` (bad settings or no
  password, found before anything runs) or `error`. A script that is KILLed
  (container stop, OOM) logs nothing, so anchor alerts on the loop's line,
  not on `reason=`.
- Add an **S3 lifecycle policy** for off-host retention/expiry.
- Run this **drill on a schedule** against the newest off-host backup and alert
  on a `FAIL`.
- (Non-swarm hosts) `api/scripts/setup-cron-backups.sh` is the host-cron
  fallback; it sources an env file (`/etc/db-backup.env`) so cron runs with
  the correct prod DB/S3 settings.

### 5.2 No HA and no PITR on the single-host DB/Redis

`db` and `redis` are single instances (see the `WARNING` comments in the
compose file). They **must stay at `replicas: 1`** — scaling them on a single
local volume would corrupt data (multiple primaries) or split queues/locks.

True production high availability and point-in-time recovery **cannot be done
inside this repo**. They require infrastructure provisioning outside it:

- **Postgres**: a managed, replicated service with automated failover and
  continuous backups/PITR (e.g. **Cloud SQL for PostgreSQL** in HA/regional
  config), or a self-managed primary/standby with streaming replication + WAL
  archiving.
- **Postgres HA remains entirely outside this repo** — no compose-level
  primary/standby topology exists for it today.

Until then, this drill + off-host encrypted dumps are the DR backstop — good
enough to recover from data loss with bounded RPO, **not** a substitute for HA.

**Redis update (audit 2026-09-08):** the money-path `redis` service (BullMQ
queues + the idempotency store — the one this section's Redis SPOF warning is
about; `redis-cache`, the general/evictable cache instance, is explicitly not
this concern) now has a real Sentinel-monitored primary + replica + 3-sentinel
topology **defined** in `docker/docker-compose.redis-sentinel.yml`, an
additive overlay applied with `docker stack deploy -c
docker-compose.production.yml -c docker-compose.redis-sentinel.yml`. The
application side (`REDIS_QUEUE_SENTINEL_ENABLED`/`REDIS_QUEUE_SENTINELS`/
`REDIS_QUEUE_SENTINEL_NAME` in `api/src/config/index.ts`, consumed by
`api/src/cache/redis-client.ts`'s ioredis Sentinel-mode branch) already
supports this transparently for every BullMQ Queue/Worker/QueueEvents
consumer and the idempotency store. This closes the "Redis: ... Sentinel/
Cluster" recommendation below **in code**, but the overlay is intentionally
NOT wired into `.github/workflows/flexible-cicd.yml` — applying it to the
running production stack, and giving the 3 Sentinels real hardware failure
isolation via multi-node Swarm placement, is a separate, operator-scheduled
step. See that file's header comment for the full topology, the quorum
reasoning, and the expected failover behavior.

---

## 6. What is REAL vs. documented-scaffolding

**Real and runnable today (in this repo):**
- `docker/backup/restore-drill.sh` — actually spins up an ephemeral Postgres,
  restores the newest backup, runs the sanity queries, prints PASS/FAIL, and
  cleans up. Runnable now given Docker + a backup file.
- `api/scripts/backup-database.sh` / `restore-database.sh` — working logical
  backup/restore scripts (custom-format `pg_dump`, encrypted S3 upload). The
  backup script now targets prod (`app_db`) by default, refuses the dev DB, and
  fails the run if a requested off-host upload fails.
- **`db-backup` service** in `docker/docker-compose.production.yml` — a
  scheduled (default 24h), off-host, encrypted backup job wired into the deployed
  stack, using the same DB creds/secret as `db` and running at `replicas: 1`
  so it never duplicates. This is what makes RPO **bounded (≤ 24h)** today (§5.1).
- The 2-replica stateless `api` service + `USE_BULLMQ_CRONS=true` (single cron
  execution across replicas) in `docker/docker-compose.production.yml`.
- `docker/docker-compose.redis-sentinel.yml` — a real Sentinel-monitored
  primary + replica + 3-sentinel topology for the money-path `redis` service,
  plus the application-side `REDIS_QUEUE_SENTINEL_*` config/connection
  plumbing it relies on (already shipped, covered by
  `api/src/cache/__tests__/redis-client.test.ts`). Validated with `docker
  compose config` (a full merge with `docker-compose.production.yml`
  resolves cleanly). **Defined and testable, NOT yet applied to
  production** — see §5.2.

**Documented recommendations — require infra provisioning outside this repo:**
- Managed, replicated Postgres HA + PITR (Cloud SQL HA or equivalent) — no
  compose-level topology exists for this yet, unlike Redis below.
- ~~Managed, replicated Redis HA (Memorystore HA or Sentinel/Cluster)~~ — the
  Sentinel/Cluster half of this is now defined in-repo (see above); what
  remains outside this repo is actually *applying* it to production and
  giving the 3 Sentinels independent hardware/AZ failure isolation (multi-node
  Swarm placement).
- **WAL archiving / PITR to reach the ≤15m RPO target — still MANUAL / not done.**
  The scheduled `db-backup` service gives ≤24h RPO with logical dumps but
  **no** point-in-time recovery. Continuous WAL archiving (`archive_mode=on` +
  an `archive_command` shipping WAL off-host, or a managed DB that does it) is a
  separate follow-up not covered by the backup service.
- Backup **staleness/failure alerting** and an **S3 lifecycle policy** for
  off-host retention (see §5.1) — operational glue outside the compose file.

Do not read the presence of this document as evidence that HA/PITR exist. They
do not yet; the drill proves the backstop works while that infrastructure is
provisioned.
