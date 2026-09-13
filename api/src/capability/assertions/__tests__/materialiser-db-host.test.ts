// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression / contract test — `loadNarrowerMap` (and every other DB-touching
 * export in materialiser.ts) must use ONLY the `pool: Pool` it is given by
 * the caller, never construct or reach for a connection of its own.
 *
 * Why this matters (2026-09-07 incident context, ci-api production): a real
 * failed BullMQ job pulled directly from production Redis
 * (`bull:scheduled-tasks:failed`, job id
 * `repeat:capability-materialise:1788741900000`) showed:
 *
 *   failedReason: getaddrinfo ENOTFOUND ci-db
 *   stacktrace: Error: getaddrinfo ENOTFOUND ci-db
 *       at /app/node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
 *       at async loadNarrowerMap (/app/dist/capability/assertions/materialiser.js:114:22)
 *       at async materialiseAllCapabilities (/app/dist/capability/assertions/materialiser.js:211:25)
 *       at async Object.runCapabilityMaterialiseNow (/app/dist/jobs/capability-materialise-job.js:18:19)
 *
 * Root-cause audit for this incident: `materialiser.ts` itself never
 * constructs a connection. `loadNarrowerMap`, `materialiseAllCapabilities`,
 * `materialiseOneModel`, and `writeProjection` all take `pool: Pool` as a
 * parameter and only ever call `pool.query(...)` on that exact object — the
 * file's only reference to `pg` is `import type { Pool } from 'pg'` (a
 * type-only import; nothing in this module ever does `new pg.Pool(...)` or
 * reads a raw env var). The actual bug was one level up the call stack, in
 * the caller: `@/capability/db/capability-pool.ts`'s `getCapabilityPool()`
 * used to read `process.env.DATABASE_URL` lazily — reassigned mid-boot by
 * `load-secrets-into-env.ts` to a stale GCP secret pointing at the
 * pre-rename Postgres host `ci-db` — instead of the early-captured, frozen
 * `config.database.url` that `database/client.ts`'s Prisma pool already used
 * safely. That has since been fixed in `capability-pool.ts` (see its own
 * `__tests__/capability-pool.test.ts`, and
 * `jobs/__tests__/capability-materialise-job-db-host.test.ts` for the same
 * guarantee proven at the job call site).
 *
 * This test pins the OTHER half of the contract: materialiser.ts's exports
 * touch ONLY the pool they are handed, so a correct caller-side fix is
 * actually sufficient and cannot be silently undermined by this module
 * reaching for a different connection internally (now, or in a future
 * refactor).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadNarrowerMap, __resetNarrowerMapCacheForTests } from '../materialiser';

const SOURCE_PATH = join(__dirname, '..', 'materialiser.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

function recordingPool(rows: Array<{ uri: string; narrower: string[] | null }> = []): {
  pool: Pool;
  calls: Array<{ text: string; values: unknown[] | undefined }>;
} {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('materialiser.ts — connection sourcing (no independent pool)', () => {
  afterEach(() => {
    __resetNarrowerMapCacheForTests();
  });

  it('loadNarrowerMap queries ONLY the pool instance it is given, never a different one', async () => {
    const { pool, calls } = recordingPool([{ uri: 'x', narrower: ['y'] }]);
    const other = recordingPool();

    const result = await loadNarrowerMap(pool);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/FROM capability_ontology/);
    expect(other.calls).toHaveLength(0);
    expect(result.get('x')).toEqual(['y']);
  });

  it('has exactly one `pg` import, and it is the type-only `Pool` import (no value import of `pg`)', () => {
    const pgImportLines = source
      .split('\n')
      .map((line) => line.trimEnd()) // normalize CRLF line endings across platforms
      .filter((line) => /from\s+['"]pg['"]/.test(line));
    expect(pgImportLines).toHaveLength(1);
    expect(pgImportLines[0]).toMatch(/^import\s+type\s*\{\s*Pool\s*\}\s*from\s*['"]pg['"];?$/);
  });

  it('never constructs its own Pool/Client', () => {
    expect(source).not.toMatch(/new\s+(pg\.)?Pool\s*\(/);
    expect(source).not.toMatch(/new\s+(pg\.)?Client\s*\(/);
  });

  it('never reads DATABASE_URL/DB_HOST env vars or hardcodes the stale pre-rename host', () => {
    expect(source).not.toMatch(/process\.env\.DATABASE_URL/);
    expect(source).not.toMatch(/process\.env\.DB_HOST/);
    expect(source).not.toMatch(/ci-db/);
  });
});
