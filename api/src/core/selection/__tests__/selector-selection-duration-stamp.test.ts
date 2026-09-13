// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Selection runs inside the strategies, so the orchestration engine (the only
 * place that records `ci_model_selection_duration_ms`) cannot time it. The
 * selector therefore stamps the elapsed time onto the request-scoped context
 * it is handed, accumulating across calls. This drives the REAL selectModels()
 * with a provided candidate list (no DB search) and the Prisma boundary
 * mocked, same convention as recent-trend-batch.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: (cb: (tx: unknown) => unknown) => Promise.resolve(cb({ $queryRaw: vi.fn() })),
    model: { findMany: vi.fn().mockResolvedValue([]) },
    learningBucket: { findMany: vi.fn().mockResolvedValue([]) },
    modelPerformanceMetric: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

// The balance-enrichment step is try/catch-wrapped in the selector but its
// first call in-process pays a real connection-timeout tax (~10 s): reject
// fast instead, as long-context-delegation-real-path.test.ts does.
vi.mock('@/services/central-model-discovery-service', () => ({
  getCentralModelDiscoveryService: () =>
    Promise.reject(new Error('no discovery service in hermetic test')),
}));

// Lazy-imported by selectModels on its first call; irrelevant here and its
// module graph is slow to initialise.
vi.mock('@/core/operability', () => ({
  shouldSkipNearZero: () => ({ skip: false }),
}));

process.env.SELECTION_POPULARITY_SEED = 'false';

import { DynamicModelSelector } from '@/core/selection/dynamic-model-selector';
import type { Model, OrchestrationContext } from '@/types';

function makeModel(id: string, provider: string): Model {
  return {
    id,
    providerId: provider,
    provider,
    name: id,
    displayName: id,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: { latencyMs: 100, throughput: 50, quality: 0.8, reliability: 0.99 },
    status: 'active',
  };
}

function makeContext(): OrchestrationContext {
  return {
    organizationId: 'org-stamp',
    requestId: 'req-stamp',
    models: [],
    taskType: 'general',
    contextSize: 100,
  } as OrchestrationContext;
}

describe('selectModels stamps context.selectionDurationMs', () => {
  it('sets a non-negative duration on the first call and accumulates on the next', async () => {
    const selector = new DynamicModelSelector();
    const models = [makeModel('stamp-a', 'prov-a'), makeModel('stamp-b', 'prov-b')];
    const context = makeContext();
    expect(context.selectionDurationMs).toBeUndefined();

    await selector.selectModels(
      models,
      { taskType: 'general', complexity: 'low', contextSize: 100 },
      context,
      2
    );
    const first = context.selectionDurationMs;
    expect(typeof first).toBe('number');
    expect(first).toBeGreaterThanOrEqual(0);

    await selector.selectModels(
      models,
      { taskType: 'general', complexity: 'low', contextSize: 100 },
      context,
      2
    );
    expect(context.selectionDurationMs).toBeGreaterThanOrEqual(first as number);
  });

  it('does not share the stamp between different context objects', async () => {
    const selector = new DynamicModelSelector();
    const models = [makeModel('stamp-c', 'prov-c')];
    const a = makeContext();
    const b = makeContext();

    await selector.selectModels(
      models,
      { taskType: 'general', complexity: 'low', contextSize: 100 },
      a,
      1
    );

    expect(typeof a.selectionDurationMs).toBe('number');
    expect(b.selectionDurationMs).toBeUndefined();
  });
});
