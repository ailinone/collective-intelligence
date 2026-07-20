#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Publication tables for the Ailin Collective-vs-Frontier benchmark.

Computes every table in AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md from
the committed raw artifacts (runs 9590ff41, f7b76768, 569ce880). Replicable:
python3 c3-publication-tables.py
"""
import csv
import re
import statistics
from collections import defaultdict

R1 = list(csv.DictReader(open('c3-frontier-executions-9590ff41.csv')))
R2 = list(csv.DictReader(open('c3-frontier2-executions-569ce880.csv')))
TOP = list(csv.DictReader(open('c3-frontier-topup-executions-f7b76768.csv')))
INTERNALS = list(csv.DictReader(open('c3-frontier2-hardness-internals-569ce880.csv')))
COLL = ['consensus', 'blind-debate', 'expert-panel']


def q(r):
    return float(r['quality_score'] or 0)


def arm_of(r):
    return r['model'] if r['execution_mode'] == 'single-model' else r['strategy']


def frozen_ok(rows):
    return [r for r in rows if r['phase'] == 'frozen' and r['success'] == 't'
            and int(r['total_tokens']) > 0]


def faithful(r):
    if r['execution_mode'] != 'single-model':
        return True
    a = r['model'] or ''
    mu = r['models_used'] or ''
    return a in mu or a.split('/')[-1] in mu


def own_label(r):
    if r['execution_mode'] == 'single-model':
        return r['strategy'] == 'single'
    return r['strategy'] in COLL


print('== A. COST PER MTOK + LATENCY per arm (frozen, success, tokens>0, own-label, faithful) ==')
for name, rows in [('r1', R1), ('r2', R2), ('topup', TOP)]:
    sub = [r for r in frozen_ok(rows) if own_label(r) and faithful(r)]
    by = defaultdict(list)
    for r in sub:
        by[arm_of(r)].append(r)
    print(f'--- {name} ---')
    for arm, rr in sorted(by.items()):
        cost = sum(float(r['cost_usd']) for r in rr)
        toks = sum(int(r['total_tokens']) for r in rr)
        lats = sorted(int(r['latency_ms']) for r in rr)
        p50 = lats[len(lats) // 2]
        p90 = lats[int(len(lats) * 0.9) - 1] if len(lats) >= 10 else lats[-1]
        print(f'{arm:32s} n={len(rr):3d} $/Mtok={1e6 * cost / max(1, toks):8.2f} '
              f'cost/exec=${cost / len(rr):.4f} lat_p50={p50 / 1000:.1f}s lat_p90={p90 / 1000:.1f}s')

print('\n== B. WIN/LOSS map: best collective vs best faithful single, per task (r2, judge metric) ==')
sub = [r for r in frozen_ok(R2) if own_label(r) and faithful(r)]
per_task = defaultdict(lambda: defaultdict(list))
meta = {}
TASKMETA = {int(t['task_index']): t for t in
            csv.DictReader(open('c3-frontier2-hardness-tasks-569ce880.csv'))}
for r in sub:
    per_task[int(r['task_index'])][arm_of(r)].append(q(r))
    tm = TASKMETA.get(int(r['task_index']), {})
    meta[int(r['task_index'])] = (tm.get('task_type', '?'), r['complexity'], r['domain'])
wins = defaultdict(lambda: [0, 0, 0])  # keyed by (complexity,) → W/L/T of best-coll vs best-single
rows_out = []
for t, arms in sorted(per_task.items()):
    colls = {a: statistics.mean(v) for a, v in arms.items() if a in COLL}
    sings = {a: statistics.mean(v) for a, v in arms.items() if a not in COLL}
    if not colls or not sings:
        continue
    bc = max(colls, key=colls.get)
    bs = max(sings, key=sings.get)
    d = colls[bc] - sings[bs]
    tt, cx, dom = meta[t]
    res = 'W' if d > 0.02 else ('L' if d < -0.02 else 'T')
    wins[cx][0 if res == 'W' else (1 if res == 'L' else 2)] += 1
    wins[tt][0 if res == 'W' else (1 if res == 'L' else 2)] += 1
    rows_out.append((t, tt, cx, dom, bc, f'{colls[bc]:.2f}', bs, f'{sings[bs]:.2f}', f'{d:+.2f}', res))
for r in rows_out:
    print(r)
print('\nby complexity/type (best-coll vs best-single W/L/T):')
for k, (w, l, t_) in sorted(wins.items()):
    print(f'{k:20s} {w}W/{l}L/{t_}T')

print('\n== C. WINNING vs LOSING collective executions: voter sets (r2 internals + quality) ==')
# quality per (task, rep, strategy) from executions; internals give models_used
exq = {}
for r in frozen_ok(R2):
    if r['execution_mode'] == 'collective' and r['strategy'] in COLL:
        exq[(r['task_index'], r['repetition'], r['strategy'])] = q(r)
win_v, lose_v = defaultdict(int), defaultdict(int)
dec_w, dec_l = defaultdict(int), defaultdict(int)
for r in INTERNALS:
    if r['strategy'] not in COLL:
        continue
    key = (r['task_index'], r['repetition'], r['strategy'])
    if key not in exq:
        continue
    good = exq[key] >= 0.8
    dm = re.search(r'\[decider: ([^\]]+)\]', r['internals'])
    for m in (r['models_used'] or '').split('|'):
        if not m:
            continue
        (win_v if good else lose_v)[m] += 1
    if dm:
        (dec_w if good else dec_l)[dm.group(1)] += 1
print('top voters in HIGH-quality (q>=0.8) collective executions:')
for m, c in sorted(win_v.items(), key=lambda kv: -kv[1])[:10]:
    print(f'  {m}: {c} (in low-q: {lose_v.get(m, 0)})')
print('top deciders — high-q vs low-q:')
for m in sorted(set(dec_w) | set(dec_l), key=lambda m: -(dec_w.get(m, 0) + dec_l.get(m, 0)))[:8]:
    print(f'  {m}: high={dec_w.get(m, 0)} low={dec_l.get(m, 0)}')

print('\n== D. Execution counts & spend per run ==')
for name, rows, spend in [('r1-9590ff41', R1, 37.71), ('topup-f7b76768', TOP, 0.12), ('r2-569ce880', R2, 105.42)]:
    fr = [r for r in rows if r['phase'] == 'frozen']
    print(f'{name}: rows={len(rows)} frozen={len(fr)} reported_spend=${spend}')
