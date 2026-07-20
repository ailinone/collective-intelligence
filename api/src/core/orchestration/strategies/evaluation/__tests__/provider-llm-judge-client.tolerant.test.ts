// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: the LLMJudgeEvaluator's ProviderLLMJudgeClient must share the
 * SAME tolerant salvage as the consensus/experiment judges — i.e. route its
 * parse through `normalizeJudgeOutput` (`@/core/quality/judge-schema`) — and
 * emit an operability judge metric on every outcome.
 *
 * This mirrors `core/quality/__tests__/judge-schema.tolerant.test.ts`: the
 * same real-world drift shapes that strict parsing dropped (~50% of prod judge
 * scores) must now survive here too. It additionally covers the rubric-only
 * fields the shared schema does not model (`verdict`, `rationale`, `subScores`)
 * and the full `judge()` client path, including the emitted metric.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProviderLLMJudgeClient,
  coerceRawResult,
} from '../provider-llm-judge-client';
import {
  METRIC_NAMES,
  getCounterValueForTesting,
  resetMetricCountersForTesting,
} from '@/core/operability/metrics';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatResponse, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function fakeChatResponse(content: string): ChatResponse {
  return {
    id: 'judge-1',
    object: 'chat.completion',
    created: 0,
    model: 'judge-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  };
}

function fakeRegistry(adapter: Partial<ProviderAdapter>, found = true): ProviderRegistry {
  const model: Model = {
    id: 'judge-model',
    providerId: 'mockprov',
    provider: 'mockprov',
    name: 'judge-model',
    displayName: 'judge',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 1, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
  };
  return {
    findModel: async () => (found ? { model, adapter: adapter as ProviderAdapter } : null),
  } as unknown as ProviderRegistry;
}

const JUDGE_INPUT = {
  judgeModelId: 'judge-model',
  rubricVersion: 'v1',
  task: {},
  output: 'candidate text',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
} as const;

function clientReturning(content: string): ProviderLLMJudgeClient {
  const adapter = { getName: () => 'mockprov', chatCompletion: vi.fn(async () => fakeChatResponse(content)) };
  return new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
}

// ─────────────────────────────────────────────────────────────────────────────
// coerceRawResult — tolerant salvage of near-canonical judge JSON (parsed obj).
// Mirrors judge-schema.tolerant.test.ts, plus rubric-only fields.
// ─────────────────────────────────────────────────────────────────────────────
describe('coerceRawResult — tolerant salvage of real LLM judge drift', () => {
  it('#0 confidence as string + extra keys (maxScore), verdict preserved', () => {
    const r = coerceRawResult({
      score: 0.7, maxScore: 1, verdict: 'pass', rationale: 'ok', confidence: '0.9',
    });
    expect(r.score).toBe(0.7);
    expect(r.confidence).toBe(0.9);
    expect(r.verdict).toBe('pass');
    expect(r.shortRationale).toBe('ok');
  });

  it('#1 overallScore instead of score, verdict preserved', () => {
    const r = coerceRawResult({ overallScore: 0.15, verdict: 'fail', justification: 'weak' });
    expect(r.score).toBeCloseTo(0.15);
    expect(r.verdict).toBe('fail');
  });

  it('#2 a 0-100 score is rescaled to [0,1]', () => {
    const r = coerceRawResult({ score: 85, verdict: 'pass' });
    expect(r.score).toBeCloseTo(0.85);
    expect(r.verdict).toBe('pass');
  });

  it('#3 missing verdict defaults to uncertain (never fabricated from score)', () => {
    const r = coerceRawResult({ score: 0.95 });
    expect(r.score).toBe(0.95);
    expect(r.verdict).toBe('uncertain');
  });

  it('extracts subScores leniently (string axis coerced, missing axes undefined)', () => {
    const r = coerceRawResult({
      score: 0.8, verdict: 'pass', subScores: { correctness: 0.9, safety: '0.7' },
    });
    expect(r.subScores?.correctness).toBe(0.9);
    expect(r.subScores?.safety).toBe(0.7); // '0.7' string coerced
    expect(r.subScores?.grounding).toBeUndefined();
  });

  it('caps rationale at 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = coerceRawResult({ score: 0.5, verdict: 'pass', rationale: long });
    expect(r.shortRationale?.length).toBe(200);
  });

  it('throws only when NO numeric score can be recovered', () => {
    expect(() => coerceRawResult({ verdict: 'pass', feedback: 'great' })).toThrow(/unparseable/);
  });

  it('no regression: a fully-canonical rubric object still parses', () => {
    const r = coerceRawResult({ score: 0.42, verdict: 'fail', confidence: 0.8, rationale: 'why' });
    expect(r.score).toBe(0.42);
    expect(r.verdict).toBe('fail');
    expect(r.confidence).toBe(0.8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// coerceRawResult — regex salvage of UNPARSEABLE judge JSON (raw string input).
// These fail JSON.parse, so only the shared normalizer's regex salvage recovers
// them — the exact prod case where a slow judge was truncated mid-`reasoning`.
// ─────────────────────────────────────────────────────────────────────────────
describe('coerceRawResult — regex salvage of unparseable judge JSON', () => {
  it('recovers score from fenced JSON truncated mid-reasoning', () => {
    const truncated =
      '```json\n{\n  "correctness": 0.95,\n  "verdict": "pass",\n  "overall": 0.93,\n' +
      '  "reasoning": [\n    "Correctness (0.95): logically sound and ha';
    const r = coerceRawResult(truncated);
    expect(r.score).toBeCloseTo(0.93);
    // JSON was unparseable, so no clean verdict object → honest `uncertain`.
    expect(r.verdict).toBe('uncertain');
  });

  it('recovers score from JSON with a trailing comma (JSON.parse rejects)', () => {
    const r = coerceRawResult('{"score": 0.8, "verdict": "pass",}');
    expect(r.score).toBeCloseTo(0.8);
    expect(r.verdict).toBe('uncertain');
  });

  it('tolerates a 0-100 scale in salvage', () => {
    const r = coerceRawResult('{"score": 85, "reasoning": "the answer was correct but');
    expect(r.score).toBeCloseTo(0.85);
  });

  it('still throws when no numeric score is present in unparseable text', () => {
    expect(() => coerceRawResult('```json\n{\n  "feedback": "great work, but')).toThrow(
      /unparseable/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full client path — judge() end-to-end + operability metric emission.
// ─────────────────────────────────────────────────────────────────────────────
describe('ProviderLLMJudgeClient.judge — metric emission by parse class', () => {
  beforeEach(() => resetMetricCountersForTesting());

  const resultTotal = (verdict: string, parseClass: string) =>
    getCounterValueForTesting(METRIC_NAMES.LLM_JUDGE_RESULT_TOTAL, { verdict, parseClass });

  it('emits an `ok` result metric for a clean parse', async () => {
    const r = await clientReturning('{"score":0.8,"verdict":"pass"}').judge({ ...JUDGE_INPUT });
    expect(r.score).toBe(0.8);
    expect(resultTotal('pass', 'ok')).toBe(1);
  });

  it('salvages a truncated response and tags the metric `salvaged`', async () => {
    const truncated = '```json\n{\n  "overall": 0.9,\n  "reasoning": ["the candidate is corr';
    const r = await clientReturning(truncated).judge({ ...JUDGE_INPUT });
    expect(r.score).toBeCloseTo(0.9);
    expect(r.verdict).toBe('uncertain');
    expect(resultTotal('uncertain', 'salvaged')).toBe(1);
  });

  it('emits an `unrecoverable` failure metric when no score can be salvaged', async () => {
    await expect(clientReturning('{"feedback":"nice"}').judge({ ...JUDGE_INPUT })).rejects.toThrow();
    expect(resultTotal('none', 'unrecoverable')).toBe(1);
  });

  it('emits an `empty` failure metric when the provider returns no content', async () => {
    await expect(clientReturning('').judge({ ...JUDGE_INPUT })).rejects.toThrow(/empty/);
    expect(resultTotal('none', 'empty')).toBe(1);
  });

  it('emits a `model_not_found` failure metric when the judge model does not resolve', async () => {
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry({}, false) });
    await expect(client.judge({ ...JUDGE_INPUT })).rejects.toThrow(/judge_model_not_found/);
    expect(resultTotal('none', 'model_not_found')).toBe(1);
  });
});
