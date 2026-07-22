#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""General-purpose judge-free objective checker for any C3 answer-tails
export (any experiment id, any config — c3-ha-verifiable-minirun,
c3-ha-hard, or any future run touching tasks 116-135 or 146-155).

Unlike c3-campaign-objective-ha-final.py / c3-hb-objective-checker-*.py
(frozen audit artifacts scoped to specific already-published experiment
ids), this script takes an answer-tails CSV path as an argument and scores
whatever verifiable tasks it finds, using the full spec set in
c3-answer-specs.py. Tasks outside that spec set (136-145 canvas-physics —
structural full-text check, different extraction unit; 156-160
code-verified — sandbox execution, not text-checkable) are reported as
SKIPPED, never silently mis-scored.

Extraction/check semantics mirror production
(best-of-n-verifier.extractFinalAnswer + answer-check-resolver) exactly,
copied from the frozen scripts this one supersedes for NEW data.

Arm grouping: single-model rows are keyed by `model`; collective rows by
`strategy` alone — this merges distinct execution_modes that share a
strategy name (e.g. a dynamic `collective:consensus` and a forced-pool
`collective-tier1:consensus`) into one bucket. Fine for a first read; if
you need mode-level separation, group by (execution_mode, strategy)
yourself from the same CSV.

Usage:
    python3 c3-objective-checker.py <answer-tails.csv> [<answer-tails2.csv> ...]

Generate the input via the export-answer-tails workflow action (or the
equivalent SQL — see C3-AUDIT-GUIDE.md §1) against a live experiment id.
"""
import csv
import re
import sys
from collections import defaultdict

from c3_answer_specs import SPECS_ALL, CANVAS_PHYSICS_CHECK

# Union of the marker sets used by c3-campaign-objective-ha-final.py and
# c3-hb-objective-checker-36183d17.py — same underlying defect (self-review
# prompt contamination, see selfCritiqueLoop fix), cataloged independently
# by each script; broadest coverage for new data.
CONTAMINATION_MARKERS = [
    '"quality_score', 'previous response', 'self-review', 'issues_found',
    'reviewing a previous', 'review my previous', 'quality assessment',
    'self-assessment', 'review process', 'quality 0.0-1.0', 'issues to fix',
]

CANVAS_TASK_INDICES = set(CANVAS_PHYSICS_CHECK['task_indices'])


def extract_final(text):
    finals = list(re.finditer(r'FINAL:\s*(.+)$', text, re.IGNORECASE))
    if finals:
        raw = finals[-1].group(1).strip()
        return raw if raw else None
    nums = re.findall(r'-?\d[\d,]*(?:\.\d+)?', text)
    return nums[-1].replace(',', '') if nums else None


def to_number(answer):
    m = re.search(r'-?\d+(?:\.\d+)?', answer.replace(',', ''))
    return float(m.group(0)) if m else None


def check(task, answer, full_text, has_final):
    kind, a, b = SPECS_ALL[task]
    if kind == 'numeric_equals':
        n = to_number(answer) if answer else None
        return n is not None and abs(n - a) <= b
    if kind == 'string_equals':
        if not answer:
            return False
        first = answer.split()[0].strip('*`"\'.,()[]') if answer.split() else ''
        return first.lower() == a.lower()
    if kind == 'regex':
        flags = re.IGNORECASE if b == 'i' else 0
        if answer and re.search(a, answer, flags):
            return True
        return bool(not has_final and re.search(a, full_text, flags))
    return False


def main(paths):
    if not paths:
        print(__doc__)
        sys.exit(1)

    agg = defaultdict(lambda: {'pass': 0, 'fail': 0, 'degraded': 0, 'contaminated': 0})
    fails = []
    skipped_canvas = 0
    skipped_other = 0
    skipped_other_indices = set()

    for path in paths:
        for r in csv.DictReader(open(path)):
            if r.get('phase') != 'frozen':
                continue
            t = int(r['task_index'])
            if t in CANVAS_TASK_INDICES:
                skipped_canvas += 1
                continue
            if t not in SPECS_ALL:
                skipped_other += 1
                skipped_other_indices.add(t)
                continue

            arm = r['model'] if r['execution_mode'] == 'single-model' else r['strategy']
            text = (r.get('answer_tail') or '').strip()
            if text.startswith('[DEGRADED]'):
                agg[arm]['degraded'] += 1
                continue
            low = text.lower()
            if any(m in low for m in CONTAMINATION_MARKERS):
                agg[arm]['contaminated'] += 1
                continue
            has_final = re.search(r'FINAL:', text, re.IGNORECASE) is not None
            ans = extract_final(text)
            ok = check(t, ans, text, has_final)
            agg[arm]['pass' if ok else 'fail'] += 1
            if not ok:
                fails.append((path, t, arm, r.get('repetition'), (ans or '(none)')[:30], text[:70]))

    print(f'== Objective checker — {len(paths)} file(s), {len(SPECS_ALL)}-task spec set (116-135, 146-155) ==\n')
    for arm, c in sorted(agg.items(), key=lambda kv: -(kv[1]['pass'] / max(1, kv[1]['pass'] + kv[1]['fail']))):
        det = c['pass'] + c['fail']
        rate = f"{c['pass']/det:.0%}" if det else '—'
        print(f"{arm:32s} pass={c['pass']:3d} fail={c['fail']:3d} "
              f"degraded={c['degraded']:2d} contaminated={c['contaminated']:2d}  rate={rate} (n={det})")

    if fails:
        print('\n=== FAILS (file, task, arm, rep, extracted, tail-excerpt) ===')
        for f in fails:
            print(f)

    if skipped_canvas:
        print(f"\nNOTE: skipped {skipped_canvas} canvas-physics rows (tasks 136-145) — "
              "structural full-text check, needs the full response export, not answer-tails.")
    if skipped_other:
        print(f"NOTE: skipped {skipped_other} rows outside the known spec set — "
              f"task indices {sorted(skipped_other_indices)}. If these are 156-160 "
              "(code-verified), score them from sandbox pass-rate, not this checker. "
              "If they're something else, c3-answer-specs.py needs extending.")


if __name__ == '__main__':
    main(sys.argv[1:])
