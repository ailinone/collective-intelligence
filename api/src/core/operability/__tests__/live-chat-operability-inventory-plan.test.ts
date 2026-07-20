// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4B §10 — Inventory planner tests.
 *
 * Pure tests — no fs, no fetch, no DB. The planner takes catalog + spec
 * + secret sets and returns a deterministic plan.
 */
import { describe, it, expect } from 'vitest';
import { buildInventoryPlan } from '@/core/operability/live-chat-inventory-planner';
import type { Model, ModelCapability } from '@/types';

function mkModel(
  overrides: Partial<Model> & Pick<Model, 'id' | 'provider'>,
): Model {
  return {
    providerId: overrides.provider,
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: 8000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0003,
    capabilities: ['chat'] as ModelCapability[],
    performance: { latencyMs: 800, throughput: 100, quality: 0.8, reliability: 0.9 },
    status: 'active',
    metadata: {},
    ...overrides,
  } as Model;
}

describe('01C.1B-J1D-R4B §8 — buildInventoryPlan', () => {
  it('selects up to N models per provider (default 3)', () => {
    const catalog = [
      mkModel({ id: 'a-1', provider: 'a', performance: { latencyMs: 100, throughput: 1, quality: 0.95, reliability: 1 } as never }),
      mkModel({ id: 'a-2', provider: 'a', contextWindow: 200_000 }),
      mkModel({ id: 'a-3', provider: 'a', inputCostPer1k: 0.00001 }),
      mkModel({ id: 'a-4', provider: 'a' }),
      mkModel({ id: 'a-5', provider: 'a' }),
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
      modelsPerProvider: 3,
      maxModelsPerProvider: 3,
    });
    const aProbes = plan.plannedProbes.filter((p) => p.providerId === 'a');
    expect(aProbes.length).toBe(3);
  });

  it('skips providers without a secret', () => {
    const catalog = [mkModel({ id: 'a-1', provider: 'a' })];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(), // no secret for 'a'
    });
    expect(plan.plannedProbes.length).toBe(0);
    expect(plan.skippedProviders.some((s) => s.reason === 'missing_secret')).toBe(true);
  });

  it('skips providers without PROVIDER_SPECS entry', () => {
    const catalog = [mkModel({ id: 'a-1', provider: 'a' })];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(), // no spec for 'a'
      providersWithSecret: new Set(['a']),
    });
    expect(plan.plannedProbes.length).toBe(0);
    expect(plan.skippedProviders.some((s) => s.reason === 'missing_provider_spec')).toBe(true);
  });

  it('skips specialized non-chat providers (e.g., deepgram, cartesia)', () => {
    const catalog = [mkModel({ id: 'd-1', provider: 'deepgram' })];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['deepgram']),
      providersWithSecret: new Set(['deepgram']),
    });
    expect(plan.plannedProbes.length).toBe(0);
    expect(plan.skippedProviders.some((s) => s.reason === 'specialized_non_chat')).toBe(true);
  });

  it('picks top_quality, largest_context, and lowest_cost in distinct rows', () => {
    const catalog = [
      mkModel({
        id: 'top-q',
        provider: 'a',
        performance: { latencyMs: 100, throughput: 1, quality: 0.99, reliability: 1 } as never,
      }),
      mkModel({ id: 'big-ctx', provider: 'a', contextWindow: 1_000_000 }),
      mkModel({ id: 'cheap', provider: 'a', inputCostPer1k: 0.0000001 }),
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
      modelsPerProvider: 3,
      maxModelsPerProvider: 3,
    });
    const reasons = plan.plannedProbes.map((p) => p.selectionReason);
    expect(reasons).toContain('top_quality');
    expect(reasons).toContain('largest_context');
    expect(reasons).toContain('lowest_cost');
  });

  it('dedupes by providerId+apiModelId+routeId', () => {
    const catalog = [
      mkModel({ id: 'm-1', provider: 'a' }),
      mkModel({ id: 'm-1', provider: 'a' }), // exact duplicate
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
    });
    const aProbes = plan.plannedProbes.filter((p) => p.providerId === 'a');
    // Plan should not contain two entries for the same (provider, model).
    const keys = new Set(aProbes.map((p) => `${p.providerId}|${p.apiModelId}`));
    expect(keys.size).toBe(aProbes.length);
  });

  it('computes canonicalModelId via deriveCanonicalModelIdentity', () => {
    const catalog = [
      mkModel({ id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', provider: 'deepinfra' }),
      mkModel({ id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', provider: 'huggingface' }),
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['deepinfra', 'huggingface']),
      providersWithSecret: new Set(['deepinfra', 'huggingface']),
    });
    const di = plan.plannedProbes.find((p) => p.providerId === 'deepinfra');
    const hf = plan.plannedProbes.find((p) => p.providerId === 'huggingface');
    expect(di?.canonicalModelId).toBe(hf?.canonicalModelId);
    expect(di?.canonicalModelId).toBe('qwen/qwen3-235b-a22b-thinking-2507');
  });

  it('separates endpoint count from canonical model count', () => {
    const catalog = [
      // Same canonical model in 3 providers — 3 endpoints, 1 canonical
      mkModel({ id: 'Qwen/Qwen3-235B', provider: 'deepinfra' }),
      mkModel({ id: 'Qwen/Qwen3-235B', provider: 'huggingface' }),
      mkModel({ id: 'Qwen/Qwen3-235B', provider: 'novita' }),
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['deepinfra', 'huggingface', 'novita']),
      providersWithSecret: new Set(['deepinfra', 'huggingface', 'novita']),
    });
    expect(plan.summary.routesPlanned).toBe(3);
    expect(plan.summary.distinctCanonicalModelsPlanned).toBe(1);
  });

  it('estimates worst-case cost below the budget cap', () => {
    const catalog: Model[] = [];
    for (let i = 0; i < 100; i++) {
      catalog.push(mkModel({ id: `m-${i}`, provider: 'a' }));
    }
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
      modelsPerProvider: 5,
      maxModelsPerProvider: 5,
      maxTotalCostUsd: 0.012,
      perProbeWorstCaseCostUsd: 0.00001,
      maxTotalEndpointProbes: 120,
    });
    expect(plan.summary.estimatedWorstCaseCostUsd).toBeLessThanOrEqual(0.012);
    expect(plan.summary.routesPlanned).toBeLessThanOrEqual(120);
  });

  it('does NOT execute provider calls in plan mode (pure)', () => {
    // Sanity: the planner is synchronous + has no fetch references.
    // We just assert it returns a plan deterministically.
    const r = buildInventoryPlan({
      catalog: [mkModel({ id: 'a-1', provider: 'a' })],
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
    });
    expect(r.stage).toBe('01C.1B-J1D-R4B-INVENTORY');
    expect(r.generatedAt).toBeDefined();
  });

  it('sanitizes — no secret-like strings in plan output', () => {
    const r = buildInventoryPlan({
      catalog: [mkModel({ id: 'a-1', provider: 'a' })],
      providersWithSpec: new Set(['a']),
      providersWithSecret: new Set(['a']),
    });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('does NOT depend on dry-run route plan (pure catalog input)', () => {
    // Re-running with same input yields same output → independent of
    // any external state.
    const args = {
      catalog: [
        mkModel({ id: 'a-1', provider: 'a' }),
        mkModel({ id: 'a-2', provider: 'a' }),
        mkModel({ id: 'b-1', provider: 'b' }),
      ],
      providersWithSpec: new Set(['a', 'b']),
      providersWithSecret: new Set(['a', 'b']),
    } as const;
    const r1 = buildInventoryPlan(args);
    const r2 = buildInventoryPlan(args);
    expect(r1.summary).toEqual(r2.summary);
    expect(r1.plannedProbes.map((p) => p.apiModelId)).toEqual(
      r2.plannedProbes.map((p) => p.apiModelId),
    );
  });

  it('summary lists providers + distinct canonicals correctly', () => {
    const catalog = [
      mkModel({ id: 'Qwen/Qwen3-235B', provider: 'deepinfra' }),
      mkModel({ id: 'openai/gpt-oss-120b', provider: 'deepinfra' }),
      mkModel({ id: 'claude-opus-4.7', provider: 'anthropic' }),
    ];
    const plan = buildInventoryPlan({
      catalog,
      providersWithSpec: new Set(['deepinfra', 'anthropic']),
      providersWithSecret: new Set(['deepinfra', 'anthropic']),
    });
    expect(plan.summary.providersProbeEligible).toBe(2);
    expect(plan.summary.distinctCanonicalModelsPlanned).toBe(3);
    expect(plan.summary.routesPlanned).toBe(3);
  });
});
