// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Configuration resilience toggles test
 *
 * Validates that FORCE_DISTRIBUTED_* environment flags
 * are read through the central config loader without mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalForceCircuits = process.env.FORCE_DISTRIBUTED_CIRCUITS;
const originalForceBuckets = process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS;

describe('config.resilience', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.FORCE_DISTRIBUTED_CIRCUITS;
    delete process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS;
  });

  afterEach(() => {
    vi.resetModules();
    process.env.FORCE_DISTRIBUTED_CIRCUITS = originalForceCircuits;
    process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS = originalForceBuckets;
  });

  it('should default to local fallback when flags are unset', async () => {
    const { config } = await import('@/config');

    expect(config.resilience.forceDistributedCircuits).toBe(false);
    expect(config.resilience.forceDistributedTokenBuckets).toBe(false);
  });

  it('should honour FORCE_DISTRIBUTED_* environment variables', async () => {
    process.env.FORCE_DISTRIBUTED_CIRCUITS = 'true';
    process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS = 'true';

    const { config } = await import('@/config');

    expect(config.resilience.forceDistributedCircuits).toBe(true);
    expect(config.resilience.forceDistributedTokenBuckets).toBe(true);
  });
});

