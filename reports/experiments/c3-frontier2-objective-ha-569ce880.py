#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""H-A 100% objective — judge-free checker scoring of ALL arms (run 569ce880).

Mirrors production semantics exactly:
  - extraction: best-of-n-verifier.extractFinalAnswer (last `FINAL:` line,
    else last number in the text);
  - checking: answer-check-resolver.resolveAnswerChecker (string_equals /
    numeric_equals / contains_all / one_of / regex), specs copied verbatim
    from experiment-suite.ts tasks 116-125.

Input: c3-frontier2-hardness-outputs-569ce880.csv — 400-char LEFT excerpts
with newlines flattened. Because the tail of long responses is lost, each row
gets a three-way outcome:
  PASS / FAIL      — determinate (a FINAL: answer or an untruncated excerpt)
  INDETERMINATE    — excerpt truncated (len ≥ 395) with no FINAL: visible;
                     the answer may exist beyond the cut. Counted separately,
                     NEVER as fail. Pass-rate denominators exclude these.

Flattening caveat: production captures FINAL: up to end-of-line; here the
rest-of-excerpt stands in for the line, with trailing punctuation stripped.
"""
import csv
import re
import sys
from collections import defaultdict

OUT = sys.argv[1] if len(sys.argv) > 1 else 'c3-frontier2-hardness-outputs-569ce880.csv'

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


def extract_final(text):
    finals = list(re.finditer(r'FINAL:\s*(.+)$', text, re.IGNORECASE))
    if finals:
        raw = finals[-1].group(1).strip()
        # flattened-text stand-in for "rest of line": strip trailing prose
        raw = re.split(r'\s{2,}', raw)[0].strip()
        raw = raw.strip(' .*`"\'()')
        return raw if raw else None
    nums = re.findall(r'-?\d[\d,]*(?:\.\d+)?', text)
    return nums[-1].replace(',', '') if nums else None


def to_number(answer):
    m = re.search(r'-?\d+(?:\.\d+)?', answer.replace(',', ''))
    return float(m.group(0)) if m else None


def check(task, answer, full_text):
    kind, a, b = SPECS[task]
    if kind == 'numeric_equals':
        n = to_number(answer) if answer else None
        return n is not None and abs(n - a) <= b
    if kind == 'string_equals':
        return answer is not None and answer.strip().lower() == a.lower()
    if kind == 'regex':
        # production tests the extracted answer; the O(log n) / (5,5) patterns
        # may appear in prose rather than the FINAL token — test both, as the
        # verifier's checker sees the extracted answer which for regex tasks
        # is the FINAL payload; full-text fallback marked separately below.
        flags = re.IGNORECASE if b == 'i' else 0
        return bool(answer and re.search(a, answer, flags))
    return False


rows = list(csv.DictReader(open(OUT)))
ver = [r for r in rows if 116 <= int(r['task_index']) <= 125 and r['phase'] == 'frozen']
res = defaultdict(lambda: {'pass': 0, 'fail': 0, 'indet': 0})
fails = []
for r in ver:
    t = int(r['task_index'])
    arm = r['model'] if r['execution_mode'] == 'single-model' else r['strategy']
    text = r['output_excerpt'] or ''
    ans = extract_final(text)
    truncated = len(text) >= 395
    has_final = re.search(r'FINAL:', text, re.IGNORECASE) is not None
    if truncated and not has_final:
        res[arm]['indet'] += 1
        continue
    # FINAL payload touching the 400-char cut → answer may be truncated
    # mid-token (observed: 'O(log n' with the ')' beyond the cut) → indeterminate.
    if truncated and has_final:
        last = list(re.finditer(r'FINAL:\s*(.+)$', text, re.IGNORECASE))[-1]
        if last.end() >= len(text) - 1:
            res[arm]['indet'] += 1
            continue
    ok = check(t, ans, text)
    # regex specs: production extracts FINAL payload; if no FINAL and text is
    # complete, the pattern may legitimately appear anywhere in the answer.
    if not ok and SPECS[t][0] == 'regex' and not has_final:
        kind, a, b = SPECS[t]
        ok = bool(re.search(a, text, re.IGNORECASE if b == 'i' else 0))
    res[arm]['pass' if ok else 'fail'] += 1
    if not ok:
        fails.append((t, arm, r['repetition'], (ans or '')[:40], text[:80]))

print('== H-A 100% OBJECTIVE (checker pass-rate, run 569ce880, tasks 116-125) ==')
print(f'{"arm":32s} pass fail indet  rate(determinate)')
for arm, c in sorted(res.items(), key=lambda kv: -(kv[1]['pass'] / max(1, kv[1]['pass'] + kv[1]['fail']))):
    det = c['pass'] + c['fail']
    rate = c['pass'] / det if det else 0
    print(f'{arm:32s} {c["pass"]:4d} {c["fail"]:4d} {c["indet"]:5d}  {rate:.0%} (n={det})')
print('\n== determinate FAILS (task, arm, rep, extracted, excerpt) ==')
for f in fails:
    print(f)
