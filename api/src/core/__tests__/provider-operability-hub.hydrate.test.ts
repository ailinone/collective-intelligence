// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 2026-08-21 cold-restart fix (request 7CN_Dg8wWlEcA9FcadbxA):
 * a persisted `healthy` overlay hydrated dead providers (openrouter/phala/
 * nanogpt/cometapi all carried a stale `healthy` snapshot taken at the last
 * persist tick) straight to rank-0 primaries right after a deploy, burning
 * every pass's budget re-learning them. Hydration must only restore BAD
 * states — `healthy` must be re-proven by runtime signals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();

vi.mock('@/database/client.js', () => ({
  prisma: {
    providerOperabilitySnapshot: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');

describe('operability hub — hydrateFromStore skips healthy rows', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('rehydrates bad states but NOT healthy (healthy must be re-proven)', async () => {
    const hub = getProviderOperabilityHub();
    const future = new Date(Date.now() + 60_000);
    findMany.mockResolvedValue([
      {
        providerKey: 'hydrate-openrouter',
        state: 'healthy',
        reasonCode: 'operational',
        isNative: false,
        expiresAt: future,
      },
      {
        providerKey: 'hydrate-nanogpt',
        state: 'no_credits',
        reasonCode: 'runtime_credit_error',
        isNative: false,
        expiresAt: future,
      },
      {
        providerKey: 'hydrate-phala',
        state: 'auth_failed',
        reasonCode: 'runtime_auth_error',
        isNative: false,
        expiresAt: future,
      },
    ]);

    const { loaded, skippedHealthy } = await hub.hydrateFromStore();
    expect(loaded).toBe(2);
    expect(skippedHealthy).toBe(1);

    // Bad states restored — dead-skip / ranking can use them immediately.
    expect(hub.getProviderState('hydrate-nanogpt').operabilityState).toBe('no_credits');
    expect(hub.getProviderState('hydrate-phala').operabilityState).toBe('auth_failed');
    // Stale persisted healthy is NOT promoted — unknown until runtime proves it.
    expect(hub.getProviderState('hydrate-openrouter').operabilityState).toBe('unknown');
  });

  it('DB failure yields an empty overlay (cold start, no throw)', async () => {
    const hub = getProviderOperabilityHub();
    findMany.mockRejectedValue(new Error('db down'));
    const result = await hub.hydrateFromStore();
    expect(result).toEqual({ loaded: 0, skippedHealthy: 0 });
    expect(hub.getProviderState('hydrate-cold').operabilityState).toBe('unknown');
  });
});
