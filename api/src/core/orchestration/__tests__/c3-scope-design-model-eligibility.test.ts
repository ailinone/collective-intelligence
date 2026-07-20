// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN-R3 §2 — Model eligibility contract.
 *
 * R3 (Full Provider Expansion): eligibility is now policy-based, not list-based.
 * Quality score is a stratification/priority signal updated from execution results,
 * NOT an eligibility gate. Candidate pool: 934 known models from 17 chat-ready
 * providers, expandable via runtime discovery.
 *
 * Key changes from R2:
 *   - Removed: fixed C3_ELIGIBLE_MODELS list (was 3 models)
 *   - Removed: fixed C3_BLOCKED_MODELS list (was 7 models)
 *   - Added: eligibility POLICY constants (3 gates)
 *   - Added: quality stratification tiers (not a gate)
 *   - Added: 17 chat-ready providers (was 4)
 *   - Added: 934 known candidate pool (was 10)
 *   - Quality score role: stratification_and_priority (not eligibility_gate)
 *
 * ABSOLUTE PROHIBITIONS:
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 */

import { describe, it, expect } from 'vitest';
import {
  C3_ELIGIBILITY_GATE_1,
  C3_ELIGIBILITY_GATE_2,
  C3_ELIGIBILITY_GATE_3,
  C3_QUALITY_SCORE_REQUIRED_FOR_ELIGIBILITY,
  C3_QUALITY_SCORE_ROLE,
  C3_QUALITY_SCORE_UPDATE_POLICY,
  C3_QUALITY_UPDATE_ALPHA,
  C3_BLOCK_POLICY_VARIANT,
  C3_BLOCK_POLICY_PROVIDER,
  C3_BLOCK_POLICY_CAPABILITY,
  C3_CHAT_READY_PROVIDERS,
  C3_CHAT_READY_PROVIDER_COUNT,
  C3_KNOWN_CANDIDATE_COUNT,
  C3_CANDIDATE_POOL_SOURCE,
  C3_CANDIDATE_POOL_EXPANDABLE,
  C3_KNOWN_CANDIDATES_BY_PROVIDER,
  C3_QUALITY_TIER_HIGH_THRESHOLD,
  C3_QUALITY_TIER_MID_LOWER,
  C3_QUALITY_TIER_HIGH_KNOWN_COUNT,
  C3_QUALITY_TIER_MID_KNOWN_COUNT,
  C3_QUALITY_TIER_LOW_KNOWN_COUNT,
  C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT,
  C3_QUALITY_SCORE_SOURCES,
  C3_SYNTHESIZER_POOL,
  C3_JUDGE_POOL,
  C3_POOL_SEPARATION_INVARIANT,
  C3_JUDGE_TIER_REQUIRED,
  C3_SYNTHESIZER_TIER_REQUIRED,
  C3_SYNTHESIZER_QUALITY_SCORE,
  C3_JUDGE_QUALITY_SCORE,
  C3_SYNTHESIZER_QUALITY_SOURCE,
  C3_JUDGE_QUALITY_SOURCE,
  C3_CONSENSUS_TIER_SAMPLE,
  C3_COST_CASCADE_PREFERS_ECONOMY,
  J2C_HARDEN_DECISION,
  J1D_R4B_DECISION,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-DESIGN-R3 §2 — model eligibility contract', () => {

  describe('eligibility policy: 3 gates (R3 replaces fixed model list)', () => {
    it('gate 1 is provider_passes_chat_ready_probe', () => {
      expect(C3_ELIGIBILITY_GATE_1).toBe('provider_passes_chat_ready_probe');
    });

    it('gate 2 is model_has_chat_capability', () => {
      expect(C3_ELIGIBILITY_GATE_2).toBe('model_has_chat_capability');
    });

    it('gate 3 is no_unresolved_variant_flag', () => {
      expect(C3_ELIGIBILITY_GATE_3).toBe('no_unresolved_variant_flag');
    });

    it('quality score is NOT required for eligibility (key R3 change)', () => {
      expect(C3_QUALITY_SCORE_REQUIRED_FOR_ELIGIBILITY).toBe(false);
    });

    it('quality score role is stratification_and_priority, not eligibility_gate', () => {
      expect(C3_QUALITY_SCORE_ROLE).toContain('stratification_and_priority');
      expect(C3_QUALITY_SCORE_ROLE).toContain('not_eligibility_gate');
    });
  });

  describe('quality score update policy', () => {
    it('quality scores are updated from execution results (not static)', () => {
      expect(C3_QUALITY_SCORE_UPDATE_POLICY).toContain('execution_results');
    });

    it('quality update uses Bayesian weighting', () => {
      expect(C3_QUALITY_SCORE_UPDATE_POLICY).toContain('bayesian');
    });

    it('alpha is 0.3 (weight for new execution evidence)', () => {
      expect(C3_QUALITY_UPDATE_ALPHA).toBe(0.3);
    });

    it('alpha is in (0, 1) — valid Bayesian weight', () => {
      expect(C3_QUALITY_UPDATE_ALPHA).toBeGreaterThan(0);
      expect(C3_QUALITY_UPDATE_ALPHA).toBeLessThan(1);
    });
  });

  describe('blocking policy rules (R3 replaces fixed blocked list)', () => {
    it('variant block policy is defined', () => {
      expect(C3_BLOCK_POLICY_VARIANT).toBeTruthy();
      expect(C3_BLOCK_POLICY_VARIANT).toContain('variant');
    });

    it('provider block policy is defined', () => {
      expect(C3_BLOCK_POLICY_PROVIDER).toBeTruthy();
      expect(C3_BLOCK_POLICY_PROVIDER).toContain('provider');
    });

    it('capability block policy is defined', () => {
      expect(C3_BLOCK_POLICY_CAPABILITY).toBeTruthy();
      expect(C3_BLOCK_POLICY_CAPABILITY).toContain('capability');
    });
  });

  describe('source decisions', () => {
    it('J2C_HARDEN_DECISION references blocked-by-medium-confidence (informs block policy)', () => {
      expect(J2C_HARDEN_DECISION).toContain('C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS');
    });

    it('J1D_R4B_DECISION references inventory (was sample, not universe)', () => {
      expect(J1D_R4B_DECISION).toContain('INVENTORY');
    });
  });

  describe('chat-ready provider pool (R4: 23 providers — 17 R3 + 6 reprobe)', () => {
    it('C3_CHAT_READY_PROVIDER_COUNT is 23 (17 R3 + 3 reprobe + 2 HZU + 1 HZU2/HF)', () => {
      expect(C3_CHAT_READY_PROVIDER_COUNT).toBe(23);
    });

    it('C3_CHAT_READY_PROVIDERS has exactly 23 entries', () => {
      expect(C3_CHAT_READY_PROVIDERS.length).toBe(23);
    });

    it('includes deepinfra (was approved in R2)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepinfra');
    });

    it('includes fireworks-ai (was approved in R2)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('fireworks-ai');
    });

    it('includes deepseek (native provider, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepseek');
    });

    it('includes mistral (native provider, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('mistral');
    });

    it('includes openrouter (hub, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('openrouter');
    });

    it('includes groq (inference, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('groq');
    });

    it('includes alibaba (native, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('alibaba');
    });

    it('includes moonshot (native/Kimi, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('moonshot');
    });

    it('includes cerebras (inference, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('cerebras');
    });

    it('includes sambanova (inference, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('sambanova');
    });

    it('includes cohere (native, new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('cohere');
    });

    it('all 17 entries are non-empty strings', () => {
      for (const provider of C3_CHAT_READY_PROVIDERS) {
        expect(typeof provider).toBe('string');
        expect(provider.length).toBeGreaterThan(0);
      }
    });

    it('no duplicate providers', () => {
      const unique = new Set(C3_CHAT_READY_PROVIDERS);
      expect(unique.size).toBe(C3_CHAT_READY_PROVIDERS.length);
    });
  });

  describe('candidate pool (R4: 13808 known — 934 R3 + 12874 reprobe/HF expansion)', () => {
    it('C3_KNOWN_CANDIDATE_COUNT is 13808 (R4 canonical)', () => {
      expect(C3_KNOWN_CANDIDATE_COUNT).toBe(13808);
    });

    it('candidate pool source documents DB census method', () => {
      expect(C3_CANDIDATE_POOL_SOURCE).toContain('db_census');
      expect(C3_CANDIDATE_POOL_SOURCE).toContain('chat_ready');
    });

    it('candidate pool is expandable (runtime discovery at dry-run)', () => {
      expect(C3_CANDIDATE_POOL_EXPANDABLE).toBe(true);
    });

    it('per-provider candidate counts sum to total known', () => {
      const total = Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER).reduce((s, n) => s + n, 0);
      expect(total).toBe(C3_KNOWN_CANDIDATE_COUNT);
    });

    it('openrouter has 365 candidates (largest non-HuggingFace provider)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['openrouter']).toBe(365);
    });

    it('huggingface is the largest provider by catalog size (12692)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']).toBe(12692);
      // HuggingFace dominates by catalog count but is catalog_candidate_pool,
      // not all-models model_probe_validated. All non-HF providers have < 400 candidates.
      for (const [provider, count] of Object.entries(C3_KNOWN_CANDIDATES_BY_PROVIDER)) {
        if (provider !== 'huggingface') {
          expect(count).toBeLessThanOrEqual(400);
        }
      }
    });

    it('every chat-ready provider appears in the known candidates map', () => {
      for (const provider of C3_CHAT_READY_PROVIDERS) {
        expect(C3_KNOWN_CANDIDATES_BY_PROVIDER[provider]).toBeDefined();
        expect(typeof C3_KNOWN_CANDIDATES_BY_PROVIDER[provider]).toBe('number');
      }
    });

    it('all per-provider counts are non-negative integers', () => {
      for (const count of Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER)) {
        expect(count).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(count)).toBe(true);
      }
    });
  });

  describe('quality stratification tiers (signal, not gate)', () => {
    it('high tier threshold is 45 (intelligenceIndex)', () => {
      expect(C3_QUALITY_TIER_HIGH_THRESHOLD).toBe(45);
    });

    it('mid tier lower bound is 25 (intelligenceIndex)', () => {
      expect(C3_QUALITY_TIER_MID_LOWER).toBe(25);
    });

    it('high > mid lower bound (non-overlapping tiers)', () => {
      expect(C3_QUALITY_TIER_HIGH_THRESHOLD).toBeGreaterThan(C3_QUALITY_TIER_MID_LOWER);
    });

    it('high tier has 32 known models (from AA dataset)', () => {
      expect(C3_QUALITY_TIER_HIGH_KNOWN_COUNT).toBe(32);
    });

    it('mid tier has 137 known models', () => {
      expect(C3_QUALITY_TIER_MID_KNOWN_COUNT).toBe(137);
    });

    it('low tier has 303 known models', () => {
      expect(C3_QUALITY_TIER_LOW_KNOWN_COUNT).toBe(303);
    });

    it('unknown tier has 13336 models (462 R3 no-AA + 12874 reprobe/HF additions)', () => {
      expect(C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT).toBe(13336);
    });

    it('high + mid + low equals AA coverage (472 models with intelligenceIndex)', () => {
      const aaIndexed = C3_QUALITY_TIER_HIGH_KNOWN_COUNT
        + C3_QUALITY_TIER_MID_KNOWN_COUNT
        + C3_QUALITY_TIER_LOW_KNOWN_COUNT;
      expect(aaIndexed).toBe(472);
    });

    it('all tiers total to candidate pool size', () => {
      const allTiers = C3_QUALITY_TIER_HIGH_KNOWN_COUNT
        + C3_QUALITY_TIER_MID_KNOWN_COUNT
        + C3_QUALITY_TIER_LOW_KNOWN_COUNT
        + C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT;
      expect(allTiers).toBe(C3_KNOWN_CANDIDATE_COUNT);
    });
  });

  describe('quality score sources (priority order)', () => {
    it('C3_QUALITY_SCORE_SOURCES has 4 sources', () => {
      expect(C3_QUALITY_SCORE_SOURCES.length).toBe(4);
    });

    it('execution_history is the first (highest-priority) source', () => {
      expect(C3_QUALITY_SCORE_SOURCES[0]).toBe('execution_history');
    });

    it('artificial_analysis_intelligence_index is the second source', () => {
      expect(C3_QUALITY_SCORE_SOURCES[1]).toBe('artificial_analysis_intelligence_index');
    });

    it('benchlm_lmarena_composite is the third source', () => {
      expect(C3_QUALITY_SCORE_SOURCES[2]).toBe('benchlm_lmarena_composite');
    });

    it('provider_tier_proxy is the last-resort source', () => {
      expect(C3_QUALITY_SCORE_SOURCES[3]).toBe('provider_tier_proxy');
    });
  });

  describe('consensus sampling tier distribution', () => {
    it('consensus sample has 2 high-tier participants', () => {
      expect(C3_CONSENSUS_TIER_SAMPLE.high).toBe(2);
    });

    it('consensus sample has 2 mid-tier participants', () => {
      expect(C3_CONSENSUS_TIER_SAMPLE.mid).toBe(2);
    });

    it('consensus sample has 1 low-tier participant', () => {
      expect(C3_CONSENSUS_TIER_SAMPLE.low).toBe(1);
    });

    it('total consensus tier sample sums to 5', () => {
      const total = C3_CONSENSUS_TIER_SAMPLE.high
        + C3_CONSENSUS_TIER_SAMPLE.mid
        + C3_CONSENSUS_TIER_SAMPLE.low;
      expect(total).toBe(5);
    });

    it('cost-cascade prefers economy tier (thesis: cheap models via cascade)', () => {
      expect(C3_COST_CASCADE_PREFERS_ECONOMY).toBe(true);
    });
  });

  describe('judge and synthesizer: pre-selected high-tier models', () => {
    it('synthesizer pool has exactly 1 model', () => {
      expect(C3_SYNTHESIZER_POOL.length).toBe(1);
    });

    it('judge pool has exactly 1 model', () => {
      expect(C3_JUDGE_POOL.length).toBe(1);
    });

    it('synthesizer is claude-opus-4-7 (intelligenceIndex 57.3)', () => {
      expect(C3_SYNTHESIZER_POOL).toContain('anthropic/claude-opus-4-7');
    });

    it('judge is deepseek-r1-0528 (independent, quality 0.753)', () => {
      expect(C3_JUDGE_POOL).toContain('deepseek-ai/DeepSeek-R1-0528');
    });

    it('pool separation invariant is defined', () => {
      expect(C3_POOL_SEPARATION_INVARIANT).toContain('judge_not_in_synthesizer_pool');
    });

    it('judge is NOT in synthesizer pool (separation invariant)', () => {
      const judge = C3_JUDGE_POOL[0]!;
      const synth: readonly string[] = C3_SYNTHESIZER_POOL;
      expect(synth.includes(judge)).toBe(false);
    });

    it('judge tier requirement is high', () => {
      expect(C3_JUDGE_TIER_REQUIRED).toBe('high');
    });

    it('synthesizer tier requirement is high', () => {
      expect(C3_SYNTHESIZER_TIER_REQUIRED).toBe('high');
    });

    it('synthesizer quality score is 0.9625 (benchlm+lmarena)', () => {
      expect(C3_SYNTHESIZER_QUALITY_SCORE).toBe(0.9625);
    });

    it('judge quality score is 0.753 (artificial_analysis_api)', () => {
      expect(C3_JUDGE_QUALITY_SCORE).toBe(0.753);
    });

    it('synthesizer quality source is benchlm+lmarena', () => {
      expect(C3_SYNTHESIZER_QUALITY_SOURCE).toBe('benchlm+lmarena');
    });

    it('judge quality source is artificial_analysis_api', () => {
      expect(C3_JUDGE_QUALITY_SOURCE).toBe('artificial_analysis_api');
    });

    it('synthesizer has higher quality score than judge', () => {
      expect(C3_SYNTHESIZER_QUALITY_SCORE).toBeGreaterThan(C3_JUDGE_QUALITY_SCORE);
    });
  });
});
