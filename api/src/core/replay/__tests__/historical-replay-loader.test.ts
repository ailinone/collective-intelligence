// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-loader.test.ts — MVP 8B.5
 *
 * Tests the loader's parsing + sanitisation rules.
 */

import { describe, expect, it } from 'vitest';
import { loadFromJsonl } from '../historical-replay-loader';
import { SYNTHETIC_REPLAY_FIXTURE, asJsonl } from './fixtures/synthetic-replay.fixture';

describe('loadFromJsonl — happy path', () => {
  it('parses every line of a well-formed JSONL', () => {
    const text = asJsonl();
    const r = loadFromJsonl(text);
    expect(r.executions.length).toBe(SYNTHETIC_REPLAY_FIXTURE.length);
    expect(r.skipped.length).toBe(0);
  });

  it('preserves required fields', () => {
    const text = asJsonl();
    const r = loadFromJsonl(text);
    for (const e of r.executions) {
      expect(e.executionId).toBeTruthy();
      expect(e.experimentId).toBeTruthy();
      expect(e.taskType).toBeTruthy();
      expect(e.strategyId).toBeTruthy();
      expect(e.modelsUsed.length).toBeGreaterThan(0);
    }
  });

  it('result is frozen', () => {
    const r = loadFromJsonl(asJsonl());
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.executions)).toBe(true);
    expect(Object.isFrozen(r.skipped)).toBe(true);
  });
});

describe('loadFromJsonl — sanitisation', () => {
  const ROW_WITH_PII = JSON.stringify({
    executionId: 'e1',
    experimentId: 'exp1',
    taskId: 't1',
    taskType: 'code',
    strategy: 'single',
    modelsUsed: ['m1'],
    judgeScore: 0.5,
    costUsd: 0.01,
    success: true,
    prompt: 'SECRET-PROMPT-CONTENT',
    response: 'SECRET-RESPONSE-CONTENT',
    messages: ['SECRET-MESSAGE'],
    rawContext: 'SECRET-CONTEXT',
    judge_rubric: 'SECRET-RUBRIC',
    structured_metadata: { foo: 'SECRET' },
  });

  it('strips prompt/response/messages/rawContext from parsed row', () => {
    const r = loadFromJsonl(ROW_WITH_PII);
    expect(r.executions.length).toBe(1);
    const e = r.executions[0];
    const json = JSON.stringify(e);
    expect(json).not.toContain('SECRET-PROMPT-CONTENT');
    expect(json).not.toContain('SECRET-RESPONSE-CONTENT');
    expect(json).not.toContain('SECRET-MESSAGE');
    expect(json).not.toContain('SECRET-CONTEXT');
    expect(json).not.toContain('SECRET-RUBRIC');
    expect(json).not.toContain('"prompt"');
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"rawContext"');
  });
});

describe('loadFromJsonl — error tolerance', () => {
  it('skips invalid JSON lines', () => {
    const text = '{"executionId":"e1"\nthis-is-not-json\n{}';
    const r = loadFromJsonl(text);
    // Two lines fail (invalid JSON + missing required fields). One is "{}".
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it('skips rows missing required fields', () => {
    const text = JSON.stringify({ foo: 'bar' });
    const r = loadFromJsonl(text);
    expect(r.executions.length).toBe(0);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0].reason).toBe('missing_required_fields');
  });

  it('parses Postgres array literal in modelsUsed', () => {
    const row = JSON.stringify({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      strategy: 'parallel',
      modelsUsed: '{model-a,model-b}',
      judgeScore: 0.5,
      costUsd: 0.01,
      success: true,
    });
    const r = loadFromJsonl(row);
    expect(r.executions.length).toBe(1);
    expect(r.executions[0].modelsUsed).toEqual(['model-a', 'model-b']);
  });
});

describe('loadFromJsonl — does not throw on empty input', () => {
  it('empty string → zero executions', () => {
    const r = loadFromJsonl('');
    expect(r.executions.length).toBe(0);
    expect(r.skipped.length).toBe(0);
  });
});
