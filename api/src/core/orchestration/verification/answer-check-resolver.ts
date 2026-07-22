// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Declarative answer-check resolver (2026-07-03).
 *
 * The best-of-N verifier (#2) and the consensus verification short-circuit
 * consume an in-process `(answer: string) => boolean` predicate on
 * `OrchestrationContext.answerVerifier`. But the experiment driver — and any
 * external caller — reaches orchestration over HTTP `/v1/chat/completions`,
 * where a function cannot be serialized. This module bridges that gap: a
 * SERIALIZABLE `AnswerCheckSpec` travels on `ailin_constraints.answer_check`,
 * and the orchestration engine resolves it into the predicate before dispatch.
 *
 * This is the piece that lets the v4 benchmark test the collective's thesis in
 * its *winnable* form (select the objectively-verified candidate) instead of
 * re-running the plain LLM-judge form v3 already showed to be a wash.
 *
 * PURE: no I/O. The predicate compares a candidate's already-extracted final
 * answer (see best-of-n-verifier.extractFinalAnswer) against the spec.
 */

import vm from 'node:vm';

import { parseLocaleNumber } from './locale-number';

/** Serializable objective check for a task with a verifiable answer. */
export type AnswerCheckSpec =
  /** Exact string match after trim + trailing-punctuation strip
   *  (case-insensitive unless `caseSensitive`). */
  | { readonly kind: 'string_equals'; readonly expected: string; readonly caseSensitive?: boolean }
  /** Numeric equality within `tolerance` (default 0). Non-numeric answers fail. */
  | { readonly kind: 'numeric_equals'; readonly expected: number; readonly tolerance?: number }
  /** Answer must contain every listed substring (case-insensitive unless flagged). */
  | { readonly kind: 'contains_all'; readonly needles: readonly string[]; readonly caseSensitive?: boolean }
  /** Answer must match against exactly one of a fixed set of accepted strings
   *  (same normalization as `string_equals`). */
  | { readonly kind: 'one_of'; readonly accepted: readonly string[]; readonly caseSensitive?: boolean }
  /** Full-answer regex (anchored by the pattern itself). `flags` forwarded to RegExp. */
  | { readonly kind: 'regex'; readonly pattern: string; readonly flags?: string };

const norm = (s: string, caseSensitive?: boolean): string => {
  const t = s.trim();
  return caseSensitive ? t : t.toLowerCase();
};

/** A compliant model often ends the FINAL line with sentence punctuation
 *  (`FINAL: Canberra.`) — since the objective grade is authoritative, that
 *  period must not fail an exact match. TRAILING characters only, and applied
 *  SYMMETRICALLY to candidate and expected, so equivalent variants collapse
 *  together but a genuinely wrong answer can never be flipped into a pass.
 *  String-comparison specs only: numeric_equals extracts the number itself,
 *  contains_all is substring-based, and regex owns its own pattern.
 *  Stripped one character at a time (no `+` quantifier) rather than via a
 *  single `[...]+$` regex: that shape is polynomial-time on strings that
 *  DON'T end in the class (e.g. many punctuation chars followed by one
 *  non-punctuation char), since an unanchored `String#replace` retries the
 *  whole quantified run from every start index. */
const TRAILING_PUNCT_CHAR = /[.,;:!?'"`)\]\s]/u;
const stripTrailingPunct = (s: string): string => {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT_CHAR.test(s[end - 1])) end--;
  return s.slice(0, end);
};

const normEq = (s: string, caseSensitive?: boolean): string =>
  stripTrailingPunct(norm(s, caseSensitive));

/** Parse a candidate answer to a finite number, tolerating surrounding punctuation
 *  and BOTH separator locales ("1,234.56" and "1.234,56" — see locale-number.ts).
 *  The LAST numeric token wins, consistent with extractFinalAnswer, so prose like
 *  "answer 2: 98.41" grades on 98.41. Returns null when nothing numeric is present. */
const toNumber = parseLocaleNumber;

/**
 * Compile a spec into an objective predicate over a candidate's final answer.
 * The predicate NEVER throws — a malformed spec or answer yields `false`, so a
 * bad check can only ever *withhold* verification, never crash a request or
 * falsely pass. Returns null when the spec itself is structurally invalid, so
 * the caller can leave `answerVerifier` unset (task treated as unverifiable).
 */
export function resolveAnswerChecker(
  spec: AnswerCheckSpec | undefined | null,
): ((answer: string) => boolean) | null {
  if (!spec || typeof spec !== 'object') return null;

  switch (spec.kind) {
    case 'string_equals': {
      if (typeof spec.expected !== 'string') return null;
      const target = normEq(spec.expected, spec.caseSensitive);
      // An expected that normalizes to nothing (empty / pure punctuation)
      // would match any punctuation-only answer — withhold instead.
      if (target === '') return null;
      return (a) => normEq(a, spec.caseSensitive) === target;
    }
    case 'numeric_equals': {
      if (typeof spec.expected !== 'number' || !Number.isFinite(spec.expected)) return null;
      const tol = typeof spec.tolerance === 'number' && spec.tolerance >= 0 ? spec.tolerance : 0;
      return (a) => {
        const n = toNumber(a);
        return n !== null && Math.abs(n - spec.expected) <= tol;
      };
    }
    case 'contains_all': {
      if (!Array.isArray(spec.needles) || spec.needles.length === 0) return null;
      const needles = spec.needles.map((n) => norm(String(n), spec.caseSensitive));
      return (a) => {
        const hay = norm(a, spec.caseSensitive);
        return needles.every((n) => hay.includes(n));
      };
    }
    case 'one_of': {
      if (!Array.isArray(spec.accepted) || spec.accepted.length === 0) return null;
      const accepted = new Set(
        spec.accepted.map((s) => normEq(String(s), spec.caseSensitive)).filter((s) => s !== ''),
      );
      if (accepted.size === 0) return null;
      return (a) => accepted.has(normEq(a, spec.caseSensitive));
    }
    case 'regex': {
      if (typeof spec.pattern !== 'string') return null;
      let re: RegExp;
      try {
        re = new RegExp(spec.pattern, spec.flags);
      } catch {
        return null; // invalid pattern → unverifiable, not a crash
      }
      return (a) => {
        try {
          // spec.pattern/flags are caller-supplied (any external HTTP caller,
          // per the module doc above) and are the whole point of this check
          // kind, so they can't be escaped/rejected without defeating the
          // feature. Instead, run the match in a throwaway VM context with a
          // hard wall-clock timeout: a catastrophic-backtracking ("evil")
          // pattern can then only ever time out into `false`, never hang the
          // event loop for other requests. 750ms (not the original 100ms):
          // a legitimate match is effectively instant regardless of load,
          // while a genuinely catastrophic-backtracking pattern blows past
          // this by orders of magnitude — 100ms measurably false-timed-out
          // under ordinary CPU contention (e.g. the full parallel test
          // suite), which would silently mis-score a correct answer as
          // wrong in production too.
          return Boolean(
            vm.runInNewContext('re.test(input)', { re, input: a.trim() }, { timeout: 750 }),
          );
        } catch {
          return false;
        }
      };
    }
    default:
      return null;
  }
}
