// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Lote 3 of the system-prompts audit refactor.
 *
 * Covers:
 *   R2       — unified JudgeVerdict schema + normalizeJudgeOutput adapts
 *              legacy BEST/REASON text, legacy 0-100 scores array, and
 *              legacy dimensional JSON into the canonical shape.
 *   R3       — inline prompts migrated to the SOTA catalog are importable
 *              under their canonical names.
 *   Z-A/B    — peer-review benchmark harness is reproducible, correctly
 *              aggregates, and produces non-null recommendations.
 *   T-Strict — strict top-level schema rejects unknown keys;
 *              detectTriageDrift surfaces drift as a metric.
 *   O-Obs    — fallback / peer-review / triage / judge hooks all bump the
 *              shared prompt-metrics counters.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  JudgeVerdictSchema,
  IssueSchema,
  normalizeJudgeOutput,
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
} from '@/core/quality/judge-schema';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { TriageResponseSchema, detectTriageDrift } from '../triage-schema';
import {
  aggregateReport,
  buildRecommendation,
  runPeerReviewABBenchmark,
  REPRESENTATIVE_TASKS,
  type BenchmarkSample,
  type ExecutionRunner,
  type QualityJudge,
  type BenchmarkArm,
} from '@/core/benchmark/peer-review-ab-benchmark';
import {
  PROMPT_METRIC_NAMES,
  getPromptMetric,
  resetPromptMetrics,
} from '../prompts/prompt-metrics';
import { buildAilinFallbackPrompt } from '../prompts/fallback-prompt';
import {
  shouldInjectPeerReviewPrompt,
  injectPeerReviewPrompt,
} from '../prompts/peer-review-prompt';
import type { ChatRequest, ChatResponse } from '@/types';

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hi' }],
    ...overrides,
  } as ChatRequest;
}

// ────────────────────────────────────────────────────────────────────────────
// R2 — Unified judge schema
// ────────────────────────────────────────────────────────────────────────────

describe('R2 — JudgeVerdict schema', () => {
  it('accepts a canonical verdict with score + issues', () => {
    const parsed = JudgeVerdictSchema.safeParse({
      score: 0.85,
      issues: [
        { severity: 'major', location: 'paragraph 2', description: 'missing edge case' },
      ],
      summary: 'Mostly good, one gap.',
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects score out of range', () => {
    expect(JudgeVerdictSchema.safeParse({ score: 1.4, issues: [] }).success).toBe(false);
  });

  it('rejects unknown severity', () => {
    expect(
      IssueSchema.safeParse({ severity: 'catastrophic', location: 'x', description: 'y' }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level verdict keys', () => {
    const parsed = JudgeVerdictSchema.safeParse({
      score: 0.5,
      issues: [],
      not_a_field: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('R2 — normalizeJudgeOutput legacy adapters', () => {
  beforeEach(() => resetPromptMetrics());

  it('accepts canonical JudgeVerdict JSON unchanged', () => {
    const v = normalizeJudgeOutput(
      { score: 0.7, issues: [], summary: 'ok' },
      { where: 'test.canonical' },
    );
    expect(v?.score).toBe(0.7);
    expect(getPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS)).toBe(1);
  });

  it('parses canonical JSON embedded in a prose response', () => {
    const raw =
      'Here is my evaluation:\n```json\n{"score": 0.9, "issues": [], "winnerIndex": 2}\n```\nEnd.';
    const v = normalizeJudgeOutput(raw, { where: 'test.prose' });
    expect(v?.score).toBe(0.9);
    expect(v?.winnerIndex).toBe(2);
  });

  it('converts legacy {scores: [0-100], weaknesses} to canonical verdict', () => {
    const raw = {
      scores: [60, 90, 70],
      weaknesses: [['verbose'], ['missing caveats'], []],
      recommendation: 'Solution 2 is strongest on completeness.',
      confidence: 0.8,
    };
    const v = normalizeJudgeOutput(raw, { where: 'test.arbitration' });
    expect(v?.winnerIndex).toBe(1);
    expect(v?.score).toBeCloseTo(0.9, 5);
    expect(v?.issues.length).toBeGreaterThan(0);
    expect(v?.dimensions).toBeDefined();
  });

  it('converts legacy {overall, correctness, ...} quality-scorer output', () => {
    const v = normalizeJudgeOutput(
      {
        overall: 0.82,
        correctness: 0.9,
        completeness: 0.8,
        clarity: 0.7,
        relevance: 0.9,
        reasoning: ['solid logic', 'minor stylistic issues'],
      },
      { where: 'test.dimensional' },
    );
    expect(v?.score).toBe(0.82);
    expect(v?.dimensions?.correctness).toBe(0.9);
    expect(v?.summary).toContain('solid logic');
  });

  it('converts legacy "BEST: N\\nREASON: X" free text to canonical winnerIndex', () => {
    const v = normalizeJudgeOutput('BEST: 1\nREASON: more accurate and concise', {
      where: 'test.best-text',
      candidateCount: 3,
    });
    expect(v?.winnerIndex).toBe(1);
    expect(v?.summary).toContain('accurate');
  });

  it('rejects BEST index beyond candidate count', () => {
    const v = normalizeJudgeOutput('BEST: 9\nREASON: out of range', {
      where: 'test.out-of-range',
      candidateCount: 3,
    });
    expect(v).toBeUndefined();
  });

  it('returns undefined and bumps failure counter on unrecognized input', () => {
    resetPromptMetrics();
    const v = normalizeJudgeOutput(42, { where: 'test.unknown' });
    expect(v).toBeUndefined();
    expect(getPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATION_FAILURES)).toBe(1);
  });

  it('exports instructions string that mentions the required JSON fields', () => {
    expect(JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS).toContain('score');
    expect(JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS).toContain('issues');
    expect(JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS).toContain('winnerIndex');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R3 — Inline prompts migrated to catalog
// ────────────────────────────────────────────────────────────────────────────

describe('R3 — migrated prompts are in the SOTA catalog', () => {
  it('stigmergicCritic is a factory producing a prompt tailored to the review', () => {
    const out = PROMPTS.stigmergicCritic('Original question?', 'Refined answer.');
    expect(out).toContain('Ailin¹ Collective Intelligence refinement pipeline');
    expect(out).toContain('Original question?');
    expect(out).toContain('Refined answer.');
  });

  it('doubleDiamondSynthesizer is present and mentions Double Diamond', () => {
    expect(PROMPTS.doubleDiamondSynthesizer).toContain('Double Diamond');
    expect(PROMPTS.doubleDiamondSynthesizer).toContain('Ailin¹');
  });

  it('warRoomSpecialistRework is present and references critic feedback', () => {
    expect(PROMPTS.warRoomSpecialistRework).toContain('critic');
    expect(PROMPTS.warRoomSpecialistRework).toContain('war-room');
  });

  it('migrated prompts carry the adaptive-depth directive (regression vs R5)', () => {
    expect(PROMPTS.doubleDiamondSynthesizer.toLowerCase()).toContain(
      'match depth to task complexity',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Z-A/B — Peer-review benchmark harness
// ────────────────────────────────────────────────────────────────────────────

describe('Z-A/B — peer-review benchmark harness', () => {
  const fakeResponse = (text: string): ChatResponse =>
    ({
      choices: [{ message: { content: text, role: 'assistant' } }],
    }) as unknown as ChatResponse;

  /** Deterministic runner: reports fixed latency/tokens per arm. */
  function makeRunner(
    profiles: Record<BenchmarkArm, { latency: number; tokens: number; quality: number }>,
  ): ExecutionRunner {
    return {
      async run(_task, arm) {
        const p = profiles[arm];
        return {
          response: fakeResponse(`${arm}-${p.quality}`),
          latencyMs: p.latency,
          inputTokens: p.tokens,
          outputTokens: p.tokens,
          totalCost: p.tokens * 0.00001,
          success: true,
        };
      },
    };
  }

  /** Deterministic judge: extracts the numeric quality from the response content. */
  const judge: QualityJudge = {
    async score({ response }) {
      const text = response?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') return undefined;
      const m = text.match(/-([\d.]+)$/);
      if (!m) return undefined;
      return { score: Number(m[1]), issues: [] };
    },
  };

  it('runs both arms against every task and produces a full report', async () => {
    const runner = makeRunner({
      'A-peer-review-on': { latency: 2000, tokens: 900, quality: 0.8 },
      'B-peer-review-off': { latency: 1800, tokens: 800, quality: 0.78 },
    });
    const report = await runPeerReviewABBenchmark({
      runId: 'unit-test-run',
      tasks: REPRESENTATIVE_TASKS,
      runner,
      judge,
    });
    expect(report.samples.length).toBe(REPRESENTATIVE_TASKS.length * 2);
    expect(report.aggregates.byArm['A-peer-review-on'].meanQuality).toBeCloseTo(0.8, 3);
    expect(report.aggregates.byArm['B-peer-review-off'].meanQuality).toBeCloseTo(0.78, 3);
    expect(report.recommendation.decision).toBeDefined();
  });

  it('recommends flip-off when off is at least as good and saves tokens', async () => {
    const runner = makeRunner({
      'A-peer-review-on': { latency: 2000, tokens: 1000, quality: 0.79 },
      'B-peer-review-off': { latency: 1500, tokens: 800, quality: 0.8 },
    });
    const report = await runPeerReviewABBenchmark({
      runId: 'flip-off-test',
      tasks: REPRESENTATIVE_TASKS,
      runner,
      judge,
    });
    expect(report.recommendation.decision).toBe('flip-off');
  });

  it('recommends keep-on when on dominates by >=0.03', async () => {
    const runner = makeRunner({
      'A-peer-review-on': { latency: 2000, tokens: 1000, quality: 0.9 },
      'B-peer-review-off': { latency: 1800, tokens: 900, quality: 0.8 },
    });
    const report = await runPeerReviewABBenchmark({
      runId: 'keep-on-test',
      tasks: REPRESENTATIVE_TASKS,
      runner,
      judge,
    });
    expect(report.recommendation.decision).toBe('keep-on');
  });

  it('flags inconclusive when sample count is too small', () => {
    const emptySamples: BenchmarkSample[] = [];
    const rec = buildRecommendation(emptySamples);
    expect(rec.decision).toBe('inconclusive');
  });

  it('aggregateReport computes mean correctly per arm', () => {
    const samples: BenchmarkSample[] = [
      {
        taskId: 't1',
        arm: 'A-peer-review-on',
        category: 'x',
        strategy: 'single',
        complexity: 'low',
        qualityScore: 0.8,
        latencyMs: 1000,
        inputTokens: 100,
        outputTokens: 100,
        totalCost: 0.001,
        success: true,
      },
      {
        taskId: 't1',
        arm: 'B-peer-review-off',
        category: 'x',
        strategy: 'single',
        complexity: 'low',
        qualityScore: 0.7,
        latencyMs: 900,
        inputTokens: 90,
        outputTokens: 90,
        totalCost: 0.0009,
        success: true,
      },
    ];
    const agg = aggregateReport(samples);
    expect(agg.byArm['A-peer-review-on'].meanQuality).toBe(0.8);
    expect(agg.byArm['B-peer-review-off'].meanQuality).toBe(0.7);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-Strict — triage schema hardening
// ────────────────────────────────────────────────────────────────────────────

describe('T-Strict — triage schema hardening', () => {
  beforeEach(() => resetPromptMetrics());

  it('rejects unknown TOP-LEVEL keys (strict)', () => {
    const parsed = TriageResponseSchema.safeParse({
      intent: 'analysis',
      complexity: 'low',
      evil_hidden_field: 'no pasaran',
    });
    expect(parsed.success).toBe(false);
  });

  it('silently drops unknown keys inside stages (strip, not strict)', () => {
    const parsed = TriageResponseSchema.safeParse({
      intent: 'analysis',
      execution_plan: {
        max_tokens: 2048,
        quality_target: 0.8,
        prefer_speed: false,
        required_capabilities: [],
        estimated_input_tokens: 0,
        strategy: 'single',
        model_count: 1,
        requires_continuation: false,
        stages: [
          {
            name: 'main',
            strategy: 'single',
            model_roles: [{ role: 'primary', count: 1, preferred_capabilities: [], quality_target: 0.8 }],
            required_capabilities: [],
            max_tokens: 2048,
            experimental_foo: 'bar', // unknown key — should be stripped, not rejected
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.execution_plan?.stages[0].name).toBe('main');
    // @ts-expect-error -- experimental_foo should not exist on the typed shape
    expect(parsed.data.execution_plan?.stages[0].experimental_foo).toBeUndefined();
  });

  it('detectTriageDrift reports unknown keys and bumps drift metric', () => {
    resetPromptMetrics();
    const drift = detectTriageDrift({
      intent: 'analysis',
      complexity: 'low',
      some_new_key: true,
      another_one: 42,
    });
    expect(drift).toEqual(expect.arrayContaining(['some_new_key', 'another_one']));
    expect(getPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_DRIFT_DETECTED)).toBe(2);
  });

  it('detectTriageDrift returns empty array for clean payloads', () => {
    const drift = detectTriageDrift({ intent: 'analysis', complexity: 'low' });
    expect(drift).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// O-Obs — metrics wired to every observability point
// ────────────────────────────────────────────────────────────────────────────

describe('O-Obs — prompt metrics wiring', () => {
  beforeEach(() => resetPromptMetrics());

  it('fallback activation increments the fallback counter', () => {
    buildAilinFallbackPrompt('lote3-test-site');
    expect(getPromptMetric(PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS)).toBe(1);
  });

  it('peer-review injection increments the injection counter', () => {
    injectPeerReviewPrompt(makeRequest());
    expect(getPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS)).toBe(1);
  });

  it('peer-review skipped increments the skipped counter', () => {
    shouldInjectPeerReviewPrompt({
      isCollectiveStrategy: false,
      request: makeRequest(),
    });
    expect(getPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED)).toBe(1);
  });

  it('peer-review mode-off increments skipped with attribute reason', () => {
    shouldInjectPeerReviewPrompt({
      isCollectiveStrategy: true,
      request: makeRequest(),
      env: { AILIN_PEER_REVIEW_MODE: 'off' },
    });
    expect(getPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED)).toBe(1);
  });

  it('judge normalization bumps counter on success', () => {
    normalizeJudgeOutput({ score: 0.5, issues: [] }, { where: 'obs-test' });
    expect(getPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS)).toBe(1);
  });

  it('metric counters are independent and additive', () => {
    buildAilinFallbackPrompt('a');
    buildAilinFallbackPrompt('b');
    buildAilinFallbackPrompt('c');
    expect(getPromptMetric(PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS)).toBe(3);
    expect(getPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS)).toBe(0);
  });
});
