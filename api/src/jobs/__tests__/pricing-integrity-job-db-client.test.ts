// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression / contract test — pricing-integrity-job.ts must route ALL
 * database access through the shared, early-captured Prisma client
 * (`prisma` from `@/database/client`), never an independently constructed
 * `pg.Pool`/`pg.Client` or a raw `process.env.DATABASE_URL` read.
 *
 * Why this file, why now: the 2026-09-07 "getaddrinfo ENOTFOUND old-db-host"
 * incident (see `capability/db/capability-pool.ts` and its test,
 * `jobs/__tests__/capability-materialise-job-db-host.test.ts`, and
 * `capability/assertions/__tests__/materialiser-db-host.test.ts`) was caused
 * by a module building its OWN Postgres connection from a lazily-read
 * `process.env.DATABASE_URL` — reassigned mid-boot by
 * `load-secrets-into-env.ts` to a stale GCP secret pointing at the
 * pre-rename Postgres host, instead of reusing the app's one
 * correctly-configured client. That anti-pattern has recurred more than
 * once in this codebase whenever a module reached for its own connection
 * instead of the shared one.
 *
 * pricing-integrity-job.ts was audited as part of the same incident sweep
 * (staleness-quarantine and auto-disable sweeps here were suspected of
 * silently never firing, which would be consistent with the same bug
 * class). The audit found this file already routes every query —
 * `quarantineStaleModels`, `autoDisableDelistedModels`,
 * `checkCrossTierPricing` — through `prisma`, imported from
 * `@/database/client`: the SAME client `database/client.ts` builds from
 * `config.database.url` at synchronous top-level import time, before
 * `load-secrets-into-env.ts` can reassign `process.env.DATABASE_URL`. It
 * does NOT independently construct a connection, so it never shared the
 * capability-pool.ts bug (its staleness/auto-disable mechanisms not firing,
 * if real, has a different root cause than a wrong DB host — this test only
 * rules out THIS bug class for this file).
 *
 * This test locks that fact down so a future edit cannot silently
 * reintroduce the anti-pattern (e.g. someone adding a raw `pg.Pool` "just
 * for one query" without realizing the divergence risk load-secrets-into-env
 * creates for anything that isn't captured early).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_PATH = join(__dirname, '..', 'pricing-integrity-job.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('pricing-integrity-job — DB connection sourcing (no independent pg connection)', () => {
  it('imports the shared Prisma client from @/database/client', () => {
    expect(source).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*['"]@\/database\/client['"]/);
  });

  it('never imports the raw `pg` driver directly', () => {
    expect(source).not.toMatch(/from\s+['"]pg['"]/);
    expect(source).not.toMatch(/require\(\s*['"]pg['"]\s*\)/);
  });

  it('never constructs its own Pool/Client', () => {
    expect(source).not.toMatch(/new\s+(pg\.)?Pool\s*\(/);
    expect(source).not.toMatch(/new\s+(pg\.)?Client\s*\(/);
  });

  it('never reads process.env.DATABASE_URL directly (would bypass the early-captured config.database.url)', () => {
    expect(source).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it('never references the stale pre-rename Postgres hostname or a raw DB_HOST override', () => {
    expect(source).not.toMatch(/old-db-host/);
    expect(source).not.toMatch(/process\.env\.DB_HOST/);
  });

  it('sanity: the shared client is actually used for both reads and writes, not just imported', () => {
    expect(source).toMatch(/prisma\.\$queryRaw/);
    expect(source).toMatch(/prisma\.model\.(update|updateMany)/);
  });
});
