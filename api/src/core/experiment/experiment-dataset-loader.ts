// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Public-benchmark dataset loader.
 *
 * Maps vendored HumanEval and GSM8K records (see `fixtures/datasets/`) onto
 * `ExperimentTask`s graded by the EXISTING objective pipeline — sandbox
 * execution for HumanEval, `numeric_equals` answer-check for GSM8K. No LLM
 * judge is involved, so these give a market-comparable axis (code pass@1 and
 * grade-school-math accuracy) alongside the internal suite. Consumed via a
 * config's explicit `tasks` universe (ExperimentConfig.tasks), so the static
 * `EXPERIMENT_SUITE` is untouched.
 *
 * Index ranges are reserved so loaded tasks never collide with the built-in
 * suite (indices ≲ 200): HumanEval → 10000+, GSM8K → 20000+,
 * HumanEval+ (EvalPlus augmented tests) → 30000+.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExperimentTask } from './experiment-types';

const DATASET_DIR = join(__dirname, 'fixtures', 'datasets');
/** Vendored LiveBench scoring `utils.py` (Apache-2.0), one file per reasoning task. */
const LIVEBENCH_SCORER_DIR = join(__dirname, 'fixtures', 'livebench_scorers', 'reasoning');

export const HUMANEVAL_INDEX_BASE = 10_000;
export const GSM8K_INDEX_BASE = 20_000;
export const HUMANEVAL_PLUS_INDEX_BASE = 30_000;
export const LIVEBENCH_REASONING_INDEX_BASE = 40_000;

/**
 * Cap on the number of differential-test inputs per HumanEval+ problem. The
 * EvalPlus fixture carries ~999 augmented inputs per problem; running all of
 * them × arms × repetitions would be slow with no discriminative gain past a
 * few hundred. We take ALL base_input first, then a deterministic prefix of
 * plus_input up to this total — no RNG, so the harness is byte-stable across
 * runs. Far stronger than HumanEval's 7 base asserts (which frontier models
 * saturate), still fast. base_input never exceeds this cap in the fixture, so
 * every base input is always included.
 */
export const HUMANEVAL_PLUS_MAX_TESTS = 200;

/** Parse a JSONL file into typed records, skipping blank lines. */
function readJsonl<T>(fileName: string): T[] {
  const raw = readFileSync(join(DATASET_DIR, fileName), 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

interface HumanEvalRecord {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

/**
 * EvalPlus HumanEvalPlus record. Same 164 problems as HumanEval, but each
 * carries differential-test inputs (`base_input` + ~999 `plus_input`) plus a
 * float tolerance (`atol`). We reconstruct the reference from
 * `prompt + canonical_solution` and check the candidate's output against the
 * reference's output on every (capped) input — an un-saturated, far harder
 * grade than the 7-assert `test`. `test`/`contract` are ignored (the weak base
 * / an EvalPlus input-validation contract we don't enforce).
 */
interface HumanEvalPlusRecord {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  /** Original 7-assert HumanEval harness — NOT used (the weak base). */
  test: string;
  /** ~7 original arg-lists (each an array of positional args). */
  base_input: unknown[][];
  /** ~999 augmented arg-lists (differential-tested vs the reference). */
  plus_input: unknown[][];
  /** Float comparison tolerance (0 → exact equality). */
  atol: number;
  /** EvalPlus input-validation contract — ignored. */
  contract?: string;
}

interface Gsm8kRecord {
  question: string;
  answer: string;
}

/**
 * Extract the gold integer from a GSM8K answer string, which ends with a
 * `#### <number>` line. Strips thousands separators and a leading `$`.
 * Returns null when no parseable final answer is present (record skipped).
 */
export function parseGsm8kAnswer(answer: string): number | null {
  const m = answer.match(/####\s*(.+?)\s*$/);
  if (!m) return null;
  const cleaned = m[1].replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the HumanEval user prompt: the function stub + docstring, with an
 * explicit instruction to output ONLY the completed function so `extractCode`
 * yields runnable Python.
 */
export function buildHumanEvalPrompt(stub: string): string {
  return (
    'Complete the following Python function. Output ONLY the full function ' +
    'definition (including the signature and imports if needed), no prose, no ' +
    'test code, no explanation.\n\n```python\n' +
    stub.trimEnd() +
    '\n```'
  );
}

/**
 * Build the GSM8K user prompt: the word problem plus a strict final-answer
 * contract so the objective `numeric_equals` checker can isolate the number.
 */
export function buildGsm8kPrompt(question: string): string {
  return (
    question.trim() +
    '\n\nShow your reasoning, then end with exactly one line in the form:\n' +
    'FINAL: <number>\n(the number only — no units, no words, no commas).'
  );
}

export interface DatasetLoadOptions {
  /** Cap the number of tasks loaded (deterministic prefix). Default: all in the fixture. */
  limit?: number;
}

/**
 * Load HumanEval tasks. Each carries the dataset's native `check(candidate)`
 * harness as `codeTest.checkSource`; the runner concatenates it with the
 * model's code and a zero-arg wrapper and grades binary pass@1 via the
 * existing sandbox path (no float/tuple lossiness). `functionName`/`tests`
 * are set to the wrapper's fixed shape.
 */
export function loadHumanEvalTasks(opts: DatasetLoadOptions = {}): ExperimentTask[] {
  const records = readJsonl<HumanEvalRecord>('humaneval.jsonl');
  const limited = typeof opts.limit === 'number' ? records.slice(0, opts.limit) : records;
  return limited.map((r, i) => ({
    index: HUMANEVAL_INDEX_BASE + i,
    taskType: 'code-verified',
    complexity: 'high' as const,
    domain: 'tech',
    prompt: buildHumanEvalPrompt(r.prompt),
    judgeRubric: `HumanEval ${r.task_id}: objectively graded by sandbox execution of the native check() harness (binary pass@1). No judge.`,
    expectedDifficulty: 0.6,
    maxTokens: 1024,
    codeTest: {
      language: 'python' as const,
      functionName: '__ailin_check',
      tests: [{ args: [], expected: true }],
      checkSource: r.test,
      entryPoint: r.entry_point,
    },
  }));
}

/**
 * Produce a Python string literal equivalent to the given JS string, valid in
 * BOTH JSON and Python source. `JSON.stringify` of a string emits a
 * double-quoted literal escaping only `"`, `\`, and the control characters
 * (as `\n`, `\t`, `\r`, `\b`, `\f`, or `\u00XX`) — every one of these is also
 * a valid Python 3 string escape, and non-ASCII is passed through verbatim
 * (the source is UTF-8). So this is a robust, injection-safe way to embed
 * arbitrary reference source / JSON text into the generated harness, WITHOUT
 * the triple-quote/backslash escaping bugs that hand-rolled quoting invites
 * (17 of the 164 HumanEval+ reference sources contain `'''`, 2 contain a
 * backslash — a naive triple-single-quoted embed would corrupt those).
 */
function toPyStringLiteral(s: string): string {
  return JSON.stringify(s);
}

/**
 * Build the DIFFERENTIAL-TEST harness for one HumanEval+ problem: a Python
 * `check(candidate)` that reconstructs the reference and asserts the candidate
 * agrees with it on every capped input.
 *
 * The generated harness (module-scope after the candidate's code, per the
 * runner's `isNativeHarness` concatenation):
 *   1. `json.loads` a constant `{inputs, atol}` object (so JSON null/true/false
 *      become Python None/True/False — never pasted as raw Python).
 *   2. `exec` the reference source (`prompt + canonical_solution`) into a
 *      SEPARATE dict — never module scope, so the reference's `entry_point`
 *      does not clash with the candidate's same-named function that `check`
 *      receives.
 *   3. For each arg-list: call reference and candidate, each wrapped so an
 *      exception becomes a `(False, ExcTypeName)` sentinel; assert they MATCH —
 *      both returned equal values, or both raised the same exception type.
 *      Value comparison is exact `==` for ints/strings/bools/None/containers,
 *      with element-wise float tolerance applied at numeric leaves when
 *      `atol > 0` (recursive over lists/tuples/dicts).
 * Any mismatch → `assert False` → the native wrapper raises → scored 0. All
 * inputs match → returns None → scored 1 (faithful binary pass@1, but against
 * ~200 differential inputs instead of HumanEval's 7 asserts).
 */
export function buildHumanEvalPlusCheckSource(record: HumanEvalPlusRecord): string {
  // Cap deterministically: ALL base_input, then a prefix of plus_input up to
  // the total cap (no RNG). base_input never exceeds the cap in the fixture.
  const base = Array.isArray(record.base_input) ? record.base_input : [];
  const plus = Array.isArray(record.plus_input) ? record.plus_input : [];
  const remaining = Math.max(0, HUMANEVAL_PLUS_MAX_TESTS - base.length);
  const inputs = [...base, ...plus.slice(0, remaining)];

  const referenceSource = record.prompt + record.canonical_solution;
  const dataLiteral = toPyStringLiteral(JSON.stringify({ inputs, atol: record.atol ?? 0 }));
  const refLiteral = toPyStringLiteral(referenceSource);
  const entryLiteral = toPyStringLiteral(record.entry_point);

  // NOTE: kept at column 0; the runner concatenates this verbatim after the
  // candidate's code, so any leading indentation would be a syntax error.
  return [
    'import json',
    '',
    '',
    'def check(candidate):',
    `    __data = json.loads(${dataLiteral})`,
    '    __inputs = __data["inputs"]',
    '    __atol = __data["atol"]',
    '    __ref_ns = {}',
    `    exec(${refLiteral}, __ref_ns)`,
    `    __ref = __ref_ns[${entryLiteral}]`,
    '',
    '    def __call(fn, args):',
    '        try:',
    '            return (True, fn(*args))',
    '        except Exception as __e:',
    '            return (False, type(__e).__name__)',
    '',
    '    def __match(a, b):',
    '        if a is None or b is None:',
    '            return a is None and b is None',
    '        if isinstance(a, bool) or isinstance(b, bool):',
    '            return a == b',
    '        if isinstance(a, (int, float)) and isinstance(b, (int, float)):',
    '            if __atol and __atol > 0:',
    '                try:',
    '                    return abs(a - b) <= __atol',
    '                except Exception:',
    '                    return a == b',
    '            return a == b',
    '        if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):',
    '            if len(a) != len(b):',
    '                return False',
    '            for __x, __y in zip(a, b):',
    '                if not __match(__x, __y):',
    '                    return False',
    '            return True',
    '        if isinstance(a, dict) and isinstance(b, dict):',
    '            if set(a.keys()) != set(b.keys()):',
    '                return False',
    '            for __k in a:',
    '                if not __match(a[__k], b[__k]):',
    '                    return False',
    '            return True',
    '        return a == b',
    '',
    '    for __inp in __inputs:',
    '        __args = list(__inp)',
    '        __ok_r, __val_r = __call(__ref, __args)',
    '        __ok_c, __val_c = __call(candidate, __args)',
    '        assert __ok_r == __ok_c, "exception/return mismatch"',
    '        if __ok_r:',
    '            assert __match(__val_r, __val_c), "value mismatch"',
    '        else:',
    '            assert __val_r == __val_c, "exception type mismatch"',
    '    return None',
    '',
  ].join('\n');
}

/**
 * Load HumanEval+ (EvalPlus augmented) tasks. Same 164 problems as HumanEval,
 * but each is graded by a DIFFERENTIAL-TEST harness (see
 * buildHumanEvalPlusCheckSource) against ~200 inputs rather than HumanEval's 7
 * asserts — this un-saturates the ceiling that plain HumanEval cannot express.
 * Routes through the identical sandbox path as loadHumanEvalTasks: the harness
 * is carried as `codeTest.checkSource` with `entryPoint`, so the runner's
 * native-harness branch grades a faithful binary pass@1. No LLM judge.
 */
export function loadHumanEvalPlusTasks(opts: DatasetLoadOptions = {}): ExperimentTask[] {
  const records = readJsonl<HumanEvalPlusRecord>('humaneval_plus.jsonl');
  const limited = typeof opts.limit === 'number' ? records.slice(0, opts.limit) : records;
  return limited.map((r, i) => ({
    index: HUMANEVAL_PLUS_INDEX_BASE + i,
    taskType: 'code-verified',
    complexity: 'high' as const,
    domain: 'tech',
    prompt: buildHumanEvalPrompt(r.prompt),
    judgeRubric: `HumanEval+ ${r.task_id}: objectively graded by sandbox execution of an EvalPlus differential-test harness (candidate vs reference on ~${HUMANEVAL_PLUS_MAX_TESTS} augmented inputs, binary pass@1). No judge.`,
    // Harder than plain HumanEval (augmented tests catch edge-case bugs the 7
    // base asserts miss), so a higher expectedDifficulty for calibration.
    expectedDifficulty: 0.75,
    maxTokens: 1024,
    codeTest: {
      language: 'python' as const,
      functionName: '__ailin_check',
      tests: [{ args: [], expected: true }],
      checkSource: buildHumanEvalPlusCheckSource(r),
      entryPoint: r.entry_point,
    },
  }));
}

/**
 * Load GSM8K tasks. Each carries a `numeric_equals` answer-check on the gold
 * integer; graded objectively against the model's `FINAL: <n>` line via the
 * existing answer-check path (no sandbox, no judge). Records without a
 * parseable gold answer are skipped.
 */
export function loadGsm8kTasks(opts: DatasetLoadOptions = {}): ExperimentTask[] {
  const records = readJsonl<Gsm8kRecord>('gsm8k.jsonl');
  const limited = typeof opts.limit === 'number' ? records.slice(0, opts.limit) : records;
  const tasks: ExperimentTask[] = [];
  limited.forEach((r, i) => {
    const expected = parseGsm8kAnswer(r.answer);
    if (expected === null) return; // unparseable gold — skip rather than mis-grade
    tasks.push({
      index: GSM8K_INDEX_BASE + i,
      taskType: 'gsm8k',
      complexity: 'medium',
      domain: 'math',
      prompt: buildGsm8kPrompt(r.question),
      judgeRubric: 'GSM8K: objectively graded by numeric_equals on the FINAL line. No judge.',
      expectedDifficulty: 0.5,
      maxTokens: 1024,
      answerCheck: { kind: 'numeric_equals', expected, tolerance: 0 },
      // default answerCheckScope 'final' → inspects the extracted FINAL line
    });
  });
  return tasks;
}

// ─── LiveBench reasoning (contamination-free, oracle-free) ──────────────────

/**
 * One vendored LiveBench reasoning row (fixtures/datasets/livebench_reasoning.jsonl).
 * `turns[0]` is the full prompt (including LiveBench's own answer-format
 * instruction); `ground_truth` is the held-out gold answer — SCORING ONLY, never
 * forwarded to the collective. `livebench_removal_date` is '' when the question
 * is still active in LiveBench's monthly-refreshed live set.
 */
interface LiveBenchReasoningRecord {
  question_id: string;
  category: string;
  ground_truth: string;
  turns: string[];
  task: string;
  livebench_release_date: string;
  livebench_removal_date: string;
  level: number;
}

/**
 * Per-task scorer wiring. `file` is the vendored LiveBench `utils.py`; `entry`
 * maps a row's release date (already sliced to YYYY-MM-DD) onto the Python
 * expression that yields the scoring function `fn(ground_truth, llm_answer) ->
 * float`. Tasks absent from this map are unsupported and skipped by the loader.
 *
 * zebra_puzzle is the interesting case: LiveBench's own `get_zebra_puzzle_evaluator`
 * switches scorer by release date — the pre-2024-11-25 format (`***X***`, single
 * answer, `zebra_puzzle_process_results_old`) vs the current `<solution>…</solution>`
 * multi-answer partial-credit scorer. We defer that choice to LiveBench's own
 * selector by passing the release date through, but the OLD format is EXCLUDED
 * anyway (see `excludeRow`) because its `\w+`-only bold regex cannot faithfully
 * score hyphenated / special-character ground truths (police-officer, d&b, …) —
 * exactly the defect LiveBench fixed in the new format.
 */
const LIVEBENCH_REASONING_SCORERS: Record<
  string,
  { file: string; entry: (releaseDate: string) => string }
> = {
  zebra_puzzle: {
    file: 'zebra_puzzle.py',
    entry: (releaseDate) => `get_zebra_puzzle_evaluator(${JSON.stringify(releaseDate)})`,
  },
  spatial: {
    file: 'spatial.py',
    entry: () => 'spatial_process_results',
  },
  web_of_lies_v2: {
    file: 'web_of_lies_v2.py',
    entry: () => 'web_of_lies_process_results',
  },
};

/** Strips the `from livebench.process_results.util import …` line (no such package in the sandbox). */
const LIVEBENCH_UTIL_IMPORT_RE = /^from\s+livebench\.process_results\.util\s+import.*$/m;

/** Cache vendored scorer file reads (util.py + each task utils.py are read once). */
const livebenchScorerFileCache = new Map<string, string>();
function readLiveBenchScorerFile(fileName: string): string {
  const cached = livebenchScorerFileCache.get(fileName);
  if (cached !== undefined) return cached;
  const src = readFileSync(join(LIVEBENCH_SCORER_DIR, fileName), 'utf8');
  livebenchScorerFileCache.set(fileName, src);
  return src;
}

/**
 * Build the self-contained Python module for one row's scorer. Prepends the
 * vendored shared `util.py` helpers (last_boxed_only_string / remove_boxed),
 * inlines the task scorer with its livebench import removed, and appends a
 * canonical `__ailin_scorer(ground_truth, llm_answer) -> float` wrapper that the
 * runner's generic driver calls. The release-date-dependent scorer selection is
 * baked in HERE (the loader has the row metadata); the runner stays task-agnostic.
 */
function buildLiveBenchScorerSource(taskFile: string, entryExpr: string): string {
  const util = readLiveBenchScorerFile('util.py');
  const task = readLiveBenchScorerFile(taskFile).replace(
    LIVEBENCH_UTIL_IMPORT_RE,
    '# (livebench.process_results.util helpers are inlined above from util.py)',
  );
  return [
    util,
    '',
    task,
    '',
    '',
    'def __ailin_scorer(ground_truth, llm_answer):',
    `    _fn = ${entryExpr}`,
    '    return float(_fn(ground_truth, llm_answer))',
    '',
  ].join('\n');
}

/**
 * EXCLUDED rows (unfaithful/unsupported scorer). Better to ship fewer subtasks
 * faithfully than all of them wrongly. Currently: the pre-2024-11-25 zebra_puzzle
 * format, whose `zebra_puzzle_process_results_old` scorer mis-scores hyphenated /
 * special-char ground truths (validated: 3/50 correct answers graded 0). These
 * rows are also RETIRED (livebench_removal_date set). Everything else validates
 * perfect-answer→~1.0 / wrong→low (see livebench-reasoning-loader.test.ts + the
 * PR's scorer-fidelity report).
 */
function isExcludedReasoningRow(r: LiveBenchReasoningRecord): boolean {
  return r.task === 'zebra_puzzle' && r.livebench_release_date.slice(0, 10) < '2024-11-25';
}

/**
 * Load LiveBench reasoning tasks — a contamination-free, ORACLE-FREE objective
 * axis. Each row is graded by LiveBench's OWN vendored scorer (Apache-2.0) run in
 * the sandbox against a held-out ground truth via `groundTruthScorer`; that
 * ground truth is used for SCORING ONLY and is NEVER forwarded to the collective
 * (unlike `answerCheck`). The prompt is `turns[0]` VERBATIM (it already carries
 * LiveBench's answer-format instruction — appending our own would change scoring).
 * The subtask name is carried in `domain` so reports segment by subtask.
 *
 * Rows whose scorer cannot be validated as faithful are excluded
 * (see isExcludedReasoningRow) — currently the old-format zebra_puzzle block.
 * Removed-but-faithful subtasks (e.g. web_of_lies_v2) ARE kept; the release/
 * removal metadata is preserved in the fixture so operators can filter further.
 */
export function loadLiveBenchReasoningTasks(opts: DatasetLoadOptions = {}): ExperimentTask[] {
  const records = readJsonl<LiveBenchReasoningRecord>('livebench_reasoning.jsonl');
  const tasks: ExperimentTask[] = [];
  records.forEach((r, i) => {
    if (isExcludedReasoningRow(r)) return;
    const scorerCfg = LIVEBENCH_REASONING_SCORERS[r.task];
    if (!scorerCfg) return; // unsupported subtask — skip rather than mis-grade
    const releaseDate = r.livebench_release_date.slice(0, 10);
    const prompt = r.turns?.[0];
    if (!prompt) return; // malformed row — no prompt to send
    tasks.push({
      // Index by original fixture position so indices are stable + disjoint from
      // the other benchmarks even though excluded rows leave gaps.
      index: LIVEBENCH_REASONING_INDEX_BASE + i,
      taskType: 'reasoning',
      complexity: 'high',
      // Subtask name → segmented (rankingByDomain) breakdown per LiveBench task.
      domain: r.task,
      prompt,
      judgeRubric:
        `LiveBench reasoning (${r.task}): objectively graded by LiveBench's own ` +
        `vendored scorer in the sandbox against a held-out ground truth (oracle-free, ` +
        `no judge). Continuous 0..1 with partial credit where the scorer defines it.`,
      expectedDifficulty: 0.7,
      // Reasoning prompts ask to "think step by step"; give CoT room so a correct
      // answer is never clipped before the answer-format line the scorer reads.
      maxTokens: 2048,
      groundTruthScorer: {
        scorerSource: buildLiveBenchScorerSource(scorerCfg.file, scorerCfg.entry(releaseDate)),
        groundTruth: r.ground_truth,
      },
    });
  });
  const limited = typeof opts.limit === 'number' ? tasks.slice(0, opts.limit) : tasks;
  return limited;
}
