// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-R4 — HuggingFace Classification Invariants
 *
 * HuggingFace is provider_probe_validated (1 confirmed model returned HTTP 200).
 * Its 12692 catalog models are catalog_candidate_pool, NOT model_probe_validated.
 * Any code that assumes all HF models are callable must fail this test suite.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - No HuggingFace API calls, no HTTP requests, no provider probes.
 *   - No C3 execution, no dryRun=false, no billable provider calls.
 */

import { describe, it, expect } from 'vitest';
import {
  HF_PROVIDER_STATUS,
  HF_CONFIRMED_MODEL,
  HF_CONFIRMED_ENDPOINT,
  HF_ALL_MODELS_CALLABLE_ASSUMED,
  HF_CATALOG_CANDIDATE_COUNT,
  C3_KNOWN_CANDIDATES_BY_PROVIDER,
  C3_CHAT_READY_PROVIDERS,
  type C3CandidateClass,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-R4 — HuggingFace classification', () => {

  describe('provider validation status', () => {
    it('HF_PROVIDER_STATUS is provider_probe_validated', () => {
      expect(HF_PROVIDER_STATUS).toBe('provider_probe_validated');
    });

    it('HF_PROVIDER_STATUS is NOT model_probe_validated', () => {
      expect(HF_PROVIDER_STATUS).not.toBe('model_probe_validated');
    });

    it('HF_PROVIDER_STATUS is NOT c3_sampling_eligible', () => {
      expect(HF_PROVIDER_STATUS).not.toBe('c3_sampling_eligible');
    });

    it('HF_PROVIDER_STATUS is NOT catalog_candidate', () => {
      // HF is provider_probe_validated — the provider itself is confirmed
      // but its model pool is catalog_candidate
      expect(HF_PROVIDER_STATUS).not.toBe('catalog_candidate');
    });

    it('HF_PROVIDER_STATUS is a valid C3CandidateClass', () => {
      const validClasses: C3CandidateClass[] = [
        'catalog_candidate',
        'provider_probe_validated',
        'model_probe_validated',
        'c3_sampling_eligible',
      ];
      expect(validClasses).toContain(HF_PROVIDER_STATUS);
    });
  });

  describe('confirmed model and endpoint', () => {
    it('HF_CONFIRMED_MODEL is Qwen/Qwen2.5-7B-Instruct', () => {
      expect(HF_CONFIRMED_MODEL).toBe('Qwen/Qwen2.5-7B-Instruct');
    });

    it('HF_CONFIRMED_MODEL is a non-empty string', () => {
      expect(typeof HF_CONFIRMED_MODEL).toBe('string');
      expect(HF_CONFIRMED_MODEL.length).toBeGreaterThan(0);
    });

    it('HF_CONFIRMED_ENDPOINT is the router endpoint (not api-inference)', () => {
      expect(HF_CONFIRMED_ENDPOINT).toBe('https://router.huggingface.co/v1');
      // Explicitly not the old API-inference endpoint
      expect(HF_CONFIRMED_ENDPOINT).not.toContain('api-inference.huggingface.co');
    });
  });

  describe('catalog assumption guard', () => {
    it('HF_ALL_MODELS_CALLABLE_ASSUMED is false (critical invariant)', () => {
      expect(HF_ALL_MODELS_CALLABLE_ASSUMED).toBe(false);
    });

    it('HF_ALL_MODELS_CALLABLE_ASSUMED is typed as `false as const`', () => {
      const guard: false = HF_ALL_MODELS_CALLABLE_ASSUMED;
      expect(guard).toBe(false);
    });

    it('HF catalog count is 12692 (not all individually probe-validated)', () => {
      expect(HF_CATALOG_CANDIDATE_COUNT).toBe(12692);
    });

    it('Only 1 model is confirmed (Qwen/Qwen2.5-7B-Instruct), not all 12692', () => {
      // provider_probe_validated = 1 model returned HTTP 200
      // 12692 are catalog_candidate — require per-model validation before billable calls
      expect(HF_CATALOG_CANDIDATE_COUNT).toBeGreaterThan(1);
      expect(HF_CONFIRMED_MODEL).toBeTruthy();
      // The ratio of confirmed to catalog shows why not-assumed-callable matters
      const confirmationRatio = 1 / HF_CATALOG_CANDIDATE_COUNT;
      expect(confirmationRatio).toBeLessThan(0.01); // Less than 1% confirmed individually
    });
  });

  describe('provider pool membership', () => {
    it('huggingface is in C3_CHAT_READY_PROVIDERS', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('huggingface');
    });

    it('huggingface has 12692 catalog candidates in C3_KNOWN_CANDIDATES_BY_PROVIDER', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']).toBe(12692);
    });

    it('HF_CATALOG_CANDIDATE_COUNT matches byProvider entry', () => {
      expect(HF_CATALOG_CANDIDATE_COUNT).toBe(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']);
    });

    it('HF is the largest provider by catalog count', () => {
      const hfCount = C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface'];
      for (const [provider, count] of Object.entries(C3_KNOWN_CANDIDATES_BY_PROVIDER)) {
        if (provider !== 'huggingface') {
          expect(hfCount).toBeGreaterThan(count);
        }
      }
    });
  });
});
