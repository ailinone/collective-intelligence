// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profile-normalizer.ts — MVP 6A
 *
 * Pure helpers used by the profiler. No I/O.
 *
 * Word-boundary detection via char-code checks: a "word match" requires
 * the matched span to be bordered by non-alphanumeric chars (or
 * start/end-of-string). Substring searches use indexOf only.
 */

// ─── Word-boundary primitive ────────────────────────────────────────────

function isWordChar(c: string): boolean {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

/**
 * Returns true iff `text` contains `term` as a WHOLE WORD (case-insensitive).
 * Uses indexOf + char-code boundary checks only.
 */
export function containsWord(text: string, term: string): boolean {
  if (text.length === 0 || term.length === 0) return false;
  const lc = text.toLowerCase();
  const needle = term.toLowerCase();
  let pos = lc.indexOf(needle);
  while (pos !== -1) {
    const before = pos === 0 ? '' : lc.charAt(pos - 1);
    const afterPos = pos + needle.length;
    const after = afterPos >= lc.length ? '' : lc.charAt(afterPos);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    pos = lc.indexOf(needle, pos + 1);
  }
  return false;
}

/**
 * Returns true if ANY term in `terms` is present in `text` as a word.
 */
export function containsAnyWord(
  text: string,
  terms: readonly string[],
): boolean {
  for (const t of terms) {
    if (containsWord(text, t)) return true;
  }
  return false;
}

// ─── Token estimation ──────────────────────────────────────────────────

/**
 * Returns the total estimated input tokens across text + attachments.
 * When `approximateInputTokens` is provided, it's used as-is; otherwise
 * we estimate ~4 chars per token from the raw text length.
 */
export function estimateTotalInputTokens(input: {
  readonly text?: string;
  readonly approximateInputTokens?: number;
  readonly attachments?: readonly { readonly approximateTokens?: number }[];
}): number {
  let total = 0;
  if (typeof input.approximateInputTokens === 'number' && input.approximateInputTokens > 0) {
    total += input.approximateInputTokens;
  } else if (input.text && input.text.length > 0) {
    // Rough heuristic: 4 chars ≈ 1 token. Conservative for English.
    total += Math.ceil(input.text.length / 4);
  }
  if (input.attachments) {
    for (const a of input.attachments) {
      if (typeof a.approximateTokens === 'number' && a.approximateTokens > 0) {
        total += a.approximateTokens;
      }
    }
  }
  return total;
}

// ─── Deterministic sort + dedupe ────────────────────────────────────────

/**
 * Returns a new array containing each value at most once, ordered
 * alphabetically. Deterministic.
 */
export function sortedUnique<T extends string>(input: readonly T[]): readonly T[] {
  const set = new Set<T>(input);
  const out: T[] = [];
  for (const v of set) out.push(v);
  out.sort();
  return Object.freeze(out);
}
