// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DiscoveryScheduler — periodic + on-demand discovery runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDiscoveryScheduler,
  resetDiscoveryShedulerForTesting,
} from '../discovery-scheduler';
import {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from '../operational-candidate-pool';
import {
  resetProviderDiscoveryServiceForTesting,
} from '../discovery-service';
import {
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { resetHealthSyncBusForTesting } from '../health-sync-bus';

describe('DiscoveryScheduler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetDiscoveryShedulerForTesting();
    resetOperationalCandidatePoolForTesting();
    resetProviderDiscoveryServiceForTesting();
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  afterEach(() => {
    const sched = getDiscoveryScheduler();
    sched.stop();
    process.env = { ...originalEnv };
  });

  it('triggerNow runs discovery and rebuilds pool', async () => {
    process.env.OAI_KEY = 'sk-test';

    const sched = getDiscoveryScheduler();
    sched.start({
      resolveProviders: () => [
        { providerId: 'foo', integrationClass: 'native-anthropic', apiKeyEnvVar: 'OAI_KEY' },
      ],
      resolveFallbackModels: () => ({
        foo: [{ modelId: 'bar' }],
      }),
      resolveIntegrationClasses: () => ({ foo: 'native-anthropic' }),
      initialDelayMs: 1_000_000, // never fire from interval
    });

    const snapshot = await sched.triggerNow();
    expect(snapshot).toBeDefined();
    expect(snapshot?.totalAvailable).toBe(1);
    expect(getOperationalCandidatePool().size()).toBe(1);
    expect(getOperationalCandidatePool().get('foo', 'bar')).toBeDefined();
  });

  it('marks unavailable provider but does not cascade', async () => {
    delete process.env.MISSING_KEY;
    process.env.OK_KEY = 'sk';

    const sched = getDiscoveryScheduler();
    sched.start({
      resolveProviders: () => [
        { providerId: 'broken', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'MISSING_KEY' },
        { providerId: 'ok', integrationClass: 'native-anthropic', apiKeyEnvVar: 'OK_KEY' },
      ],
      resolveFallbackModels: () => ({ ok: [{ modelId: 'm1' }] }),
      resolveIntegrationClasses: () => ({ broken: 'oai-compat-pure', ok: 'native-anthropic' }),
      initialDelayMs: 1_000_000,
    });

    const snapshot = await sched.triggerNow();
    expect(snapshot?.totalAvailable).toBe(1);
    expect(snapshot?.totalUnavailable).toBe(1);
    expect(getOperationalCandidatePool().get('ok', 'm1')).toBeDefined();
    expect(getOperationalCandidatePool().get('broken', 'whatever')).toBeUndefined();
  });

  it('triggerNow returns the same promise when called concurrently', async () => {
    process.env.K = 'sk';

    const sched = getDiscoveryScheduler();
    let resolveCount = 0;

    sched.start({
      resolveProviders: async () => {
        resolveCount++;
        // Slow resolver to overlap calls
        await new Promise((r) => setTimeout(r, 10));
        return [
          { providerId: 'p', integrationClass: 'native-anthropic', apiKeyEnvVar: 'K' },
        ];
      },
      resolveFallbackModels: () => ({ p: [{ modelId: 'm' }] }),
      resolveIntegrationClasses: () => ({ p: 'native-anthropic' }),
      initialDelayMs: 1_000_000,
    });

    const a = sched.triggerNow();
    const b = sched.triggerNow();
    await Promise.all([a, b]);
    expect(resolveCount).toBe(1); // second call coalesced into first
  });

  it('isRunning returns true after start', () => {
    const sched = getDiscoveryScheduler();
    expect(sched.isRunning()).toBe(false);
    sched.start({
      resolveProviders: () => [],
      initialDelayMs: 1_000_000,
    });
    expect(sched.isRunning()).toBe(true);
    sched.stop();
    expect(sched.isRunning()).toBe(false);
  });

  it('getLastSnapshot returns the most recent snapshot', async () => {
    process.env.K = 'sk';
    const sched = getDiscoveryScheduler();
    sched.start({
      resolveProviders: () => [
        { providerId: 'p', integrationClass: 'native-anthropic', apiKeyEnvVar: 'K' },
      ],
      initialDelayMs: 1_000_000,
    });
    expect(sched.getLastSnapshot()).toBeNull();
    await sched.triggerNow();
    expect(sched.getLastSnapshot()).not.toBeNull();
  });
});
