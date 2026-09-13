// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test — the capability-materialise job must source its Postgres
 * connection through the shared, correctly-configured `getCapabilityPool()`
 * (built from `config.database.url`), never a connection that can diverge
 * onto a stale host.
 *
 * Real production evidence (2026-09-07 incident, ci-api): a failed BullMQ
 * job pulled directly from `bull:scheduled-tasks:failed`
 * (`repeat:capability-materialise:1788741900000`) —
 *
 *   failedReason: getaddrinfo ENOTFOUND old-db-host
 *   stacktrace: Error: getaddrinfo ENOTFOUND old-db-host
 *       at .../pg-pool/index.js:45:11
 *       at async loadNarrowerMap (/app/dist/capability/assertions/materialiser.js:114:22)
 *       at async materialiseAllCapabilities (/app/dist/capability/assertions/materialiser.js:211:25)
 *       at async Object.runCapabilityMaterialiseNow (/app/dist/jobs/capability-materialise-job.js:18:19)
 *
 * Root cause (confirmed by reading materialiser.ts and this job in full):
 * `materialiser.ts` never constructs its own connection — every DB-touching
 * export takes `pool: Pool` as a parameter (see
 * `capability/assertions/__tests__/materialiser-db-host.test.ts`). The bug
 * was one level up: `getCapabilityPool()` (`capability/db/capability-pool.ts`)
 * used to read `process.env.DATABASE_URL` lazily, on first real use — well
 * after `load-secrets-into-env.ts` reassigns that env var mid-boot from a
 * stale GCP secret pointing at a pre-rename Postgres host. Prisma
 * was unaffected because `database/client.ts` captures `config.database.url`
 * at synchronous top-level import time, before the reassignment.
 * `getCapabilityPool()` has since been fixed to read `config.database.url`
 * the same way (see `capability/db/__tests__/capability-pool.test.ts`, which
 * proves the pool-construction fix in isolation).
 *
 * This test closes the loop at the JOB level: it proves
 * `runCapabilityMaterialiseNow()` actually feeds `materialiseAllCapabilities`
 * the pool `getCapabilityPool()` returns — i.e. the fixed, config-sourced
 * connection — and not some other, independently-resolved one. Uses the same
 * mocked-config-vs-stale-env divergence technique as
 * `capability-pool.test.ts` so a regression in either module trips this test
 * too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DATABASE_URL = 'postgresql://ci_user:secret@db:5432/ci_db';
const STALE_ENV_DATABASE_URL = 'postgresql://ci_user:secret@old-db-host:5432/ci_db';

vi.mock('@/config', () => ({
  config: {
    database: {
      url: CONFIG_DATABASE_URL,
    },
  },
}));

const materialiseAllCapabilitiesMock = vi.fn().mockResolvedValue({
  modelsWritten: 0,
  modelsCleared: 0,
  capabilitiesEmitted: 0,
  capabilitiesSuppressed: 0,
  elapsedMs: 0,
});

vi.mock('@/capability/assertions/materialiser', () => ({
  materialiseAllCapabilities: materialiseAllCapabilitiesMock,
}));

const JOB_SOURCE_PATH = join(__dirname, '..', 'capability-materialise-job.ts');
const jobSource = readFileSync(JOB_SOURCE_PATH, 'utf8');

describe('capability-materialise-job — DB connection sourcing (2026-09-07 incident)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDisabled = process.env.HCRA_MATERIALISE_DISABLED;

  beforeEach(() => {
    vi.resetModules();
    materialiseAllCapabilitiesMock.mockClear();
    // Simulate the production divergence: process.env.DATABASE_URL has
    // already been overwritten (by load-secrets-into-env.ts, from the stale
    // GCP secret) to a DIFFERENT host than config.database.url captured
    // early. If the job (or getCapabilityPool) ever regresses to reading
    // process.env directly, this test will see the stale placeholder host.
    process.env.DATABASE_URL = STALE_ENV_DATABASE_URL;
    delete process.env.HCRA_MATERIALISE_DISABLED;
  });

  afterEach(async () => {
    const { closeCapabilityPool } = await import('@/capability/db/capability-pool');
    await closeCapabilityPool();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDisabled === undefined) delete process.env.HCRA_MATERIALISE_DISABLED;
    else process.env.HCRA_MATERIALISE_DISABLED = originalDisabled;
    vi.resetModules();
  });

  it('passes materialiseAllCapabilities a pool built from config.database.url, not the stale process.env.DATABASE_URL', async () => {
    const { runCapabilityMaterialiseNow } = await import('../capability-materialise-job');

    await runCapabilityMaterialiseNow();

    expect(materialiseAllCapabilitiesMock).toHaveBeenCalledTimes(1);
    const [poolArg] = materialiseAllCapabilitiesMock.mock.calls[0] as [
      { options: { connectionString: string } },
    ];
    expect(poolArg.options.connectionString).toBe(CONFIG_DATABASE_URL);
    expect(poolArg.options.connectionString).not.toBe(STALE_ENV_DATABASE_URL);
    expect(poolArg.options.connectionString).not.toContain('old-db-host');
  });

  it('uses the SAME pool instance getCapabilityPool() returns — no independently-constructed connection', async () => {
    const { runCapabilityMaterialiseNow } = await import('../capability-materialise-job');
    const { getCapabilityPool } = await import('@/capability/db/capability-pool');

    await runCapabilityMaterialiseNow();

    const [poolArg] = materialiseAllCapabilitiesMock.mock.calls[0];
    expect(poolArg).toBe(getCapabilityPool());
  });

  it('sources its pool via the shared getCapabilityPool() import, not a raw `pg` import or env read', () => {
    expect(jobSource).toMatch(
      /import\s*\{\s*getCapabilityPool\s*\}\s*from\s*['"]@\/capability\/db\/capability-pool['"]/
    );
    expect(jobSource).not.toMatch(/from\s+['"]pg['"]/);
    expect(jobSource).not.toMatch(/new\s+(pg\.)?Pool\s*\(/);
    expect(jobSource).not.toMatch(/process\.env\.DATABASE_URL/);
    expect(jobSource).not.toMatch(/old-db-host/);
  });
});
