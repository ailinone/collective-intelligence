// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the best-of-N verifier (#2, 2026-07-02): the aggregation primitive that lets a cheap
 * diverse collective beat single-shot by SELECTING the objectively-verified candidate instead
 * of voting. Key case: a WRONG majority is overridden by the checker.
 */
import { describe, it, expect } from 'vitest';
import {
  extractFinalAnswer,
  selfConsistency,
  selectVerifiedAnswer,
} from '../best-of-n-verifier';

describe('extractFinalAnswer', () => {
  it('prefers the last FINAL: line', () => {
    expect(extractFinalAnswer('reasoning...\nFINAL: 42')).toBe('42');
    expect(extractFinalAnswer('FINAL: 1\nmore\nFINAL: 7')).toBe('7');
  });
  it('falls back to the last integer when no FINAL line', () => {
    expect(extractFinalAnswer('the answer is 137 after 5 steps... 23')).toBe('23');
    expect(extractFinalAnswer('value = 1,234')).toBe('1234');
  });
  it('locale: comma-decimal answers are normalized, NOT collapsed (98,41 ≠ 9841)', () => {
    expect(extractFinalAnswer('a média é 98,41')).toBe('98.41');
    expect(extractFinalAnswer('total de 1.234,56 unidades')).toBe('1234.56');
    expect(extractFinalAnswer('sum is 1,234.56 overall')).toBe('1234.56');
    expect(extractFinalAnswer('população: 1.234.567')).toBe('1234567');
    // The FINAL: branch returns the raw token untouched — parsing happens in the
    // numeric consumers (numeric_equals / among ordering), not in extraction.
    expect(extractFinalAnswer('FINAL: 98,41')).toBe('98,41');
  });
  it('returns null when nothing parseable', () => {
    expect(extractFinalAnswer('no numbers here')).toBeNull();
    expect(extractFinalAnswer('')).toBeNull();
    expect(extractFinalAnswer(null)).toBeNull();
  });
});

describe('selfConsistency', () => {
  it('returns the mode and its agreement ratio', () => {
    expect(selfConsistency(['5', '5', '5', '8'])).toEqual({ answer: '5', agreement: 0.75 });
  });
  it('ignores nulls and reports 0 when empty', () => {
    expect(selfConsistency([null, '9', null])).toEqual({ answer: '9', agreement: 1 });
    expect(selfConsistency([null, null])).toEqual({ answer: null, agreement: 0 });
  });
});

describe('selectVerifiedAnswer', () => {
  it('THESIS: the checker overrides a WRONG majority', () => {
    // 3 of 4 models agree on 100 (wrong); one produced 648 (correct). A vote returns 100;
    // the checker (answer must equal 648) selects the single correct one.
    const cands = ['FINAL: 100', 'FINAL: 100', 'FINAL: 648', 'FINAL: 100'];
    const r = selectVerifiedAnswer(cands, { checker: (a) => a === '648' });
    expect(r.answer).toBe('648');
    expect(r.method).toBe('checker');
    expect(r.verifiedCount).toBe(1);
    expect(r.totalCount).toBe(4);
    expect(r.confidence).toBeCloseTo(0.25, 5);
  });

  it('among:min picks the smallest checker-passing candidate (smallest-N tasks)', () => {
    // Constraint "smallest N with N%3==2 && N%5==3 && N%7==2" → 23. Candidates: 23, 128 both
    // satisfy the congruences (checker proves validity, not minimality) → min = 23.
    const checker = (a: string) => {
      const n = Number(a);
      return n % 3 === 2 && n % 5 === 3 && n % 7 === 2;
    };
    const cands = ['FINAL: 128', 'FINAL: 23', 'FINAL: 50'];
    const r = selectVerifiedAnswer(cands, { checker, among: 'min' });
    expect(r.answer).toBe('23');
    expect(r.method).toBe('checker');
    expect(r.verifiedCount).toBe(2); // 23 and 128 pass; 50 fails
  });

  it('among:max orders comma-decimal passers numerically (locale-aware)', () => {
    // Pre-fix, Number('1,5') was NaN for BOTH candidates, so ordering silently
    // degraded to self-consistency and returned the first-seen answer.
    const r = selectVerifiedAnswer(['FINAL: 1,5', 'FINAL: 2,5'], {
      checker: () => true,
      among: 'max',
    });
    expect(r.answer).toBe('2,5');
    expect(r.method).toBe('checker');
    expect(r.verifiedCount).toBe(2);
  });

  it('falls back to self-consistency when no checker is given', () => {
    const r = selectVerifiedAnswer(['FINAL: 7', 'FINAL: 7', 'FINAL: 9']);
    expect(r.answer).toBe('7');
    expect(r.method).toBe('self_consistency');
    expect(r.confidence).toBeCloseTo(2 / 3, 5);
  });

  it('falls back to self-consistency when NO candidate passes the checker', () => {
    const r = selectVerifiedAnswer(['FINAL: 1', 'FINAL: 1', 'FINAL: 2'], { checker: () => false });
    expect(r.method).toBe('self_consistency');
    expect(r.answer).toBe('1');
  });

  it('reports method none when nothing is parseable', () => {
    const r = selectVerifiedAnswer(['no answer', '', null]);
    expect(r.answer).toBeNull();
    expect(r.method).toBe('none');
    expect(r.confidence).toBe(0);
  });

  it('exposes passerIndices (original candidate order) and flags a vacuous majority', () => {
    // All passers distinct → no real mode → the returned answer is only the first
    // passer; the flag tells richer callers to re-rank among passerIndices.
    const r = selectVerifiedAnswer(['FINAL: 3', 'FINAL: 2', 'FINAL: 4'], { checker: (a) => Number(a) % 2 === 0 });
    expect(r.passerIndices).toEqual([1, 2]);
    expect(r.arbitraryAmongPassers).toBe(true);
    expect(r.answer).toBe('2'); // unchanged default: first passer

    // A real mode → not arbitrary.
    const modal = selectVerifiedAnswer(['FINAL: 2', 'FINAL: 2', 'FINAL: 4'], { checker: (a) => Number(a) % 2 === 0 });
    expect(modal.arbitraryAmongPassers).toBe(false);
    expect(modal.answer).toBe('2');

    // Extremal selection is meaningful → not arbitrary; no checker → empty indices.
    const extremal = selectVerifiedAnswer(['FINAL: 8', 'FINAL: 2'], { checker: () => true, among: 'min' });
    expect(extremal.arbitraryAmongPassers).toBe(false);
    expect(extremal.passerIndices).toEqual([0, 1]);
    expect(selectVerifiedAnswer(['FINAL: 7']).passerIndices).toEqual([]);
  });

  it('a broken checker (throws) never crashes selection', () => {
    const r = selectVerifiedAnswer(['FINAL: 5', 'FINAL: 5'], {
      checker: () => {
        throw new Error('boom');
      },
    });
    expect(r.method).toBe('self_consistency'); // no passers → fallback
    expect(r.answer).toBe('5');
  });
});
