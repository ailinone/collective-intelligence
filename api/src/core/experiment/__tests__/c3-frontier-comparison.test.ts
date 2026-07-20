// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the frontier supplement config (c3-frontier-comparison,
 * 2026-07-05).
 *
 * The 7bb900e2 audit found the "single" arm never contained a current
 * flagship — resolveTopTierModels() picks 1 model per PROVIDER by
 * context/cost, which surfaces haiku/flash-lite-class models, not the
 * market frontier. These tests pin the election logic that closes that
 * gap:
 *
 *   1. One flagship per frontier family (gpt/claude-opus/gemini-pro/grok),
 *      NEWEST generation wins within the family.
 *   2. Downsized/specialty variants (fast/mini/codex/flash) can NEVER
 *      fill a flagship slot.
 *   3. Stale generations below the family floor (gemini-1.5-pro, grok-3)
 *      are excluded even when nothing newer exists.
 *   4. Date-token freshness parses (claude-3-opus-20240229 → 20240229)
 *      are clamped, not treated as generation 20 million.
 *   5. EXPERIMENT_FRONTIER_MODEL_IDS overrides the election with exact
 *      catalog ids, preserving operator order, skipping unknown ids.
 *   6. The built config always carries the three collective arms and the
 *      full verifiable subset (H-A against real flagships).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Catalog fixture: real flagship ids observed in the production catalog
// plus the decoys the election must reject.
const CATALOG = [
  // GPT family — 5.4 must beat 5.1; codex-mini is a variant decoy.
  row('openai/gpt-5.4', 'GPT-5.4', 'openai', 400_000),
  row('openai/gpt-5.1', 'GPT-5.1', 'openai', 400_000),
  row('openai/gpt-5.1-codex-mini', 'GPT-5.1 Codex mini', 'openai', 400_000),
  // Claude family — opus-4-7 must beat opus-4-6; the 2024 date-token id
  // must not win via its absurd parsed "generation" 20240229.
  row('anthropic/claude-opus-4-7', 'Claude Opus 4.7', 'anthropic', 200_000),
  row('anthropic/claude-opus-4-6', 'Claude Opus 4.6', 'anthropic', 200_000),
  row('anthropic/claude-3-opus-20240229', 'Claude 3 Opus (2024)', 'anthropic', 200_000),
  // Gemini family — only 'pro' qualifies; flash is a variant decoy;
  // 1.5-pro is below the generation floor.
  row('google/gemini-2.5-pro', 'Gemini 2.5 Pro', 'google', 1_000_000),
  row('google/gemini-2.0-flash', 'Gemini 2.0 Flash', 'google', 1_000_000),
  row('google/gemini-1.5-pro', 'Gemini 1.5 Pro', 'google', 2_000_000),
  // Grok family — 4.20 must beat plain 4; 'fast' variants and grok-3 are out.
  row('xai/grok-4.20-reasoning', 'Grok 4.20 Reasoning', 'xai', 256_000),
  row('xai/grok-4-fast-non-reasoning', 'Grok 4 Fast', 'xai', 2_000_000),
  row('xai/grok-3', 'Grok 3', 'xai', 131_072),
  // Non-chat row sharing a flagship name — must be structurally excluded.
  { ...row('openai/gpt-5.4-vision-only', 'GPT-5.4 Vision', 'openai', 400_000), capabilities: ['vision'] },
];

function row(id: string, displayName: string, provider: string, contextWindow: number) {
  return {
    id,
    displayName,
    contextWindow,
    inputCostPer1k: 0.005,
    capabilities: ['chat'],
    provider: { name: provider },
  };
}

vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      findFirst: vi.fn().mockResolvedValue(null),
      // The resolver's structural filters are all JS-side, so the mock can
      // return the full catalog regardless of the WHERE clause — exactly
      // like the real DB returning a superset the JS election narrows.
      findMany: vi.fn().mockImplementation(() => Promise.resolve(CATALOG)),
    },
  },
}));

vi.mock('@/services/credit-monitor-service', () => ({
  getCreditMonitorService: () => ({ hasCredits: () => true }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.EXPERIMENT_FRONTIER_MODEL_IDS;
  // vitest.config.ts sets mockReset:true (in addition to clearMocks/restoreMocks),
  // which wipes a mock's IMPLEMENTATION (not just its call history) before every
  // test — including implementations set inside a vi.mock() factory, which only
  // runs once at module-mock-setup time. Without re-asserting here, any test
  // that does NOT supply its own per-call mockImplementationOnce (i.e. relies on
  // this base CATALOG mock) sees `findMany`/`findFirst` return undefined instead
  // of a promise, which resolveFrontierModels' override path (line ~941) then
  // crashes on (`rows.filter` of undefined) and the default path silently
  // degrades to an empty array. Awaited so the re-assertion is in place before
  // the next test body runs (a fire-and-forget re-mock races the test start).
  const { prisma } = await import('@/database/client');
  (prisma.model.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(CATALOG));
});

afterEach(() => {
  delete process.env.EXPERIMENT_FRONTIER_MODEL_IDS;
});

describe('resolveFrontierModels — flagship election', () => {
  it('elects the top-2 newest per take-2 family and one per single-take family', async () => {
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const picked = await resolveFrontierModels();

    // gpt/gemini are take:2 (round 2: incumbent + newer release compared
    // side by side); with this catalog gemini has only one candidate above
    // the generation floor. Fable/Mythos specs are absent from this catalog
    // → arms omitted, run proceeds.
    expect(picked.map((m) => m.id)).toEqual([
      'openai/gpt-5.4',
      'openai/gpt-5.1',
      'anthropic/claude-opus-4-7',
      'google/gemini-2.5-pro',
      'xai/grok-4.20-reasoning',
    ]);
  });

  it('elects Fable/Mythos/GPT-5.6/Gemini-3.5 when present, keeping incumbents (round 2)', async () => {
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const extra = [
      row('anthropic/claude-fable-5', 'Claude Fable 5', 'anthropic', 300_000),
      row('anthropic/claude-mythos-5', 'Claude Mythos 5', 'anthropic', 300_000),
      row('openai/gpt-5.6', 'GPT-5.6', 'openai', 400_000),
      row('google/gemini-3.5-pro', 'Gemini 3.5 Pro', 'google', 1_000_000),
    ];
    const { prisma } = await import('@/database/client');
    (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve([...CATALOG, ...extra]),
    );

    const picked = await resolveFrontierModels();
    const ids = picked.map((m) => m.id);

    // New releases win the newest slot; incumbents stay via take:2.
    expect(ids).toContain('openai/gpt-5.6');
    expect(ids).toContain('openai/gpt-5.4'); // incumbent kept
    expect(ids).toContain('anthropic/claude-fable-5');
    expect(ids).toContain('anthropic/claude-mythos-5');
    expect(ids).toContain('google/gemini-3.5-pro');
    expect(ids).toContain('google/gemini-2.5-pro'); // incumbent kept
    expect(ids).toContain('anthropic/claude-opus-4-7');
    expect(ids).toContain('xai/grok-4.20-reasoning');
    // No id pinned twice (dedup across overlapping specs).
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a community-fork mis-election (mythos-9b-unhinged on huggingface)', async () => {
    // Regression for the round-2 mis-election: a broad substring match
    // (id.includes('mythos')) with no owner awareness let a HuggingFace
    // community fork win the "Claude Mythos 5" flagship slot outright,
    // since its family is 'unknown' to scoreModelFreshness (score forced
    // to 0) and the zero-floor spec (minGeneration: 0) treated that as a
    // pass. The canonical-owner gate must reject it: owner 'king3djbl' is
    // neither in CANONICAL_MODEL_OWNERS nor equal to the provider name.
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const fork = row('King3Djbl/mythos-9b-unhinged', 'Mythos 9B Unhinged', 'huggingface', 8_192);
    const { prisma } = await import('@/database/client');
    (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve([...CATALOG, fork]),
    );

    const picked = await resolveFrontierModels();
    const ids = picked.map((m) => m.id);

    expect(ids).not.toContain('King3Djbl/mythos-9b-unhinged');
    // The legitimate flagships are unaffected — the mythos spec is simply
    // absent (no canonical-owner candidate exists in this catalog).
    expect(ids).toEqual([
      'openai/gpt-5.4',
      'openai/gpt-5.1',
      'anthropic/claude-opus-4-7',
      'google/gemini-2.5-pro',
      'xai/grok-4.20-reasoning',
    ]);
  });

  it('never fills a flagship slot with a downsized/specialty variant', async () => {
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const picked = await resolveFrontierModels();
    const ids = picked.map((m) => m.id).join(',');

    expect(ids).not.toContain('codex-mini');
    expect(ids).not.toContain('fast');
    expect(ids).not.toContain('flash');
    expect(ids).not.toContain('vision-only');
  });

  it('excludes stale generations below the family floor and date-token parses', async () => {
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const picked = await resolveFrontierModels();
    const ids = picked.map((m) => m.id);

    // grok-3 and gemini-1.5-pro are below their family floors.
    expect(ids).not.toContain('xai/grok-3');
    expect(ids).not.toContain('google/gemini-1.5-pro');
    // claude-3-opus-20240229 parses to "generation 20240229" — the sanity
    // clamp must zero it out instead of letting it beat opus-4-7.
    expect(ids).not.toContain('anthropic/claude-3-opus-20240229');
  });

  it('EXPERIMENT_FRONTIER_MODEL_IDS pins exact ids, keeps order, skips unknowns', async () => {
    process.env.EXPERIMENT_FRONTIER_MODEL_IDS =
      'xai/grok-4.20-reasoning, openai/gpt-5.4, made-up/not-in-db';
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const picked = await resolveFrontierModels();

    expect(picked.map((m) => m.id)).toEqual(['xai/grok-4.20-reasoning', 'openai/gpt-5.4']);
  });

  it('caps the pinned singles at maxModels', async () => {
    const { resolveFrontierModels } = await import('../c3-experiment-configs');
    const picked = await resolveFrontierModels({ maxModels: 2 });
    expect(picked.length).toBe(2);
  });
});

describe('buildC3FrontierComparison — config structure', () => {
  it('is registered in C3_CONFIG_BUILDERS', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');
    expect(C3_CONFIG_BUILDERS['c3-frontier-comparison']).toBeDefined();
  });

  it('carries the flagship singles as pinned single-model arms', async () => {
    const { buildC3FrontierComparison } = await import('../c3-experiment-configs');
    const config = await buildC3FrontierComparison();

    const singles = config.modes.filter((m) => m.mode === 'single-model');
    expect(singles.map((m) => (m as { modelId?: string }).modelId).sort()).toEqual([
      'anthropic/claude-opus-4-7',
      'google/gemini-2.5-pro',
      'openai/gpt-5.1',
      'openai/gpt-5.4',
      'xai/grok-4.20-reasoning',
    ]);
  });

  it('carries exactly the three surviving collective arms', async () => {
    const { buildC3FrontierComparison } = await import('../c3-experiment-configs');
    const config = await buildC3FrontierComparison();

    const collectives = config.modes.filter((m) => m.mode === 'collective');
    expect(collectives.map((m) => (m as { strategy?: string }).strategy).sort()).toEqual([
      'blind-debate',
      'consensus',
      'expert-panel',
    ]);
  });

  it('runs the full verifiable subset plus a stratified sample of the same suite', async () => {
    const { buildC3FrontierComparison, VERIFIABLE_TASK_INDICES } = await import(
      '../c3-experiment-configs'
    );
    const config = await buildC3FrontierComparison();

    for (const idx of VERIFIABLE_TASK_INDICES) {
      expect(config.taskIndices, `verifiable task ${idx} must be included`).toContain(idx);
    }
    // Stratified sample reaches beyond the verifiable block.
    expect(config.taskIndices.some((i) => i < 116)).toBe(true);
    // Sorted, deduplicated.
    expect(config.taskIndices).toEqual([...new Set(config.taskIndices)].sort((a, b) => a - b));
  });

  it('is cost-guarded (supplement budget, small warmup, learning frozen)', async () => {
    const { buildC3FrontierComparison } = await import('../c3-experiment-configs');
    const config = await buildC3FrontierComparison();

    expect(config.maxBudgetUsd).toBeLessThanOrEqual(250);
    // Arm-bucket starvation guard (2026-07-05): maxBudget / #arms must
    // clear the observed worst-case collective arm (~$35).
    expect(config.maxBudgetUsd / config.modes.length).toBeGreaterThanOrEqual(20);
    expect(config.warmupExecutions).toBeLessThanOrEqual(10);
    expect(config.freezeLearningDuringEval).toBe(true);

    const overridden = await buildC3FrontierComparison({
      maxBudgetUsd: 25,
      repetitions: 1,
      taskIndices: [116, 117],
    });
    expect(overridden.maxBudgetUsd).toBe(25);
    expect(overridden.repetitions).toBe(1);
    expect(overridden.taskIndices).toEqual([116, 117]);
  });

  it('c3-frontier-ha-topup: collectives-only on the verifiable subset, arm-budget-safe', async () => {
    // Completes the H-A sample that 9590ff41's silent arm_budget_exceeded
    // skips truncated. Invariants: NO single-model arms (the flagships
    // already have 2 full reps on 116-125), exactly the three collective
    // arms, exactly the verifiable tasks, and a budget whose per-arm bucket
    // (maxBudget / #arms) clears the observed worst case (~$4/arm).
    const { buildC3FrontierHaTopup, VERIFIABLE_TASK_INDICES } = await import(
      '../c3-experiment-configs'
    );
    const config = buildC3FrontierHaTopup();

    expect(config.modes.every((m) => m.mode === 'collective')).toBe(true);
    expect(config.modes.map((m) => (m as { strategy?: string }).strategy).sort()).toEqual([
      'blind-debate',
      'consensus',
      'expert-panel',
    ]);
    expect(config.taskIndices).toEqual([...VERIFIABLE_TASK_INDICES]);
    expect(config.maxBudgetUsd / config.modes.length).toBeGreaterThanOrEqual(5);
    expect(config.freezeLearningDuringEval).toBe(true);
  });

  it('c3-hb-mixed-minirun: own single + mixed forced pools + baselines (H-B)', async () => {
    process.env.OWN_MODEL_ENABLED = 'true';
    try {
      const { prisma } = await import('@/database/client');
      const ollamaRow = {
        id: 'qwen3:8b', displayName: 'Qwen3 8B (VPS)', contextWindow: 32768,
        inputCostPer1k: 0, capabilities: ['chat'], provider: { name: 'ollama' },
      };
      const cheap1 = row('openai/gpt-4o-mini', 'GPT-4o mini', 'openai', 128000);
      const cheap2 = row('anthropic/claude-haiku', 'Claude Haiku', 'anthropic', 200000);
      (prisma.model.findMany as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => Promise.resolve([ollamaRow]))      // resolveOwnModels
        .mockImplementationOnce(() => Promise.resolve([cheap1, cheap2])); // resolveBudgetModels

      const { buildC3HbMixedMiniRun, VERIFIABLE_TASK_INDICES } = await import(
        '../c3-experiment-configs'
      );
      const config = await buildC3HbMixedMiniRun();

      const singles = config.modes.filter((m) => m.mode === 'single-model');
      expect(singles.map((m) => (m as { modelId?: string }).modelId)).toEqual([
        'qwen3:8b',
        'openai/gpt-4o-mini',
      ]);
      const forced = config.modes.filter((m) => m.mode === 'forced-pool-collective');
      expect(forced.map((m) => (m as { strategy?: string }).strategy).sort()).toEqual([
        'consensus',
        'sensitivity-consensus',
      ]);
      for (const f of forced) {
        expect((f as { forcedModelPool: string[] }).forcedModelPool).toEqual([
          'qwen3:8b', 'openai/gpt-4o-mini', 'anthropic/claude-haiku',
        ]);
      }
      for (const idx of VERIFIABLE_TASK_INDICES) {
        expect(config.taskIndices).toContain(idx);
      }
      expect(config.maxBudgetUsd).toBeLessThanOrEqual(20);
    } finally {
      delete process.env.OWN_MODEL_ENABLED;
    }
  });

  it('documents the pinned non-competitor judge requirement in the description', async () => {
    // All four flagship families are contestants in this config — a judge
    // from any of them self-grades. The description is the operator-facing
    // surface where that protocol requirement must survive refactors.
    const { buildC3FrontierComparison } = await import('../c3-experiment-configs');
    const config = await buildC3FrontierComparison();
    expect(config.description).toMatch(/EXPERIMENT_JUDGE_MODEL/);
    expect(config.description).toMatch(/[Jj]udge/);
  });
});
