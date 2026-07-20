// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability #4 (tool-calling) — objective grading proof.
 *
 * Verifies the operator's acceptance criterion deterministically, without a live
 * server: a response that RESULTS FROM calling the tool scores 1, and one that
 * answers BLIND (no call, wrong number) scores 0 — via BOTH objective signals
 * (answer_check on the post-loop FINAL answer, and a matching raw tool_call).
 *
 * Also asserts the suite wiring (166-169 carry tools + expectTool + answerCheck +
 * a FINAL: prompt) and that the tool handlers actually return the datum the
 * answerCheck expects (single source of truth — a task can't drift from its tool).
 */
import { describe, it, expect } from 'vitest';
import { narrowAs } from '@/utils/type-guards';
import type { ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import { EXPERIMENT_SUITE, getToolCallingTaskIndices, getVerifiableTaskIndices, getRunnableTextTaskIndices } from '../experiment-suite';
import {
  gradeToolCallingResponse,
  isToolCallingTask,
  matchToolCall,
  type ObservedToolCall,
} from '../tool-calling-grader';
import {
  EXPERIMENT_TOOL_CALLING_TASKS,
  EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS,
  TOOL_TASK_EXPECTED,
  resolveCurrencyCode,
  resolveSku,
} from '../experiment-tool-catalog';

const TOOL_CALLING_TASK_INDICES = getToolCallingTaskIndices();

const task166 = EXPERIMENT_TOOL_CALLING_TASKS.find((t) => t.index === 166)!;
const task167 = EXPERIMENT_TOOL_CALLING_TASKS.find((t) => t.index === 167)!;

const toolCall = (name: string, args: Record<string, unknown>): ObservedToolCall => ({
  id: 'call_1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const ctx = narrowAs<ToolExecutionContext>({
  workingDirectory: process.cwd(),
  log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } },
});

describe('tool-calling grader — the core 1-vs-0 guarantee', () => {
  it('scores 1 when the FINAL answer matches (the server-loop path: tool_calls already consumed)', () => {
    // Model called getExchangeRate, got rate 3.75, answered 100×3.75=375.
    const r = gradeToolCallingResponse(task166, {
      content: 'I called getExchangeRate: 1 ZRG = 3.75 USD, so 100 ZRG = 375 USD.\nFINAL: 375',
      toolCalls: undefined, // loop consumed the calls; only the grounded answer remains
    });
    expect(r.objectiveScore).toBe(1);
    expect(r.answerMatched).toBe(true);
  });

  it('scores 0 when the model answers BLIND (never called the tool → cannot know the fictional rate)', () => {
    // No tool_calls, and a plausible-but-wrong guess (the real rate is unknowable).
    const r = gradeToolCallingResponse(task166, {
      content: 'ZorgCoins are roughly a dollar each, so about 100 USD.\nFINAL: 100',
      toolCalls: undefined,
    });
    expect(r.objectiveScore).toBe(0);
    expect(r.answerMatched).toBe(false);
    expect(r.toolMatched).toBe(false);
  });

  it('scores 1 via the tool_call branch when the raw call survives in the response', () => {
    // A path that returns the raw tool_call (no server loop). Even if the text
    // answer is absent/wrong, the correct request is objective evidence.
    const r = gradeToolCallingResponse(task166, {
      content: '', // no final answer yet — the call was just emitted
      toolCalls: [toolCall('getExchangeRate', { from: 'ZRG', to: 'USD' })],
    });
    expect(r.objectiveScore).toBe(1);
    expect(r.toolMatched).toBe(true);
  });

  it('scores 0 when tool_calls are present but for the WRONG tool/args', () => {
    const r = gradeToolCallingResponse(task167, {
      content: 'FINAL: 12',
      toolCalls: [toolCall('lookupInventory', { sku: 'ZZ-0' })], // wrong SKU, wrong answer
    });
    expect(r.objectiveScore).toBe(0);
    expect(r.toolMatched).toBe(false);
    expect(r.answerMatched).toBe(false);
  });
});

describe('tool-calling grader — matching + extraction details', () => {
  it('matchToolCall is loose/case-insensitive on args (ZorgCoin ⊇ ZRG)', () => {
    expect(matchToolCall([toolCall('getExchangeRate', { from: 'ZorgCoin (ZRG)', to: 'usd' })], task166.expectTool!)).toBe(true);
    expect(matchToolCall([toolCall('getExchangeRate', { from: 'BLP', to: 'USD' })], task166.expectTool!)).toBe(false);
    expect(matchToolCall([], task166.expectTool!)).toBe(false);
  });

  it('uses the canonical FINAL extraction: LAST FINAL line wins, prose tolerated', () => {
    // Same instrument as every other verifiable task (best-of-n-verifier).
    expect(
      gradeToolCallingResponse(task166, { content: 'draft FINAL: 42\ncorrected FINAL: 375' }).objectiveScore,
    ).toBe(1);
    // No FINAL marker → falls back to the last number in the reply.
    expect(gradeToolCallingResponse(task166, { content: 'that comes to 375' }).objectiveScore).toBe(1);
  });

  it('every 166-169 task is a tool-calling task with tools + expectTool + answerCheck + FINAL prompt', () => {
    expect(TOOL_CALLING_TASK_INDICES).toEqual([166, 167, 168, 169]);
    for (const t of EXPERIMENT_TOOL_CALLING_TASKS) {
      expect(isToolCallingTask(t), `task ${t.index}`).toBe(true);
      expect(t.tools && t.tools.length, `task ${t.index} tools`).toBeGreaterThan(0);
      expect(t.expectTool, `task ${t.index} expectTool`).toBeDefined();
      expect(t.answerCheck, `task ${t.index} answerCheck`).toBeDefined();
      expect(t.prompt, `task ${t.index} FINAL`).toMatch(/FINAL:/);
      expect(t.taskType).toBe('tool-calling');
    }
  });

  it('the tasks are wired into the shared EXPERIMENT_SUITE', () => {
    for (const idx of TOOL_CALLING_TASK_INDICES) {
      expect(EXPERIMENT_SUITE.find((t) => t.index === idx), `suite has ${idx}`).toBeDefined();
    }
  });

  // ── Isolation: a new capability must not silently change existing protocols ──

  it('tool tasks are EXCLUDED from the pre-registered verifiable subset (H-A)', () => {
    // They carry an answerCheck, so without the explicit exclusion they would
    // silently join getVerifiableTaskIndices() and change H-A's composition.
    const verifiable = getVerifiableTaskIndices();
    for (const idx of TOOL_CALLING_TASK_INDICES) {
      expect(verifiable, `verifiable subset must not contain tool task ${idx}`).not.toContain(idx);
    }
  });

  it('tool tasks are EXCLUDED from the main comparison default task set', () => {
    // They need function_calling arms (the main comparison does not require it)
    // and are graded binary/objectively — both would contaminate that run.
    const runnable = getRunnableTextTaskIndices();
    for (const idx of TOOL_CALLING_TASK_INDICES) {
      expect(runnable, `runnable-text set must not contain tool task ${idx}`).not.toContain(idx);
    }
  });
});

describe('tool handlers ARE the single source of truth for the expected answers', () => {
  const handlerOf = (name: string) => EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS.find((t) => t.name === name)!.handler;

  it('getExchangeRate(ZRG,USD)=3.75 → 100 ZRG = 375 USD (matches task 166 + TOOL_TASK_EXPECTED)', async () => {
    const res = await handlerOf('getExchangeRate')({ from: 'ZRG', to: 'USD' }, 'c1', ctx);
    expect(res.success).toBe(true);
    const rate = (res.metadata as { rate: number }).rate;
    expect(100 * rate).toBe(TOOL_TASK_EXPECTED[166]);
    expect(task166.answerCheck!.expected).toBe(TOOL_TASK_EXPECTED[166]);
  });

  it('lookupInventory(QX-9)=4321 (matches task 167 + TOOL_TASK_EXPECTED)', async () => {
    const res = await handlerOf('lookupInventory')({ sku: 'QX-9' }, 'c2', ctx);
    expect(res.success).toBe(true);
    expect((res.metadata as { in_stock: number }).in_stock).toBe(TOOL_TASK_EXPECTED[167]);
  });

  it('unknown currency / SKU fail closed (model then cannot answer → scores 0)', async () => {
    const bad = await handlerOf('getExchangeRate')({ from: 'FAKE', to: 'USD' }, 'c3', ctx);
    expect(bad.success).toBe(false);
    expect(resolveCurrencyCode('FAKE')).toBeNull();
    expect(resolveSku('NOPE')).toBeNull();
  });

  it('every task expected answer is reachable from the tables', () => {
    // 168: 8×12 QBT @ 12.5 = 1200 ; 169: 1580 ZP-7 × 3kg = 4740
    expect(TOOL_TASK_EXPECTED[168]).toBe(1200);
    expect(TOOL_TASK_EXPECTED[169]).toBe(4740);
    for (const t of EXPERIMENT_TOOL_CALLING_TASKS) {
      expect(t.answerCheck!.expected).toBe(TOOL_TASK_EXPECTED[t.index]);
    }
  });
});
