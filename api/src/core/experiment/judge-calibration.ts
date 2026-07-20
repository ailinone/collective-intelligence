// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Judge Calibration — Inter-Rater Reliability Test
 *
 * Runs the same (response, rubric) pair through the judge N times
 * and measures score consistency. If stddev > 0.1, the judge is
 * too noisy for reliable benchmark scoring.
 *
 * Should be run BEFORE each benchmark experiment to validate
 * that the judge model produces consistent scores.
 *
 * Usage:
 *   const report = await calibrateJudge({ runs: 20, apiBase, bearerToken });
 *   if (report.maxStdDev > 0.1) throw new Error('Judge too noisy');
 */

import { logger } from '@/utils/logger';
import {
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
  normalizeJudgeOutput,
} from '@/core/quality/judge-schema';
import { narrowAs } from '@/utils/type-guards';
import type { ChatResponse, ChatRequest, OrchestrationContext } from '@/types';

const log = logger.child({ component: 'judge-calibration' });

export interface CalibrationConfig {
  /** Number of times to score each test case */
  runs: number;
  /** API base URL */
  apiBase: string;
  /** Bearer token for API */
  bearerToken: string;
  /** Judge model (should match EXPERIMENT_JUDGE_MODEL) */
  judgeModel: string;
}

export interface CalibrationResult {
  taskLabel: string;
  scores: number[];
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  range: number;
  /** Human gold label for this case (0..1). The accuracy axis compares against this. */
  expectedScore: number;
  /** |mean − expectedScore| — how far this case's mean drifts from the gold label.
   *  This is the ACCURACY signal. For a DYNAMIC judge (provider-diverse cascade)
   *  this — not stdDev — is the primary trust criterion: a judge that swaps models
   *  per call has high stdDev BY DESIGN, but each pick must still track the gold. */
  absError: number;
  /** Whether this case counts toward the ACCURACY gate. Ambiguous cases — gold
   *  with low human inter-rater agreement (e.g. correct-but-incomplete) — are
   *  measured and reported but NOT gated, so the gate trusts only clear labels. */
  gated: boolean;
}

export interface CalibrationReport {
  judgeModel: string;
  totalRuns: number;
  results: CalibrationResult[];
  /** Total parsed judge scores across all cases. 0 ⇒ the judge produced nothing. */
  totalScoresCollected: number;
  /** False when any case collected too few scores to measure variance (an empty
   *  sample yields stdDev 0, which would otherwise FALSELY pass the noise gate). */
  enoughData: boolean;
  avgStdDev: number;
  maxStdDev: number;
  minStdDev: number;
  reliable: boolean;       // true ONLY if enoughData AND maxStdDev <= threshold (NOISE axis)
  threshold: number;
  // ── ACCURACY axis (vs human gold labels) ────────────────────────────────
  // The noise axis (reliable/maxStdDev) is the right gate for a PINNED judge.
  // A DYNAMIC judge (provider-diverse fallback cascade) is variance-rich by
  // design, so it must be judged on ACCURACY instead: does each verdict track
  // the human gold label? meanAbsError is the mean |mean − expected| over cases
  // with enough data; maxAbsError is the worst case.
  /** Mean absolute error vs gold labels across cases (the dynamic-judge metric). */
  meanAbsError: number;
  /** Worst single-case absolute error vs gold. */
  maxAbsError: number;
  /** Max tolerated absolute error before the judge is deemed inaccurate. */
  accuracyThreshold: number;
  /** true ONLY if enoughData AND maxAbsError <= accuracyThreshold. The correct
   *  gate for the dynamic production judge (use alongside `reliable` for pinned). */
  accurate: boolean;
  timestamp: string;
}

// Test cases: known responses with expected quality levels
const CALIBRATION_CASES = [
  {
    label: 'perfect-code (expected ~0.95)',
    expectedScore: 0.95,
    gated: true,
    taskType: 'code-generation',
    response: `\`\`\`typescript
function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min cannot be greater than max");
  if (Number.isNaN(value) || Number.isNaN(min) || Number.isNaN(max)) return NaN;
  return Math.min(Math.max(value, min), max);
}
\`\`\`

### Behavior
- Returns \`min\` if \`value < min\`
- Returns \`max\` if \`value > max\`
- Returns \`value\` if \`min <= value <= max\`
- Throws RangeError if min > max
- Preserves NaN behavior

### Edge cases handled
- NaN inputs return NaN
- Infinity values work correctly
- min === max returns that value`,
    rubric: 'Correct TypeScript clamp function with: proper clamping logic, NaN handling, min>max validation, edge case documentation. Clean code with JSDoc or comments.',
  },
  {
    label: 'mediocre-code (expected ~0.50)',
    expectedScore: 0.50,
    // NOT gated: correct-but-incomplete vs an exacting rubric is genuinely
    // ambiguous (human raters split ~0.3–0.6), so it is measured but does not
    // gate the judge. Keeping it as a gate target overfit the judge prompt.
    gated: false,
    taskType: 'code-generation',
    response: `\`\`\`typescript
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
\`\`\``,
    rubric: 'Correct TypeScript clamp function with: proper clamping logic, NaN handling, min>max validation, edge case documentation. Clean code with JSDoc or comments.',
  },
  {
    label: 'wrong-answer (expected ~0.00)',
    expectedScore: 0.00,
    gated: true,
    taskType: 'code-generation',
    response: 'The clamp function returns the average of min and max. Here it is:\n\n```typescript\nfunction clamp(value: number, min: number, max: number): number {\n  return (min + max) / 2;\n}\n```',
    rubric: 'Correct TypeScript clamp function with: proper clamping logic, NaN handling, min>max validation, edge case documentation. Clean code with JSDoc or comments.',
  },
  {
    label: 'detailed-analysis (expected ~0.85)',
    expectedScore: 0.85,
    gated: true,
    taskType: 'analysis',
    response: `The API performance metrics show several concerning trends:

1. **P99 latency increased 340% over 30 days** — from 120ms to 530ms, indicating either increased load, database degradation, or resource contention
2. **Error rate stable at 0.2%** — within SLA but should be monitored
3. **Throughput plateau at 1200 RPS** — suggests a bottleneck (connection pool, CPU, or external dependency)

Root cause analysis:
- The latency spike correlates with the deployment of v2.3.1 on day 15
- Query analysis shows N+1 patterns in the /api/users endpoint
- Connection pool is at 85% utilization during peak hours

Recommendations:
1. Immediate: Add database query batching for /api/users (expected 60% latency reduction)
2. Short-term: Increase connection pool from 20 to 40 and add PgBouncer
3. Medium-term: Implement read replicas for analytics queries`,
    rubric: 'Accurate analysis of performance metrics with: correct identification of trends, plausible root cause analysis, specific and actionable recommendations. Should reference actual data points from the metrics.',
  },
];

/** Build a per-case result (mean/stdDev + accuracy vs gold) from a score sample.
 *  Shared by the HTTP (pinned) and in-process (dynamic) calibration paths so both
 *  report identical NOISE + ACCURACY axes. */
function summarizeCase(label: string, expectedScore: number, scores: number[], gated: boolean): CalibrationResult {
  const mean = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  const stdDev = scores.length > 1
    ? Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1))
    : 0;
  return {
    taskLabel: label,
    scores,
    mean,
    stdDev,
    min: scores.length > 0 ? Math.min(...scores) : 0,
    max: scores.length > 0 ? Math.max(...scores) : 0,
    range: scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0,
    expectedScore,
    // ACCURACY: how far the judge's mean verdict drifts from the gold label.
    // NaN when no scores were parsed (excluded from the aggregate) so an
    // unreachable judge cannot masquerade as perfectly accurate (absError 0).
    absError: scores.length > 0 ? Math.abs(mean - expectedScore) : Number.NaN,
    gated,
  };
}

/** Aggregate per-case results into the dual-axis report — NOISE (reliable/stdDev,
 *  the pinned-judge gate) and ACCURACY (accurate/absError vs gold, the dynamic-
 *  judge gate). `runsRequested` drives the minimum-sample guard. */
function buildReport(judgeModel: string, runsRequested: number, results: CalibrationResult[]): CalibrationReport {
  const threshold = Number(process.env.JUDGE_CALIBRATION_THRESHOLD ?? 0.10);
  const accuracyThreshold = Number(process.env.JUDGE_ACCURACY_THRESHOLD ?? 0.15);
  const stdDevs = results.map(r => r.stdDev);
  // Too few parsed scores ⇒ untrustworthy: an empty/near-empty sample yields
  // stdDev 0 AND absError NaN, which must not pass either gate. Require a real
  // sample per case — >=2 for a variance, and at least half the requested runs.
  const minScoresPerCase = Math.max(2, Math.ceil(runsRequested / 2));
  const totalScoresCollected = results.reduce((s, r) => s + r.scores.length, 0);
  const enoughData = results.length > 0 && results.every(r => r.scores.length >= minScoresPerCase);

  // ACCURACY gate considers only GATED cases (unambiguous gold). Non-gated cases
  // (e.g. correct-but-incomplete, where human raters legitimately disagree) are
  // still measured and reported, but never fail the gate.
  const gatedResults = results.filter(r => r.gated);
  const absErrors = gatedResults.map(r => r.absError).filter((e) => Number.isFinite(e));
  const meanAbsError = absErrors.length > 0 ? absErrors.reduce((s, v) => s + v, 0) / absErrors.length : Number.NaN;
  const maxAbsError = absErrors.length > 0 ? Math.max(...absErrors) : Number.NaN;
  const accurate = enoughData && gatedResults.length > 0 && absErrors.length === gatedResults.length && maxAbsError <= accuracyThreshold;

  const report: CalibrationReport = {
    judgeModel,
    totalRuns: runsRequested * results.length,
    results,
    totalScoresCollected,
    enoughData,
    avgStdDev: stdDevs.length > 0 ? stdDevs.reduce((s, v) => s + v, 0) / stdDevs.length : 0,
    maxStdDev: stdDevs.length > 0 ? Math.max(...stdDevs) : 0,
    minStdDev: stdDevs.length > 0 ? Math.min(...stdDevs) : 0,
    reliable: enoughData && stdDevs.length > 0 && Math.max(...stdDevs) <= threshold,
    threshold,
    meanAbsError,
    maxAbsError,
    accuracyThreshold,
    accurate,
    timestamp: new Date().toISOString(),
  };

  log.info({
    reliable: report.reliable,
    maxStdDev: report.maxStdDev.toFixed(3),
    threshold,
    accurate: report.accurate,
    meanAbsError: Number.isNaN(meanAbsError) ? 'n/a' : meanAbsError.toFixed(3),
    maxAbsError: Number.isNaN(maxAbsError) ? 'n/a' : maxAbsError.toFixed(3),
    accuracyThreshold,
    enoughData,
    totalScoresCollected,
  }, !enoughData
    ? 'Judge calibration FAILED — too few scores collected (judge unreachable/unauthenticated or producing no parseable output)'
    : (report.reliable && report.accurate)
      ? 'Judge calibration PASSED (consistent AND accurate vs gold)'
      : !report.accurate
        ? 'Judge calibration: INACCURATE vs gold (maxAbsError > accuracyThreshold) — the dynamic-judge concern'
        : 'Judge calibration: NOISY (maxStdDev > threshold) — accurate but inconsistent (pinned-judge concern)');

  return report;
}

/**
 * Run judge calibration and return reliability report.
 */
export async function calibrateJudge(config: CalibrationConfig): Promise<CalibrationReport> {
  const results: CalibrationResult[] = [];

  log.info({ judgeModel: config.judgeModel, runs: config.runs, cases: CALIBRATION_CASES.length }, 'Starting judge calibration');

  for (const testCase of CALIBRATION_CASES) {
    const scores: number[] = [];

    for (let i = 0; i < config.runs; i++) {
      try {
        const resp = await fetch(config.apiBase, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.bearerToken}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            model: config.judgeModel,
            strategy: 'single',
            no_cache: true,
            response_format: { type: 'json_object' },
            ailin_constraints: { requiredCapabilities: ['chat', 'json_mode'] },
            messages: [{
              role: 'user',
              content: `You are an expert evaluator. Score the following response against the rubric.

RUBRIC:
${testCase.rubric}

RESPONSE:
${testCase.response}

Score from 0.0 (completely wrong) to 1.0 (perfect).
Consider: accuracy, completeness, actionability, and depth.

${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`,
            }],
          }),
        });

        const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? '';
        // J-Final (Lote 4): route through the unified judge normalizer so
        // canonical JudgeVerdict JSON, legacy `{score, reasoning}`, and
        // markdown-wrapped JSON are all accepted.
        const verdict = normalizeJudgeOutput(content, { where: 'judge-calibration.case' });
        if (verdict) {
          scores.push(verdict.score);
        }
      } catch (err) {
        log.warn({ case: testCase.label, run: i, error: String(err) }, 'Calibration run failed');
      }
    }

    const result = summarizeCase(testCase.label, testCase.expectedScore, scores, testCase.gated ?? true);
    results.push(result);
    log.info({
      case: testCase.label,
      runs: scores.length,
      mean: result.mean.toFixed(3),
      expected: testCase.expectedScore.toFixed(2),
      absError: Number.isNaN(result.absError) ? 'n/a' : result.absError.toFixed(3),
      stdDev: result.stdDev.toFixed(3),
    }, 'Calibration case complete');
  }

  return buildReport(config.judgeModel, config.runs, results);
}

/**
 * Dynamic-judge calibration (Via A) — exercises the REAL production judge: the
 * provider-diverse fallback cascade in `QualityScorer.evaluateWithLLMJudge`
 * (ba654a5), via `calculatePolicyAwareScore('benchmark')` with NO judgeModel
 * (no forced pick). Unlike calibrateJudge (which HTTP-fetches a single pinned
 * EXPERIMENT_JUDGE_MODEL), this runs IN-PROCESS, so it needs no external token
 * and uses the booted app's registry + GCP-resolved provider secrets.
 *
 * The ACCURACY axis (maxAbsError vs gold) is the authoritative gate here — the
 * cascade is variance-rich by design, so its stdDev is informational only.
 *
 * CAVEAT: the dynamic judge evaluates with GENERIC criteria (correctness/
 * completeness/clarity/relevance), NOT each case's specific rubric, so part of
 * any gold gap is prompt-mismatch rather than judge error — read accordingly.
 */
export async function calibrateDynamicJudge(runs: number): Promise<CalibrationReport & { totalCostUsd: number }> {
  const { getQualityScorer } = await import('@/core/quality/quality-scorer.js');
  const scorer = getQualityScorer();
  const results: CalibrationResult[] = [];
  let totalCostUsd = 0;

  log.info({ runs, cases: CALIBRATION_CASES.length }, 'Starting DYNAMIC judge calibration (in-process cascade, no forced pick)');

  for (const testCase of CALIBRATION_CASES) {
    const scores: number[] = [];
    const response = narrowAs<ChatResponse>({
      id: 'calib', object: 'chat.completion', created: 0, model: 'calibration',
      choices: [{ index: 0, message: { role: 'assistant', content: testCase.response }, finish_reason: 'stop' }],
    });
    const context = narrowAs<OrchestrationContext>({
      taskType: testCase.taskType, models: [], contextSize: 0,
    });
    const originalRequest = narrowAs<ChatRequest>({
      model: 'auto', messages: [{ role: 'user', content: testCase.rubric }],
    });

    for (let i = 0; i < runs; i++) {
      try {
        const r = await scorer.calculatePolicyAwareScore(response, context, undefined, 'benchmark', { originalRequest });
        totalCostUsd += r.judgeCostUsd ?? 0;
        // Only count a REAL judge verdict (the cascade succeeded). A judgeFailed
        // result is a neutral non-verdict — dropping it keeps it out of the score
        // sample, so enoughData correctly fails if the cascade can't produce one.
        if (!r.judgeFailed && r.method === 'llm-judge') {
          scores.push(typeof r.judgeScore === 'number' ? r.judgeScore : r.overall);
        }
      } catch (err) {
        log.warn({ case: testCase.label, run: i, error: String(err) }, 'Dynamic calibration run failed');
      }
    }

    const result = summarizeCase(testCase.label, testCase.expectedScore, scores, testCase.gated ?? true);
    results.push(result);
    log.info({
      case: testCase.label,
      runs: scores.length,
      mean: result.mean.toFixed(3),
      expected: testCase.expectedScore.toFixed(2),
      absError: Number.isNaN(result.absError) ? 'n/a' : result.absError.toFixed(3),
      stdDev: result.stdDev.toFixed(3),
    }, 'Dynamic calibration case complete');
  }

  const report = buildReport('dynamic-cascade (no forced pick)', runs, results);
  log.info({ totalCostUsd: totalCostUsd.toFixed(4) }, 'Dynamic judge calibration cost');
  return { ...report, totalCostUsd };
}
