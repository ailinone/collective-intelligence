// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Systems trace pins (orchestration result -> ailin.systems `stages[]` / `trace_payloads[]`):
 *   - pipeline order and stage typing (triage -> selection -> participants -> quality -> decision -> narration);
 *   - evaluator verdict/score/outlier land on the matching participant;
 *   - the STRUCTURE plane never carries text derived from the user's data
 *     (triage reason, narration text, participant output, provider error messages);
 *   - the CONTENT plane exists only when capture is on, with stage-bound payloads;
 *   - the 32-stage / 40-payload caps keep the structural stages;
 *   - the builder never throws.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest, OrchestrationResult } from '@/types';
import type { SystemsPayload } from '../systems-trace';
import {
  MAX_PAYLOADS,
  MAX_STAGES,
  MAX_TOTAL_PAYLOAD_CHARS,
  applyPayloadBudget,
  buildSingleStreamTrace,
  buildSystemsTrace,
  classifyError,
  isContentCaptureEnabled,
  safeCorrelationId,
} from '../systems-trace';

const SECRET_TRIAGE_REASON = 'user asks about their salary negotiation';
const SECRET_NARRATION = 'Reviewer two disagreed about the salary figure';
const SECRET_OUTPUT = 'Your salary should be 120k';

function exec(modelId: string, role: string, overrides: Record<string, unknown> = {}) {
  return {
    modelId,
    modelName: modelId.split(':')[1] ?? modelId,
    provider: modelId.split(':')[0],
    role,
    request: {},
    response: {
      choices: [{ message: { content: `${SECRET_OUTPUT} (${modelId})` } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    cost: 0.002,
    durationMs: 1500,
    success: true,
    ...overrides,
  };
}

function consensusResult(): OrchestrationResult {
  return {
    strategyUsed: 'consensus',
    modelsUsed: [
      exec('anthropic:claude-a', 'voter'),
      exec('openai:gpt-b', 'voter'),
      exec('google:gemini-c', 'voter', {
        success: false,
        error: 'Request timed out after 15000ms for prompt "salary"',
        response: undefined,
      }),
      exec('anthropic:claude-a', 'synthesizer', { durationMs: 2100 }),
    ],
    finalResponse: {
      choices: [{ message: { content: SECRET_OUTPUT } }],
      usage: { prompt_tokens: 300, completion_tokens: 60 },
    },
    totalCost: 0.0071,
    totalDuration: 6645,
    metadata: {
      triage: {
        intent: 'analysis',
        complexity: 'high',
        confidence: 0.87,
        source: 'llm',
        reason: SECRET_TRIAGE_REASON,
        costUsd: 0.0001,
      },
      requested_strategy: 'best:large',
      resolved_strategy: 'consensus',
      decision_source: 'triage',
      final_decider_model_id: 'anthropic:claude-a',
      fallback_chain: ['anthropic:claude-a', 'openai:gpt-b'],
      quality: {
        method: 'llm',
        score: 0.9,
        judgeScore: 0.88,
        confidence: 0.7,
        reasoning: 'Answer is specific and consistent',
      },
      consensusArtifacts: {
        participantOutputs: [
          {
            modelId: 'openai:gpt-b',
            evaluatorVerdict: 'uncertain',
            individualScore: 0.62,
            outlier: true,
          },
          { modelId: 'anthropic:claude-a', evaluatorVerdict: 'pass', individualScore: 0.91 },
        ],
        finalSelection: { source: 'synthesis', fallbackTriggered: false },
      },
      observer_narrations: [
        {
          event: 'phase_start',
          narration: SECRET_NARRATION,
          reasoning: 'internal reasoning text',
          duration_ms: 300,
        },
        { event: 'model_failed', narration: 'Reviewer timed out', duration_ms: 5 },
      ],
    },
  } as unknown as OrchestrationResult;
}

const request = {
  model: 'best:large',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'How much salary should I ask for?' }] },
  ],
} as unknown as ChatRequest;

describe('buildSystemsTrace — structure plane', () => {
  const trace = buildSystemsTrace(consensusResult(), request, {
    correlationId: 'chat:abc-123:msg-9',
    captureContent: false,
  });

  it('orders the pipeline and types every stage', () => {
    expect(trace.stages.map((s) => [s.sequence, s.stage_type])).toEqual([
      [0, 'triage'],
      [1, 'strategy_selection'],
      [2, 'participant'],
      [3, 'participant'],
      [4, 'participant'],
      [5, 'synthesizer'],
      [6, 'quality'],
      [7, 'decider'],
      [8, 'narration'],
      [9, 'narration'],
    ]);
  });

  it('records triage and selection attributes', () => {
    expect(trace.stages[0].attributes).toMatchObject({
      intent: 'analysis',
      complexity: 'high',
      confidence: 0.87,
      triage_source: 'llm',
    });
    expect(trace.stages[1].attributes).toEqual({
      selection_source: 'triage',
      requested_strategy: 'best:large',
      resolved_strategy: 'consensus',
    });
  });

  it('puts the evaluator verdict, score and outlier flag on the matching participant', () => {
    const [claude, gpt, gemini] = [trace.stages[2], trace.stages[3], trace.stages[4]];
    expect(claude.attributes).toMatchObject({ role: 'voter', verdict: 'pass', score: 0.91 });
    expect(gpt.attributes).toMatchObject({ verdict: 'uncertain', score: 0.62, outlier: true });
    expect(gemini.status).toBe('error');
    expect(gemini.error_type).toBe('timeout');
    expect(gemini.attributes).toMatchObject({ error_code: 'timeout' });
    expect(gpt).toMatchObject({
      provider: 'openai',
      model: 'gpt-b',
      duration_ms: 1500,
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  it('records quality, the final decision and observer events', () => {
    expect(trace.stages[6].attributes).toMatchObject({
      judge_method: 'llm',
      judge_score: 0.88,
      score: 0.9,
    });
    expect(trace.stages[7].attributes).toMatchObject({
      final_decider: 'anthropic:claude-a',
      final_source: 'synthesis',
      fallback_from: 'anthropic:claude-a',
      fallback_to: 'openai:gpt-b',
      participants_executed: 4,
    });
    expect(trace.stages[8]).toMatchObject({
      name: 'Observer: phase_start',
      duration_ms: 300,
      attributes: { event: 'phase_start' },
    });
  });

  it('never carries text derived from the user data in the structure plane', () => {
    const wire = JSON.stringify(trace.stages);
    for (const secret of [
      SECRET_TRIAGE_REASON,
      SECRET_NARRATION,
      SECRET_OUTPUT,
      'salary',
      'internal reasoning text',
      'Answer is specific',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(trace.payloads).toBeUndefined();
  });

  it('carries the validated correlation id', () => {
    expect(trace.correlationId).toBe('chat:abc-123:msg-9');
  });
});

describe('buildSystemsTrace — content plane (opt-in)', () => {
  const trace = buildSystemsTrace(consensusResult(), request, { captureContent: true });
  const bySeq = (kind: string, seq?: number) =>
    trace.payloads?.filter((p) => p.kind === kind && p.stage_sequence === seq);

  it('adds input, participant outputs, narration, reasoning and the final output, bound to their stage', () => {
    expect(trace.payloads?.[0]).toMatchObject({ kind: 'input' });
    expect(trace.payloads?.[0].text).toContain('[user] How much salary should I ask for?');
    expect(bySeq('stage_output', 2)?.[0].text).toContain(SECRET_OUTPUT);
    expect(bySeq('stage_output', 4)).toEqual([]); // the failed voter produced no output
    expect(bySeq('reasoning', 0)?.[0].text).toBe(SECRET_TRIAGE_REASON);
    expect(bySeq('narration', 8)?.[0].text).toBe(SECRET_NARRATION);
    expect(bySeq('output', 7)?.[0].text).toBe(SECRET_OUTPUT);
  });

  it('keeps the structure plane free of content even when capture is on', () => {
    expect(JSON.stringify(trace.stages)).not.toContain(SECRET_OUTPUT);
  });

  it('is ON by default: unset or blank SYSTEMS_TRACE_CONTENT captures content', () => {
    expect(isContentCaptureEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ['', '   ']) {
      expect(isContentCaptureEnabled({ SYSTEMS_TRACE_CONTENT: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('accepts affirmative values case-insensitively', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      expect(isContentCaptureEnabled({ SYSTEMS_TRACE_CONTENT: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('fails SAFE: any explicit non-affirmative value (including a typo) turns capture off', () => {
    for (const v of ['false', 'FALSE', '0', 'off', 'no', 'disabled', 'flase', 'ture']) {
      expect(isContentCaptureEnabled({ SYSTEMS_TRACE_CONTENT: v } as NodeJS.ProcessEnv)).toBe(
        false
      );
    }
  });
});

describe('aggregate content budget', () => {
  const big = (kind: SystemsPayload['kind'], chars: number, seq?: number): SystemsPayload => ({
    kind,
    text: 'x'.repeat(chars),
    ...(seq === undefined ? {} : { stage_sequence: seq }),
  });

  it('leaves a request under the budget untouched', () => {
    const payloads = [big('input', 100), big('stage_output', 200, 1), big('output', 300)];
    expect(applyPayloadBudget(payloads)).toEqual(payloads);
  });

  it('never ships more than the budget and keeps the output and input first', () => {
    const payloads = [
      big('input', 60_000),
      ...Array.from({ length: 12 }, (_, i) => big('stage_output', 60_000, i)),
      big('output', 60_000),
    ];
    const kept = applyPayloadBudget(payloads);
    const total = kept.reduce((sum, p) => sum + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PAYLOAD_CHARS);
    expect(kept.some((p) => p.kind === 'output' && p.text.length === 60_000)).toBe(true);
    expect(kept.some((p) => p.kind === 'input' && p.text.length === 60_000)).toBe(true);
    expect(kept.length).toBeLessThan(payloads.length);
  });

  it('truncates the payload that crosses the budget and keeps the original order', () => {
    const kept = applyPayloadBudget(
      [big('input', 50), big('stage_output', 80, 0), big('stage_output', 80, 1), big('output', 50)],
      200
    );
    // output (50) + input (50) first, then 80 fits whole, the next one is cut to the 20 left.
    expect(kept.map((p) => p.kind)).toEqual(['input', 'stage_output', 'stage_output', 'output']);
    expect(kept.map((p) => p.text.length)).toEqual([50, 80, 20, 50]);
  });

  it('applies to a real orchestration trace', () => {
    const result = consensusResult();
    result.modelsUsed = Array.from({ length: 30 }, (_, i) =>
      exec(`p:m${i}`, 'voter', {
        response: { choices: [{ message: { content: 'y'.repeat(59_000) } }] },
      })
    ) as never;
    const trace = buildSystemsTrace(result, request, { captureContent: true });
    const total = trace.payloads!.reduce((sum, p) => sum + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PAYLOAD_CHARS);
    expect(trace.payloads!.some((p) => p.kind === 'output')).toBe(true);
  });
});

describe('caps and resilience', () => {
  it('keeps structural stages when participants overflow the 32-stage cap', () => {
    const result = consensusResult();
    result.modelsUsed = Array.from({ length: 50 }, (_, i) => exec(`p:m${i}`, 'voter')) as never;
    const trace = buildSystemsTrace(result, request, { captureContent: false });
    expect(trace.stages).toHaveLength(MAX_STAGES);
    const types = trace.stages.map((s) => s.stage_type);
    for (const required of ['triage', 'strategy_selection', 'quality', 'decider'])
      expect(types).toContain(required);
    expect(trace.stages.map((s) => s.sequence)).toEqual(
      Array.from({ length: MAX_STAGES }, (_, i) => i)
    );
  });

  it('keeps the final output when payloads overflow the cap', () => {
    const result = consensusResult();
    result.modelsUsed = Array.from({ length: 30 }, (_, i) => exec(`p:m${i}`, 'voter')) as never;
    (result.metadata as Record<string, unknown>).observer_narrations = Array.from(
      { length: 20 },
      () => ({
        event: 'phase_start',
        narration: 'n',
        reasoning: 'r',
        duration_ms: 1,
      })
    );
    const trace = buildSystemsTrace(result, request, { captureContent: true });
    expect(trace.payloads!.length).toBeLessThanOrEqual(MAX_PAYLOADS);
    expect(trace.payloads!.some((p) => p.kind === 'output')).toBe(true);
    expect(trace.payloads!.some((p) => p.kind === 'input')).toBe(true);
  });

  it('never throws on malformed results', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { metadata: null },
      { modelsUsed: 'x', metadata: { observer_narrations: 3 } },
    ]) {
      expect(() =>
        buildSystemsTrace(bad as never, undefined, { captureContent: true })
      ).not.toThrow();
    }
  });
});

describe('helpers', () => {
  it.each([
    ['Request timed out after 15000ms', 'timeout'],
    ['aborted by deadline', 'timeout'],
    ['429 Too Many Requests: rate limit hit', 'rate_limited'],
    ['Empty response from provider', 'empty_response'],
    ['HTTP 503 upstream unavailable', 'http_503'],
    ['something about the secret prompt', 'execution_error'],
  ])('classifyError(%j) -> %s, never echoing the message', (raw, code) => {
    expect(classifyError(raw)).toBe(code);
  });

  it('classifyError ignores empty input', () => {
    expect(classifyError(undefined)).toBeUndefined();
    expect(classifyError('')).toBeUndefined();
  });

  it('accepts only well-formed correlation ids (same rule as the inbound header)', () => {
    expect(
      safeCorrelationId(
        'chat:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'
      )
    ).toBeDefined();
    for (const bad of [
      'short',
      'has space in it',
      'x'.repeat(129),
      42,
      undefined,
      'bad/char/slash',
    ]) {
      expect(safeCorrelationId(bad)).toBeUndefined();
    }
  });

  it('builds the single-model streaming trace with fallback attempts and optional content', () => {
    const off = buildSingleStreamTrace({
      correlationId: 'chat:abc-123:msg-9',
      provider: 'cometapi',
      modelId: 'openai:gpt-5.4-nano',
      durationMs: 840,
      fallbackAttempts: 2,
      request,
      outputText: SECRET_OUTPUT,
      captureContent: false,
    });
    expect(off.stages).toEqual([
      expect.objectContaining({
        sequence: 0,
        stage_type: 'participant',
        provider: 'cometapi',
        model: 'gpt-5.4-nano',
        retry_count: 2,
        attributes: { role: 'primary', attempt: 3 },
      }),
    ]);
    expect(off.payloads).toBeUndefined();
    const on = buildSingleStreamTrace({
      provider: 'p',
      modelId: 'm',
      durationMs: 1,
      fallbackAttempts: 0,
      request,
      outputText: 'hi',
      captureContent: true,
    });
    expect(on.payloads?.map((p) => p.kind)).toEqual(['input', 'output']);
  });
});
