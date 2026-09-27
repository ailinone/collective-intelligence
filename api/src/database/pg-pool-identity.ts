// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Identity and liveness options shared by every pg.Pool this app opens: the
 * Prisma adapter pool (`database/client.ts`), the HCRA capability pool
 * (`capability/db/capability-pool.ts`) and the SAB candidate-index worker
 * pool (`core/selection/sab-candidate-index/worker.ts`).
 *
 * application_name: every app connection used to arrive with an empty
 * application_name and the same client_addr (the Swarm VIP SNATs every task
 * behind one overlay address, measured 2026-09-24), so pg_stat_activity
 * could not tell which process or which pool held a connection. Attribution
 * during the rollout connection storms had to be done with `nsenter ... ss`
 * per container. The name is `<service>-<pool>@<host>`: the service comes
 * from the same SERVICE_NAME / OTEL_SERVICE_NAME the logger and metrics use
 * (`ci-api` or `ci-worker` in production), and the host is the container
 * hostname, which tells an old task from a new one during a rollout.
 *
 * keepAlive: pg.Pool enables no TCP keepalive by default, so a connection
 * whose peer vanished (task killed, overlay path reset) is only noticed on
 * the next write. keepAliveInitialDelayMillis is set explicitly because the
 * pg default of 0 falls back to the kernel idle time (7200 s on Linux).
 * Server-side detection of dead clients (tcp_keepalives_* on Postgres) is a
 * separate, server configuration change.
 *
 * Dependency-free (node:os only): the SAB worker thread imports this and
 * must not evaluate `@/config` in its own realm.
 */
import { hostname } from 'node:os';

export type PgPoolRole = 'prisma' | 'capability' | 'sab';

/** Postgres keeps at most NAMEDATALEN - 1 bytes of application_name. */
export const PG_APPLICATION_NAME_MAX_LENGTH = 63;

export const PG_POOL_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

type ServiceEnv = Record<string, string | undefined>;

export function resolvePgApplicationName(
  role: PgPoolRole,
  env: ServiceEnv = process.env,
  host: string = hostname()
): string {
  const service = env.SERVICE_NAME || env.OTEL_SERVICE_NAME || 'ci-api';
  const raw = host ? `${service}-${role}@${host}` : `${service}-${role}`;
  // Postgres replaces non-printable-ASCII bytes with '?'; doing it here keeps
  // the value we log identical to the one pg_stat_activity shows.
  return raw.replace(/[^\x20-\x7e]/g, '?').slice(0, PG_APPLICATION_NAME_MAX_LENGTH);
}

export interface PgPoolIdentityOptions {
  application_name: string;
  keepAlive: true;
  keepAliveInitialDelayMillis: number;
}

export function pgPoolIdentityOptions(
  role: PgPoolRole,
  env: ServiceEnv = process.env,
  host: string = hostname()
): PgPoolIdentityOptions {
  return {
    application_name: resolvePgApplicationName(role, env, host),
    keepAlive: true,
    keepAliveInitialDelayMillis: PG_POOL_KEEPALIVE_INITIAL_DELAY_MS,
  };
}
