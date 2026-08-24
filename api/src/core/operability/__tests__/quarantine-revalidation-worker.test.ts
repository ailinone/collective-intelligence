// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Workstream F (2026-08-17) — background quarantine revalidation worker.
 * A user request must never be the probe: the worker re-probes quarantined
 * providers out-of-band, restores on a healthy healthCheck, and refreshes
 * the quarantine signal when the provider still fails auth/billing.
 */
import { describe, expect, it } from 'vitest';
import { getProviderOperabilityHub } from '../../provider-operability-hub';
import { runQuarantineRevalidationOnce, type HealthCheckLike } from '../quarantine-revalidation-worker';

const adapter = (name: string, healthy: boolean, error?: string): HealthCheckLike => ({
  getName: () => name,
  healthCheck: async () => ({ healthy, error }),
});

describe('quarantine revalidation worker', () => {
  it('restores a provider whose healthCheck now succeeds', async () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-reval-restore';
    hub.recordExecution(key, false, 401, 'invalid api key');
    expect(hub.isProviderUsable(key)).toBe(false);

    const result = await runQuarantineRevalidationOnce({
      adapterLookup: (k) => (k === key ? adapter(key, true) : undefined),
      maxPerTick: 10,
    });
    expect(result.restored).toContain(key);
    expect(hub.isProviderUsable(key)).toBe(true);
  });

  it('refreshes quarantine when the probe still returns 401', async () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-reval-still-dead';
    hub.recordExecution(key, false, 401, 'invalid api key');

    const result = await runQuarantineRevalidationOnce({
      adapterLookup: (k) => (k === key ? adapter(key, false, '[401] API key not valid') : undefined),
    });
    expect(result.stillFailing).toContain(key);
    expect(hub.isProviderUsable(key)).toBe(false);
  });

  it('skips route-level keys and providers without an adapter (no state change)', async () => {
    const hub = getProviderOperabilityHub();
    hub.recordExecution('wf-reval-hub:openai', false, 401, 'invalid api key');
    const result = await runQuarantineRevalidationOnce({ adapterLookup: () => undefined });
    expect(result.skipped).toContain('wf-reval-hub:openai');
    expect(hub.isProviderUsable('wf-reval-hub:openai')).toBe(false);
  });

  it('treats a probe timeout as inconclusive (no restore, no extra penalty)', async () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-reval-slow';
    hub.recordExecution(key, false, 401, 'invalid api key');
    const never: HealthCheckLike = {
      getName: () => key,
      healthCheck: () => new Promise(() => {}) as never,
    };
    const result = await runQuarantineRevalidationOnce({
      adapterLookup: (k) => (k === key ? never : undefined),
      probeTimeoutMs: 20,
    });
    expect(result.skipped).toContain(key);
    expect(hub.isProviderUsable(key)).toBe(false);
  });
});
