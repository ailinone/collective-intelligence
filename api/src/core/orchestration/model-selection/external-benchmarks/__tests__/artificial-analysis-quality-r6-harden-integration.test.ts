// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §11 — End-to-end integration test.
 *
 * Exercises the full pipeline for the 4 unique R6 selected models:
 *   assessVariantEvidence → evaluateC3Eligibility → C3EligibilitySummary
 *
 * Expected outcome:
 *   C3_ELIGIBLE = 2 (claude-opus-4-7, deepseek-ai/DeepSeek-R1-0528)
 *   C3_BLOCKED  = 2 (kimi-k2p5, Qwen3-235B-A22B-Thinking-2507)
 *
 * Decision phrase: CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS
 */
import { describe, it, expect } from 'vitest';
import { assessVariantEvidence } from '@/core/orchestration/model-selection/external-benchmarks/model-variant-evidence';
import {
  evaluateC3EligibilityBatch,
  C3_ELIGIBILITY_POLICY_VERSION,
} from '@/core/orchestration/model-selection/external-benchmarks/c3-eligibility-policy';

/** Representative AA match data for each of the 4 R6 selected models. */
const R6_SELECTED_AA_MATCHES = [
  {
    modelId: 'anthropic/claude-opus-4-7',
    aaSlug: 'claude-opus-4-7',
    aaName: 'Claude Opus 4.7',
    matchConfidence: 'high' as const,
    matchKind: 'aa_slug_exact',
    externalBenchmarkUsed: true,
  },
  {
    modelId: 'deepseek-ai/DeepSeek-R1-0528',
    aaSlug: 'deepseek-r1',
    aaName: "DeepSeek R1 0528 (May '25)",
    matchConfidence: 'high' as const,
    matchKind: 'aa_slug_exact',
    externalBenchmarkUsed: true,
  },
  {
    modelId: 'accounts/fireworks/models/kimi-k2p5',
    aaSlug: 'kimi-k2-5-non-reasoning',
    aaName: 'Kimi K2.5 (Non-reasoning)',
    matchConfidence: 'high' as const,
    matchKind: 'aa_slug_exact',
    externalBenchmarkUsed: true,
  },
  {
    modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
    aaName: 'Qwen3 235B A22B 2507 (Reasoning)',
    matchConfidence: 'medium' as const,
    matchKind: 'aa_slug_exact',
    externalBenchmarkUsed: true,
  },
] as const;

describe('01C.1B-J2-C-R6-HARDEN — end-to-end C3 eligibility pipeline', () => {
  it('assessVariantEvidence for all 4 selected models produces expected evidence tiers', () => {
    const results = R6_SELECTED_AA_MATCHES.map((m) =>
      assessVariantEvidence({
        runtimeModelId: m.modelId,
        aaSlug: m.aaSlug,
        aaName: m.aaName,
        matchConfidence: m.matchConfidence,
        matchKind: m.matchKind,
      }),
    );

    // claude-opus-4-7: no variant indicator
    expect(['not_applicable', 'confirmed']).toContain(results[0].variantEvidence);

    // deepseek-r1-0528: no variant indicator (R1 is not "reasoning" suffix)
    expect(['not_applicable', 'confirmed']).toContain(results[1].variantEvidence);

    // kimi-k2p5: AA declares -non-reasoning, runtime does not
    expect(results[2].variantEvidence).toBe('probable');
    expect(results[2].nonReasoningSlugNotInRuntime).toBe(true);

    // Qwen3: Thinking → Reasoning discrepancy
    expect(results[3].variantEvidence).toBe('probable');
    expect(results[3].thinkingReasoningDiscrepancy).toBe(true);
  });

  it('evaluateC3EligibilityBatch yields 2 eligible and 2 blocked', () => {
    const variantResults = R6_SELECTED_AA_MATCHES.map((m) =>
      assessVariantEvidence({
        runtimeModelId: m.modelId,
        aaSlug: m.aaSlug,
        aaName: m.aaName,
        matchConfidence: m.matchConfidence,
        matchKind: m.matchKind,
      }),
    );

    const batch = R6_SELECTED_AA_MATCHES.map((m, i) => ({
      modelId: m.modelId,
      externalBenchmarkUsed: m.externalBenchmarkUsed,
      matchConfidence: m.matchConfidence,
      variantEvidence: variantResults[i]!.variantEvidence,
      aaSlug: m.aaSlug,
      aaName: m.aaName,
    }));

    const summary = evaluateC3EligibilityBatch(batch);

    expect(summary.policyVersion).toBe(C3_ELIGIBILITY_POLICY_VERSION);
    expect(summary.totalEvaluated).toBe(4);
    expect(summary.c3EligibleCount).toBe(2);
    expect(summary.c3BlockedCount).toBe(2);
    expect(summary.allEligible).toBe(false);
    expect(summary.anyMediumConfidenceBlock).toBe(true);
    expect(summary.anyVariantBlock).toBe(true);
  });

  it('C3-eligible models are claude-opus-4-7 and deepseek-r1-0528', () => {
    const variantResults = R6_SELECTED_AA_MATCHES.map((m) =>
      assessVariantEvidence({
        runtimeModelId: m.modelId,
        aaSlug: m.aaSlug,
        aaName: m.aaName,
        matchConfidence: m.matchConfidence,
        matchKind: m.matchKind,
      }),
    );
    const batch = R6_SELECTED_AA_MATCHES.map((m, i) => ({
      modelId: m.modelId,
      externalBenchmarkUsed: m.externalBenchmarkUsed,
      matchConfidence: m.matchConfidence,
      variantEvidence: variantResults[i]!.variantEvidence,
      aaSlug: m.aaSlug,
      aaName: m.aaName,
    }));
    const summary = evaluateC3EligibilityBatch(batch);

    const eligibleIds = summary.results.filter((r) => r.c3Eligible).map((r) => r.modelId);
    expect(eligibleIds).toContain('anthropic/claude-opus-4-7');
    expect(eligibleIds).toContain('deepseek-ai/DeepSeek-R1-0528');
  });

  it('C3-blocked models are kimi-k2p5 (variant) and Qwen3 (medium+variant)', () => {
    const variantResults = R6_SELECTED_AA_MATCHES.map((m) =>
      assessVariantEvidence({
        runtimeModelId: m.modelId,
        aaSlug: m.aaSlug,
        aaName: m.aaName,
        matchConfidence: m.matchConfidence,
        matchKind: m.matchKind,
      }),
    );
    const batch = R6_SELECTED_AA_MATCHES.map((m, i) => ({
      modelId: m.modelId,
      externalBenchmarkUsed: m.externalBenchmarkUsed,
      matchConfidence: m.matchConfidence,
      variantEvidence: variantResults[i]!.variantEvidence,
      aaSlug: m.aaSlug,
      aaName: m.aaName,
    }));
    const summary = evaluateC3EligibilityBatch(batch);

    const kimiResult = summary.results.find((r) => r.modelId.includes('kimi'));
    expect(kimiResult?.c3Eligible).toBe(false);
    expect(kimiResult?.reason).toBe('blocked_variant_probable_requires_waiver');

    const qwenResult = summary.results.find((r) => r.modelId.includes('Qwen3'));
    expect(qwenResult?.c3Eligible).toBe(false);
    expect(qwenResult?.reason).toBe('blocked_medium_confidence_requires_waiver');
  });

  it('decision phrase: CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS', () => {
    // This test encodes the expected decision outcome as a verifiable assertion.
    // The decision phrase maps directly to: anyMediumConfidenceBlock=true, allEligible=false.
    const variantResults = R6_SELECTED_AA_MATCHES.map((m) =>
      assessVariantEvidence({
        runtimeModelId: m.modelId,
        aaSlug: m.aaSlug,
        aaName: m.aaName,
        matchConfidence: m.matchConfidence,
        matchKind: m.matchKind,
      }),
    );
    const batch = R6_SELECTED_AA_MATCHES.map((m, i) => ({
      modelId: m.modelId,
      externalBenchmarkUsed: m.externalBenchmarkUsed,
      matchConfidence: m.matchConfidence,
      variantEvidence: variantResults[i]!.variantEvidence,
      aaSlug: m.aaSlug,
      aaName: m.aaName,
    }));
    const summary = evaluateC3EligibilityBatch(batch);

    const decisionPhrase = summary.allEligible
      ? 'CONSENSUS_01C_1B_J2C_R6_HARDEN_ALL_MODELS_C3_ELIGIBLE'
      : summary.anyMediumConfidenceBlock
        ? 'CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS'
        : 'CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_VARIANT_MISMATCH';

    expect(decisionPhrase).toBe(
      'CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS',
    );
  });
});
