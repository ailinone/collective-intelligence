// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Locale-aware numeric token parsing for the verification primitives (2026-07-16).
 *
 * Why this exists: the numeric paths used to strip ALL commas before parsing, so a
 * comma-decimal answer ("98,41", pt-BR / European locale) became "9841" — corrupted
 * by 10^(digits after the comma). These are VERIFICATION primitives: a lossy parse
 * silently FAILS a correct candidate or PASSES a wrong one, so the separator must be
 * disambiguated, never erased. Single source of truth for:
 *   - answer-check-resolver `numeric_equals` (parses the candidate answer);
 *   - best-of-n-verifier `extractFinalAnswer` (last-number fallback);
 *   - best-of-n-verifier `selectVerifiedAnswer` (among:'min'|'max' ordering).
 *
 * Disambiguation rules for a single token (sign, digits, '.', ','):
 *   - BOTH '.' and ',' present → the LAST-occurring separator is the decimal point,
 *     every other separator is thousands. "1,234.56" → 1234.56 ; "1.234,56" → 1234.56.
 *   - ONLY ',' present → exactly one comma NOT followed by exactly 3 digits is a
 *     decimal ("98,41" → 98.41, "12,5" → 12.5); multiple commas, or a single comma
 *     followed by exactly 3 digits, are thousands ("1,234,567" → 1234567). "1,234"
 *     is the irreducible ambiguous case — resolved to thousands (1234) to preserve
 *     the pre-existing behavior of every dot-locale answer in production.
 *   - ONLY '.' present → multiple dots are European thousands ("1.234.567" → 1234567);
 *     a single dot stays the decimal point.
 *
 * PURE: no I/O.
 */

/** A numeric token: optional sign, starts and ends with a digit, may carry '.'/','
 *  separators inside. Trailing punctuation ("1234.") is never captured. */
const NUMERIC_TOKEN_RE = /-?\d(?:[\d.,]*\d)?/g;

/** The LAST numeric token in `text` (consistent with extractFinalAnswer's
 *  "last answer wins"), or null when nothing numeric is present. */
export function extractLastNumericToken(text: string): string | null {
  const matches = text.match(NUMERIC_TOKEN_RE);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

/** Normalize a numeric token to plain dot-decimal form (separator disambiguation
 *  per the module header), WITHOUT going through Number — callers that need the
 *  string (extractFinalAnswer) keep leading zeros and full precision. */
export function normalizeNumericToken(token: string): string {
  let t = token;
  let sign = '';
  if (t.startsWith('-')) {
    sign = '-';
    t = t.slice(1);
  }

  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: last-occurring separator is the decimal point.
    const decIdx = Math.max(lastDot, lastComma);
    const intPart = t.slice(0, decIdx).replace(/[.,]/g, '');
    return `${sign}${intPart}.${t.slice(decIdx + 1)}`;
  }
  if (lastComma >= 0) {
    const commaCount = t.split(',').length - 1;
    const digitsAfter = t.length - lastComma - 1;
    if (commaCount === 1 && digitsAfter !== 3) {
      return `${sign}${t.replace(',', '.')}`; // comma-decimal ("98,41")
    }
    return `${sign}${t.replace(/,/g, '')}`; // thousands (incl. ambiguous "1,234")
  }
  if (lastDot >= 0 && t.indexOf('.') !== lastDot) {
    return `${sign}${t.replace(/\./g, '')}`; // European thousands ("1.234.567")
  }
  return `${sign}${t}`;
}

/** Parse the LAST numeric token in `raw` to a finite number, locale-aware.
 *  Returns null when nothing numeric is present or the token does not survive
 *  Number() (defense in depth — a matched token always should). */
export function parseLocaleNumber(raw: string): number | null {
  const token = extractLastNumericToken(raw);
  if (token === null) return null;
  const n = Number(normalizeNumericToken(token));
  return Number.isFinite(n) ? n : null;
}
