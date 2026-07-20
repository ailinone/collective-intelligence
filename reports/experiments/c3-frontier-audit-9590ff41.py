#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Routing-fidelity audit for c3-frontier run 9590ff41 — fully replicable.

Input: c3-frontier-executions-9590ff41.csv (raw per-execution artifact,
exported via experiment-admin.yml action `export-executions-csv`; response
text replaced by md5+length).

Reproduces every number in the AUDIT ADDENDUM of
c3-frontier-report-9590ff41.md:

  1. Routing fidelity: single-model rows whose `models_used` does NOT
     contain the pinned flagship id were served by fallback models — they
     understate the flagship and must be excluded from arm attribution.
  2. Empty-generation defect: rows with total_tokens=0 marked success=t all
     carry quality 0 — excluded (harness defect, not model behavior).
  3. Corrected (faithful-only) per-arm tables, full suite + verifiable
     subset (H-A), paired per-task win/loss/tie.

Usage: python3 c3-frontier-audit-9590ff41.py [csv_path]
"""
import csv
import sys
from statistics import mean

CSV = sys.argv[1] if len(sys.argv) > 1 else 'c3-frontier-executions-9590ff41.csv'
ARMS = ['gpt-5.5-pro-2026-04-23', 'claude-opus-4-8', 'gemini-3.1-pro', 'grok-4.3']
COLL = ['consensus', 'blind-debate', 'expert-panel']

rows = list(csv.DictReader(open(CSV)))
frozen = [r for r in rows if r['phase'] == 'frozen' and r['success'] == 't']


def q(r):
    return float(r['quality_score'] or 0)


def faithful(r, arm):
    return arm in (r['models_used'] or '') and int(r['total_tokens']) > 0


def single_rows(arm, pred=lambda r: True):
    return [r for r in frozen
            if r['model'] == arm and r['execution_mode'] == 'single-model'
            and faithful(r, arm) and pred(r)]


def coll_rows(strategy, pred=lambda r: True):
    return [r for r in frozen
            if r['strategy'] == strategy and r['execution_mode'] == 'collective'
            and int(r['total_tokens']) > 0 and pred(r)]


print(f'rows={len(rows)} frozen_success={len(frozen)}')

print('\n== 1. Routing fidelity per flagship arm (frozen) ==')
for a in ARMS:
    all_rows = [r for r in frozen if r['model'] == a and r['execution_mode'] == 'single-model']
    faith = [r for r in all_rows if faithful(r, a)]
    print(f'{a}: total={len(all_rows)} faithful={len(faith)} '
          f'({100 * len(faith) // max(1, len(all_rows))}%)')

print('\n== 2. Empty-generation defect ==')
zt = [r for r in rows if r['phase'] == 'frozen'
      and int(r['total_tokens']) == 0 and r['success'] == 't']
print(f'zero-token success rows: {len(zt)}; all q==0: {all(q(r) == 0 for r in zt)}')

print('\n== 3a. FULL SUITE, faithful-only ==')
table = {}
for a in ARMS:
    sub = single_rows(a, lambda r: r['strategy'] == 'single')
    table[a] = (len(sub), mean(q(r) for r in sub), mean(float(r['cost_usd']) for r in sub))
for s in COLL:
    sub = coll_rows(s)
    table[s] = (len(sub), mean(q(r) for r in sub), mean(float(r['cost_usd']) for r in sub))
for k, (n, m, c) in sorted(table.items(), key=lambda kv: -kv[1][1]):
    print(f'{k}: n={n} avg_q={m:.3f} avg_cost=${c:.4f}')

print('\n== 3b. H-A verifiable 116-125, faithful-only ==')
inv = lambda r: 116 <= int(r['task_index']) <= 125
table = {}
for a in ARMS:
    sub = single_rows(a, inv)
    table[a] = (len(sub), mean(q(r) for r in sub) if sub else 0)
for s in COLL:
    sub = coll_rows(s, inv)
    table[s] = (len(sub), mean(q(r) for r in sub) if sub else 0)
for k, (n, m) in sorted(table.items(), key=lambda kv: -kv[1][1]):
    print(f'{k}: n={n} avg_q={m:.3f}')

print('\n== 3c. Paired per-task on 116-125, faithful-only ==')


def per_task(rows_):
    m = {}
    for r in rows_:
        m.setdefault(int(r['task_index']), []).append(q(r))
    return {t: mean(v) for t, v in m.items()}


for cs in ['consensus', 'expert-panel']:
    cq = per_task(coll_rows(cs, inv))
    tw = tl = tt = 0
    for a in ARMS:
        sq = per_task(single_rows(a, inv))
        w = l = t_ = 0
        for t in set(cq) & set(sq):
            if cq[t] > sq[t]: w += 1
            elif cq[t] < sq[t]: l += 1
            else: t_ += 1
        tw += w; tl += l; tt += t_
        print(f'{cs} vs {a}: {w}W/{l}L/{t_}T')
    print(f'{cs} TOTAL: {tw}W/{tl}L/{tt}T')


# ── Pooled H-A analysis (run 9590ff41 + top-up f7b76768) ────────────────
# Reproduces ADDENDUM 2. Requires both CSVs next to this script.
def pooled_addendum2(csv1='c3-frontier-executions-9590ff41.csv',
                     csv2='c3-frontier-topup-executions-f7b76768.csv'):
    r1 = list(csv.DictReader(open(csv1)))
    r2 = list(csv.DictReader(open(csv2)))
    fro = lambda r: r['phase'] == 'frozen' and r['success'] == 't' and int(r['total_tokens']) > 0
    inv2 = lambda r: 116 <= int(r['task_index']) <= 125
    singles = {a: [r for r in r1 if fro(r) and inv2(r) and r['model'] == a
                   and r['execution_mode'] == 'single-model' and a in (r['models_used'] or '')]
               for a in ARMS}
    colls = {s: [r for r in r1 + r2 if fro(r) and inv2(r) and r['strategy'] == s
                 and r['execution_mode'] == 'collective'] for s in COLL}
    print('\n== POOLED H-A (ADDENDUM 2) ==')
    tbl = {**singles, **colls}
    for k, v in sorted(tbl.items(), key=lambda kv: -mean(q(r) for r in kv[1])):
        print(f'{k}: n={len(v)} avg_q={mean(q(r) for r in v):.3f}')
    def pt(rows_):
        m = {}
        for r in rows_: m.setdefault(int(r['task_index']), []).append(q(r))
        return {t: mean(v) for t, v in m.items()}
    for s in COLL:
        cq = pt(colls[s]); tw = tl = tt = 0
        for a in ARMS:
            sq = pt(singles[a])
            for t in set(cq) & set(sq):
                if cq[t] > sq[t]: tw += 1
                elif cq[t] < sq[t]: tl += 1
                else: tt += 1
        print(f'{s} pooled paired vs flagships: {tw}W/{tl}L/{tt}T')


if __name__ == '__main__' and len(sys.argv) > 2 and sys.argv[2] == '--pooled':
    pooled_addendum2()
