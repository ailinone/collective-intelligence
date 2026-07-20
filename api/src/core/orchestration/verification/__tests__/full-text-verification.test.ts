// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { selectVerifiedAnswer, answerForScope } from '../best-of-n-verifier';
import { selectWithVerification } from '../verified-selection';
import { resolveAnswerChecker, type AnswerCheckSpec } from '../answer-check-resolver';

// The structural check the canvas-physics tasks carry.
const CANVAS_CHECK: AnswerCheckSpec = {
  kind: 'contains_all',
  needles: ['<canvas', 'getContext', 'requestAnimationFrame'],
  caseSensitive: false,
};
const checker = resolveAnswerChecker(CANVAS_CHECK)!;

const WORKING = `\`\`\`html
<!doctype html><html><body><canvas id="c" width="800" height="600"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');
let y = 0;
function loop(){ y += 1; ctx.clearRect(0,0,800,600); ctx.fillRect(100,y,20,20); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script></body></html>
\`\`\``;

const BROKEN_PROSE = 'Here is how you could build it: first set up a canvas, then add physics. (No code provided.)';
const PARTIAL_NO_LOOP = '<canvas id="c"></canvas><script>const ctx = c.getContext("2d"); ctx.fillRect(0,0,10,10);</script>';
// Passes the binary structural floor (all three needles present) but is a stub —
// the truncated/barely-passing artefact the first-passer defect used to serve.
const TRUNCATED_PASSER =
  '<canvas id="c"></canvas><script>const ctx = c.getContext("2d"); requestAnimationFrame(() => {});</script>';

describe('answerForScope', () => {
  it("'full' returns the entire reply; 'final' extracts a FINAL line", () => {
    expect(answerForScope(WORKING, 'full')).toBe(WORKING);
    expect(answerForScope('reasoning...\nFINAL: 42', 'final')).toBe('42');
    expect(answerForScope('   ', 'full')).toBeNull();
  });
});

describe('best-of-N with scope=full (code artefacts)', () => {
  it('selects the structurally-working candidate and rejects the broken ones', () => {
    const r = selectVerifiedAnswer([BROKEN_PROSE, PARTIAL_NO_LOOP, WORKING], {
      checker,
      scope: 'full',
    });
    expect(r.method).toBe('checker');
    expect(r.verifiedCount).toBe(1); // only WORKING has canvas+context+loop
    expect(r.answer).toBe(WORKING);
  });

  it('the DEFAULT (final) scope would NOT verify code — proves scope matters', () => {
    // Without full scope, extractFinalAnswer pulls a stray number/nothing from the
    // code, so the structural check cannot pass — the collective loses its edge.
    const r = selectVerifiedAnswer([WORKING], { checker }); // scope defaults to 'final'
    expect(r.verifiedCount).toBe(0);
  });
});

describe('selectWithVerification with scope=full', () => {
  it('overrides a broken synthesis to the working voter', () => {
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,          // synthesis came out broken
      candidateTexts: [PARTIAL_NO_LOOP, WORKING],
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);           // the WORKING voter
    expect(r.synthesisVerified).toBe(false);
  });

  it('keeps a synthesis that itself structurally passes', () => {
    const r = selectWithVerification({
      synthesisText: WORKING,
      candidateTexts: [BROKEN_PROSE],
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('keep_synthesis');
    expect(r.synthesisVerified).toBe(true);
  });
});

describe('best passer among equally-verified candidates (first-passer defect, 2026-07-16)', () => {
  // Full-scope code blobs are always pairwise distinct, so 'majority' never forms a
  // real mode: the verifier used to serve the FIRST passer in voter order, letting a
  // truncated stub beat a richer, higher-judge-score artefact that also passed.

  it('serves the highest-judge-score passer, not the first one', () => {
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,
      candidateTexts: [TRUNCATED_PASSER, BROKEN_PROSE, WORKING],
      candidateScores: [0.35, 0.1, 0.9],
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(2); // WORKING, not the truncated index-0 passer
    expect(r.verify.verifiedCount).toBe(2);
    expect(r.verify.arbitraryAmongPassers).toBe(true);
    expect(r.verify.passerIndices).toEqual([0, 2]);
  });

  it('falls back to reply length when no judge scores are provided', () => {
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,
      candidateTexts: [TRUNCATED_PASSER, WORKING],
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1); // WORKING is the longer (richer) passer
  });

  it('judge score outranks length: a shorter but higher-scored passer wins', () => {
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,
      candidateTexts: [TRUNCATED_PASSER, WORKING],
      candidateScores: [0.9, 0.2], // judge says the short one is better
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(0);
  });

  it('breaks full ties (score and length) to voter order — deterministic', () => {
    // Distinct passers, same length, same score → the earliest voter wins.
    const twin = TRUNCATED_PASSER.replace('id="c"', 'id="d"');
    expect(twin.length).toBe(TRUNCATED_PASSER.length);
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,
      candidateTexts: [TRUNCATED_PASSER, twin],
      candidateScores: [0.5, 0.5],
      checker,
      scope: 'full',
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(0);
  });
});

// ─── Completeness gates (selection-side mirror of gradeObjectiveAnswer) ─────
// A structural check's needles sit near the START of the artifact, so a reply
// clipped at the token cap still contains all three while being non-runnable.
// These fixtures mirror api/src/core/experiment/__tests__/
// objective-scoring-authoritative.test.ts: complete passes; clipped mid-script
// fails; prose-only fails; provider-reported truncation disqualifies.
const COMPLETION_SIGNALS = ['</html>', '</script>'] as const;

// The WORKING file cut right after the last requestAnimationFrame call — the
// shape a maxTokens clip produces: all three needles present, no closing tag.
const CLIPPED = WORKING.slice(
  0,
  WORKING.lastIndexOf('requestAnimationFrame(loop);') + 'requestAnimationFrame(loop);'.length,
);

// Prose that merely NAMES the three APIs — passes contains_all, is not a file.
const PROSE_NAMING_APIS =
  'I would build this with a <canvas> element, acquire a 2D context via ' +
  "getContext('2d'), and drive the physics loop with requestAnimationFrame.";

describe('scope=full completeness gates — a truncated candidate must not be selected', () => {
  it('guard: the clipped fixture still contains all three needles (the blind spot is real)', () => {
    const hay = CLIPPED.toLowerCase();
    for (const needle of ['<canvas', 'getcontext', 'requestanimationframe']) {
      expect(hay).toContain(needle);
    }
    expect(checker(CLIPPED)).toBe(true); // the raw checker alone would pass it
  });

  it('completionAnyOf: complete file verifies; clipped and prose-only do not', () => {
    const r = selectVerifiedAnswer([CLIPPED, PROSE_NAMING_APIS, WORKING], {
      checker,
      scope: 'full',
      completionAnyOf: COMPLETION_SIGNALS,
    });
    expect(r.method).toBe('checker');
    expect(r.verifiedCount).toBe(1);
    expect(r.answer).toBe(WORKING);
    // Gated-out candidates count as FAILED (denominator), not unparseable.
    expect(r.totalCount).toBe(3);
  });

  it("truncated flag (finish_reason='length') disqualifies even a complete-LOOKING text", () => {
    const r = selectVerifiedAnswer([WORKING], {
      checker,
      scope: 'full',
      truncated: [true],
    });
    expect(r.verifiedCount).toBe(0);
    expect(r.method).not.toBe('checker');
  });

  it("does NOT gate 'final' scope — a surviving FINAL line is still the answer", () => {
    const finalChecker = resolveAnswerChecker({ kind: 'numeric_equals', expected: 1020 })!;
    const r = selectVerifiedAnswer(['200*0.85=170, 170*6=1020\nFINAL: 1020'], {
      checker: finalChecker,
      scope: 'final',
      truncated: [true],
      completionAnyOf: COMPLETION_SIGNALS,
    });
    expect(r.verifiedCount).toBe(1);
    expect(r.answer).toBe('1020');
  });

  it('selectWithVerification: overrides past a clipped voter to the complete one', () => {
    const r = selectWithVerification({
      synthesisText: BROKEN_PROSE,
      candidateTexts: [CLIPPED, WORKING],
      checker,
      scope: 'full',
      completionAnyOf: COMPLETION_SIGNALS,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);
  });

  it('selectWithVerification: a TRUNCATED synthesis is not kept, even when its text passes', () => {
    const r = selectWithVerification({
      synthesisText: WORKING,
      synthesisTruncated: true,
      candidateTexts: [WORKING],
      checker,
      scope: 'full',
      completionAnyOf: COMPLETION_SIGNALS,
    });
    expect(r.synthesisVerified).toBe(false);
    expect(r.decision).toBe('override_to_voter'); // the complete voter wins instead
    expect(r.voterIndex).toBe(0);
  });

  it('selectWithVerification: everything clipped → no_signal (caller keeps its judge decision)', () => {
    const r = selectWithVerification({
      synthesisText: CLIPPED,
      candidateTexts: [CLIPPED, PROSE_NAMING_APIS],
      checker,
      scope: 'full',
      completionAnyOf: COMPLETION_SIGNALS,
      candidateTruncated: [true, false],
    });
    expect(r.decision).toBe('no_signal');
    expect(r.synthesisVerified).toBe(false);
  });
});
