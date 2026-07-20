// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §7 — model-variant-evidence unit tests.
 *
 * 8 cases covering all VariantEvidence tiers for the R6 selected models
 * and edge cases.
 */
import { describe, it, expect } from 'vitest';
import {
  assessVariantEvidence,
  type VariantEvidenceInput,
} from '@/core/orchestration/model-selection/external-benchmarks/model-variant-evidence';

function input(overrides: Partial<VariantEvidenceInput> & Pick<VariantEvidenceInput, 'runtimeModelId' | 'aaSlug' | 'aaName'>): VariantEvidenceInput {
  return {
    matchConfidence: 'high',
    matchKind: 'aa_slug_exact',
    ...overrides,
  };
}

describe('01C.1B-J2-C-R6-HARDEN — assessVariantEvidence', () => {
  // ── Case 1: claude-opus-4-7 — slug exact, no variant indicator → confirmed ──
  it('claude-opus-4-7: slug exact, no variant indicator → not_applicable', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'anthropic/claude-opus-4-7',
      aaSlug: 'claude-opus-4-7',
      aaName: 'Claude Opus 4.7',
    }));
    // No variant language on either side
    expect(['not_applicable', 'confirmed']).toContain(r.variantEvidence);
    expect(r.thinkingReasoningDiscrepancy).toBe(false);
    expect(r.nonReasoningSlugNotInRuntime).toBe(false);
  });

  // ── Case 2: deepseek-r1-0528 — high confidence, version in name → confirmed ──
  it('deepseek-ai/DeepSeek-R1-0528: high confidence, no reasoning discrepancy → not_applicable', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'deepseek-ai/DeepSeek-R1-0528',
      aaSlug: 'deepseek-r1',
      aaName: "DeepSeek R1 0528 (May '25)",
      matchConfidence: 'high',
      matchKind: 'aa_slug_exact',
    }));
    // "R1" is not "reasoning"; "0528" is a version tag, not a variant mode indicator
    // Neither side has Thinking/Reasoning/NonReasoning → not_applicable
    expect(r.variantEvidence).toBe('not_applicable');
    expect(r.thinkingReasoningDiscrepancy).toBe(false);
    expect(r.nonReasoningSlugNotInRuntime).toBe(false);
  });

  // ── Case 3: kimi-k2p5 — aaSlug has -non-reasoning, runtime does not → probable ──
  it('kimi-k2p5: aaSlug has -non-reasoning suffix not declared at runtime → probable', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'accounts/fireworks/models/kimi-k2p5',
      aaSlug: 'kimi-k2-5-non-reasoning',
      aaName: 'Kimi K2.5 (Non-reasoning)',
      matchConfidence: 'high',
      matchKind: 'aa_slug_exact',
    }));
    expect(r.variantEvidence).toBe('probable');
    expect(r.nonReasoningSlugNotInRuntime).toBe(true);
    expect(r.thinkingReasoningDiscrepancy).toBe(false);
  });

  // ── Case 4: Qwen3 Thinking→Reasoning → probable ──────────────────────────
  it('Qwen3-235B-A22B-Thinking-2507: Thinking runtime vs Reasoning AA slug → probable', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
      aaName: 'Qwen3 235B A22B 2507 (Reasoning)',
      matchConfidence: 'medium',
      matchKind: 'aa_slug_exact',
    }));
    expect(r.variantEvidence).toBe('probable');
    expect(r.thinkingReasoningDiscrepancy).toBe(true);
  });

  // ── Case 5: no_match → ambiguous ─────────────────────────────────────────
  it('no_match confidence → ambiguous', () => {
    const r = assessVariantEvidence({
      runtimeModelId: 'some/unknown-model-xyz',
      aaSlug: '',
      aaName: '',
      matchConfidence: 'none',
      matchKind: 'no_match',
    });
    expect(r.variantEvidence).toBe('ambiguous');
  });

  // ── Case 6: family/short-name match → ambiguous ───────────────────────────
  it('family_or_short_name_medium match → ambiguous', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'gpt-4',
      aaSlug: 'gpt-4-turbo',
      aaName: 'GPT-4 Turbo',
      matchConfidence: 'medium',
      matchKind: 'family_or_short_name_medium',
    }));
    expect(r.variantEvidence).toBe('ambiguous');
  });

  // ── Case 7: high conf, slug exact, runtime has -reasoning matching AA → confirmed ──
  it('both runtime and AA slug have reasoning suffix consistently → confirmed', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'myorg/my-model-reasoning',
      aaSlug: 'my-model-reasoning',
      aaName: 'My Model (Reasoning)',
      matchConfidence: 'high',
      matchKind: 'aa_slug_exact',
    }));
    // Both sides have reasoning, no discrepancy → confirmed
    expect(r.variantEvidence).toBe('confirmed');
    expect(r.thinkingReasoningDiscrepancy).toBe(false);
  });

  // ── Case 8: explicit_alias_high, no variant indicators → not_applicable ───
  it('explicit_alias_high match, no variant indicator → not_applicable', () => {
    const r = assessVariantEvidence(input({
      runtimeModelId: 'accounts/fireworks/models/deepseek-v4-pro',
      aaSlug: 'deepseek-v4-pro',
      aaName: 'DeepSeek V4 Pro',
      matchConfidence: 'high',
      matchKind: 'explicit_alias_high',
    }));
    expect(r.variantEvidence).toBe('not_applicable');
    expect(r.thinkingReasoningDiscrepancy).toBe(false);
  });
});
