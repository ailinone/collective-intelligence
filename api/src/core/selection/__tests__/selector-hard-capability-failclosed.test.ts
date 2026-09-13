// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Production-path hard-capability fail-closed integration test
 * (SOTA §19 + §20, 2026-09-03).
 *
 * Unlike capability-uri-matching.test.ts / semantic-search-evaluations.test.ts
 * (which pin the POLICY with locally-mirrored filters, reviewed at PR time),
 * this suite drives the REAL DynamicModelSelector.findModelsByRequirements —
 * production validation, production filtering, production mapping — with the
 * Prisma fetch mocked to return RANDOM-ID fixture rows. No selection logic
 * is reimplemented here.
 *
 * Invariant (SOTA §20): a hard functional capability requirement (vision,
 * reasoning, structured output, ...) may NOT be bypassed by a never-empty
 * failsafe. A pool with zero models declaring the requirement must yield a
 * zero-model result — unknown capability never satisfies a hard requirement.
 * The ONLY deferred capability is function_calling, which is verified at
 * execution time by the lazy probe (fc-pool-recovery wiring).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { prisma } from '@/database/client';
import { DynamicModelSelector } from '@/core/selection/dynamic-model-selector';
import type { ModelCapability } from '@/types';

function randomModelId(): string {
  return `model-id-generated-during-test-${randomBytes(6).toString('hex')}`;
}

interface FixtureCaps {
  caps: ModelCapability[];
}

function prismaRecord(id: string, { caps }: FixtureCaps) {
  return {
    id,
    uid: id,
    providerId: 'provider-fixture',
    provider: { name: 'provider-fixture' },
    name: id,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: caps,
    capabilityUris: [],
    performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
    status: 'active',
    metadata: {},
    usageCount: 0,
  };
}

const baseCriteria = {
  taskType: 'general' as const,
  complexity: 'medium' as const,
  contextSize: 1000,
};

describe('production selector: hard capability requirements fail closed', () => {
  let selector: DynamicModelSelector;
  let findManySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.SELECTION_POPULARITY_SEED = 'false';
    selector = new DynamicModelSelector();
    findManySpy = vi.spyOn(prisma.model, 'findMany');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SELECTION_POPULARITY_SEED;
  });

  it('returns ZERO models when no fixture declares the required vision capability', async () => {
    const blind = prismaRecord(randomModelId(), { caps: ['chat'] as ModelCapability[] });
    findManySpy.mockResolvedValue([blind]);

    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['vision'] as ModelCapability[],
    });

    // The dangerous old behavior restored the unfiltered pool here.
    expect(result).toHaveLength(0);
  });

  it('returns only the declaring models when the requirement IS satisfiable', async () => {
    const sighted = prismaRecord(randomModelId(), {
      caps: ['chat', 'vision'] as ModelCapability[],
    });
    const blind = prismaRecord(randomModelId(), { caps: ['chat'] as ModelCapability[] });
    findManySpy.mockResolvedValue([sighted, blind]);

    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['vision'] as ModelCapability[],
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(sighted.id);
  });

  it('reasoning + structured output use ALL-of semantics and fail closed when either is missing', async () => {
    const reasonOnly = prismaRecord(randomModelId(), {
      caps: ['chat', 'reasoning'] as ModelCapability[],
    });
    findManySpy.mockResolvedValue([reasonOnly]);

    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['reasoning', 'json_mode'] as ModelCapability[],
    });

    expect(result).toHaveLength(0);
  });

  it('function_calling remains DEFERRED (probe-gated at execution), not pool-dropped', async () => {
    const noFcDeclared = prismaRecord(randomModelId(), { caps: ['chat'] as ModelCapability[] });
    findManySpy.mockResolvedValue([noFcDeclared]);

    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['function_calling'] as ModelCapability[],
    });

    // NOT zero — FC is verified by the execution-time lazy probe instead
    expect(result.map((m) => m.id)).toContain(noFcDeclared.id);
  });

  it('tool_use + function_calling together (real production shape) do not wrongly exclude a model declaring only function_calling', async () => {
    // mapInferredCapabilities (orchestration-engine.ts) always pushes BOTH
    // 'tool_use' and 'function_calling' together for a tools-bearing
    // request — this is the shape actually sent to the selector in
    // production, never 'function_calling' alone. The two are aliases of
    // the SAME capability under the ontology (canonical id 'tools'), so a
    // model that declares only 'function_calling' (mirroring the real
    // Baidu ERNIE-4.x fetcher shape, which never independently tags
    // 'tool_use') must still be eligible — deferring 'function_calling'
    // while silently hard-enforcing its alias 'tool_use' would defeat the
    // whole point of the deferral.
    const baiduShaped = prismaRecord(randomModelId(), {
      caps: ['chat', 'function_calling'] as ModelCapability[],
    });
    findManySpy.mockResolvedValue([baiduShaped]);

    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['tool_use', 'function_calling'] as ModelCapability[],
    });

    expect(result.map((m) => m.id)).toContain(baiduShaped.id);
  });

  it('capability change upstream changes eligibility without code change (lifecycle proof)', async () => {
    const id = randomModelId();
    // One selection may issue several prisma.model.findMany calls (verified-hub
    // / popularity fallbacks), so drive the spy with a mutable fixture instead
    // of a one-shot queue that a mid-selection refetch would exhaust.
    let upstreamRecord = prismaRecord(id, { caps: ['chat', 'vision'] as ModelCapability[] });
    findManySpy.mockImplementation(async () => [upstreamRecord]);

    const before = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['vision'] as ModelCapability[],
    });
    expect(before.map((m) => m.id)).toEqual([id]);

    // "Upstream removes vision": same model id served without the capability
    selector = new DynamicModelSelector(); // bypass instance-level cache
    upstreamRecord = prismaRecord(id, { caps: ['chat'] as ModelCapability[] });
    const after = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['vision'] as ModelCapability[],
    });
    expect(after).toHaveLength(0);
  });
});
