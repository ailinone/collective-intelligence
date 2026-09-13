// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Resolves the DATABASE_URL the SAB worker's own pg.Pool uses.
 *
 * Prefers the URL the manager placed in `workerData` (taken from
 * `getRuntimeDatabaseUrl()` on the main thread, i.e. the early-captured
 * `config.database.url`, rerouted to the pooler when enabled). The manager
 * is started lazily on the first selection, AFTER `loadSecretsIntoEnv()` has
 * overwritten `process.env.DATABASE_URL` with the GCP secret (stale host
 * a stale internal DB hostname), and `new Worker()` snapshots `process.env` at that instant, so
 * neither `process.env.DATABASE_URL` nor a re-evaluated `@/config` inside
 * the worker realm can be trusted. `process.env.DATABASE_URL` stays as the
 * fallback for callers that spawn the worker without the field.
 */
export function resolveWorkerDatabaseUrl(
  data: { databaseUrl?: string } | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const url = data?.databaseUrl || env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'sab-candidate-index worker: DATABASE_URL is not set in this worker thread\'s environment ' +
        '(worker_threads inherit a snapshot of process.env taken at Worker construction time — ' +
        'if DATABASE_URL is set asynchronously by the main thread AFTER the worker is spawned, ' +
        'e.g. by Testcontainers in tests, the worker must be (re)spawned after that point).'
    );
  }
  return url;
}
