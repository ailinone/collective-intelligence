// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the declarative answer-check resolver — the serializable bridge that lets
 * an HTTP caller (the v4 benchmark driver) arm the best-of-N verifier. A bad
 * spec must WITHHOLD verification (null / false), never crash or falsely pass.
 */
import { describe, it, expect } from 'vitest';
import { resolveAnswerChecker, type AnswerCheckSpec } from '../answer-check-resolver';

describe('resolveAnswerChecker', () => {
  it('string_equals: trims + case-insensitive by default, exact when flagged', () => {
    const ci = resolveAnswerChecker({ kind: 'string_equals', expected: 'Paris' })!;
    expect(ci('  paris ')).toBe(true);
    expect(ci('PARIS')).toBe(true);
    expect(ci('London')).toBe(false);
    const cs = resolveAnswerChecker({ kind: 'string_equals', expected: 'Paris', caseSensitive: true })!;
    expect(cs('paris')).toBe(false);
    expect(cs('Paris')).toBe(true);
  });

  it('string_equals: trailing sentence punctuation must not zero a correct answer', () => {
    // The grade is authoritative (no judge fallback): a compliant model writing
    // `FINAL: Canberra.` must score 1, not 0.
    const c = resolveAnswerChecker({ kind: 'string_equals', expected: 'Canberra' })!;
    expect(c('Canberra.')).toBe(true);
    expect(c('canberra .')).toBe(true);
    expect(c('Canberra')).toBe(true);
    expect(c('Canberra!')).toBe(true);
    expect(c('"Canberra"')).toBe(false); // leading wrapper NOT stripped — trailing only
    expect(c('.Canberra')).toBe(false);
    expect(c('Sydney.')).toBe(false); // wrong stays wrong
  });

  it('string_equals: stripping is symmetric — expected may itself carry punctuation', () => {
    const c = resolveAnswerChecker({ kind: 'string_equals', expected: 'Canberra.' })!;
    expect(c('Canberra')).toBe(true);
    expect(c('Canberra.')).toBe(true);
    expect(c('Sydney')).toBe(false);
  });

  it('string_equals: closing wrappers strip symmetrically, so parenthesized answers still match', () => {
    const c = resolveAnswerChecker({ kind: 'string_equals', expected: 'O(log n)' })!;
    expect(c('O(log n)')).toBe(true);
    expect(c('O(log n).')).toBe(true);
    expect(c('O(n)')).toBe(false);
  });

  it('string_equals: punctuation strip respects caseSensitive', () => {
    const cs = resolveAnswerChecker({ kind: 'string_equals', expected: 'Paris', caseSensitive: true })!;
    expect(cs('Paris.')).toBe(true);
    expect(cs('paris.')).toBe(false);
  });

  it('numeric_equals: parses separators/punctuation, honors tolerance, rejects non-numeric', () => {
    const exact = resolveAnswerChecker({ kind: 'numeric_equals', expected: 1234 })!;
    expect(exact('1,234')).toBe(true);
    expect(exact('the answer is 1234.')).toBe(true);
    expect(exact('1235')).toBe(false);
    expect(exact('twelve')).toBe(false);
    const tol = resolveAnswerChecker({ kind: 'numeric_equals', expected: 3.14, tolerance: 0.01 })!;
    expect(tol('3.15')).toBe(true);
    expect(tol('3.2')).toBe(false);
    const neg = resolveAnswerChecker({ kind: 'numeric_equals', expected: -5 })!;
    expect(neg('-5')).toBe(true);
  });

  it('numeric_equals: comma-decimal (pt-BR / European) answers parse losslessly', () => {
    const c = resolveAnswerChecker({ kind: 'numeric_equals', expected: 98.41 })!;
    expect(c('98,41')).toBe(true); // pre-fix: comma stripped → 9841 → false
    expect(c('98.41')).toBe(true);
    expect(c('FINAL: 98,41')).toBe(true);
    expect(c('9841')).toBe(false);
    const mixed = resolveAnswerChecker({ kind: 'numeric_equals', expected: 1234.56 })!;
    expect(mixed('1,234.56')).toBe(true);
    expect(mixed('1.234,56')).toBe(true);
    const millions = resolveAnswerChecker({ kind: 'numeric_equals', expected: 1234567 })!;
    expect(millions('1,234,567')).toBe(true);
    expect(millions('1.234.567')).toBe(true);
  });

  it('numeric_equals: grades the LAST numeric token, not the first', () => {
    const c = resolveAnswerChecker({ kind: 'numeric_equals', expected: 98.41 })!;
    expect(c('answer 2: 98.41')).toBe(true); // pre-fix: graded on the "2"
  });

  it('contains_all: every needle must appear', () => {
    const c = resolveAnswerChecker({ kind: 'contains_all', needles: ['O(1)', 'map'] })!;
    expect(c('uses a MAP for o(1) lookups')).toBe(true);
    expect(c('uses a map only')).toBe(false);
  });

  it('one_of: membership against accepted set', () => {
    const c = resolveAnswerChecker({ kind: 'one_of', accepted: ['true', 'yes'] })!;
    expect(c('TRUE')).toBe(true);
    expect(c('Yes')).toBe(true);
    expect(c('maybe')).toBe(false);
  });

  it('one_of: trailing punctuation tolerated on candidate and accepted values', () => {
    const c = resolveAnswerChecker({ kind: 'one_of', accepted: ['true', 'yes.'] })!;
    expect(c('Yes.')).toBe(true);
    expect(c('TRUE!')).toBe(true);
    expect(c('yes')).toBe(true);
    expect(c('maybe.')).toBe(false);
  });

  it('regex: compiles pattern + flags; matches trimmed answer', () => {
    const c = resolveAnswerChecker({ kind: 'regex', pattern: '^\\d{3}-\\d{4}$' })!;
    expect(c('  123-4567 ')).toBe(true);
    expect(c('12-4567')).toBe(false);
  });

  it('invalid specs resolve to null (task treated as unverifiable)', () => {
    expect(resolveAnswerChecker(undefined)).toBeNull();
    expect(resolveAnswerChecker(null)).toBeNull();
    expect(resolveAnswerChecker({ kind: 'numeric_equals', expected: Number.NaN })).toBeNull();
    expect(resolveAnswerChecker({ kind: 'numeric_equals', expected: 'x' } as unknown as AnswerCheckSpec)).toBeNull();
    expect(resolveAnswerChecker({ kind: 'contains_all', needles: [] })).toBeNull();
    expect(resolveAnswerChecker({ kind: 'one_of', accepted: [] })).toBeNull();
    // expected/accepted that normalize to nothing would match any punctuation-only
    // answer after the trailing-punct strip — must withhold, not falsely pass.
    expect(resolveAnswerChecker({ kind: 'string_equals', expected: '...' })).toBeNull();
    expect(resolveAnswerChecker({ kind: 'one_of', accepted: ['...', '?!'] })).toBeNull();
    expect(resolveAnswerChecker({ kind: 'regex', pattern: '(' })).toBeNull(); // invalid regex
    expect(resolveAnswerChecker({ kind: 'unknown' } as unknown as AnswerCheckSpec)).toBeNull();
  });

  it('a resolved predicate never throws on hostile input', () => {
    const c = resolveAnswerChecker({ kind: 'numeric_equals', expected: 1 })!;
    expect(() => c('')).not.toThrow();
    expect(c('')).toBe(false);
  });
});
