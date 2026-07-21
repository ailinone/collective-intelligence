<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Vendored public benchmark datasets

These JSONL files are verbatim copies of two public, MIT-licensed benchmark
datasets, vendored so experiment runs are hermetic (no network fetch, no
non-determinism). They are consumed by `../../experiment-dataset-loader.ts`,
which maps each record onto an `ExperimentTask` graded by the existing
objective pipeline (sandbox execution for HumanEval, `numeric_equals`
answer-check for GSM8K). No LLM judge is involved.

## `humaneval.jsonl` — HumanEval (164 problems, complete)
- Source: https://github.com/openai/human-eval (`data/HumanEval.jsonl.gz`)
- License: MIT © OpenAI
- Fields per line: `task_id`, `prompt` (function stub + docstring),
  `entry_point` (function name), `canonical_solution` (reference; not sent to
  the model), `test` (a native `check(candidate)` harness).
- Grading: the model completes the function; the loader carries the native
  `test` harness as `codeTest.checkSource` and the runner runs it unmodified
  in the sandbox — binary pass@1 (all asserts pass → 1.0, else 0.0).

## `gsm8k.jsonl` — GSM8K (first 200 test problems)
- Source: https://github.com/openai/grade-school-math
  (`grade_school_math/data/test.jsonl`, full test split is 1319 problems)
- License: MIT © OpenAI
- Subset: the first 200 lines of the test split, taken deterministically to
  keep the fixture and any run bounded (the full 1319 × arms × repetitions
  would blow past the per-config budget cap). To use the full set, replace
  this file with the complete `test.jsonl`.
- Fields per line: `question`, `answer` (chain-of-thought ending with
  `#### <integer>`).
- Grading: the loader extracts the integer after `####` into a
  `numeric_equals` answer-check; the model is asked to end with `FINAL: <n>`,
  which the objective grader isolates. No sandbox, no judge.
