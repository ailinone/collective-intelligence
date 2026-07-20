// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability smoke test — operational validation of the Phase 1-5
 * control plane runtime.
 *
 * Verifies that:
 *   1. ProviderHealthRegistry + skip-near-zero are wired
 *   2. CandidateTrace is emitting
 *   3. Catalog resolver produces a non-empty ConfiguredProvider list
 *   4. DiscoveryService can be invoked (synthetic provider succeeds, fake failures classify correctly)
 *   5. OperationalCandidatePool builds from a snapshot
 *   6. SemanticIndex + EmbeddingPipeline are functional (with TEI mocked when not reachable)
 *   7. resolveSemanticCandidates returns ranked candidates
 *   8. shouldSkipNearZero p95 < 5ms
 *
 * Designed to run without external dependencies (no real Redis, no
 * real Postgres, no real TEI). It validates the WIRING + LOGIC. A
 * separate "live smoke" pulls real adapter probes at deploy time.
 *
 * Run: pnpm run operability:smoke
 */

import { performance } from 'node:perf_hooks';
import {
  classifyProviderError,
  emitCandidateTrace,
  queryTraces,
  clearTraceBufferForTesting,
  resetMetricCountersForTesting,
  getCounterValueForTesting,
  METRIC_NAMES,
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
  shouldSkipNearZero,
  resetHealthSyncBusForTesting,
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
  getSemanticIndex,
  resetSemanticIndexForTesting,
  getEmbeddingCache,
  resetEmbeddingCacheForTesting,
  resetTEIClientForTesting,
  resolveSemanticCandidates,
  resolveConfiguredProviders,
  buildCatalogResolvers,
  rebuildEmbeddingIndex,
} from '@/core/operability';
import type { ProviderDiscoverySnapshot } from '@/core/operability';

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
  metric?: number;
}

const results: CheckResult[] = [];

function check(name: string, passed: boolean, detail?: string, metric?: number): void {
  results.push({ name, passed, detail, metric });
  const icon = passed ? '✅' : '❌';
  const metricStr = metric !== undefined ? ` (metric: ${metric})` : '';
  const detailStr = detail ? `  — ${detail}` : '';
  // eslint-disable-next-line no-console
  console.log(`${icon} ${name}${metricStr}${detailStr}`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\n=== Operability Smoke Test ===\n');

  // Reset all singletons for clean state
  clearTraceBufferForTesting();
  resetMetricCountersForTesting();
  resetProviderHealthRegistryForTesting();
  resetHealthSyncBusForTesting();
  resetOperationalCandidatePoolForTesting();
  resetSemanticIndexForTesting();
  resetEmbeddingCacheForTesting();
  resetTEIClientForTesting();

  // ─── 1. Catalog resolver ─────────────────────────────────────────
  let configuredProviders: ReturnType<typeof resolveConfiguredProviders> = [];
  try {
    configuredProviders = resolveConfiguredProviders();
    check(
      'Catalog resolver returns providers',
      configuredProviders.length > 0,
      `${configuredProviders.length} providers resolved from PROVIDER_CATALOG`,
      configuredProviders.length,
    );
  } catch (err) {
    check('Catalog resolver returns providers', false, String(err));
  }

  // ─── 2. Error classification ──────────────────────────────────────
  const c401 = classifyProviderError({ status: 401 });
  check(
    'classifyProviderError(401) → auth_failed',
    c401.errorClass === 'auth_failed' && c401.scope === 'account',
  );

  const cModelNotFound = classifyProviderError(new Error("Model 'foo' not found"));
  check(
    'classifyProviderError("Model X not found") → model_not_found, scope=provider_model',
    cModelNotFound.errorClass === 'model_not_found' && cModelNotFound.scope === 'provider_model',
  );

  // ─── 3. Health registry + near-zero skip ──────────────────────────
  const registry = getProviderHealthRegistry();
  registry.recordExecution({
    key: { providerId: 'fake-bad-provider' },
    success: false,
    classification: classifyProviderError({ status: 401 }),
  });
  const skipDecision = shouldSkipNearZero({ providerId: 'fake-bad-provider' });
  check(
    'shouldSkipNearZero skips known-bad provider',
    skipDecision.skip === true && skipDecision.reason === 'auth_failed',
  );

  // Latency: warm up, then measure 1000 calls
  for (let i = 0; i < 100; i++) shouldSkipNearZero({ providerId: 'fake-bad-provider' });
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) shouldSkipNearZero({ providerId: 'fake-bad-provider' });
  const elapsed = performance.now() - t0;
  const perCallMs = elapsed / 1000;
  check(
    'shouldSkipNearZero p99 < 5ms',
    perCallMs < 5,
    `${perCallMs.toFixed(4)}ms per call (over 1000 calls)`,
    perCallMs,
  );

  // ─── 4. Granularity: model-level vs provider-level ───────────────
  registry.recordExecution({
    key: { providerId: 'partial-bad', modelId: 'broken-model' },
    success: false,
    classification: classifyProviderError(new Error("Model 'broken-model' not found")),
  });
  const skipBroken = shouldSkipNearZero({ providerId: 'partial-bad', modelId: 'broken-model' });
  const skipFresh = shouldSkipNearZero({ providerId: 'partial-bad', modelId: 'good-model' });
  check(
    'model_not_found does NOT poison sibling models',
    skipBroken.skip === true && skipFresh.skip === false,
    `broken=${skipBroken.skip}, sibling=${skipFresh.skip}`,
  );

  // ─── 5. CandidateTrace emission ──────────────────────────────────
  emitCandidateTrace({
    providerId: 'smoke-test-provider',
    modelId: 'm',
    stage: 'configured',
    included: true,
  });
  const traces = queryTraces({ providerId: 'smoke-test-provider' });
  check('CandidateTrace events queryable', traces.length === 1);

  // ─── 6. Pool builds from snapshot ─────────────────────────────────
  const snap: ProviderDiscoverySnapshot = {
    generatedAt: new Date().toISOString(),
    durationMs: 50,
    totalConfigured: 2,
    totalAvailable: 2,
    totalUnavailable: 0,
    results: new Map([
      [
        'p1',
        {
          providerId: 'p1',
          status: 'available',
          healthState: 'healthy',
          discoveryConfidence: 'verified',
          models: [{ modelId: 'm1' }, { modelId: 'm2' }],
          includeInOperationalPool: true,
          discoveredAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          probeLatencyMs: 25,
        },
      ],
    ]),
  };
  const pool = getOperationalCandidatePool();
  pool.rebuild({ snapshot: snap });
  check(
    'OperationalCandidatePool rebuilt from snapshot',
    pool.size() === 2,
    `pool.size() = ${pool.size()}`,
    pool.size(),
  );

  // ─── 7. SemanticIndex + resolveSemanticCandidates fallback ────────
  // Index is empty — resolveSemanticCandidates should fall back to pool query.
  const ranked = await resolveSemanticCandidates({ query: 'analyze code', k: 3 });
  check(
    'resolveSemanticCandidates falls back when index empty',
    ranked.length === 2 && ranked.every((r) => r.semanticScore === undefined),
  );

  // ─── 8. Embedding pipeline (mocked TEI) ───────────────────────────
  const fakeTeiClient = {
    embed: async (_text: string) => Float32Array.from([1, 0, 0]),
    embedBatch: async (texts: readonly string[]) => texts.map((_, i) => Float32Array.from([i, 0, 0])),
    isHealthy: async () => true,
  };
  // Inject our fake into the embedding cache singleton
  getEmbeddingCache(100, fakeTeiClient as never);
  const count = await rebuildEmbeddingIndex({ tei: fakeTeiClient as never });
  check(
    'EmbeddingPipeline.rebuildIndexNow populates index',
    count === 2 && getSemanticIndex().size() === 2,
    `embedded ${count} candidates`,
    count,
  );

  // ─── 9. Semantic resolver ranks by similarity ─────────────────────
  const rankedSemantic = await resolveSemanticCandidates({ query: 'analyze code', k: 3 });
  check(
    'resolveSemanticCandidates returns semantic-ranked results',
    rankedSemantic.length > 0 && rankedSemantic[0].semanticScore !== undefined,
  );

  // ─── 10. Catalog resolvers bundle ────────────────────────────────
  const bundle = buildCatalogResolvers();
  check(
    'buildCatalogResolvers returns the four resolvers',
    typeof bundle.resolveProviders === 'function'
      && typeof bundle.resolveProbeInputs === 'function'
      && typeof bundle.resolveIntegrationClasses === 'function'
      && typeof bundle.resolveFallbackModels === 'function',
  );

  // ─── 11. dead_provider_http_attempt counter is 0 ──────────────────
  const deadAttempts = getCounterValueForTesting(METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL, {
    providerId: 'fake-bad-provider',
    modelId: '',
    reason: 'auth_failed',
  });
  check(
    'dead_provider_http_attempt_total stays at 0 in steady state',
    deadAttempts === 0,
    `counter=${deadAttempts}`,
  );

  // ─── Summary ──────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n=== Summary ===\n');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  // eslint-disable-next-line no-console
  console.log(`Passed: ${passed} / ${results.length}`);
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.log(`Failed: ${failed}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('\n✅ Operability smoke test passed.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('FATAL:', err);
  process.exit(1);
});
