// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-R4 — Candidate Pool Integrity
 *
 * Verifies the R4 candidate pool canonical count of 13808 with auditable formula.
 * Enforces per-provider accounting and HuggingFace classification correctness.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - No C3 execution, no provider calls, no dryRun=false, no secrets.
 */

import { describe, it, expect } from 'vitest';
import {
  C3_KNOWN_CANDIDATE_COUNT,
  C3_R3_ORIGINAL_KNOWN_COUNT,
  C3_KNOWN_CANDIDATES_BY_PROVIDER,
  C3_CHAT_READY_PROVIDERS,
  C3_CANDIDATE_POOL_FORMULA,
  HF_PROVIDER_STATUS,
  HF_CONFIRMED_MODEL,
  HF_ALL_MODELS_CALLABLE_ASSUMED,
  HF_CATALOG_CANDIDATE_COUNT,
  C3_QUALITY_TIER_HIGH_KNOWN_COUNT,
  C3_QUALITY_TIER_MID_KNOWN_COUNT,
  C3_QUALITY_TIER_LOW_KNOWN_COUNT,
  C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT,
  C3_QUALITY_TIER_AA_INDEXED_COUNT,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-R4 — candidate pool integrity', () => {

  describe('canonical total', () => {
    it('C3_KNOWN_CANDIDATE_COUNT is 13808', () => {
      expect(C3_KNOWN_CANDIDATE_COUNT).toBe(13808);
    });

    it('C3_R3_ORIGINAL_KNOWN_COUNT is 934 (historical baseline)', () => {
      expect(C3_R3_ORIGINAL_KNOWN_COUNT).toBe(934);
    });

    it('R4 canonical > R3 baseline (expansion happened)', () => {
      expect(C3_KNOWN_CANDIDATE_COUNT).toBeGreaterThan(C3_R3_ORIGINAL_KNOWN_COUNT);
    });
  });

  describe('formula auditability', () => {
    it('C3_CANDIDATE_POOL_FORMULA is a string with an equals sign', () => {
      expect(typeof C3_CANDIDATE_POOL_FORMULA).toBe('string');
      expect(C3_CANDIDATE_POOL_FORMULA).toContain('=');
    });

    it('formula contains 13808', () => {
      expect(C3_CANDIDATE_POOL_FORMULA).toContain('13808');
    });

    it('formula contains 934', () => {
      expect(C3_CANDIDATE_POOL_FORMULA).toContain('934');
    });
  });

  describe('per-provider candidate counts', () => {
    it('per-provider sum equals C3_KNOWN_CANDIDATE_COUNT', () => {
      const total = Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER).reduce((s, n) => s + n, 0);
      expect(total).toBe(C3_KNOWN_CANDIDATE_COUNT);
    });

    it('every chat-ready provider has a candidate count entry', () => {
      for (const provider of C3_CHAT_READY_PROVIDERS) {
        expect(C3_KNOWN_CANDIDATES_BY_PROVIDER[provider]).toBeDefined();
        expect(typeof C3_KNOWN_CANDIDATES_BY_PROVIDER[provider]).toBe('number');
      }
    });

    it('all candidate counts are non-negative integers', () => {
      for (const count of Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER)) {
        expect(count).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(count)).toBe(true);
      }
    });

    it('huggingface has 12692 catalog candidates', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']).toBe(12692);
    });

    it('HF_CATALOG_CANDIDATE_COUNT matches byProvider entry', () => {
      expect(HF_CATALOG_CANDIDATE_COUNT).toBe(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']);
    });

    it('openrouter is 365 (largest non-HF provider)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['openrouter']).toBe(365);
    });

    it('reprobe additions are present (perplexity 24, nvidia 107, wandb 27)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['perplexity']).toBe(24);
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['nvidia']).toBe(107);
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['wandb']).toBe(27);
    });

    it('HZU additions are present (inworld 6, infermatic 18)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['inworld']).toBe(6);
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['infermatic']).toBe(18);
    });
  });

  describe('HuggingFace classification (R4 critical)', () => {
    it('HF_PROVIDER_STATUS is provider_probe_validated', () => {
      expect(HF_PROVIDER_STATUS).toBe('provider_probe_validated');
    });

    it('HF_CONFIRMED_MODEL is Qwen/Qwen2.5-7B-Instruct', () => {
      expect(HF_CONFIRMED_MODEL).toBe('Qwen/Qwen2.5-7B-Instruct');
    });

    it('HF_ALL_MODELS_CALLABLE_ASSUMED is false (catalog, not model-probe-validated)', () => {
      expect(HF_ALL_MODELS_CALLABLE_ASSUMED).toBe(false);
    });

    it('HF is NOT a model_probe_validated classification', () => {
      expect(HF_PROVIDER_STATUS).not.toBe('model_probe_validated');
    });

    it('HF is NOT classified as c3_sampling_eligible for all models', () => {
      expect(HF_PROVIDER_STATUS).not.toBe('c3_sampling_eligible');
    });
  });

  describe('quality tier accounting', () => {
    it('AA-indexed count (high+mid+low) is 472 — unchanged from R3 baseline', () => {
      expect(C3_QUALITY_TIER_AA_INDEXED_COUNT).toBe(472);
      const computed = C3_QUALITY_TIER_HIGH_KNOWN_COUNT
        + C3_QUALITY_TIER_MID_KNOWN_COUNT
        + C3_QUALITY_TIER_LOW_KNOWN_COUNT;
      expect(computed).toBe(C3_QUALITY_TIER_AA_INDEXED_COUNT);
    });

    it('unknown tier is 13336 (462 R3 original + 12874 reprobe/HF additions)', () => {
      expect(C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT).toBe(13336);
    });

    it('all tiers sum to C3_KNOWN_CANDIDATE_COUNT (13808)', () => {
      const total = C3_QUALITY_TIER_HIGH_KNOWN_COUNT
        + C3_QUALITY_TIER_MID_KNOWN_COUNT
        + C3_QUALITY_TIER_LOW_KNOWN_COUNT
        + C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT;
      expect(total).toBe(C3_KNOWN_CANDIDATE_COUNT);
    });
  });
});
