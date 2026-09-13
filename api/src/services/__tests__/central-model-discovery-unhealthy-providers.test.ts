// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * getProvidersWithoutHealthyDiscovery() — 2026-09-08 incident circuit
 * breaker.
 *
 * Real incident: at 05:00 UTC on 2026-09-08, pricing-integrity-job.ts's
 * autoDisableDelistedModels() mass-disabled 19,875 models (17% of the
 * catalog) in one run. Root cause: workers/queue-runner.ts (the process
 * that actually executes the pricing-integrity-check / model-discovery-hourly
 * cron payloads) never called loadSecretsIntoEnv(), so every provider
 * fetcher in this file that reads its credential straight off
 * process.env.<PROVIDER>_API_KEY at call time (openai-native,
 * anthropic-native, aws-bedrock-hub, orqai-hub, edenai-hub, ai302-hub,
 * routeway-hub, ...) silently discovered zero models — not because those
 * providers delisted anything, but because discovery for them was
 * completely blind in that process. `last_synced_at` staleness alone cannot
 * tell those two situations apart.
 *
 * getProvidersWithoutHealthyDiscovery() closes that gap: it flags a provider
 * only when EVERY discovery source that covers it has been attempted at
 * least once and NONE of them has ever reported a nonzero result on its
 * last attempt. pricing-integrity-job.ts's autoDisableDelistedModels() (see
 * jobs/__tests__/pricing-integrity-auto-disable.test.ts for the consumer
 * side) uses this to exempt a provider's stale rows from auto-disable while
 * its discovery is blind, without masking a genuinely broken source forever
 * (every tick it fires is logged at ERROR level).
 *
 * Deliberately source-name-agnostic: the method derives its answer purely
 * from `discoverySources`' declared `providers` coverage and
 * `sourceHealthMap`'s pre-existing, general-purpose per-source health
 * bookkeeping (modelsDiscoveredLast/totalAttempts) — nothing here hardcodes
 * the specific providers this incident happened to affect.
 *
 * Hermetic: constructs a real CentralModelDiscoveryService (same convention
 * as central-model-discovery-auto-reenable.test.ts) but replaces its
 * private discoverySources/sourceHealthMap maps directly, synchronously,
 * before any assertion — the constructor's background initializeSources()
 * promise (network/env-touching) never gets a chance to interleave since
 * every test body here is fully synchronous.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/database/client', () => ({ prisma: {} }));

import {
  CentralModelDiscoveryService,
  type DiscoverySource,
  type SourceHealthRecord,
} from '@/services/central-model-discovery-service';

type ServiceInternals = {
  discoverySources: Map<string, DiscoverySource>;
  sourceHealthMap: Map<string, SourceHealthRecord>;
};

function fakeSource(name: string, providers: string[]): DiscoverySource {
  return { name, type: 'native_api', priority: 1, providers, fetcher: async () => [] };
}

function fakeHealth(overrides: Partial<SourceHealthRecord>): SourceHealthRecord {
  return {
    sourceName: overrides.sourceName ?? 'unnamed',
    lastAttemptAt: new Date(),
    lastSuccessAt: null,
    consecutiveFailures: 0,
    failReason: null,
    retriable: false,
    backoffMs: 0,
    modelsDiscoveredLast: 0,
    totalAttempts: 1,
    totalSuccesses: 0,
    ...overrides,
  };
}

function makeService(
  sources: DiscoverySource[],
  health: Record<string, Partial<SourceHealthRecord>>
): CentralModelDiscoveryService {
  const service = new CentralModelDiscoveryService();
  const internals = service as unknown as ServiceInternals;
  internals.discoverySources = new Map(sources.map((s) => [s.name, s]));
  internals.sourceHealthMap = new Map(
    Object.entries(health).map(([name, h]) => [name, fakeHealth({ sourceName: name, ...h })])
  );
  return service;
}

describe('getProvidersWithoutHealthyDiscovery', () => {
  it('flags a provider whose sole discovery source reports zero models despite being attempted (the 2026-09-08 incident shape)', () => {
    const service = makeService([fakeSource('openai-native', ['openai'])], {
      'openai-native': { modelsDiscoveredLast: 0, totalAttempts: 5 },
    });

    expect(service.getProvidersWithoutHealthyDiscovery()).toEqual(new Set(['openai']));
  });

  it('does NOT flag a provider whose source has a healthy nonzero result', () => {
    const service = makeService([fakeSource('anthropic-native', ['anthropic'])], {
      'anthropic-native': { modelsDiscoveredLast: 12, totalAttempts: 5 },
    });

    expect(service.getProvidersWithoutHealthyDiscovery().has('anthropic')).toBe(false);
  });

  it('does NOT flag a provider that has never been attempted yet (no false positive right after boot — not enough signal)', () => {
    const service = makeService([fakeSource('brand-new-hub', ['brand-new'])], {});

    expect(service.getProvidersWithoutHealthyDiscovery().has('brand-new')).toBe(false);
  });

  it('does NOT flag a provider covered by multiple sources when at least one of them is healthy', () => {
    const service = makeService(
      [fakeSource('google-native', ['google']), fakeSource('vertex-ai-hub', ['google', 'vertex-ai'])],
      {
        'google-native': { modelsDiscoveredLast: 0, totalAttempts: 3 },
        'vertex-ai-hub': { modelsDiscoveredLast: 40, totalAttempts: 3 },
      }
    );

    expect(service.getProvidersWithoutHealthyDiscovery().has('google')).toBe(false);
  });

  it('flags multiple independently-broken providers in the same tick with no hardcoded provider list, and leaves a genuinely healthy provider alone', () => {
    const service = makeService(
      [
        fakeSource('aws-bedrock-hub', ['aws-bedrock']),
        fakeSource('orqai-hub', ['orqai']),
        fakeSource('featherless-ai-native', ['featherless-ai']),
      ],
      {
        'aws-bedrock-hub': { modelsDiscoveredLast: 0, totalAttempts: 14 },
        'orqai-hub': { modelsDiscoveredLast: 0, totalAttempts: 14 },
        // featherless-ai's real production behavior on the incident date:
        // still actively discovering (1.1% disabled = normal churn), NOT
        // part of the credential-loading bug.
        'featherless-ai-native': { modelsDiscoveredLast: 22159, totalAttempts: 14 },
      }
    );

    const unhealthy = service.getProvidersWithoutHealthyDiscovery();
    expect(unhealthy).toEqual(new Set(['aws-bedrock', 'orqai']));
    expect(unhealthy.has('featherless-ai')).toBe(false);
  });

  it('ignores the wildcard "*" provider marker (a catch-all source is not a per-provider health signal)', () => {
    const service = makeService([fakeSource('catch-all', ['*'])], {
      'catch-all': { modelsDiscoveredLast: 0, totalAttempts: 3 },
    });

    expect(service.getProvidersWithoutHealthyDiscovery().size).toBe(0);
  });

  it('returns an empty set when there are no discovery sources registered at all', () => {
    const service = makeService([], {});

    expect(service.getProvidersWithoutHealthyDiscovery().size).toBe(0);
  });
});
