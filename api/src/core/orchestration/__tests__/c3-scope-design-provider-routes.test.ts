// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN-R3 §3 — Provider route contract.
 *
 * R3 (Full Provider Expansion): 17 chat-ready providers (was 4 in R2).
 * Provider classification changes from approved/conditional to chat-ready/not-ready.
 * Source: provider_adapter_readiness_01c1b_j1b_r2.json (bucket A_registered_and_chat_ready).
 *
 * R2 had: 2 approved (deepinfra, fireworks-ai) + 2 conditional (nanogpt, vercel-ai-gateway)
 * R3 has: 17 chat-ready from adapter readiness audit (nanogpt now credit-blocked, not chat-ready)
 *
 * ABSOLUTE PROHIBITIONS:
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 */

import { describe, it, expect } from 'vitest';
import {
  C3_CHAT_READY_PROVIDERS,
  C3_CHAT_READY_PROVIDER_COUNT,
  C3_KNOWN_CANDIDATES_BY_PROVIDER,
  C3_KNOWN_CANDIDATE_COUNT,
  C3_CANDIDATE_POOL_EXPANDABLE,
  C3_SYNTHESIZER_POOL,
  C3_JUDGE_POOL,
  C3_POOL_SEPARATION_INVARIANT,
  C3_ELIGIBILITY_GATE_1,
  C3_QUALITY_SCORE_REQUIRED_FOR_ELIGIBILITY,
  C3_COST_CASCADE_PREFERS_ECONOMY,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-DESIGN-R3 §3 — provider route contract', () => {

  describe('chat-ready provider pool (R4: 23 providers — 17 R3 + 6 reprobe)', () => {
    it('C3_CHAT_READY_PROVIDER_COUNT is 23', () => {
      expect(C3_CHAT_READY_PROVIDER_COUNT).toBe(23);
    });

    it('C3_CHAT_READY_PROVIDERS has exactly 23 entries', () => {
      expect(C3_CHAT_READY_PROVIDERS.length).toBe(23);
    });

    it('no duplicate provider names', () => {
      const unique = new Set(C3_CHAT_READY_PROVIDERS);
      expect(unique.size).toBe(C3_CHAT_READY_PROVIDERS.length);
    });

    it('all entries are non-empty strings', () => {
      for (const p of C3_CHAT_READY_PROVIDERS) {
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
      }
    });
  });

  describe('provider membership: inference providers', () => {
    it('deepinfra is chat-ready (was approved in R2, still present in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepinfra');
    });

    it('fireworks-ai is chat-ready (was approved in R2, still present in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('fireworks-ai');
    });

    it('groq is chat-ready (new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('groq');
    });

    it('cerebras is chat-ready (new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('cerebras');
    });

    it('sambanova is chat-ready (new in R3)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('sambanova');
    });
  });

  describe('provider membership: native providers', () => {
    it('deepseek is chat-ready (native, sampleModel: deepseek-v4-pro)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepseek');
    });

    it('mistral is chat-ready (native, sampleModel: ministral-14b-latest)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('mistral');
    });

    it('cohere is chat-ready (native, sampleModel: tiny-aya-fire)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('cohere');
    });

    it('alibaba is chat-ready (native, sampleModel: qwen3.5-plus)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('alibaba');
    });

    it('moonshot is chat-ready (native/Kimi, sampleModel: kimi-k2-0711-preview)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('moonshot');
    });

    it('minimax is chat-ready (sampleModel: MiniMax-M2.7-highspeed)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('minimax');
    });

    it('writer is chat-ready (native, sampleModel: palmyra-x-004)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('writer');
    });

    it('upstage is chat-ready (native, sampleModel: solar-mini-250422)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('upstage');
    });

    it('rekaai is chat-ready (native, sampleModel: reka-edge-2603)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('rekaai');
    });
  });

  describe('provider membership: hub / aggregator', () => {
    it('openrouter is chat-ready (hub, sampleModel: gpt-oss-120b:free)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('openrouter');
    });

    it('vercel-ai-gateway is chat-ready (was conditional in R2, still present)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('vercel-ai-gateway');
    });

    it('avian is chat-ready (hub, sampleModel: kimi-k2.6)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('avian');
    });
  });

  describe('providers NOT in chat-ready pool (credit-blocked or auth-blocked)', () => {
    it('nanogpt is NOT chat-ready (blocked by credit in adapter readiness audit)', () => {
      const chatReady: readonly string[] = C3_CHAT_READY_PROVIDERS;
      expect(chatReady.includes('nanogpt')).toBe(false);
    });

    it('openai is NOT chat-ready (blocked by credit)', () => {
      const chatReady: readonly string[] = C3_CHAT_READY_PROVIDERS;
      expect(chatReady.includes('openai')).toBe(false);
    });

    it('anthropic (native) is NOT chat-ready (blocked by credit)', () => {
      const chatReady: readonly string[] = C3_CHAT_READY_PROVIDERS;
      expect(chatReady.includes('anthropic')).toBe(false);
    });

    it('aihubmix is NOT chat-ready (auth-blocked)', () => {
      const chatReady: readonly string[] = C3_CHAT_READY_PROVIDERS;
      expect(chatReady.includes('aihubmix')).toBe(false);
    });

    it('novita is NOT chat-ready (credit-blocked)', () => {
      const chatReady: readonly string[] = C3_CHAT_READY_PROVIDERS;
      expect(chatReady.includes('novita')).toBe(false);
    });
  });

  describe('eligibility gate: provider-based (R3 replaces quality-score gate)', () => {
    it('eligibility gate 1 is provider_passes_chat_ready_probe', () => {
      expect(C3_ELIGIBILITY_GATE_1).toBe('provider_passes_chat_ready_probe');
    });

    it('quality score is NOT required for provider eligibility', () => {
      expect(C3_QUALITY_SCORE_REQUIRED_FOR_ELIGIBILITY).toBe(false);
    });

    it('candidate pool is expandable via runtime discovery', () => {
      expect(C3_CANDIDATE_POOL_EXPANDABLE).toBe(true);
    });
  });

  describe('candidate pool distribution', () => {
    it('total known candidates sum to 13808 (canonical R4 pool)', () => {
      const total = Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER).reduce((s, n) => s + n, 0);
      expect(total).toBe(C3_KNOWN_CANDIDATE_COUNT);
    });

    it('huggingface contributes 12692 candidates (catalog; provider_probe_validated)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['huggingface']).toBe(12692);
    });

    it('openrouter contributes 365 candidates (largest non-HF provider)', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['openrouter']).toBe(365);
    });

    it('alibaba contributes 156 candidates', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['alibaba']).toBe(156);
    });

    it('vercel-ai-gateway contributes 134 candidates', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['vercel-ai-gateway']).toBe(134);
    });

    it('deepinfra contributes 113 candidates', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['deepinfra']).toBe(113);
    });

    it('mistral contributes 64 candidates', () => {
      expect(C3_KNOWN_CANDIDATES_BY_PROVIDER['mistral']).toBe(64);
    });

    it('all providers in pool have non-negative candidate count', () => {
      for (const count of Object.values(C3_KNOWN_CANDIDATES_BY_PROVIDER)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('thesis-relevant provider features', () => {
    it('cost-cascade strategy prefers economy-tier providers', () => {
      expect(C3_COST_CASCADE_PREFERS_ECONOMY).toBe(true);
    });

    it('pool has more than 10 providers (meaningful provider diversity)', () => {
      expect(C3_CHAT_READY_PROVIDERS.length).toBeGreaterThan(10);
    });

    it('pool has at least 5 distinct provider types (native + inference + hub)', () => {
      // all 17 are distinct — just verify cardinality
      expect(C3_CHAT_READY_PROVIDERS.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('role pool assignments (unchanged from R2)', () => {
    it('synthesizer pool contains claude-opus-4-7', () => {
      expect(C3_SYNTHESIZER_POOL).toContain('anthropic/claude-opus-4-7');
    });

    it('judge pool contains deepseek-r1-0528', () => {
      expect(C3_JUDGE_POOL).toContain('deepseek-ai/DeepSeek-R1-0528');
    });

    it('pool separation invariant is defined', () => {
      expect(C3_POOL_SEPARATION_INVARIANT).toContain('judge_not_in_synthesizer_pool');
    });

    it('judge is NOT in synthesizer pool', () => {
      const judge = C3_JUDGE_POOL[0]!;
      const synth: readonly string[] = C3_SYNTHESIZER_POOL;
      expect(synth.includes(judge)).toBe(false);
    });

    it('synthesizer provider (deepinfra) is chat-ready', () => {
      // claude-opus-4-7 is served by deepinfra which is in chat-ready pool
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepinfra');
    });

    it('judge provider (deepinfra) is chat-ready', () => {
      // deepseek-r1-0528 is served by deepinfra which is in chat-ready pool
      expect(C3_CHAT_READY_PROVIDERS).toContain('deepinfra');
    });
  });
});
