// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Verified selection — the wiring layer between the pure best-of-N verifier and a
 * collective strategy's final-selection step (the follow-up promised in #2).
 *
 * Given the synthesis text and the individual voter outputs, decide whether an
 * OBJECTIVE checker should override the judge-driven synthesis-vs-best-individual
 * decision:
 *   - synthesis itself passes the checker  → keep synthesis (it is verified AND merged);
 *   - synthesis fails but ≥1 voter passes → override to the checker-selected voter
 *     (this is the "select verified over vote" thesis lever);
 *   - nothing passes / nothing parseable  → no override; the caller keeps its
 *     judge-based decision untouched.
 *
 * PURE: no I/O, no model calls. The checker itself must be objective (plug the answer
 * back into the task's constraints) — see best-of-n-verifier.ts.
 */
import {
  answerForScope,
  passesCompletenessGates,
  selectVerifiedAnswer,
  type VerifyResult,
} from './best-of-n-verifier';

export interface VerifiedSelectionInput {
  /** The collective's synthesized answer text (empty/null when synthesis didn't run). */
  readonly synthesisText: string | null | undefined;
  /** Individual voter outputs, in voter order. */
  readonly candidateTexts: ReadonlyArray<string | null | undefined>;
  /** Objective verifier — returns true iff the extracted answer satisfies the task's
   *  checkable property. Exceptions are treated as "did not pass". */
  readonly checker: (answer: string) => boolean;
  /** Tie-break among checker-passers (default 'majority'; 'min'/'max' for extremal tasks). */
  readonly among?: 'majority' | 'min' | 'max';
  /** 'final' (default) checks the extracted FINAL line; 'full' checks the entire reply
   *  (CODE / structured artefacts — see best-of-n-verifier SelectOptions.scope). */
  readonly scope?: 'final' | 'full';
  /** Optional per-candidate quality signal (e.g. the strategy's judge scores), indexed
   *  like `candidateTexts`. Consulted ONLY to rank equally-verified passers when the
   *  checker formed no real majority (every passing answer distinct — the code/full-scope
   *  case): highest score wins, then longest reply, then voter order. A real majority or
   *  an extremal ('min'/'max') selection is never re-ranked by score. */
  readonly candidateScores?: ReadonlyArray<number | null | undefined>;
  /** Completion signals for 'full' scope — at least ONE must appear in a candidate (or
   *  the synthesis) before the checker gets a say. See SelectOptions.completionAnyOf. */
  readonly completionAnyOf?: readonly string[];
  /** Per-candidate provider-reported truncation (finish_reason='length'), index-aligned
   *  with `candidateTexts`. Disqualifies a candidate from 'full'-scope verification. */
  readonly candidateTruncated?: ReadonlyArray<boolean | undefined>;
  /** Provider-reported truncation of the synthesis itself — a clipped synthesis must not
   *  be kept as "verified" under 'full' scope. */
  readonly synthesisTruncated?: boolean;
}

export interface VerifiedSelectionResult {
  /** What the checker decided:
   *  'keep_synthesis'   — synthesis passed verification; no override needed.
   *  'override_to_voter' — synthesis failed but a voter passed; use `voterIndex`.
   *  'no_signal'        — checker matched nothing parseable/passing; caller keeps its decision. */
  readonly decision: 'keep_synthesis' | 'override_to_voter' | 'no_signal';
  /** Index into `candidateTexts` of the verified voter (only for 'override_to_voter'). */
  readonly voterIndex?: number;
  /** Whether the synthesis text itself passed the checker. */
  readonly synthesisVerified: boolean;
  /** Verifier telemetry over the voter candidates (method/confidence/verifiedCount). */
  readonly verify: VerifyResult;
}

function passesChecker(checker: (answer: string) => boolean, answer: string | null): boolean {
  if (answer == null) return false;
  try {
    return checker(answer) === true;
  } catch {
    return false;
  }
}

/**
 * Rank equally-verified passers when the checker formed NO real majority (every passing
 * answer distinct — code/full-scope artefacts). The binary structural floor proves each
 * one runs but says nothing about WHICH is best; first-seen would serve a barely-passing
 * truncated artefact over a richer, higher-judge-score one (the first-passer defect).
 * Order: judge score (when provided) → reply length (structural-richness proxy) → voter
 * order (deterministic).
 */
function bestPasserIndex(
  passerIndices: ReadonlyArray<number>,
  input: VerifiedSelectionInput,
): number {
  const scoreAt = (i: number): number => {
    const s = input.candidateScores?.[i];
    return typeof s === 'number' && Number.isFinite(s) ? s : -Infinity;
  };
  const lengthAt = (i: number): number => (input.candidateTexts[i] ?? '').length;

  let best = passerIndices[0];
  for (const i of passerIndices.slice(1)) {
    const better =
      scoreAt(i) > scoreAt(best) ||
      (scoreAt(i) === scoreAt(best) && lengthAt(i) > lengthAt(best));
    if (better) best = i;
  }
  return best;
}

export function selectWithVerification(input: VerifiedSelectionInput): VerifiedSelectionResult {
  const scope = input.scope ?? 'final';
  const verify = selectVerifiedAnswer(input.candidateTexts, {
    checker: input.checker,
    among: input.among,
    scope,
    completionAnyOf: input.completionAnyOf,
    truncated: input.candidateTruncated,
  });

  // The synthesis is held to the SAME completeness gates as the candidates: a
  // token-cap-clipped synthesis still contains the structural needles while
  // being non-runnable, and "keep_synthesis" on it would ship a broken file.
  const synthesisAnswer = answerForScope(input.synthesisText, scope);
  const synthesisComplete = passesCompletenessGates(input.synthesisText, {
    scope,
    completionAnyOf: input.completionAnyOf,
    truncated: input.synthesisTruncated,
  });
  const synthesisVerified = synthesisComplete && passesChecker(input.checker, synthesisAnswer);

  if (synthesisVerified) {
    return { decision: 'keep_synthesis', synthesisVerified, verify };
  }

  if (verify.method === 'checker' && verify.answer != null) {
    // When the "majority" among passers was vacuous (all distinct), the verifier's
    // answer is just the first passer — pick the BEST passer instead (judge score →
    // length → voter order); `passerIndices` only contains candidates that already
    // cleared the completeness gates inside the verifier. Otherwise map the verified
    // answer back to the first voter that produced it AND passes the completeness
    // gates AND the checker (extraction is deterministic, so equality identifies the
    // voter; the gates stop a disqualified candidate with text identical to the
    // winner from hijacking the index).
    const idx =
      verify.arbitraryAmongPassers && verify.passerIndices.length > 1
        ? bestPasserIndex(verify.passerIndices, input)
        : input.candidateTexts.findIndex((t, i) => {
            const a = answerForScope(t, scope);
            return a === verify.answer
              && passesCompletenessGates(t, {
                scope,
                completionAnyOf: input.completionAnyOf,
                truncated: input.candidateTruncated?.[i],
              })
              && passesChecker(input.checker, a);
          });
    if (idx >= 0) {
      return { decision: 'override_to_voter', voterIndex: idx, synthesisVerified, verify };
    }
  }

  return { decision: 'no_signal', synthesisVerified, verify };
}
