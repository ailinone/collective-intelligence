// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-sanitizer.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import {
  sanitiseRow,
  sanitiseRows,
} from '../harvest/historical-results-sanitizer';

describe('sanitiseRow', () => {
  it('strips PII fields (prompt, response, messages, rawContext, …)', () => {
    const raw = {
      id: 'e1',
      experiment_id: 'exp1',
      task_type: 'code-generation',
      prompt: 'SECRET-PROMPT',
      response: 'SECRET-RESPONSE',
      response_summary: 'SECRET-SUMMARY',
      messages: ['SECRET-M'],
      rawContext: 'SECRET-CTX',
      judge_rubric: 'SECRET-RUBRIC',
      structured_metadata: { foo: 'SECRET' },
    };
    const { sanitised, droppedKeys } = sanitiseRow(raw);
    const json = JSON.stringify(sanitised);
    expect(json).not.toContain('SECRET-PROMPT');
    expect(json).not.toContain('SECRET-RESPONSE');
    expect(json).not.toContain('SECRET-SUMMARY');
    expect(json).not.toContain('SECRET-M');
    expect(json).not.toContain('SECRET-CTX');
    expect(json).not.toContain('SECRET-RUBRIC');
    expect(droppedKeys.length).toBeGreaterThan(0);
  });

  it('renames snake_case to camelCase', () => {
    const raw = {
      id: 'e1',
      experiment_id: 'exp1',
      task_index: 5,
      task_type: 'analysis',
      models_used: ['m'],
      judge_score: 0.5,
      cost_usd: 0.02,
      created_at: '2026-05-01',
    };
    const { sanitised } = sanitiseRow(raw);
    const s = sanitised as Record<string, unknown>;
    expect(s.executionId).toBe('e1');
    expect(s.experimentId).toBe('exp1');
    expect(s.taskIndex).toBe(5);
    expect(s.taskType).toBe('analysis');
    expect(s.modelsUsed).toEqual(['m']);
    expect(s.judgeScore).toBe(0.5);
    expect(s.costUsd).toBe(0.02);
  });

  it('drops unknown columns silently', () => {
    const raw = {
      id: 'e1',
      experiment_id: 'exp1',
      some_unknown_column: 'whatever',
    };
    const { sanitised, droppedKeys } = sanitiseRow(raw);
    const s = sanitised as Record<string, unknown>;
    expect(s.some_unknown_column).toBeUndefined();
    expect(droppedKeys).toContain('some_unknown_column');
  });
});

describe('sanitiseRows — aggregate', () => {
  it('counts dropped fields across rows', () => {
    const rows = [
      { id: 'e1', experiment_id: 'exp1', prompt: 'p1' },
      { id: 'e2', experiment_id: 'exp2', prompt: 'p2', response: 'r2' },
    ];
    const { sanitised, droppedKeyCounts } = sanitiseRows(rows);
    expect(sanitised.length).toBe(2);
    expect(droppedKeyCounts.prompt).toBe(2);
    expect(droppedKeyCounts.response).toBe(1);
  });
});
