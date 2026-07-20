#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""H-A 100% DEFINITIVE — judge-free checker scoring over full answer TAILS.

Inputs (all committed next to this script):
  c3-frontier-answer-tails-9590ff41.csv        (round 1, 11 arms... 7 arms)
  c3-frontier-topup-answer-tails-f7b76768.csv  (top-up, 3 collectives)
  c3-frontier2-answer-tails-569ce880.csv       (round 2, 11 arms)

Tails are the LAST 300 chars of each response: the last `FINAL:` line and the
last number of the full text are both inside the tail, so production
extraction semantics (best-of-n-verifier.extractFinalAnswer: last FINAL: line,
else last number) apply exactly. Checker semantics mirror
answer-check-resolver.resolveAnswerChecker; specs verbatim from
experiment-suite.ts (tasks 116-125).

Row classification:
  PASS / FAIL   — objective checker verdict on the extracted answer
  DEGRADED      — literal harness placeholder (no response produced);
                  excluded from model pass-rates, reported separately
  CONTAMINATED  — self-review/meta text instead of a task answer (prompt
                  contamination in the serving path, round-1 singles);
                  reported separately

Usage: python3 c3-campaign-objective-ha-final.py
"""
import csv
import re
from collections import defaultdict

FILES = {
    'r1-9590ff41': 'c3-frontier-answer-tails-9590ff41.csv',
    'topup-f7b76768': 'c3-frontier-topup-answer-tails-f7b76768.csv',
    'r2-569ce880': 'c3-frontier2-answer-tails-569ce880.csv',
}

SPECS = {
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

CONTAMINATION_MARKERS = [
    '"quality_score', 'previous response', 'self-review', 'issues_found',
    'reviewing a previous', 'review my previous', 'quality assessment',
]


def extract_final(text):
    """Production: last FINAL: line's payload, else last number. The export
    flattened newlines, so 'rest of line' became 'rest of text' — checks below
    are written to be robust to trailing prose; the payload itself is NOT
    stripped of syntax chars (production does not strip either)."""
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
    kind, a, b = SPECS[task]
    if kind == 'numeric_equals':
        # production: first number in the FINAL-line payload (toNumber). The
        # flatten made the payload = rest-of-text; first number is unchanged.
        n = to_number(answer) if answer else None
        return n is not None and abs(n - a) <= b
    if kind == 'string_equals':
        if not answer:
            return False
        # production compares the FINAL line's trimmed payload. Line
        # boundaries were flattened away, so accept the target as the first
        # word of the payload (markdown wrappers stripped from that word only).
        first = answer.split()[0].strip('*`"\'.,()[]') if answer.split() else ''
        return first.lower() == a.lower()
    if kind == 'regex':
        flags = re.IGNORECASE if b == 'i' else 0
        if answer and re.search(a, answer, flags):
            return True
        return bool(not has_final and re.search(a, full_text, flags))
    return False


agg = defaultdict(lambda: defaultdict(lambda: {'pass': 0, 'fail': 0, 'degraded': 0, 'contaminated': 0}))
fails = []
for run, path in FILES.items():
    for r in csv.DictReader(open(path)):
        if r['phase'] != 'frozen':
            continue
        t = int(r['task_index'])
        arm = r['model'] if r['execution_mode'] == 'single-model' else r['strategy']
        # collective rows' `model` column is the decider — arm is the strategy
        if r['execution_mode'] == 'collective' and r['strategy'] not in (
                'consensus', 'blind-debate', 'expert-panel'):
            continue
        text = (r['answer_tail'] or '').strip()
        if text.startswith('[DEGRADED]'):
            agg[run][arm]['degraded'] += 1
            continue
        low = text.lower()
        if any(m in low for m in CONTAMINATION_MARKERS):
            agg[run][arm]['contaminated'] += 1
            continue
        has_final = re.search(r'FINAL:', text, re.IGNORECASE) is not None
        ans = extract_final(text)
        ok = check(t, ans, text, has_final)
        agg[run][arm]['pass' if ok else 'fail'] += 1
        if not ok:
            fails.append((run, t, arm, r['repetition'], (ans or '(none)')[:30], text[:70]))

print('== H-A 100% DEFINITIVE — objective checker pass-rates (frozen, tasks 116-125) ==')
pooled = defaultdict(lambda: {'pass': 0, 'fail': 0, 'degraded': 0, 'contaminated': 0})
for run in FILES:
    print(f'\n--- {run} ---')
    for arm, c in sorted(agg[run].items(), key=lambda kv: -(kv[1]['pass'] / max(1, kv[1]['pass'] + kv[1]['fail']))):
        det = c['pass'] + c['fail']
        rate = f"{c['pass']/det:.0%}" if det else '—'
        print(f"{arm:32s} pass={c['pass']:3d} fail={c['fail']:3d} "
              f"degraded={c['degraded']:2d} contaminated={c['contaminated']:2d}  rate={rate} (n={det})")
        for k in c:
            pooled[arm][k] += c[k]

print('\n=== POOLED (all runs) ===')
for arm, c in sorted(pooled.items(), key=lambda kv: -(kv[1]['pass'] / max(1, kv[1]['pass'] + kv[1]['fail']))):
    det = c['pass'] + c['fail']
    rate = f"{c['pass']/det:.0%}" if det else '—'
    print(f"{arm:32s} pass={c['pass']:3d} fail={c['fail']:3d} "
          f"degraded={c['degraded']:2d} contaminated={c['contaminated']:2d}  rate={rate} (n={det})")

print('\n=== ALL objective FAILS (run, task, arm, rep, extracted, tail-excerpt) ===')
for f in fails:
    print(f)
