// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Best-of-N verifier — the aggregation primitive for the collective (#2, 2026-07-02).
 *
 * Why this exists: controlled experiments (2026-06/07) showed that a collective that
 * AGGREGATES BY MAJORITY VOTE does not beat a strong single — when the members share a
 * blind spot the vote amplifies the shared error. The thesis lives only where there is a
 * RELIABLE VERIFIER: generate N candidates (cheap, diverse models) and SELECT the one that
 * objectively passes verification, rather than voting. Where verification is cheap (a
 * checker: code→tests, constraint→predicate, factual→cross-check) this genuinely beats
 * single-shot; where it is absent, we fall back to self-consistency (a weak signal) and the
 * caller should route to a strong single instead.
 *
 * This module is PURE (no I/O, no model calls, no pins): it takes candidate texts + an
 * optional objective `checker` and returns the verified selection with a confidence. It is
 * the replacement for the plain majority-vote step inside collective strategies.
 */

import {
  extractLastNumericToken,
  normalizeNumericToken,
  parseLocaleNumber,
} from './locale-number';

export type VerifyMethod = 'checker' | 'self_consistency' | 'none';

export interface VerifyResult {
  /** The selected final answer (normalized string), or null when nothing usable was produced. */
  readonly answer: string | null;
  /** How the answer was selected. */
  readonly method: VerifyMethod;
  /** [0,1]: for `checker`, the fraction of candidates that objectively passed; for
   *  `self_consistency`, the agreement ratio of the winning answer; 0 for `none`. */
  readonly confidence: number;
  /** How many candidates objectively passed the checker (0 when no checker was used). */
  readonly verifiedCount: number;
  /** How many candidates produced a parseable answer. */
  readonly totalCount: number;
  /** Indices into the ORIGINAL `candidateTexts` whose scoped answer passed the checker,
   *  in candidate order (empty when no checker ran or nothing passed). */
  readonly passerIndices: ReadonlyArray<number>;
  /** True when `among:'majority'` formed NO real mode among the passers (>1 passer, every
   *  passing answer distinct — the code/full-scope case, where whole-reply strings never
   *  collide): `answer` is then merely the FIRST passer in candidate order, an arbitrary
   *  representative rather than a majority signal. Callers holding a richer per-candidate
   *  signal (e.g. a judge score) should re-rank among `passerIndices` instead. */
  readonly arbitraryAmongPassers: boolean;
}

/**
 * Extract the final answer from a model reply. Prefers an explicit `FINAL: <x>` line (last
 * occurrence wins); otherwise falls back to the last numeric token in the text, normalized
 * to dot-decimal form (locale-aware — a comma-decimal "98,41" stays 98.41, it is NOT
 * collapsed to 9841; see locale-number.ts).
 * Returns the trimmed answer string, or null if nothing parseable is present.
 */
export function extractFinalAnswer(text: string | null | undefined): string | null {
  if (!text) return null;
  const finals = [...text.matchAll(/FINAL:\s*([^\n]+)/gi)];
  if (finals.length > 0) {
    const raw = finals[finals.length - 1][1].trim();
    return raw.length > 0 ? raw : null;
  }
  const token = extractLastNumericToken(text);
  return token !== null ? normalizeNumericToken(token) : null;
}

/** Mode + agreement ratio over a list of answers (self-consistency). Ties break to the
 *  first-seen answer for determinism. */
export function selfConsistency(answers: ReadonlyArray<string | null>): {
  answer: string | null;
  agreement: number;
} {
  const counts = new Map<string, number>();
  let total = 0;
  for (const a of answers) {
    if (a == null) continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return { answer: null, agreement: 0 };
  let best: string | null = null;
  let bestN = 0;
  for (const [a, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = a;
    }
  }
  return { answer: best, agreement: bestN / total };
}

/** True when a 'majority' over these answers is vacuous: more than one answer and every
 *  one distinct, so the "mode" is just the first-seen element. */
function allDistinct(answers: ReadonlyArray<string>): boolean {
  return answers.length > 1 && new Set(answers).size === answers.length;
}

export interface SelectOptions {
  /** Objective verifier: returns true iff the answer satisfies the task's checkable property
   *  WITHOUT knowing the intended answer (e.g. plug a candidate back into the constraints).
   *  When present and at least one candidate passes, selection is checker-driven (strong). */
  readonly checker?: (answer: string) => boolean;
  /** For "smallest/largest N" tasks: among checker-passers pick the numeric min/max instead
   *  of the majority (the checker proves validity, not minimality). Ignored without a checker. */
  readonly among?: 'majority' | 'min' | 'max';
  /** What the checker inspects:
   *  'final' (default) — the extracted `FINAL:` line / last number (short factual answers);
   *  'full'  — the ENTIRE candidate reply. Use for CODE / structured artefacts (e.g. a
   *  self-contained HTML canvas scene), where the "answer" is the whole output and the
   *  objective property is structural (contains `<canvas>`, an animation loop, no external
   *  deps). This is what lets the collective REJECT a structurally-broken candidate — the
   *  "a broken output costs you reruns" advantage. */
  readonly scope?: 'final' | 'full';
  /** Completion signals for 'full' scope: at least ONE must appear (case-insensitive) in a
   *  candidate before the checker gets a say (e.g. ['</html>', '</script>']). A structural
   *  check's needles sit near the START of the artifact, so a reply clipped at the token
   *  cap still contains them while being non-runnable. Ignored for 'final' scope. */
  readonly completionAnyOf?: readonly string[];
  /** Per-candidate provider-reported truncation (finish_reason='length'), index-aligned
   *  with `candidateTexts`. A truncated candidate is disqualified from 'full'-scope
   *  verification — the artifact is broken by definition. Ignored for 'final' scope: a
   *  FINAL line that survived the cut is still the model's answer. */
  readonly truncated?: ReadonlyArray<boolean | undefined>;
}

/**
 * Completeness gates for a 'full'-scope candidate — the SELECTION-side mirror of
 * the experiment's `gradeObjectiveAnswer` truncation/closing-signal gates. Two
 * gates run before the needle checker gets a say:
 *  (a) provider-reported truncation (finish_reason='length') — broken by definition;
 *  (b) declared completion signals — covers providers that omit finish_reason AND
 *      fails prose-only replies that merely name the needle APIs.
 * Always passes for 'final' scope (a surviving FINAL line is still the answer)
 * and when neither gate is configured.
 */
export function passesCompletenessGates(
  text: string | null | undefined,
  opts: {
    readonly scope?: 'final' | 'full';
    readonly completionAnyOf?: readonly string[];
    readonly truncated?: boolean;
  },
): boolean {
  if ((opts.scope ?? 'final') !== 'full') return true;
  if (opts.truncated === true) return false;
  const signals = opts.completionAnyOf;
  if (signals && signals.length > 0) {
    const hay = (text ?? '').toLowerCase();
    if (!signals.some((s) => hay.includes(String(s).toLowerCase()))) return false;
  }
  return true;
}

/** The string the checker inspects for a candidate, per scope. */
export function answerForScope(
  text: string | null | undefined,
  scope: 'final' | 'full' = 'final',
): string | null {
  if (scope === 'full') {
    const t = text == null ? '' : String(text);
    return t.trim().length > 0 ? t : null;
  }
  return extractFinalAnswer(text);
}

/**
 * Select the best answer from N candidate replies.
 *   - With a `checker`: keep only candidates whose parsed answer objectively passes, then
 *     resolve among them by `among` (default majority). Confidence = passers / parseable.
 *     This is the mechanism that lets a cheap diverse collective beat single-shot.
 *   - Without a checker (or when none pass): self-consistency majority. Confidence = agreement.
 */
export function selectVerifiedAnswer(
  candidateTexts: ReadonlyArray<string | null | undefined>,
  opts: SelectOptions = {},
): VerifyResult {
  const answers = candidateTexts.map((t) => answerForScope(t, opts.scope));
  const parseable = answers.filter((a): a is string => a != null);

  if (opts.checker) {
    // Keep the ORIGINAL candidate index alongside each passing answer so callers
    // can re-rank equally-verified passers with signals the verifier doesn't have.
    // Completeness gates run BEFORE the checker so per-candidate metadata
    // (truncation) can disqualify a candidate. A gated-out candidate still
    // counts in `totalCount` — it FAILED verification (mirrors the experiment
    // grading it 0); it is not unparseable.
    const passers: Array<{ answer: string; index: number }> = [];
    answers.forEach((a, index) => {
      if (a == null) return;
      const complete = passesCompletenessGates(a, {
        scope: opts.scope,
        completionAnyOf: opts.completionAnyOf,
        truncated: opts.truncated?.[index],
      });
      if (!complete) return;
      try {
        if (opts.checker!(a) === true) passers.push({ answer: a, index });
      } catch {
        /* a throwing checker means "did not pass", never a crash */
      }
    });
    if (passers.length > 0) {
      const among = opts.among ?? 'majority';
      const passerAnswers = passers.map((p) => p.answer);
      let answer: string | null;
      let arbitraryAmongPassers = false;
      if (among === 'min' || among === 'max') {
        // parseLocaleNumber, not Number(): a FINAL-branch answer keeps its raw form
        // ("2,5"), which Number() would turn into NaN and silently drop from ordering.
        const nums = passerAnswers
          .map((a) => ({ a, n: parseLocaleNumber(a) }))
          .filter((x): x is { a: string; n: number } => x.n !== null);
        if (nums.length > 0) {
          nums.sort((x, y) => (among === 'min' ? x.n - y.n : y.n - x.n));
          answer = nums[0].a;
        } else {
          answer = selfConsistency(passerAnswers).answer;
          arbitraryAmongPassers = allDistinct(passerAnswers);
        }
      } else {
        answer = selfConsistency(passerAnswers).answer;
        arbitraryAmongPassers = allDistinct(passerAnswers);
      }
      return {
        answer,
        method: 'checker',
        confidence: passers.length / parseable.length,
        verifiedCount: passers.length,
        totalCount: parseable.length,
        passerIndices: passers.map((p) => p.index),
        arbitraryAmongPassers,
      };
    }
  }

  const { answer, agreement } = selfConsistency(parseable);
  return {
    answer,
    method: parseable.length > 0 ? 'self_consistency' : 'none',
    confidence: parseable.length > 0 ? agreement : 0,
    verifiedCount: 0,
    totalCount: parseable.length,
    passerIndices: [],
    arbitraryAmongPassers: false,
  };
}
