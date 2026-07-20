// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderDiscoveryService — basic discovery flow.
 *
 * Tests cover:
 *  - configured providers appear in snapshot
 *  - missing env var → auth_failed (not silent removal)
 *  - probe error in one provider does NOT cascade
 *  - probe timeout produces partially_verified, not unavailable
 *  - listModels populates result.models
 *  - confidence levels reflect what was actually verified
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runProviderDiscovery,
  resetProviderDiscoveryServiceForTesting,
  type ConfiguredProvider,
  type ProviderProbeCallbacks,
} from '../discovery-service';
import {
  resetProviderHealthRegistryForTesting,
  getProviderHealthRegistry,
} from '../provider-health-registry';
import { clearTraceBufferForTesting, queryTraces } from '../candidate-trace';
import { resetMetricCountersForTesting, getCounterValueForTesting, METRIC_NAMES } from '../metrics';

describe('runProviderDiscovery', () => {
  const ENV_BACKUP = { ...process.env };

  beforeEach(() => {
    resetProviderDiscoveryServiceForTesting();
    resetProviderHealthRegistryForTesting();
    clearTraceBufferForTesting();
    resetMetricCountersForTesting();
  });

  afterEach(() => {
    process.env = { ...ENV_BACKUP };
  });

  it('publishes a snapshot with all configured providers', async () => {
    process.env.TEST_PROVIDER_A_KEY = 'sk-aaa';
    process.env.TEST_PROVIDER_B_KEY = 'sk-bbb';

    const providers: ConfiguredProvider[] = [
      { providerId: 'providerA', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'TEST_PROVIDER_A_KEY' },
      { providerId: 'providerB', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'TEST_PROVIDER_B_KEY' },
    ];

    const snapshot = await runProviderDiscovery(providers);

    expect(snapshot.totalConfigured).toBe(2);
    expect(snapshot.results.size).toBe(2);
    expect(snapshot.results.get('providerA')?.status).toBe('available');
    expect(snapshot.results.get('providerB')?.status).toBe('available');
  });

  it('marks provider with missing env var as auth_failed', async () => {
    delete process.env.NONEXISTENT_KEY;

    const snapshot = await runProviderDiscovery([
      { providerId: 'foo', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'NONEXISTENT_KEY' },
    ]);

    const result = snapshot.results.get('foo');
    expect(result?.status).toBe('unavailable');
    expect(result?.healthState).toBe('auth_failed');
    expect(result?.errorClass).toBe('auth_failed');
    expect(result?.includeInOperationalPool).toBe(false);
  });

  it('updates ProviderHealthRegistry on auth failure', async () => {
    delete process.env.MISSING_KEY;

    await runProviderDiscovery([
      { providerId: 'bar', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'MISSING_KEY' },
    ]);

    const registry = getProviderHealthRegistry();
    const record = registry.lookupExact({ providerId: 'bar' });
    expect(record?.state).toBe('auth_failed');
    expect(record?.nextProbeAfter).toBeDefined();
  });

  it('emits CandidateTrace events for every stage', async () => {
    process.env.TRACE_KEY = 'sk-trace';

    await runProviderDiscovery([
      { providerId: 'tracer', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'TRACE_KEY' },
    ]);

    const traces = queryTraces({ providerId: 'tracer', limit: 100 });
    const stages = new Set(traces.map((t) => t.stage));
    expect(stages.has('configured')).toBe(true);
    expect(stages.has('credential_validated')).toBe(true);
    expect(stages.has('operational_pool')).toBe(true);
  });

  it('one provider failing does not cascade to others', async () => {
    process.env.OK_KEY = 'sk-ok';
    delete process.env.BROKEN_KEY;

    const snapshot = await runProviderDiscovery([
      { providerId: 'broken', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'BROKEN_KEY' },
      { providerId: 'ok', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'OK_KEY' },
    ]);

    expect(snapshot.results.get('broken')?.status).toBe('unavailable');
    expect(snapshot.results.get('ok')?.status).toBe('available');
    expect(snapshot.totalAvailable).toBe(1);
    expect(snapshot.totalUnavailable).toBe(1);
  });

  it('credit probe exhausted → unavailable + insufficient_credit', async () => {
    process.env.CREDIT_KEY = 'sk-credit';

    const probeCallbacks: Record<string, ProviderProbeCallbacks> = {
      hubX: {
        probeCredit: async () => ({ status: 'exhausted', balanceUsd: 0, reason: 'balance is $0.00' }),
      },
    };

    const snapshot = await runProviderDiscovery(
      [{ providerId: 'hubX', integrationClass: 'aggregator-with-billing', apiKeyEnvVar: 'CREDIT_KEY' }],
      { probeCallbacks },
    );

    const result = snapshot.results.get('hubX');
    expect(result?.status).toBe('unavailable');
    expect(result?.healthState).toBe('insufficient_credit');
    expect(result?.errorClass).toBe('insufficient_credit');
  });

  it('listModels populates result.models', async () => {
    process.env.LM_KEY = 'sk-lm';

    const probeCallbacks: Record<string, ProviderProbeCallbacks> = {
      lister: {
        listModels: async () => [
          { modelId: 'foo', family: 'foo' },
          { modelId: 'bar', family: 'bar' },
        ],
      },
    };

    const snapshot = await runProviderDiscovery(
      [{ providerId: 'lister', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'LM_KEY' }],
      { probeCallbacks },
    );

    expect(snapshot.results.get('lister')?.models).toHaveLength(2);
  });

  it('partial verification when only credential checked (env_only)', async () => {
    process.env.PARTIAL_KEY = 'sk-partial';

    const snapshot = await runProviderDiscovery([
      { providerId: 'partial', integrationClass: 'native-anthropic', apiKeyEnvVar: 'PARTIAL_KEY' },
    ]);

    const result = snapshot.results.get('partial');
    expect(result?.status).toBe('available');
    // Anthropic strategy: credentialProbe=env_only, creditProbe=not_supported,
    // endpointProbe=not_supported. Confidence is 'inferred' (only env present).
    expect(result?.discoveryConfidence).toBe('inferred');
  });

  it('fully verified when credential + credit + listModels all pass', async () => {
    process.env.FULL_KEY = 'sk-full';

    const probeCallbacks: Record<string, ProviderProbeCallbacks> = {
      full: {
        probeCredit: async () => ({ status: 'has_credits', balanceUsd: 10 }),
        listModels: async () => [{ modelId: 'm1' }],
      },
    };

    const snapshot = await runProviderDiscovery(
      [{ providerId: 'full', integrationClass: 'aggregator-with-billing', apiKeyEnvVar: 'FULL_KEY' }],
      { probeCallbacks },
    );

    const result = snapshot.results.get('full');
    expect(result?.status).toBe('available');
    expect(result?.discoveryConfidence).toBe('verified');
    expect(result?.models).toHaveLength(1);
  });

  it('listModels timeout treats provider as available with partial confidence', async () => {
    process.env.SLOW_KEY = 'sk-slow';

    const probeCallbacks: Record<string, ProviderProbeCallbacks> = {
      slow: {
        listModels: () => new Promise((resolve) => {
          // Never resolves — will time out
          setTimeout(() => resolve([{ modelId: 'never' }]), 10_000);
        }),
      },
    };

    const snapshot = await runProviderDiscovery(
      [{ providerId: 'slow', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'SLOW_KEY' }],
      { probeCallbacks, perProviderTimeoutMs: 50 },
    );

    const result = snapshot.results.get('slow');
    expect(result?.status).toBe('available');
    // listModels failed → endpointVerified=false → inferred confidence
    expect(result?.discoveryConfidence).toBe('inferred');
    expect(result?.models).toHaveLength(0);
  });

  it('emits provider_configured_total for every provider', async () => {
    process.env.A = 'a';
    process.env.B = 'b';

    await runProviderDiscovery([
      { providerId: 'a', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'A' },
      { providerId: 'b', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'B' },
    ]);

    expect(getCounterValueForTesting(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: 'a' })).toBe(1);
    expect(getCounterValueForTesting(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: 'b' })).toBe(1);
  });

  it('emits provider_configured_but_not_discovered_total for unavailable providers', async () => {
    delete process.env.MISSING;

    await runProviderDiscovery([
      { providerId: 'missing', integrationClass: 'oai-compat-pure', apiKeyEnvVar: 'MISSING' },
    ]);

    const value = getCounterValueForTesting(
      METRIC_NAMES.PROVIDER_CONFIGURED_BUT_NOT_DISCOVERED_TOTAL,
      { providerId: 'missing', reason: 'missing env var: MISSING' },
    );
    expect(value).toBeGreaterThanOrEqual(1);
  });
});
