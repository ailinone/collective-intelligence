// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Interactive-transaction defaults handed to PrismaClient: untouched in
 * direct mode, and in pooler mode a maxWait that stays under pgbouncer's
 * QUERY_WAIT_TIMEOUT (10 s in compose) so a saturated pool surfaces as a
 * retryable P2028 instead of a connection killed by the pooler.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config', () => ({
  config: { database: { url: 'postgresql://ci_user:s3cr3t@db:5432/ci_db' } },
}));

import { resolveTransactionOptions } from '../connection-url';

const PGBOUNCER_QUERY_WAIT_TIMEOUT_MS = 10_000;

describe('resolveTransactionOptions', () => {
  it('is undefined in direct mode (Prisma defaults unchanged)', () => {
    expect(resolveTransactionOptions({})).toBeUndefined();
    expect(resolveTransactionOptions({ DATABASE_USE_POOLER: 'true' })).toBeUndefined();
  });

  it('sets maxWait 8000 / timeout 15000 in pooler mode', () => {
    expect(
      resolveTransactionOptions({ DATABASE_USE_POOLER: 'true', DATABASE_POOLER_HOST: 'pgbouncer' })
    ).toEqual({ maxWait: 8000, timeout: 15000 });
  });

  it('keeps maxWait below the documented QUERY_WAIT_TIMEOUT so the app error wins the race', () => {
    const options = resolveTransactionOptions({
      DATABASE_USE_POOLER: 'true',
      DATABASE_POOLER_HOST: 'pgbouncer',
    });
    expect(options!.maxWait).toBeLessThan(PGBOUNCER_QUERY_WAIT_TIMEOUT_MS);
  });
});
