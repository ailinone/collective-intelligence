// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §15 — Integration: client → normalizer → matcher.
 *
 * Exercises the full structural pipeline with a hand-built minimal AA
 * response (mocked fetch). Proves the modules compose correctly without
 * touching the live API.
 *
 * The matcher's outputs feed the R6 quality snapshot builder, which is
 * a tmp/ script (not a runtime module). This test pins the structural
 * contract that the runtime depends on.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchArtificialAnalysisLlmModels,
  type ArtificialAnalysisModelsResponse,
} from '@/core/orchestration/model-selection/external-benchmarks/artificial-analysis-client';
import { normalizeArtificialAnalysisModels } from '@/core/orchestration/model-selection/external-benchmarks/artificial-analysis-normalizer';
import {
  matchArtificialAnalysisModel,
  type ExplicitAliasEntry,
} from '@/core/orchestration/model-selection/external-benchmarks/artificial-analysis-matcher';

const MOCK_AA: ArtificialAnalysisModelsResponse = {
  status: 200,
  data: [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      slug: 'deepseek-v4-pro',
      model_creator: { id: 'deepseek', name: 'DeepSeek', slug: 'deepseek-ai' },
      evaluations: {
        artificial_analysis_intelligence_index: 80,
        artificial_analysis_coding_index: 90,
        gpqa: 70,
      },
      pricing: { price_1m_blended_3_to_1: 2.5, price_1m_input_tokens: 1, price_1m_output_tokens: 7 },
      median_output_tokens_per_second: 120,
      median_time_to_first_token_seconds: 0.5,
    },
    {
      id: 'deepseek-r1-0528',
      name: 'DeepSeek R1 0528',
      slug: 'deepseek-r1-0528',
      model_creator: { id: 'deepseek', name: 'DeepSeek', slug: 'deepseek-ai' },
      evaluations: {
        artificial_analysis_intelligence_index: 82,
        gpqa: 76,
      },
    },
    {
      id: 'kimi-k2-6',
      name: 'Kimi K2.6',
      slug: 'kimi-k2-6',
      model_creator: { id: 'moonshot', name: 'Moonshot', slug: 'moonshotai' },
    },
    {
      id: 'qwen3-235b-a22b-thinking-2507',
      name: 'Qwen3-235B-A22B-Thinking-2507',
      slug: 'qwen3-235b-a22b-thinking-2507',
      model_creator: { id: 'alibaba', name: 'Alibaba', slug: 'qwen' },
      evaluations: {
        artificial_analysis_intelligence_index: 78,
        artificial_analysis_math_index: 91,
      },
    },
  ],
};

function makeResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: {} });
}

describe('01C.1B-J2-C-R6 §15 — end-to-end AA pipeline (mocked)', () => {
  it('client → normalizer → matcher: fireworks wrapper resolves to AA deepseek-v4-pro at exact', async () => {
    const fetchFn = vi.fn(async () => makeResponse(MOCK_AA));
    const { response } = await fetchArtificialAnalysisLlmModels({
      apiKey: 'mock-key',
      fetchFn: fetchFn as never,
    });
    const normalized = normalizeArtificialAnalysisModels(response.data);
    const r = matchArtificialAnalysisModel({
      runtimeModelId: 'accounts/fireworks/models/deepseek-v4-pro',
      aaModels: normalized,
    });
    expect(r.matched).toBe(true);
    expect(['aa_id_exact', 'aa_slug_exact', 'normalized_name_exact']).toContain(r.matchKind);
    expect(r.aaModel?.aaModelId).toBe('deepseek-v4-pro');
    expect(r.aaModel?.evaluations.intelligenceIndex).toBe(80);
    expect(r.aaModel?.pricing.blended3To1UsdPer1MTokens).toBe(2.5);
  });

  it('Qwen3-235B-Thinking (short runtime name) resolves only at medium via explicit alias ceiling', async () => {
    const fetchFn = vi.fn(async () => makeResponse(MOCK_AA));
    const { response } = await fetchArtificialAnalysisLlmModels({
      apiKey: 'mock-key',
      fetchFn: fetchFn as never,
    });
    const normalized = normalizeArtificialAnalysisModels(response.data);
    const explicit: ExplicitAliasEntry[] = [
      {
        runtimePattern: 'Qwen3-235B-Thinking',
        candidateAliases: ['qwen3-235b-a22b-thinking-2507'],
        confidenceCeiling: 'medium',
      },
    ];
    const r = matchArtificialAnalysisModel({
      runtimeModelId: 'Qwen3-235B-Thinking',
      explicitAliases: explicit,
      aaModels: normalized,
    });
    expect(r.matched).toBe(true);
    expect(r.confidence).toBe('medium');
  });

  it('kimi-k2p5 does NOT match Kimi-K2.6 without an explicit alias', async () => {
    const fetchFn = vi.fn(async () => makeResponse(MOCK_AA));
    const { response } = await fetchArtificialAnalysisLlmModels({
      apiKey: 'mock-key',
      fetchFn: fetchFn as never,
    });
    const normalized = normalizeArtificialAnalysisModels(response.data);
    const r = matchArtificialAnalysisModel({
      runtimeModelId: 'accounts/fireworks/models/kimi-k2p5',
      aaModels: normalized,
    });
    expect(r.matched).toBe(false);
  });

  it('DeepSeek-R1-0528 with vendor prefix resolves via normalizer alias', async () => {
    const fetchFn = vi.fn(async () => makeResponse(MOCK_AA));
    const { response } = await fetchArtificialAnalysisLlmModels({
      apiKey: 'mock-key',
      fetchFn: fetchFn as never,
    });
    const normalized = normalizeArtificialAnalysisModels(response.data);
    const r = matchArtificialAnalysisModel({
      runtimeModelId: 'deepseek-ai/DeepSeek-R1-0528',
      aaModels: normalized,
    });
    expect(r.matched).toBe(true);
    expect(r.aaModel?.aaModelId).toBe('deepseek-r1-0528');
  });

  it('end-to-end secret hygiene: no API key in any returned object', async () => {
    const secret = 'aa-end-to-end-secret-key-987654';
    const fetchFn = vi.fn(async () => makeResponse(MOCK_AA));
    const { response, rateLimit } = await fetchArtificialAnalysisLlmModels({
      apiKey: secret,
      fetchFn: fetchFn as never,
    });
    const normalized = normalizeArtificialAnalysisModels(response.data);
    const r = matchArtificialAnalysisModel({
      runtimeModelId: 'deepseek-v4-pro',
      aaModels: normalized,
    });
    const blob = JSON.stringify({ response, rateLimit, normalized, r });
    expect(blob).not.toContain(secret);
  });
});
