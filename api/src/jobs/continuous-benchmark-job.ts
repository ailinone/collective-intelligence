// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Continuous Benchmark Job
 *
 * Runs a daily sample of benchmark cases to detect strategy/model degradation.
 * Uses LLM-as-judge scoring and routes results through the champion/challenger
 * framework — weights are only promoted when the challenger beats the champion
 * by a configurable margin, and the entire set is rejected if any strategy
 * degrades beyond the degradation limit.
 *
 * Schedule: Daily 03:00 UTC (after strategy weights decay at 02:00 UTC on Sundays)
 * Override: CI_BENCHMARK_CRON env var
 *
 * Usage:
 *   import { startContinuousBenchmarkJob } from '@/jobs/continuous-benchmark-job'
 *   startContinuousBenchmarkJob()
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/utils/logger';
import { evaluateChallenger, promoteChallenger } from '@/core/orchestration/champion-challenger';
import { configurationArchive } from '@/core/learning/configuration-archive';
import { knowledgeGraphService } from '@/core/learning/knowledge-graph-service';
import { evaluatePareto } from '@/core/learning/pareto-champion-challenger';

const log = logger.child({ component: 'continuous-benchmark' });

const CONFIG = {
  enabled: process.env.CI_BENCHMARK_JOB_ENABLED !== 'false',
  cronSchedule: process.env.CI_BENCHMARK_CRON || '0 3 * * *',
  apiBase: process.env.BOOTSTRAP_API_BASE ?? process.env.EVAL_API_BASE_URL
    ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
    : 'http://localhost:3000/v1/chat/completions',
  bearerToken: process.env.BOOTSTRAP_BEARER_TOKEN ?? process.env.EVAL_BEARER_TOKEN ?? '',
  sampleSize: parseInt(process.env.CI_BENCHMARK_SAMPLE_SIZE || '4', 10),
  delayBetweenCallsMs: parseInt(process.env.CI_BENCHMARK_DELAY_MS || '2000', 10),
  /** Number of strategies to sample per benchmark run (from the full strategy roster). */
  strategySampleSize: parseInt(process.env.CI_BENCHMARK_STRATEGY_SAMPLE_SIZE || '8', 10),
};

interface BenchmarkCase {
  taskType: string;
  complexity: 'low' | 'medium' | 'high';
  prompt: string;
  judgeRubric: string;
  /** Strategies to test for this case -- populated dynamically per run via sampling. */
  strategies: string[];
  /** Optional: modality for multimodal scenarios (e.g., 'vision', 'stt'). */
  modality?: string;
  /** Optional: strategy config for compositor scenarios. */
  strategyConfig?: Record<string, unknown>;
}

// ── Full strategy roster (all 31 registered strategies) ─────────────────
const ALL_STRATEGIES: string[] = [
  'single', 'parallel', 'sequential', 'collaborative', 'hybrid',
  'competitive', 'expert-panel', 'massive-parallel', 'cost-cascade',
  'quality-multipass', 'adaptive', 'contextual', 'hierarchical',
  'consensus', 'reinforcement', 'debate', 'war-room', 'blind-debate',
  'devil-advocate-consensus', 'safety-quorum', 'diversity-ensemble',
  'stigmergic-refinement', 'swarm-explore', 'clarification-first',
  'research-synthesize', 'critique-repair', 'double-diamond',
  'multi-hop-qa', 'persona-exploration', 'agentic', 'compositor',
];

// ── Base benchmark cases (prompts + rubrics) ────────────────────────────
// Strategies are assigned dynamically per run via sampleStrategiesForRun().
const BASE_BENCHMARK_CASES: Omit<BenchmarkCase, 'strategies'>[] = [
  {
    taskType: 'code-generation',
    complexity: 'medium',
    prompt: 'Write a TypeScript debounce function with generics. Signature: debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T',
    judgeRubric: 'Implementation uses setTimeout+clearTimeout, correct TypeScript generics, returns wrapped function, handles edge cases.',
  },
  {
    taskType: 'code-review',
    complexity: 'high',
    prompt: 'Review this auth code for security vulnerabilities:\n```js\nconst q = `SELECT * FROM users WHERE username = \'${username}\' AND password = \'${password}\'`;\nconst token = jwt.sign({ userId: results[0].id }, \'secret123\');\n```',
    judgeRubric: 'Identifies SQL injection, hardcoded JWT secret, missing expiry. Provides concrete fixes for each vulnerability.',
  },
  {
    taskType: 'analysis',
    complexity: 'high',
    prompt: 'Compare Event Sourcing+CQRS vs Traditional CRUD for a financial system: 50k TPS, audit trail required, 90% reads. Recommend with rationale.',
    judgeRubric: 'Covers 50k TPS implications, audit trail comparison, read/write ratio impact, and makes a concrete recommendation.',
  },
  {
    taskType: 'debugging',
    complexity: 'medium',
    prompt: 'Debug this Node.js memory leak:\n```js\nconst ee = new EventEmitter();\nsetInterval(() => { ee.on("data", (d) => console.log(d)); }, 1000);\n```',
    judgeRubric: 'Identifies listener accumulation as the root cause, explains the mechanism, provides fix using removeListener or once().',
  },
];

// ── Mandatory multimodal & compositor scenarios ─────────────────────────
// At least 1 multimodal and 1 compositor scenario is included in every run.
const MULTIMODAL_CASE: Omit<BenchmarkCase, 'strategies'> = {
  taskType: 'multimodal-vision',
  complexity: 'medium',
  prompt: 'Describe in detail what you see in this image and any text or numbers visible.',
  judgeRubric: 'Produces a structured description, identifies key visual elements, extracts any text accurately.',
  modality: 'vision',
};

const COMPOSITOR_CASE: Omit<BenchmarkCase, 'strategies'> = {
  taskType: 'compositor-pipeline',
  complexity: 'high',
  prompt: 'Write a comprehensive technical guide for deploying a Node.js application with Docker, including CI/CD pipeline configuration. Cover security best practices.',
  judgeRubric: 'Covers Dockerfile creation, multi-stage builds, CI/CD config, security scanning, secrets management. Actionable and complete.',
  strategyConfig: { strategyPipeline: ['research-synthesize', 'critique-repair'] },
};

/**
 * Sample N strategies from the full roster for a single benchmark run.
 * Always includes 'single' as the baseline control.
 */
function sampleStrategiesForRun(n: number): string[] {
  const sampled = new Set<string>(['single']); // Always include baseline
  const pool = ALL_STRATEGIES.filter(s => s !== 'single');

  // Fisher-Yates partial shuffle
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const s of shuffled) {
    if (sampled.size >= n) break;
    sampled.add(s);
  }

  return [...sampled];
}

/**
 * Build the benchmark suite for a single run.
 * Samples strategies, then ensures at least 1 multimodal and 1 compositor case.
 */
function buildBenchmarkSuite(): BenchmarkCase[] {
  const strategies = sampleStrategiesForRun(CONFIG.strategySampleSize);
  log.info({ strategies, count: strategies.length }, 'Sampled strategies for benchmark run');

  const suite: BenchmarkCase[] = BASE_BENCHMARK_CASES.map(c => ({
    ...c,
    strategies,
  }));

  // Mandatory multimodal scenario -- uses 'single' strategy
  suite.push({ ...MULTIMODAL_CASE, strategies: ['single'] });

  // Mandatory compositor scenario -- uses 'compositor' strategy
  suite.push({
    ...COMPOSITOR_CASE,
    strategies: ['compositor'],
  });

  return suite;
}

interface BenchmarkResult {
  taskType: string;
  complexity: string;
  strategy: string;
  qualityScore: number;
  success: boolean;
  durationMs: number;
}

let cronJob: ScheduledTask | null = null;

export async function runContinuousBenchmarkNow(): Promise<{
  results: BenchmarkResult[];
  degradations: string[];
}> {
  if (!CONFIG.bearerToken) {
    log.warn('Continuous benchmark skipped: no bearer token configured (set BOOTSTRAP_BEARER_TOKEN or EVAL_BEARER_TOKEN)');
    return { results: [], degradations: [] };
  }

  const startedAt = Date.now();
  const fullSuite = buildBenchmarkSuite();
  const cases = fullSuite.slice(0, CONFIG.sampleSize + 2); // +2 for mandatory multimodal & compositor
  log.info({ caseCount: cases.length }, 'Starting continuous benchmark run');

  const results: BenchmarkResult[] = [];

  for (const bench of cases) {
    for (const strategy of bench.strategies) {
      const result = await runSingleBenchmark(bench, strategy);
      results.push(result);
      await sleep(CONFIG.delayBetweenCallsMs);
    }
  }

  // Route through champion/challenger evaluation before touching weights
  const challengerResults = results.map((r) => ({
    taskType: r.taskType,
    complexity: r.complexity,
    strategy: r.strategy,
    qualityScore: r.qualityScore,
    success: r.success,
    durationMs: r.durationMs,
  }));

  const evaluation = await evaluateChallenger(challengerResults);
  const degradations: string[] = [];

  if (evaluation.overallVerdict === 'promoted') {
    log.info(
      { promoted: evaluation.promoted.length },
      'Champion/Challenger approved — promoting weights'
    );
    await promoteChallenger(evaluation, challengerResults);
  } else if (evaluation.overallVerdict === 'rejected') {
    for (const r of evaluation.rejected) {
      const msg = `DEGRADATION DETECTED (champion/challenger rejected): ${r.strategy} on ${r.taskType}/${r.complexity} — ${r.reason}`;
      log.error({ ...r }, msg);
      degradations.push(msg);
    }
  } else {
    log.info('Champion/Challenger: no change — challenger did not exceed promotion threshold');
  }

  // ── OI-06/09/11: Feed downstream learning systems ──────────────────
  // After champion/challenger evaluation, route results to:
  // 1. Configuration Archive (quality-diversity) for multi-dimensional elite tracking
  // 2. Knowledge Graph for strategy→task relationship edges
  // 3. Pareto frontier for multi-objective dominance analysis
  // These calls are non-blocking — failures are logged but don't abort the run.

  try {
    // 1. OI-06: Aggregate by niche and ingest into the configuration archive
    const archiveAggregates = new Map<string, {
      taskType: string; complexity: string; strategy: string;
      totalQuality: number; totalLatency: number; successCount: number; count: number;
    }>();

    for (const r of results) {
      const key = `${r.taskType}|${r.complexity}|${r.strategy}`;
      const agg = archiveAggregates.get(key) ?? {
        taskType: r.taskType, complexity: r.complexity, strategy: r.strategy,
        totalQuality: 0, totalLatency: 0, successCount: 0, count: 0,
      };
      agg.totalQuality += r.qualityScore;
      agg.totalLatency += r.durationMs;
      agg.successCount += r.success ? 1 : 0;
      agg.count++;
      archiveAggregates.set(key, agg);
    }

    const archiveIngestion = configurationArchive.ingestBenchmarkResults(
      [...archiveAggregates.values()].map(a => ({
        taskType: a.taskType,
        complexity: a.complexity,
        strategy: a.strategy,
        avgQuality: a.totalQuality / a.count,
        avgCost: 0, // Continuous benchmark doesn't track cost — populated by production path
        avgLatency: a.totalLatency / a.count,
        successRate: a.successCount / a.count,
        sampleCount: a.count,
      })),
    );
    log.info(archiveIngestion, 'Benchmark results ingested into archive (OI-06)');

    // 2. OI-11: Record strategy→task edges in knowledge graph
    knowledgeGraphService.recordBenchmarkResults(
      results.filter(r => r.success).map(r => ({
        taskType: r.taskType,
        strategy: r.strategy,
        qualityScore: r.qualityScore,
        complexity: r.complexity,
      })),
    ).catch(err => log.warn({ error: String(err) }, 'KG benchmark recording failed (OI-11)'));

    // 3. OI-09: Pareto frontier evaluation across all niches
    const paretoResult = evaluatePareto(results);
    log.info({
      niches: paretoResult.totalNiches,
      newEntries: paretoResult.newFrontierEntries,
      dropped: paretoResult.droppedFromFrontier,
    }, 'Pareto evaluation completed (OI-09)');

    // 4. OI-11: Record archive elites into KG for unified querying
    if (archiveIngestion.cellsUpdated > 0) {
      const snapshot = configurationArchive.getSnapshot();
      knowledgeGraphService.recordArchiveElites(
        snapshot.topElites.map(e => ({
          taskType: e.taskType,
          complexity: e.complexity,
          dimension: e.dimension,
          strategy: e.strategy,
          fitness: e.fitness,
          avgQuality: e.avgQuality,
        })),
      ).catch(err => log.warn({ error: String(err) }, 'KG archive elite recording failed (OI-11)'));
    }
  } catch (err) {
    log.warn({ error: String(err) }, 'Downstream learning system feed failed (non-fatal)');
  }

  const durationMs = Date.now() - startedAt;
  log.info(
    { durationMs, resultsCount: results.length, degradations: degradations.length },
    'Continuous benchmark completed'
  );

  return { results, degradations };
}

async function runSingleBenchmark(bench: BenchmarkCase, strategy: string): Promise<BenchmarkResult> {
  const start = Date.now();
  try {
    const requestBody: Record<string, unknown> = {
      model: 'auto',
      strategy,
      messages: [{ role: 'user', content: bench.prompt }],
    };

    // Strategy-specific: pass compositor pipeline/workflow config
    if (bench.strategyConfig?.strategyPipeline) {
      requestBody.strategyPipeline = bench.strategyConfig.strategyPipeline;
    }
    if (bench.strategyConfig?.strategyWorkflow) {
      requestBody.strategyWorkflow = bench.strategyConfig.strategyWorkflow;
    }

    // Multimodal: tag the modality
    if (bench.modality) {
      requestBody.modality = bench.modality;
    }

    const resp = await fetch(CONFIG.apiBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const durationMs = Date.now() - start;
    const json = await resp.json() as {
      error?: { message: string };
      choices?: Array<{ message?: { content?: string } }>;
    };

    if (json.error || !resp.ok) {
      return { taskType: bench.taskType, complexity: bench.complexity, strategy, qualityScore: 0, success: false, durationMs };
    }

    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content) {
      return { taskType: bench.taskType, complexity: bench.complexity, strategy, qualityScore: 0, success: false, durationMs };
    }

    const qualityScore = await judgeResponse(content, bench.judgeRubric);
    log.info({ strategy, taskType: bench.taskType, qualityScore: qualityScore.toFixed(3), durationMs }, 'Benchmark case scored');

    return { taskType: bench.taskType, complexity: bench.complexity, strategy, qualityScore, success: true, durationMs };
  } catch (err) {
    return { taskType: bench.taskType, complexity: bench.complexity, strategy, qualityScore: 0, success: false, durationMs: Date.now() - start };
  }
}

async function judgeResponse(content: string, rubric: string): Promise<number> {
  try {
    const resp = await fetch(CONFIG.apiBase, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.bearerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        strategy: 'single',
        messages: [{
          role: 'user',
          content: `RUBRIC:\n${rubric}\n\nRESPONSE:\n${content}\n\nRespond ONLY with JSON: {"score": 0.0-1.0}`,
        }],
      }),
    });
    const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const judgeContent = json.choices?.[0]?.message?.content ?? '';
    const match = judgeContent.match(/\{[\s\S]*\}/);
    if (!match) return 0;
    const parsed = JSON.parse(match[0]) as { score?: number };
    return Number(parsed.score ?? 0);
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function startContinuousBenchmarkJob(): void {
  if (!CONFIG.enabled) {
    log.info('Continuous benchmark job disabled');
    return;
  }

  if (cronJob) {
    log.warn('Continuous benchmark job already running');
    return;
  }

  cronJob = cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      try {
        await runContinuousBenchmarkNow();
      } catch (err) {
        log.error({ error: String(err) }, 'Continuous benchmark job failed');
      }
    },
    { timezone: 'UTC' }
  );

  log.info({ schedule: CONFIG.cronSchedule }, 'Continuous benchmark job scheduled');
}

export function stopContinuousBenchmarkJob(): void {
  if (!cronJob) return;
  cronJob.stop();
  cronJob = null;
  log.info('Continuous benchmark job stopped');
}
