<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Reproducing the collective-vs-frontier benchmark

Every number in the [July 2026 benchmark report](../../reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)
is regenerable from the raw per-execution CSVs committed in this repository.
No trust required.

## 1. Regenerate the published tables (2 minutes, Python 3.10+, stdlib only)

```bash
cd reports/experiments
python3 c3-campaign-objective-ha-final.py   # THE definitive objective leaderboard (Leaderboard A)
python3 c3-publication-tables.py            # cost / latency / win-loss / voter-pool tables
python3 c3-frontier-audit-9590ff41.py       # round-1 audit (add --pooled for pooled view)
python3 c3-frontier2-objective-ha-569ce880.py  # round-2 excerpt scoring
```

The scripts read the committed artifacts
(`c3-frontier*-executions-*.csv`, `c3-frontier*-answer-tails-*.csv`,
`c3-frontier2-hardness-*.csv`) and print the tables that appear in the
report. Diff what you get against what we published — that's the point.

What to look for while auditing:

- **Routing fidelity**: single-arm rows served by a fallback model are
  excluded from single-arm scores (fidelity was 65–82%; the exclusions are
  visible in the CSVs).
- **The judge-vs-checker split**: the pinned judge scores terse verified
  answers near zero (documented bias, §8 of the report). Objective claims
  come from the deterministic checker only.
- **DEGRADED rows**: no-response placeholder rows are counted separately,
  never as model errors.

## 2. Run your own evaluation against a live engine

The experiment framework that produced these runs ships in this repository
(`api/src/core/experiment/` — task universe, objective checkers, judge
integrity gates, budget governor, canary probes). It drives the engine
through the same public API you use (`/v1/chat/completions` with
`ailin_constraints.answer_check` for machine-verifiable tasks).

A step-by-step campaign guide (defining a task set with `answer_check`,
dispatching arms, reading the per-execution telemetry) is being prepared —
until it lands, the fastest paths are:

- start from the task definitions and checkers in
  `api/src/core/experiment/` (see `experiment-tool-catalog.ts` and
  `tool-calling-grader.ts` for fully worked objective-grading examples);
- open a GitHub Discussion with the task shape you want to test — sharing
  independent results (positive **or** negative) is the single most
  valuable contribution this project accepts.

## 3. Ground rules we follow (and ask of independent runs)

1. Pin the judge; disclose its failure modes.
2. Prefer deterministic checkers over judge scores wherever the task allows.
3. Report A/A noise floors before interpreting deltas.
4. Publish raw per-execution data, not only aggregates.
5. Negative results are results.
