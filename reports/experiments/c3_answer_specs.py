# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Canonical answerCheck specs for every verifiable C3 task, transcribed
verbatim from `api/src/core/experiment/experiment-suite.ts`.

Scope, by tier (task index ranges; all currently non-overlapping):
  116-125  legacy verifiable tier ("easy") — used by every campaign run
           this repo has scored so far (r1 9590ff41, topup f7b76768,
           r2 569ce880, H-B 36183d17). SPECS_116_125 is kept separate and
           MUST match the SPECS dict hardcoded in
           c3-campaign-objective-ha-final.py and
           c3-hb-objective-checker-36183d17.py exactly — those two scripts
           are frozen audit artifacts for already-published results and are
           intentionally NOT rewired to import from here, so this dict is a
           duplication for completeness, checked in Level 1 of the audit
           guide (see reports/experiments/C3-AUDIT-GUIDE.md).
  126-135  "medium/high reasoning" tier added 2026-07-11 (commit b97c946) —
           calibrated to ~0.7-0.9 difficulty because 116-125 tops out at 0.6
           (frontier accuracy ~100%, non-discriminating). Included in
           `getVerifiableTaskIndices()` — will appear in any
           c3-ha-verifiable-minirun run from main as of 2026-07-11+.
  146-155  "reasoning-hard" tier added 2026-07-14 (commit 9cca261, #82) —
           the PURE H-A test (`c3-ha-hard`): multi-step deterministic
           computations where a single slip changes the final number, and
           the error mode is independent across models (the best-of-N
           sweet spot). Also included in `getVerifiableTaskIndices()`.
  156-160  CODE-VERIFIED tier (`c3-code-verified`) — graded by SANDBOX
           EXECUTION against hidden tests (passedCases/totalCases), not a
           text-extractable answerCheck. Deliberately NOT represented here;
           score these from the experiment's own pass-rate metadata (or the
           `structured_metadata` execution results), not this checker.
  136-145  CANVAS-PHYSICS tier (`c3-canvas-physics`) — graded by a
           STRUCTURAL full-text check (`answerCheckScope:'full'`,
           `contains_all` on `<canvas>`/`getContext`/`requestAnimationFrame`
           over the ENTIRE reply, not a `FINAL:` line) plus judge-scored
           physics plausibility. Deliberately NOT represented here — the
           check is trivial (see CANVAS_PHYSICS_CHECK below) but operates on
           full response text, not a 300-char tail, so it needs the full
           `response_summary`/output export, not the answer-tails export
           this module's numeric/regex specs are designed for.

Format: {task_index: (kind, expected, tolerance_or_flags)} — same 3-tuple
shape as the two frozen scripts, so a checker can do
`from c3_answer_specs import SPECS_ALL` (or copy the dict) as a drop-in
`SPECS` replacement without changing its `check()` function.
"""

# ─── Legacy tier (116-125) — verbatim copy, see module docstring ──────────
SPECS_116_125 = {
    116: ('numeric_equals', 1020, 0),
    117: ('numeric_equals', 98.41, 0.02),
    118: ('numeric_equals', 40.3, 0.2),
    119: ('numeric_equals', 299792458, 0),
    120: ('regex', r'O\(\s*log\s*n\s*\)', 'i'),
    121: ('regex', r'\b5\s*,\s*5\b', ''),
    122: ('string_equals', 'Canberra', None),
    123: ('numeric_equals', 44500, 0),
    124: ('numeric_equals', 47, 0),
    125: ('numeric_equals', 4, 0),
}

# ─── Medium/high reasoning tier (126-135) ──────────────────────────────────
SPECS_126_135 = {
    126: ('numeric_equals', 0.4167, 0.002),
    127: ('numeric_equals', 9, 0),
    128: ('numeric_equals', 126, 0),
    129: ('numeric_equals', 3, 0),
    130: ('numeric_equals', 6, 0),
    131: ('numeric_equals', 24, 0),
    132: ('numeric_equals', 8, 0),
    133: ('numeric_equals', 40, 0),
    134: ('regex', r'53\s*,\s*59\s*,\s*61\s*,\s*67\s*,\s*71', ''),
    135: ('numeric_equals', 9.0, 0.3),
}

# ─── Hard reasoning tier (146-155) — the "pure H-A" test ───────────────────
SPECS_146_155 = {
    146: ('numeric_equals', 925, 0),
    147: ('numeric_equals', 5543, 0),
    148: ('numeric_equals', 401, 0),
    149: ('numeric_equals', 84, 0),
    150: ('numeric_equals', 26738, 1),
    151: ('numeric_equals', 100, 0),
    152: ('regex', r'\b424\b', ''),
    153: ('numeric_equals', 34, 0),
    154: ('numeric_equals', 0.1319, 0.002),
    155: ('numeric_equals', 204, 0),
}

# Merged view for a checker that wants every text-extractable spec at once.
# Deliberately excludes 136-145 (structural full-text check, different
# extraction unit) and 156-160 (sandbox execution, not text-checkable).
SPECS_ALL = {**SPECS_116_125, **SPECS_126_135, **SPECS_146_155}

# The canvas-physics structural check (136-145), included for reference —
# NOT part of SPECS_ALL because it needs the full response text (or at
# least a much longer tail than 300 chars) and a different check function
# (contains_all / case-insensitive substring, over answerCheckScope:'full').
CANVAS_PHYSICS_CHECK = {
    'kind': 'contains_all',
    'needles': ['<canvas', 'getContext', 'requestAnimationFrame'],
    'case_sensitive': False,
    'task_indices': list(range(136, 146)),
}

if __name__ == '__main__':
    print(f'SPECS_116_125: {len(SPECS_116_125)} tasks')
    print(f'SPECS_126_135: {len(SPECS_126_135)} tasks')
    print(f'SPECS_146_155: {len(SPECS_146_155)} tasks')
    print(f'SPECS_ALL: {len(SPECS_ALL)} tasks — {sorted(SPECS_ALL)}')
    assert len(SPECS_ALL) == 30, 'expected 30 text-checkable verifiable tasks'
    assert sorted(SPECS_ALL) == sorted(list(range(116, 126)) + list(range(126, 136)) + list(range(146, 156)))
    print('OK — no duplicate/overlapping task indices across tiers')
