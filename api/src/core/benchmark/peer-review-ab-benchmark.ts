// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Peer-review (social-facilitation) A/B benchmark harness.
 *
 * The Lote 1 audit flagged the peer-review prepend as "plausibly redundant
 * with the catalog prompts, but removing it is a high-risk change". Lote 2
 * built the `peer-review-prompt` harness so the injection can be toggled
 * via `AILIN_PEER_REVIEW_MODE=on|off` with no code change. Lote 3 — this
 * module — provides the structured benchmark that USES that harness to
 * decide empirically whether to keep, retire, or gate per-strategy.
 *
 * Design goals:
 *
 * - **Reproducible**: every run is keyed by a `runId` and writes a single
 *   JSON file containing the full configuration, per-sample measurements,
 *   and aggregated verdicts. The same config should yield the same
 *   structural output (scores vary with model sampling; shape does not).
 *
 * - **Non-production-altering**: the benchmark does NOT flip production
 *   defaults. It spawns an isolated `OrchestrationEngine` execution path
 *   per arm with a scoped env var. `process.env` is restored before return.
 *
 * - **Uses the unified judge schema (R2)**: each sample is scored through
 *   `normalizeJudgeOutput` so A and B are strictly comparable on the
 *   `score ∈ [0,1]` axis, even if the underlying judge model drifts.
 *
 * - **Honest about what it cannot tell you**: the harness is scoped to
 *   measure per-sample quality, latency, and token cost deltas. It does
 *   NOT attempt to infer causation from small samples, does not claim
 *   statistical significance, and does not auto-flip production. The
 *   caller (an engineer, not CI) reads the aggregated report and decides.
 *
 * This module is deliberately DECOUPLED from the orchestration engine via
 * a small `ExecutionRunner` interface so the harness can be unit-tested
 * without spinning up real providers. A default runner is provided that
 * calls the real engine for actual benchmark runs.
 */

import { logger } from '@/utils/logger';
import { resolvePeerReviewMode } from '@/core/orchestration/prompts/peer-review-prompt';
import { normalizeJudgeOutput, type JudgeVerdict } from '@/core/quality/judge-schema';
import type { ChatRequest, ChatResponse, ExecutionStrategyName } from '@/types';

const log = logger.child({ component: 'peer-review-ab-benchmark' });

/** Semantic label for the two arms of the A/B experiment. */
export type BenchmarkArm = 'A-peer-review-on' | 'B-peer-review-off';

/** One task to run through both arms. */
export interface BenchmarkTask {
  /** Stable id for cross-run comparison. */
  id: string;
  /** What kind of workload this stresses (analysis / debugging / creative / ...). */
  category: string;
  /** The strategy to use when running this task. */
  strategy: ExecutionStrategyName;
  /** Rough complexity label so aggregation can split simple vs hard tasks. */
  complexity: 'low' | 'medium' | 'high';
  /** The ChatRequest template. `model: 'auto'` lets the engine select. */
  request: ChatRequest;
}

/** Per-sample measurement captured from one arm running one task. */
export interface BenchmarkSample {
  taskId: string;
  arm: BenchmarkArm;
  category: string;
  strategy: ExecutionStrategyName;
  complexity: BenchmarkTask['complexity'];
  /** Judge-normalized quality on the [0,1] axis (R2). */
  qualityScore: number;
  /** End-to-end latency of the engine call in milliseconds. */
  latencyMs: number;
  /** Sum of input tokens across all models invoked by the strategy. */
  inputTokens: number;
  /** Sum of output tokens across all models invoked by the strategy. */
  outputTokens: number;
  /** Total USD cost reported by the engine. */
  totalCost: number;
  /** Whether the call succeeded end-to-end. Failures are still recorded. */
  success: boolean;
  /** Error text if success === false. */
  error?: string;
}

/** What a runner produces for one (arm, task) pair. */
export interface RunnerSampleResult {
  response?: ChatResponse;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  success: boolean;
  error?: string;
}

/** How a task is executed against one arm. Abstracted for testability. */
export interface ExecutionRunner {
  /**
   * Execute one task against one arm. Implementations MUST respect the arm
   * (i.e. set AILIN_PEER_REVIEW_MODE appropriately for the duration of the
   * call) and MUST restore env state before returning.
   */
  run(task: BenchmarkTask, arm: BenchmarkArm): Promise<RunnerSampleResult>;
}

/** How a sample is scored. Separated so tests can inject a deterministic judge. */
export interface QualityJudge {
  /**
   * Score a response in [0,1]. Returning `undefined` means the judge could
   * not form an opinion — the sample will be counted as `success: false`.
   */
  score(args: {
    task: BenchmarkTask;
    response: ChatResponse | undefined;
  }): Promise<JudgeVerdict | undefined>;
}

/** Aggregated per-arm statistics. */
export interface ArmAggregate {
  arm: BenchmarkArm;
  samples: number;
  successes: number;
  meanQuality: number;
  meanLatencyMs: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCost: number;
}

/** Full benchmark output written to disk. */
export interface BenchmarkReport {
  runId: string;
  createdAt: string;
  config: {
    resolvedModeAtInvocation: ReturnType<typeof resolvePeerReviewMode>;
    taskCount: number;
    strategies: readonly ExecutionStrategyName[];
  };
  samples: BenchmarkSample[];
  aggregates: {
    byArm: Record<BenchmarkArm, ArmAggregate>;
    perStrategy: Array<{
      strategy: ExecutionStrategyName;
      a: ArmAggregate;
      b: ArmAggregate;
      qualityDelta: number;
      latencyDeltaMs: number;
      tokenDelta: number;
    }>;
  };
  /** Machine-readable recommendation. Human operators make the final call. */
  recommendation: BenchmarkRecommendation;
}

export type BenchmarkRecommendation =
  | { decision: 'keep-on'; reason: string }
  | { decision: 'flip-off'; reason: string }
  | { decision: 'per-strategy'; reason: string; strategiesToKeepOn: ExecutionStrategyName[] }
  | { decision: 'inconclusive'; reason: string };

/** Options accepted by `runPeerReviewABBenchmark`. */
export interface BenchmarkOptions {
  runId: string;
  tasks: readonly BenchmarkTask[];
  runner: ExecutionRunner;
  judge: QualityJudge;
}

/**
 * Run the benchmark end-to-end: executes every task against BOTH arms,
 * scores the results via the judge, aggregates per-arm and per-strategy,
 * and produces a `BenchmarkReport` with a machine-readable recommendation.
 *
 * The caller is responsible for persisting the report — the harness itself
 * is side-effect free except for env var scoping inside the runner.
 */
export async function runPeerReviewABBenchmark(
  options: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const { runId, tasks, runner, judge } = options;
  const samples: BenchmarkSample[] = [];

  for (const task of tasks) {
    for (const arm of ['A-peer-review-on', 'B-peer-review-off'] as const) {
      const result = await runner.run(task, arm);
      const verdict = result.success
        ? await judge.score({ task, response: result.response })
        : undefined;

      samples.push({
        taskId: task.id,
        arm,
        category: task.category,
        strategy: task.strategy,
        complexity: task.complexity,
        qualityScore: verdict?.score ?? 0,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalCost: result.totalCost,
        success: result.success && verdict !== undefined,
        error: result.error ?? (verdict ? undefined : 'judge failed to score'),
      });
    }
  }

  const report: BenchmarkReport = {
    runId,
    createdAt: new Date().toISOString(),
    config: {
      resolvedModeAtInvocation: resolvePeerReviewMode(),
      taskCount: tasks.length,
      strategies: Array.from(new Set(tasks.map((t) => t.strategy))),
    },
    samples,
    aggregates: aggregateReport(samples),
    recommendation: buildRecommendation(samples),
  };

  log.info(
    {
      runId,
      taskCount: tasks.length,
      decision: report.recommendation.decision,
    },
    'peer-review A/B benchmark completed',
  );
  return report;
}

/** Compute per-arm and per-strategy aggregates from the raw samples. */
export function aggregateReport(samples: readonly BenchmarkSample[]): BenchmarkReport['aggregates'] {
  const byArm = {
    'A-peer-review-on': aggregateArm('A-peer-review-on', samples),
    'B-peer-review-off': aggregateArm('B-peer-review-off', samples),
  };

  const strategies = Array.from(new Set(samples.map((s) => s.strategy)));
  const perStrategy = strategies.map((strategy) => {
    const subset = samples.filter((s) => s.strategy === strategy);
    const a = aggregateArm('A-peer-review-on', subset);
    const b = aggregateArm('B-peer-review-off', subset);
    return {
      strategy,
      a,
      b,
      qualityDelta: a.meanQuality - b.meanQuality,
      latencyDeltaMs: a.meanLatencyMs - b.meanLatencyMs,
      tokenDelta: a.meanInputTokens + a.meanOutputTokens - (b.meanInputTokens + b.meanOutputTokens),
    };
  });

  return { byArm, perStrategy };
}

function aggregateArm(arm: BenchmarkArm, samples: readonly BenchmarkSample[]): ArmAggregate {
  const rows = samples.filter((s) => s.arm === arm);
  const successes = rows.filter((s) => s.success);
  const n = successes.length || 1;
  const sum = successes.reduce(
    (acc, s) => ({
      q: acc.q + s.qualityScore,
      lat: acc.lat + s.latencyMs,
      inTok: acc.inTok + s.inputTokens,
      outTok: acc.outTok + s.outputTokens,
      cost: acc.cost + s.totalCost,
    }),
    { q: 0, lat: 0, inTok: 0, outTok: 0, cost: 0 },
  );
  return {
    arm,
    samples: rows.length,
    successes: successes.length,
    meanQuality: sum.q / n,
    meanLatencyMs: sum.lat / n,
    meanInputTokens: sum.inTok / n,
    meanOutputTokens: sum.outTok / n,
    meanCost: sum.cost / n,
  };
}

/**
 * Convert aggregates into a machine-readable recommendation. Rules:
 *
 * - Very small sample or low success rate → `inconclusive`.
 * - If B (off) beats A (on) on quality within 0.02 across ALL strategies and
 *   saves any tokens → `flip-off`.
 * - If A (on) beats B (off) uniformly by >=0.03 → `keep-on`.
 * - Otherwise if SOME strategies favor A and others favor B → `per-strategy`.
 * - Else `inconclusive`.
 *
 * The thresholds are intentionally conservative — the benchmark's job is to
 * narrow the decision, not replace operator judgment.
 */
export function buildRecommendation(
  samples: readonly BenchmarkSample[],
): BenchmarkRecommendation {
  if (samples.length < 4) {
    return { decision: 'inconclusive', reason: 'fewer than 4 samples collected' };
  }
  const { perStrategy } = aggregateReport(samples);
  if (perStrategy.length === 0) {
    return { decision: 'inconclusive', reason: 'no strategies yielded successful samples' };
  }

  const QUALITY_EPSILON = 0.02;
  const KEEP_ON_THRESHOLD = 0.03;

  const offDominates = perStrategy.every(
    (row) => row.b.meanQuality + QUALITY_EPSILON >= row.a.meanQuality,
  );
  const tokenSavedWhenOff = perStrategy.some((row) => row.tokenDelta > 0);
  if (offDominates && tokenSavedWhenOff) {
    return {
      decision: 'flip-off',
      reason: 'peer-review-off matches or exceeds on across all strategies and saves tokens',
    };
  }

  const onDominates = perStrategy.every(
    (row) => row.a.meanQuality >= row.b.meanQuality + KEEP_ON_THRESHOLD,
  );
  if (onDominates) {
    return {
      decision: 'keep-on',
      reason: 'peer-review-on wins by >=0.03 quality across every strategy',
    };
  }

  const strategiesToKeepOn = perStrategy
    .filter((row) => row.a.meanQuality > row.b.meanQuality + KEEP_ON_THRESHOLD)
    .map((row) => row.strategy);
  if (strategiesToKeepOn.length > 0 && strategiesToKeepOn.length < perStrategy.length) {
    return {
      decision: 'per-strategy',
      reason: 'mixed results — some strategies benefit from peer-review, others do not',
      strategiesToKeepOn,
    };
  }

  return {
    decision: 'inconclusive',
    reason: 'quality deltas fall inside the epsilon band; collect more samples or adjust tasks',
  };
}

/**
 * Factory for a runner that talks to a real orchestration engine. Takes the
 * engine's `execute` function as a plain callback so the harness does not
 * hard-depend on the OrchestrationEngine class shape (which evolves
 * independently). The caller is responsible for constructing the engine with
 * its provider registry and passing `engine.execute.bind(engine)` in.
 *
 * Every arm scopes `AILIN_PEER_REVIEW_MODE` for the duration of the call and
 * restores the previous value on exit — even on failure. This is the only
 * part of the benchmark that touches `process.env`.
 */
export interface EngineExecuteFn {
  (request: ChatRequest): Promise<{
    finalResponse: ChatResponse;
    totalCost: number;
    modelsUsed: ReadonlyArray<{
      response?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    }>;
  }>;
}

export function createEngineRunner(execute: EngineExecuteFn): ExecutionRunner {
  return {
    async run(task, arm) {
      const previous = process.env.AILIN_PEER_REVIEW_MODE;
      process.env.AILIN_PEER_REVIEW_MODE = arm === 'A-peer-review-on' ? 'on' : 'off';
      const start = Date.now();
      try {
        const result = await execute(task.request);
        const latencyMs = Date.now() - start;
        return {
          response: result.finalResponse,
          latencyMs,
          inputTokens: result.modelsUsed.reduce(
            (s, m) => s + (m.response?.usage?.prompt_tokens ?? 0),
            0,
          ),
          outputTokens: result.modelsUsed.reduce(
            (s, m) => s + (m.response?.usage?.completion_tokens ?? 0),
            0,
          ),
          totalCost: result.totalCost,
          success: true,
        };
      } catch (err) {
        return {
          latencyMs: Date.now() - start,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (previous === undefined) delete process.env.AILIN_PEER_REVIEW_MODE;
        else process.env.AILIN_PEER_REVIEW_MODE = previous;
      }
    },
  };
}

/**
 * Minimal representative task suite for the peer-review A/B. Kept here so
 * the default run shape is documented and testable; real runs should
 * extend this with production-like workloads.
 */
export const REPRESENTATIVE_TASKS: readonly BenchmarkTask[] = [
  {
    id: 'single-low-qa',
    category: 'quick-qa',
    strategy: 'single',
    complexity: 'low',
    request: {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the capital of Brazil?' }],
    } as ChatRequest,
  },
  {
    id: 'debate-high-analysis',
    category: 'analysis',
    strategy: 'debate',
    complexity: 'high',
    request: {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content:
            'Compare the trade-offs of event-sourcing vs CRUD for a financial ledger that must support retroactive corrections.',
        },
      ],
    } as ChatRequest,
  },
  {
    id: 'consensus-medium-factual',
    category: 'factual-qa',
    strategy: 'consensus',
    complexity: 'medium',
    request: {
      model: 'auto',
      messages: [
        { role: 'user', content: 'List the major differences between HTTP/2 and HTTP/3 that affect API latency.' },
      ],
    } as ChatRequest,
  },
  {
    id: 'warroom-high-decomp',
    category: 'complex-task',
    strategy: 'war-room',
    complexity: 'high',
    request: {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content:
            'Design a deployment pipeline for a multi-region Postgres with zero-downtime schema migrations.',
        },
      ],
    } as ChatRequest,
  },
  {
    id: 'blind-debate-medium',
    category: 'reasoning',
    strategy: 'blind-debate',
    complexity: 'medium',
    request: {
      model: 'auto',
      messages: [
        { role: 'user', content: 'Explain why a monotonically increasing clock is not enough to order events across nodes.' },
      ],
    } as ChatRequest,
  },
];

/**
 * Convenience wrapper that runs the benchmark against `REPRESENTATIVE_TASKS`
 * with a caller-provided engine execution callback and judge. Kept separate
 * from `runPeerReviewABBenchmark` so tests can use a deterministic runner.
 */
export async function runDefaultPeerReviewABBenchmark(
  runId: string,
  execute: EngineExecuteFn,
  judge: QualityJudge,
): Promise<BenchmarkReport> {
  const runner = createEngineRunner(execute);
  return runPeerReviewABBenchmark({
    runId,
    tasks: REPRESENTATIVE_TASKS,
    runner,
    judge,
  });
}

// Re-export so benchmark callers can build their own judges on top of the
// canonical verdict shape.
export { normalizeJudgeOutput };
