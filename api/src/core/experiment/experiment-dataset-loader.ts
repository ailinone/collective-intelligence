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
 * suite (indices ≲ 200): HumanEval → 10000+, GSM8K → 20000+.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExperimentTask } from './experiment-types';

const DATASET_DIR = join(__dirname, 'fixtures', 'datasets');

export const HUMANEVAL_INDEX_BASE = 10_000;
export const GSM8K_INDEX_BASE = 20_000;

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
