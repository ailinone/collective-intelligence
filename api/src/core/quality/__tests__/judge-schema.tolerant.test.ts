// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: `normalizeJudgeOutput` must salvage near-canonical judge JSON
 * that strict parsing rejects. The shapes below are REAL gpt-4o outputs
 * captured against prod (2026-06-26) that were silently dropped — ~50% of
 * judge scores lost, degrading both calibration AND production scoring.
 */
import { describe, it, expect } from 'vitest';
import { normalizeJudgeOutput } from '@/core/quality/judge-schema';

const ctx = { where: 'judge-schema.tolerant.test' };

describe('normalizeJudgeOutput — tolerant salvage of real LLM judge drift', () => {
  it('#0 confidence as string + extra keys (maxScore, breakdown)', () => {
    const v = normalizeJudgeOutput(
      { score: 0.7, maxScore: 1, breakdown: { a: 1 }, issues: [], summary: 'ok', confidence: '0.9' },
      ctx,
    );
    expect(v?.score).toBe(0.7);
    expect(v?.confidence).toBe(0.9);
  });

  it('#1 overallScore instead of score + alternate dimension keys', () => {
    const v = normalizeJudgeOutput(
      {
        rubricAdherence: 0.2, clarity: 0.3, efficiency: 0.1, edgeCaseHandling: 0,
        overallScore: 0.15, justification: 'weak', issues: [], summary: 's', confidence: 0.9,
      },
      ctx,
    );
    expect(v?.score).toBeCloseTo(0.15);
  });

  it('#2 extra `reasoning` key, rest canonical', () => {
    const v = normalizeJudgeOutput(
      { score: 0, reasoning: 'why', issues: [{ severity: 'critical', location: 'x', description: 'd' }], summary: 's', confidence: 1 },
      ctx,
    );
    expect(v?.score).toBe(0);
    expect(v?.issues.length).toBe(1);
  });

  it('#3 0-100 score + confidence as non-numeric string', () => {
    const v = normalizeJudgeOutput(
      { score: 85, breakdown: {}, issues: [], summary: 's', confidence: 'high' },
      ctx,
    );
    expect(v?.score).toBeCloseTo(0.85);
    expect(v?.confidence).toBeUndefined(); // 'high' is not numeric → omitted, not a crash
  });

  it('coerces non-enum issue severities (high→major, low→minor)', () => {
    const v = normalizeJudgeOutput(
      { score: 0.5, issues: [
        { severity: 'high', location: 'l', description: 'd' },
        { severity: 'low', location: 'l2', description: 'd2' },
      ] },
      ctx,
    );
    expect(v?.issues.map((i) => i.severity)).toEqual(['major', 'minor']);
  });

  it('returns undefined when no numeric score can be recovered', () => {
    expect(normalizeJudgeOutput({ feedback: 'great', issues: [] }, ctx)).toBeUndefined();
  });

  it('no regression: still accepts a fully-canonical verdict', () => {
    const v = normalizeJudgeOutput({ score: 0.95, issues: [], summary: 'good', confidence: 0.9 }, ctx);
    expect(v?.score).toBe(0.95);
  });
});

describe('normalizeJudgeOutput — regex salvage of UNPARSEABLE judge JSON', () => {
  // These fail `coerceObject` (JSON.parse throws), so the tolerant path never
  // runs — the exact prod case where a slow dynamic judge got truncated at the
  // 10s cap mid-`reasoning`, dropping an ACCURATE score. Regex salvage recovers it.
  it('recovers score from fenced JSON truncated mid-reasoning (the prod failure)', () => {
    const truncated =
      '```json\n{\n  "correctness": 0.95,\n  "completeness": 0.9,\n  "clarity": 0.95,\n' +
      '  "relevance": 1.0,\n  "overall": 0.93,\n  "reasoning": [\n' +
      '    "Correctness (0.95): The implementation is logically sound and ha';
    const v = normalizeJudgeOutput(truncated, ctx);
    expect(v?.score).toBeCloseTo(0.93);
    expect(v?.dimensions?.correctness).toBeCloseTo(0.95);
    expect(v?.dimensions?.relevance).toBeCloseTo(1.0);
  });

  it('recovers score from JSON with a trailing comma (JSON.parse rejects)', () => {
    const v = normalizeJudgeOutput('{"overall": 0.8, "correctness": 0.7,}', ctx);
    expect(v?.score).toBeCloseTo(0.8);
    expect(v?.dimensions?.correctness).toBeCloseTo(0.7);
  });

  it('tolerates a 0-100 scale in salvage', () => {
    const v = normalizeJudgeOutput('{"score": 85, "reasoning": "the answer was correct but', ctx);
    expect(v?.score).toBeCloseTo(0.85);
  });

  it('handles overallScore / overall_score spellings', () => {
    expect(normalizeJudgeOutput('{"overallScore": 0.6, "notes": "truncated', ctx)?.score).toBeCloseTo(0.6);
    expect(normalizeJudgeOutput('{"overall_score": 0.4, "notes": "truncated', ctx)?.score).toBeCloseTo(0.4);
  });

  it('still returns undefined when NO numeric score is present in the text', () => {
    expect(normalizeJudgeOutput('```json\n{\n  "feedback": "great work, but', ctx)).toBeUndefined();
  });

  it('does NOT hijack a parseable canonical verdict (happy path unaffected)', () => {
    // Complete, valid → Case 1 handles it; salvage never runs.
    const v = normalizeJudgeOutput('{"score": 0.42, "issues": []}', ctx);
    expect(v?.score).toBe(0.42);
  });
});
