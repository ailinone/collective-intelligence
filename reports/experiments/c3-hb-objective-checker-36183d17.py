#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Objective (judge-free) checker for the H-B mini-run 36183d17.

Reproduces the §3 table of c3-hb-minirun-report-36183d17.md from the
committed artifact c3-hb-answer-tails-36183d17.csv. Same task SPECS as
c3-campaign-objective-ha-final.py (tasks 116-125). DEGRADED placeholders
and self-review-contaminated rows are harness failures, classified
separately and excluded from the pass-rate denominator (DEGRADED) or
counted in it as non-passes (CONTAMINATED), exactly as in the campaign
scorer.

Usage: python3 c3-hb-objective-checker-36183d17.py
"""
import csv
import os
import re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
TAILS = os.path.join(HERE, 'c3-hb-answer-tails-36183d17.csv')

SPECS = {
    116: ('numeric', 1020, 0),
    117: ('numeric', 98.41, 0.02),
    118: ('numeric', 40.3, 0.2),
    119: ('numeric', 299792458, 0),
    120: ('regex', re.compile(r'O\(\s*log\s*n\s*\)', re.I), None),
    121: ('regex', re.compile(r'\b5\s*,\s*5\b'), None),
    122: ('string', 'Canberra', None),
    123: ('numeric', 44500, 0),
    124: ('numeric', 47, 0),
    125: ('numeric', 4, 0),
}

CONTAMINATION_MARKERS = (
    'previous response', 'self-assessment', 'review process',
    'quality 0.0-1.0', 'issues to fix',
)


def last_number_matches(text, target, tol):
    nums = re.findall(r'-?\d[\d,.]*\d|-?\d', text.replace(' ', ''))
    vals = []
    for n in nums:
        for c in {n.replace(',', ''),
                  n.replace('.', '').replace(',', '.'),
                  n.replace(',', '.')}:
            try:
                vals.append(float(c))
            except ValueError:
                pass
    if not vals:
        return False
    t = tol if tol else max(abs(target) * 1e-9, 1e-9)
    return any(abs(v - target) <= t for v in vals)


def check(idx, tail):
    kind, target, tol = SPECS[idx]
    if '[DEGRADED]' in tail:
        return 'DEGRADED'
    low = tail.lower()
    if any(m in low for m in CONTAMINATION_MARKERS):
        return 'CONTAMINATED'
    if kind == 'numeric':
        return 'PASS' if last_number_matches(tail, target, tol) else 'FAIL'
    if kind == 'regex':
        return 'PASS' if target.search(tail) else 'FAIL'
    return 'PASS' if target.lower() in low else 'FAIL'


def arm(r):
    if r['execution_mode'] == 'single-model' and r['strategy'] == 'single':
        return f"single:{r['model']}"
    return f"{r['execution_mode']}:{r['strategy']}"


def main():
    rows = [r for r in csv.DictReader(open(TAILS)) if r['phase'] == 'frozen']
    res = defaultdict(lambda: defaultdict(list))
    for r in rows:
        res[arm(r)][check(int(r['task_index']), r['answer_tail'])].append(
            int(r['task_index']))

    print('== H-B 36183d17 — objective checker, verifiable tasks 116-125 ==')
    print('   (arms AS SERVED: routing-fidelity audit found 0/283 rows')
    print('    served by local ollama models — see the report §2)')
    print()
    hdr = f"{'arm (as served)':45s} {'PASS':>4} {'FAIL':>4} {'DEGR':>4} {'CONT':>4}  rate(excl DEGR)"
    print(hdr)
    for a in sorted(res, key=lambda a: -len(res[a].get('PASS', []))):
        p = len(res[a].get('PASS', []))
        f = len(res[a].get('FAIL', []))
        d = len(res[a].get('DEGRADED', []))
        c = len(res[a].get('CONTAMINATED', []))
        denom = p + f + c
        rate = f"{p / denom * 100:.0f}%" if denom else '—'
        print(f"{a:45s} {p:4d} {f:4d} {d:4d} {c:4d}  {rate}")
        if res[a].get('FAIL'):
            print('    FAIL tasks:', sorted(res[a]['FAIL']))
        if res[a].get('CONTAMINATED'):
            print('    CONTAMINATED tasks:', sorted(res[a]['CONTAMINATED']))


if __name__ == '__main__':
    main()
