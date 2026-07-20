// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the verified-selection wiring layer (#2 follow-up): an objective checker
 * overrides the judge-driven synthesis-vs-best-individual decision only when it
 * has a real signal, and maps the verified answer back to the producing voter.
 */
import { describe, it, expect } from 'vitest';
import { selectWithVerification } from '../verified-selection';

const isEven = (a: string) => Number(a) % 2 === 0;

describe('selectWithVerification', () => {
  it('keeps synthesis when the synthesis itself passes the checker', () => {
    const r = selectWithVerification({
      synthesisText: 'combined reasoning\nFINAL: 4',
      candidateTexts: ['FINAL: 3', 'FINAL: 4', 'FINAL: 7'],
      checker: isEven,
    });
    expect(r.decision).toBe('keep_synthesis');
    expect(r.synthesisVerified).toBe(true);
  });

  it('overrides to the verified voter when synthesis fails the checker', () => {
    const r = selectWithVerification({
      synthesisText: 'FINAL: 7',
      candidateTexts: ['FINAL: 3', 'FINAL: 4', 'FINAL: 5'],
      checker: isEven,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);
    expect(r.verify.method).toBe('checker');
    expect(r.verify.verifiedCount).toBe(1);
  });

  it('a wrong majority is overridden by the checker (the thesis-lever case)', () => {
    const r = selectWithVerification({
      synthesisText: 'FINAL: 9', // synthesis followed the wrong majority
      candidateTexts: ['FINAL: 9', 'FINAL: 9', 'FINAL: 2'],
      checker: isEven,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(2);
    expect(r.verify.confidence).toBeCloseTo(1 / 3);
  });

  it('majority among multiple passers picks the modal verified answer', () => {
    const r = selectWithVerification({
      synthesisText: 'FINAL: 7',
      candidateTexts: ['FINAL: 2', 'FINAL: 8', 'FINAL: 8', 'FINAL: 5'],
      checker: isEven,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1); // first voter producing the modal passer '8'
  });

  it("among:'min' picks the smallest verified answer's voter", () => {
    const r = selectWithVerification({
      synthesisText: null,
      candidateTexts: ['FINAL: 8', 'FINAL: 2', 'FINAL: 6'],
      checker: isEven,
      among: 'min',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);
  });

  it('returns no_signal when nothing passes the checker', () => {
    const r = selectWithVerification({
      synthesisText: 'FINAL: 7',
      candidateTexts: ['FINAL: 3', 'FINAL: 5'],
      checker: isEven,
    });
    expect(r.decision).toBe('no_signal');
    expect(r.verify.method).toBe('self_consistency');
  });

  it('returns no_signal when nothing is parseable', () => {
    const r = selectWithVerification({
      synthesisText: 'no numbers here',
      candidateTexts: ['nothing', null, undefined],
      checker: isEven,
    });
    expect(r.decision).toBe('no_signal');
    expect(r.verify.method).toBe('none');
    expect(r.verify.confidence).toBe(0);
  });

  it('a REAL majority among passers is never re-ranked by judge scores', () => {
    // '8' forms a real mode (2 of 3 passers) — a majority is a signal, so the judge
    // preferring the lone '2' voter must NOT override it.
    const r = selectWithVerification({
      synthesisText: 'FINAL: 7',
      candidateTexts: ['FINAL: 2', 'FINAL: 8', 'FINAL: 8'],
      candidateScores: [0.99, 0.1, 0.1],
      checker: isEven,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1); // first producer of the modal '8'
    expect(r.verify.arbitraryAmongPassers).toBe(false);
  });

  it("among:'min' is extremal, never re-ranked by judge scores", () => {
    const r = selectWithVerification({
      synthesisText: null,
      candidateTexts: ['FINAL: 8', 'FINAL: 2', 'FINAL: 6'],
      candidateScores: [0.99, 0.1, 0.5],
      checker: isEven,
      among: 'min',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1); // still the smallest verified answer
  });

  it('all-distinct FINAL-scope passers: judge score picks the served voter', () => {
    // No real majority forms (every passing answer distinct) — the checker proves
    // validity only, so the richer judge signal decides among equals.
    const r = selectWithVerification({
      synthesisText: 'FINAL: 7',
      candidateTexts: ['FINAL: 2', 'FINAL: 4', 'FINAL: 6'],
      candidateScores: [0.2, 0.9, 0.5],
      checker: isEven,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);
    expect(r.verify.arbitraryAmongPassers).toBe(true);
  });

  it('a throwing checker is treated as not-passing, never as a crash', () => {
    const r = selectWithVerification({
      synthesisText: 'FINAL: 4',
      candidateTexts: ['FINAL: 4', 'FINAL: 6'],
      checker: () => {
        throw new Error('boom');
      },
    });
    expect(r.decision).toBe('no_signal');
    expect(r.synthesisVerified).toBe(false);
  });
});
