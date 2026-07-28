<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Vendored LiveBench reasoning scorers (Apache-2.0)

Verbatim copies of LiveBench's own `process_results` scoring code, vendored so
experiment runs grade reasoning answers with **LiveBench's own logic**, unmodified
and offline. Consumed by `../../../experiment-dataset-loader.ts`
(`loadLiveBenchReasoningTasks` → `buildLiveBenchScorerSource`) and executed in the
sandbox via `ExperimentTask.groundTruthScorer` (see `experiment-runner.ts`).

- Source: https://github.com/LiveBench/LiveBench (`livebench/process_results/`).
- License: Apache-2.0 © the LiveBench authors.
- Cite: White et al., "LiveBench: A Challenging, Contamination-Free LLM
  Benchmark" (2024), https://livebench.ai.

## Files
- `util.py` — shared helpers (`last_boxed_only_string`, `remove_boxed`,
  `levenshtein_distance`). Vendored from `livebench/process_results/util.py`.
- `zebra_puzzle.py` — `zebra_puzzle_process_results` (current `<solution>` format,
  partial credit) + `zebra_puzzle_process_results_old` (retired `***X***` format)
  + `get_zebra_puzzle_evaluator(release_date)` selector.
- `spatial.py` — `spatial_process_results` (0/1).
- `web_of_lies_v2.py` — `web_of_lies_process_results` (0/1).

## How they're used (self-contained assembly)
The task files import `from livebench.process_results.util import …`, which does
not exist in the sandbox. The loader therefore:
1. reads `util.py` and prepends its helpers;
2. reads the task file and **strips** that import line;
3. appends a canonical `__ailin_scorer(ground_truth, llm_answer) -> float`
   wrapper (for `zebra_puzzle` it defers to `get_zebra_puzzle_evaluator` with the
   row's release date, so LiveBench's own old/new selection is preserved).

The runner then embeds the model's raw response + the ground truth as
`json.loads` constants (scoring-only; **never** forwarded to the collective),
calls `__ailin_scorer`, and quantizes the returned float into the sandbox's
pass-count so `quality_score = passedCases/totalCases` is that continuous score.

## Faithfulness note
The pre-2024-11-25 `zebra_puzzle` (old `***X***` format) scorer cannot faithfully
grade hyphenated / special-character ground truths (its `\w+`-only bold regex
drops `police-officer`, `d&b`, …), so the loader **excludes** those rows. The
covered scorers validate perfect-answer→~1.0 / wrong→low across all their rows.

## Refresh
Do not hand-edit. Re-fetch from the URLs in each file's header (and re-run the
scorer-fidelity validation) to update.
