// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the locale-aware numeric parser shared by the verification primitives.
 * The stakes: this feeds numeric_equals and best-of-N min/max ordering — a lossy
 * parse silently FLIPS verification verdicts (pre-fix, "98,41" graded as 9841,
 * off by 10^(digits after the comma)).
 */
import { describe, it, expect } from 'vitest';
import {
  extractLastNumericToken,
  normalizeNumericToken,
  parseLocaleNumber,
} from '../locale-number';

describe('parseLocaleNumber', () => {
  it('comma-decimal (pt-BR / European): single comma with a non-3-digit fraction', () => {
    expect(parseLocaleNumber('98,41')).toBe(98.41);
    expect(parseLocaleNumber('12,5')).toBe(12.5);
    expect(parseLocaleNumber('-3,1416')).toBe(-3.1416);
  });

  it('thousands: multiple commas, or a single comma + exactly 3 digits (documented ambiguity)', () => {
    expect(parseLocaleNumber('1,234')).toBe(1234); // ambiguous → thousands, preserving pre-fix behavior
    expect(parseLocaleNumber('1,234,567')).toBe(1234567);
  });

  it('both separators present: the LAST-occurring one is the decimal point', () => {
    expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
    expect(parseLocaleNumber('1.234,56')).toBe(1234.56);
    expect(parseLocaleNumber('1,234,567.89')).toBe(1234567.89);
    expect(parseLocaleNumber('1.234.567,89')).toBe(1234567.89);
  });

  it('dot-only: a single dot is the decimal; multiple dots are European thousands', () => {
    expect(parseLocaleNumber('98.41')).toBe(98.41);
    expect(parseLocaleNumber('1.234.567')).toBe(1234567);
  });

  it('REGRESSION: plain integers and dot-format answers parse exactly as before', () => {
    expect(parseLocaleNumber('1020')).toBe(1020);
    expect(parseLocaleNumber('299792458')).toBe(299792458);
    expect(parseLocaleNumber('0.4167')).toBe(0.4167);
    expect(parseLocaleNumber('-5')).toBe(-5);
  });

  it('grades the LAST numeric token in prose (consistent with extractFinalAnswer)', () => {
    expect(parseLocaleNumber('answer 2: 98.41')).toBe(98.41); // pre-fix: graded on the FIRST token (2)
    expect(parseLocaleNumber('the answer is 1234.')).toBe(1234); // trailing punctuation excluded
  });

  it('returns null when nothing numeric is present', () => {
    expect(parseLocaleNumber('')).toBeNull();
    expect(parseLocaleNumber('no numbers here')).toBeNull();
  });
});

describe('normalizeNumericToken / extractLastNumericToken', () => {
  it('normalization keeps the string form (leading zeros, full precision)', () => {
    expect(normalizeNumericToken('007')).toBe('007');
    expect(normalizeNumericToken('98,41')).toBe('98.41');
    expect(normalizeNumericToken('1.234,56')).toBe('1234.56');
    expect(normalizeNumericToken('-1,5')).toBe('-1.5');
  });

  it('token extraction takes the last token and never captures trailing punctuation', () => {
    expect(extractLastNumericToken('total: 98,41.')).toBe('98,41');
    expect(extractLastNumericToken('137 then 5 then 23')).toBe('23');
    expect(extractLastNumericToken('no digits')).toBeNull();
  });
});
