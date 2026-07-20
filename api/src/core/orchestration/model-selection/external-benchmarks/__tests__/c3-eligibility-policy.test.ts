// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §6 — c3-eligibility-policy unit tests.
 *
 * 10 cases covering all C3 eligibility determination paths.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateC3Eligibility,
  evaluateC3EligibilityBatch,
  C3_ELIGIBILITY_POLICY_VERSION,
  type C3EligibilityInput,
} from '@/core/orchestration/model-selection/external-benchmarks/c3-eligibility-policy';

function input(overrides: Partial<C3EligibilityInput> & Pick<C3EligibilityInput, 'modelId'>): C3EligibilityInput {
  return {
    externalBenchmarkUsed: true,
    matchConfidence: 'high',
    variantEvidence: 'not_applicable',
    aaSlug: 'test-model',
    aaName: 'Test Model',
    ...overrides,
  };
}

describe('01C.1B-J2-C-R6-HARDEN — evaluateC3Eligibility', () => {
  // ── Case 1: high + confirmed → C3_ELIGIBLE ───────────────────────────────
  it('high confidence + confirmed variant → C3_ELIGIBLE', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'deepseek-ai/DeepSeek-R1-0528',
      matchConfidence: 'high',
      variantEvidence: 'confirmed',
      aaSlug: 'deepseek-r1',
      aaName: "DeepSeek R1 0528 (May '25)",
    }));
    expect(r.c3Eligible).toBe(true);
    expect(r.status).toBe('C3_ELIGIBLE');
    expect(r.reason).toBe('eligible');
  });

  // ── Case 2: exact + confirmed → C3_ELIGIBLE ──────────────────────────────
  it('exact confidence + confirmed variant → C3_ELIGIBLE', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'anthropic/claude-opus-4-7',
      matchConfidence: 'exact',
      variantEvidence: 'confirmed',
      aaSlug: 'claude-opus-4-7',
    }));
    expect(r.c3Eligible).toBe(true);
    expect(r.status).toBe('C3_ELIGIBLE');
  });

  // ── Case 3: high + not_applicable → C3_ELIGIBLE ─────────────────────────
  it('high confidence + not_applicable variant → C3_ELIGIBLE', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'anthropic/claude-opus-4-7',
      matchConfidence: 'high',
      variantEvidence: 'not_applicable',
      aaSlug: 'claude-opus-4-7',
    }));
    expect(r.c3Eligible).toBe(true);
    expect(r.status).toBe('C3_ELIGIBLE');
    expect(r.reason).toBe('eligible');
  });

  // ── Case 4: high + probable → BLOCKED (variant_probable) ─────────────────
  it('high confidence + probable variant → BLOCKED (variant_probable_requires_waiver)', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'accounts/fireworks/models/kimi-k2p5',
      matchConfidence: 'high',
      variantEvidence: 'probable',
      aaSlug: 'kimi-k2-5-non-reasoning',
    }));
    expect(r.c3Eligible).toBe(false);
    expect(r.status).toBe('C3_BLOCKED');
    expect(r.reason).toBe('blocked_variant_probable_requires_waiver');
  });

  // ── Case 5: high + ambiguous → BLOCKED (variant_ambiguous) ───────────────
  it('high confidence + ambiguous variant → BLOCKED (variant_ambiguous)', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'some/model',
      matchConfidence: 'high',
      variantEvidence: 'ambiguous',
      aaSlug: 'some-model-vague',
    }));
    expect(r.c3Eligible).toBe(false);
    expect(r.status).toBe('C3_BLOCKED');
    expect(r.reason).toBe('blocked_variant_ambiguous');
  });

  // ── Case 6: medium + confirmed → BLOCKED (medium_confidence) ─────────────
  it('medium confidence + confirmed variant → BLOCKED (medium_confidence_requires_waiver)', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      matchConfidence: 'medium',
      variantEvidence: 'confirmed',
      aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
    }));
    expect(r.c3Eligible).toBe(false);
    expect(r.status).toBe('C3_BLOCKED');
    expect(r.reason).toBe('blocked_medium_confidence_requires_waiver');
  });

  // ── Case 7: medium + probable → BLOCKED (medium takes priority) ───────────
  it('medium confidence + probable variant → BLOCKED (medium_confidence_requires_waiver, medium takes priority)', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      matchConfidence: 'medium',
      variantEvidence: 'probable',
      aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
    }));
    expect(r.c3Eligible).toBe(false);
    expect(r.reason).toBe('blocked_medium_confidence_requires_waiver');
  });

  // ── Case 8: low confidence → BLOCKED (low_confidence) ────────────────────
  it('low confidence → BLOCKED (low_confidence)', () => {
    const r = evaluateC3Eligibility(input({
      modelId: 'some/model',
      matchConfidence: 'low',
      variantEvidence: 'confirmed',
    }));
    expect(r.c3Eligible).toBe(false);
    expect(r.reason).toBe('blocked_low_confidence');
  });

  // ── Case 9: no external benchmark → BLOCKED ───────────────────────────────
  it('no external_benchmark used → BLOCKED (no_external_benchmark)', () => {
    const r = evaluateC3Eligibility({
      modelId: 'some/model',
      externalBenchmarkUsed: false,
    });
    expect(r.c3Eligible).toBe(false);
    expect(r.reason).toBe('blocked_no_external_benchmark');
  });

  // ── Case 10: batch — the 4 R6 selected unique models ──────────────────────
  it('batch evaluation of 4 R6 selected models → 2 eligible, 2 blocked', () => {
    const batch: C3EligibilityInput[] = [
      // anthropic/claude-opus-4-7 — high exact, no variant indicator
      {
        modelId: 'anthropic/claude-opus-4-7',
        externalBenchmarkUsed: true,
        matchConfidence: 'high',
        variantEvidence: 'not_applicable',
        aaSlug: 'claude-opus-4-7',
        aaName: 'Claude Opus 4.7',
      },
      // deepseek-ai/DeepSeek-R1-0528 — high, version confirmed
      {
        modelId: 'deepseek-ai/DeepSeek-R1-0528',
        externalBenchmarkUsed: true,
        matchConfidence: 'high',
        variantEvidence: 'not_applicable',
        aaSlug: 'deepseek-r1',
        aaName: "DeepSeek R1 0528 (May '25)",
      },
      // accounts/fireworks/models/kimi-k2p5 — high, probable (non-reasoning not declared)
      {
        modelId: 'accounts/fireworks/models/kimi-k2p5',
        externalBenchmarkUsed: true,
        matchConfidence: 'high',
        variantEvidence: 'probable',
        aaSlug: 'kimi-k2-5-non-reasoning',
        aaName: 'Kimi K2.5 (Non-reasoning)',
      },
      // Qwen/Qwen3-235B-A22B-Thinking-2507 — medium, probable (Thinking↔Reasoning)
      {
        modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
        externalBenchmarkUsed: true,
        matchConfidence: 'medium',
        variantEvidence: 'probable',
        aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
        aaName: 'Qwen3 235B A22B 2507 (Reasoning)',
      },
    ];

    const summary = evaluateC3EligibilityBatch(batch);

    expect(summary.policyVersion).toBe(C3_ELIGIBILITY_POLICY_VERSION);
    expect(summary.totalEvaluated).toBe(4);
    expect(summary.c3EligibleCount).toBe(2);
    expect(summary.c3BlockedCount).toBe(2);
    expect(summary.allEligible).toBe(false);
    expect(summary.anyMediumConfidenceBlock).toBe(true);
    expect(summary.anyVariantBlock).toBe(true);

    // claude-opus and deepseek-r1 are eligible
    const claudeResult = summary.results.find((r) => r.modelId === 'anthropic/claude-opus-4-7');
    expect(claudeResult?.c3Eligible).toBe(true);
    const r1Result = summary.results.find((r) => r.modelId === 'deepseek-ai/DeepSeek-R1-0528');
    expect(r1Result?.c3Eligible).toBe(true);

    // kimi and qwen are blocked
    const kimiResult = summary.results.find((r) => r.modelId === 'accounts/fireworks/models/kimi-k2p5');
    expect(kimiResult?.c3Eligible).toBe(false);
    expect(kimiResult?.reason).toBe('blocked_variant_probable_requires_waiver');
    const qwenResult = summary.results.find((r) => r.modelId === 'Qwen/Qwen3-235B-A22B-Thinking-2507');
    expect(qwenResult?.c3Eligible).toBe(false);
    expect(qwenResult?.reason).toBe('blocked_medium_confidence_requires_waiver');
  });
});
