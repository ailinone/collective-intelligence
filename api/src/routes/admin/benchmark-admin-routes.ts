// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark Admin Routes
 *
 * Admin-only endpoints for the CI Benchmark Harness (OI-01),
 * Reward Integrity monitoring (OI-02), Success-Story bandit state (OI-03),
 * Configuration Archive (OI-06), Triage Calibrator (OI-07),
 * Adaptive Quality Targets (OI-08), Pareto Champion/Challenger (OI-09),
 * Intelligent Feedback (OI-10), and Knowledge Graph Unification (OI-11).
 *
 * Endpoints:
 * - GET  /v1/admin/benchmark/status               — Current benchmark config & last run summary
 * - POST /v1/admin/benchmark/run                  — Trigger an ad-hoc benchmark run
 * - GET  /v1/admin/benchmark/runs                 — List recent runs (from DB or in-memory)
 * - GET  /v1/admin/benchmark/runs/:runId          — Detail of a specific run
 * - GET  /v1/admin/benchmark/reward-integrity      — Latest reward integrity results
 * - GET  /v1/admin/benchmark/gaming-signals        — Recent gaming signal detections
 * - GET  /v1/admin/benchmark/bandit                — Thompson Sampling bandit state
 * - GET  /v1/admin/benchmark/bandit/snapshots      — Success-Story snapshot history
 * - POST /v1/admin/benchmark/bandit/snapshot       — Force a manual snapshot
 * - GET  /v1/admin/benchmark/suite-stats           — Benchmark suite coverage statistics
 * - GET  /v1/admin/benchmark/archive               — Quality-diversity archive state (OI-06)
 * - GET  /v1/admin/benchmark/archive/recommend     — Archive strategy recommendation (OI-06)
 * - GET  /v1/admin/benchmark/triage                — Triage Calibrator state (OI-07)
 * - POST /v1/admin/benchmark/triage/calibrate      — Force triage calibration (OI-07)
 * - POST /v1/admin/benchmark/triage/reset-rules    — Emergency rule reset (OI-07)
 * - GET  /v1/admin/benchmark/quality-targets        — Adaptive quality target profiles (OI-08)
 * - POST /v1/admin/benchmark/quality-targets/refresh — Force profile refresh (OI-08)
 * - GET  /v1/admin/benchmark/pareto                 — Pareto frontier snapshot (OI-09)
 * - GET  /v1/admin/benchmark/pareto/history         — Pareto evaluation history (OI-09)
 * - GET  /v1/admin/benchmark/knowledge-graph        — Knowledge graph stats (OI-11)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import {
  BenchmarkEvaluator,
  loadBenchmarkConfig,
} from '@/core/benchmark/benchmark-evaluator';
import {
  getBalancedSample,
  getSuiteStats,
  BENCHMARK_SUITE,
  getTasksByCategory,
} from '@/core/benchmark/benchmark-suite';
import { strategyBandit } from '@/core/learning/strategy-bandit';
import type { BenchmarkRun, BenchmarkCategory } from '@/core/benchmark/types';
import {
  recordBenchmarkRun,
  recordBenchmarkTask,
  recordBanditSuccessStoryState,
  recordArchiveState,
  recordTriageCalibration,
  recordAdaptiveQualityTarget,
  recordParetoEvaluation,
  recordKnowledgeGraphState,
} from '@/observability/ci-metrics';
import { configurationArchive } from '@/core/learning/configuration-archive';
import { triageCalibrator } from '@/core/learning/triage-calibrator';
import {
  getAdaptiveQualityTarget,
  refreshAllProfiles,
  getCachedProfiles,
} from '@/core/quality/adaptive-quality-targets';
import {
  evaluatePareto,
  getParetoSnapshot,
  getParetoHistory,
} from '@/core/learning/pareto-champion-challenger';
import { knowledgeGraphService } from '@/core/learning/knowledge-graph-service';

const log = logger.child({ component: 'benchmark-admin' });

// ─── In-Memory Run Store (capped ring buffer) ────────────────────────────────
// Benchmark runs are expensive to persist per-result in DB, so we keep the last
// N runs in memory. The continuous-benchmark-job persists aggregate scores to
// strategy_weights via champion/challenger.

const MAX_STORED_RUNS = 20;
const runStore: BenchmarkRun[] = [];

/**
 * Store a benchmark run in the in-memory ring buffer.
 * Exported so continuous-benchmark-job can also push runs here.
 */
export function storeBenchmarkRun(run: BenchmarkRun): void {
  runStore.push(run);
  if (runStore.length > MAX_STORED_RUNS) {
    runStore.shift();
  }
}

/**
 * Register benchmark admin routes.
 */
export async function registerBenchmarkAdminRoutes(server: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/status
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/status',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get benchmark harness configuration and latest run summary',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              config: { type: 'object' },
              latestRun: {
                type: 'object',
                nullable: true,
                properties: {
                  runId: { type: 'string' },
                  overallScore: { type: 'number' },
                  totalCostUsd: { type: 'number' },
                  durationMs: { type: 'number' },
                  resultsCount: { type: 'number' },
                  startedAt: { type: 'string' },
                  completedAt: { type: 'string' },
                  verdict: { type: 'string', nullable: true },
                  driftDetected: { type: 'boolean', nullable: true },
                },
              },
              storedRunsCount: { type: 'number' },
              suiteStats: { type: 'object' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = loadBenchmarkConfig();
      const latestRun = runStore.length > 0 ? runStore[runStore.length - 1] : null;

      return reply.send({
        config: {
          enabled: config.enabled,
          cronSchedule: config.cronSchedule,
          maxTasksPerRun: config.maxTasksPerRun,
          maxBudgetPerRun: config.maxBudgetPerRun,
          enableRewardIntegrity: config.enableRewardIntegrity,
          rewardIntegritySampleRate: config.rewardIntegritySampleRate,
          driftCorrelationThreshold: config.driftCorrelationThreshold,
        },
        latestRun: latestRun
          ? {
              runId: latestRun.runId,
              overallScore: latestRun.overallScore,
              totalCostUsd: latestRun.totalCostUsd,
              durationMs: latestRun.durationMs,
              resultsCount: latestRun.results.length,
              startedAt: latestRun.startedAt,
              completedAt: latestRun.completedAt,
              verdict: latestRun.trend?.verdict ?? null,
              driftDetected: latestRun.rewardIntegrity?.driftDetected ?? null,
            }
          : null,
        storedRunsCount: runStore.length,
        suiteStats: getSuiteStats(),
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/benchmark/run
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/benchmark/run',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Trigger an ad-hoc benchmark run (async — returns immediately with runId)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            taskCount: { type: 'number', minimum: 1, maximum: 65, default: 10 },
            category: { type: 'string', nullable: true },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              taskCount: { type: 'number' },
              estimatedDurationMinutes: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        taskCount?: number;
        category?: string;
      } | undefined;

      const taskCount = body?.taskCount ?? 10;
      const category = body?.category as BenchmarkCategory | undefined;

      let tasks;
      if (category) {
        tasks = getTasksByCategory(category).slice(0, taskCount);
      } else {
        tasks = getBalancedSample(taskCount);
      }

      if (tasks.length === 0) {
        return reply.status(400).send({ error: 'No tasks match the given criteria' });
      }

      const previousRun = runStore.length > 0 ? runStore[runStore.length - 1] : undefined;

      log.info({ taskCount: tasks.length, category }, 'Ad-hoc benchmark run triggered by admin');

      // Run async — don't block the response
      const evaluator = new BenchmarkEvaluator();
      setImmediate(async () => {
        try {
          const run = await evaluator.executeRun(tasks, previousRun);
          storeBenchmarkRun(run);

          // Emit Prometheus metrics
          recordBenchmarkRun({
            verdict: run.trend?.verdict ?? 'stable',
            overallScore: run.overallScore,
            durationMs: run.durationMs,
            totalCostUsd: run.totalCostUsd,
            categoryScores: run.categoryScores.map(cs => ({
              category: cs.category,
              averageScore: cs.avgQuality,
            })),
            rewardCorrelation: run.rewardIntegrity?.correlation,
            driftDetected: run.rewardIntegrity?.driftDetected,
            gamingSignals: run.rewardIntegrity?.gamingSignals?.map(gs => ({
              type: gs.type,
              severity: gs.severity,
            })),
          });

          // Emit per-task metrics
          for (const result of run.results) {
            const prefix = result.taskId.split('-')[0];
            const catMap: Record<string, string> = {
              'cg': 'coding-generate', 'ce': 'coding-edit', 'cd': 'coding-debug',
              'cr': 'coding-review', 'at': 'analysis-technical', 'ad': 'analysis-data',
              'ax': 'analysis-text', 'fq': 'factual-qa', 'cv': 'creative',
              'ms': 'multi-step', 'rs': 'reasoning',
            };
            recordBenchmarkTask({
              category: catMap[prefix] ?? 'unknown',
              difficulty: 'medium', // Tasks know their difficulty but results don't carry it
              strategy: result.strategy,
              qualityScore: result.heuristicScore,
              durationMs: result.durationMs,
              costUsd: result.costUsd,
            });
          }

          // ── OI-06/09/11: Feed downstream learning systems ───────────
          // Map BenchmarkExecutionResult → formats expected by archive, KG, Pareto
          try {
            const taskCategoryMap: Record<string, string> = {
              'cg': 'code-generation', 'ce': 'code-editing', 'cd': 'code-debugging',
              'cr': 'code-review', 'at': 'analysis', 'ad': 'analysis',
              'ax': 'analysis', 'fq': 'factual-qa', 'cv': 'creative',
              'ms': 'multi-step', 'rs': 'reasoning',
            };

            // Map to common result shape for downstream consumers
            const mappedResults = run.results.map(r => {
              const prefix = r.taskId.split('-')[0];
              return {
                taskType: taskCategoryMap[prefix] ?? 'general',
                complexity: 'medium' as const, // BenchmarkExecutionResult lacks difficulty; default medium
                strategy: r.strategy,
                qualityScore: r.heuristicScore,
                success: r.success,
                durationMs: r.durationMs,
                costUsd: r.costUsd,
              };
            });

            // 1. OI-06: Aggregate and ingest into the quality-diversity archive
            const archiveAggregates = new Map<string, {
              taskType: string; complexity: string; strategy: string;
              totalQuality: number; totalCost: number; totalLatency: number;
              successCount: number; count: number;
            }>();

            for (const r of mappedResults) {
              const key = `${r.taskType}|${r.complexity}|${r.strategy}`;
              const agg = archiveAggregates.get(key) ?? {
                taskType: r.taskType, complexity: r.complexity, strategy: r.strategy,
                totalQuality: 0, totalCost: 0, totalLatency: 0, successCount: 0, count: 0,
              };
              agg.totalQuality += r.qualityScore;
              agg.totalCost += r.costUsd;
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
                avgCost: a.totalCost / a.count,
                avgLatency: a.totalLatency / a.count,
                successRate: a.successCount / a.count,
                sampleCount: a.count,
              })),
            );
            log.info(archiveIngestion, 'Ad-hoc run: archive ingestion (OI-06)');

            // 2. OI-11: Record in knowledge graph
            knowledgeGraphService.recordBenchmarkResults(
              mappedResults.filter(r => r.success).map(r => ({
                taskType: r.taskType,
                strategy: r.strategy,
                qualityScore: r.qualityScore,
                complexity: r.complexity,
              })),
            ).catch(err => log.warn({ error: String(err) }, 'Ad-hoc run: KG recording failed (OI-11)'));

            // 3. OI-09: Pareto frontier evaluation
            const paretoResult = evaluatePareto(mappedResults);
            log.info({
              niches: paretoResult.totalNiches,
              newEntries: paretoResult.newFrontierEntries,
            }, 'Ad-hoc run: Pareto evaluation (OI-09)');

            // 4. OI-11: Record archive elites in KG
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
              ).catch(err => log.warn({ error: String(err) }, 'Ad-hoc run: KG archive recording failed'));
            }
          } catch (downstreamErr) {
            log.warn({ error: String(downstreamErr) }, 'Ad-hoc run: downstream learning feed failed (non-fatal)');
          }

          log.info({
            runId: run.runId,
            overallScore: run.overallScore.toFixed(3),
            totalCost: run.totalCostUsd.toFixed(4),
          }, 'Ad-hoc benchmark run completed');
        } catch (err) {
          log.error({ error: String(err) }, 'Ad-hoc benchmark run failed');
        }
      });

      return reply.status(202).send({
        message: 'Benchmark run started',
        taskCount: tasks.length,
        estimatedDurationMinutes: Math.ceil(tasks.length * 2 * 3 / 60), // ~3 strategies × 2s delay
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/runs
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/runs',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'List recent benchmark runs (most recent first)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { limit?: number };
      const limit = query.limit ?? 10;

      const runs = runStore
        .slice(-limit)
        .reverse()
        .map(run => ({
          runId: run.runId,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: run.durationMs,
          overallScore: run.overallScore,
          totalCostUsd: run.totalCostUsd,
          resultsCount: run.results.length,
          verdict: run.trend?.verdict ?? null,
          driftDetected: run.rewardIntegrity?.driftDetected ?? null,
          categoryScores: run.categoryScores,
          strategyScores: run.strategyScores,
        }));

      return reply.send({ runs, total: runStore.length });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/runs/:runId
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/runs/:runId',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get detailed results of a specific benchmark run',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
          },
          required: ['runId'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { runId } = request.params as { runId: string };
      const run = runStore.find(r => r.runId === runId);

      if (!run) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      return reply.send({
        ...run,
        // Truncate response content to keep payload reasonable
        results: run.results.map(r => ({
          ...r,
          responseContent: r.responseContent.slice(0, 500) + (r.responseContent.length > 500 ? '...' : ''),
        })),
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/reward-integrity
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/reward-integrity',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get reward integrity results from recent runs (OI-02)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const results = runStore
        .filter(r => r.rewardIntegrity)
        .map(r => ({
          runId: r.runId,
          timestamp: r.completedAt,
          ...r.rewardIntegrity,
        }))
        .reverse();

      const latest = results[0] ?? null;
      const driftHistory = results.map(r => ({
        runId: r.runId,
        timestamp: r.timestamp,
        correlation: r.correlation,
        driftDetected: r.driftDetected,
        gamingSignalCount: r.gamingSignals?.length ?? 0,
      }));

      return reply.send({
        latest,
        history: driftHistory,
        config: {
          driftCorrelationThreshold: loadBenchmarkConfig().driftCorrelationThreshold,
          rewardIntegritySampleRate: loadBenchmarkConfig().rewardIntegritySampleRate,
        },
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/gaming-signals
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/gaming-signals',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get all gaming signals detected across recent runs',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const allSignals = runStore
        .filter(r => r.rewardIntegrity?.gamingSignals?.length)
        .flatMap(r =>
          (r.rewardIntegrity?.gamingSignals ?? []).map(gs => ({
            runId: r.runId,
            runTimestamp: r.completedAt,
            ...gs,
          }))
        )
        .reverse();

      const bySeverity = {
        high: allSignals.filter(s => s.severity === 'high').length,
        medium: allSignals.filter(s => s.severity === 'medium').length,
        low: allSignals.filter(s => s.severity === 'low').length,
      };

      const byType = allSignals.reduce((acc, s) => {
        acc[s.type] = (acc[s.type] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return reply.send({
        signals: allSignals.slice(0, 100),
        totalCount: allSignals.length,
        bySeverity,
        byType,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/bandit
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/bandit',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get Thompson Sampling bandit state and Success-Story status (OI-03)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            taskType: { type: 'string', nullable: true },
            complexity: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { taskType?: string; complexity?: string };

      const successStoryState = strategyBandit.getSuccessStoryState();

      // Update Prometheus gauges for bandit state
      recordBanditSuccessStoryState({
        rewardRate: successStoryState.currentRewardRate,
        snapshotCount: successStoryState.snapshotCount,
      });

      // If taskType/complexity specified, show win rates for those
      let winRates: Record<string, number> | null = null;
      if (query.taskType && query.complexity) {
        const strategies = [
          'single', 'quality-multipass', 'debate', 'collaborative',
          'consensus', 'parallel-vote', 'hierarchical', 'speculative',
          'iterative-deepening', 'mixture-of-experts', 'red-team',
          'chain-of-thought', 'meta-reasoning', 'ensembled',
          'divide-conquer', 'adaptive-routing', 'tournament',
        ];
        winRates = strategyBandit.getWinRates(query.taskType, query.complexity, strategies);
      }

      return reply.send({
        successStory: {
          currentRewardRate: successStoryState.currentRewardRate,
          bestRewardRate: successStoryState.bestRewardRate,
          snapshotCount: successStoryState.snapshotCount,
          recentExecutionCount: successStoryState.recentExecutionCount,
          lastRollbackAt: successStoryState.lastRollbackAt > 0
            ? new Date(successStoryState.lastRollbackAt).toISOString()
            : null,
        },
        winRates,
        queryFilters: {
          taskType: query.taskType ?? null,
          complexity: query.complexity ?? null,
        },
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/bandit/snapshots
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/bandit/snapshots',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'List Success-Story snapshots for auto-rollback inspection',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const state = strategyBandit.getSuccessStoryState();

      return reply.send({
        currentRewardRate: state.currentRewardRate,
        snapshotCount: state.snapshotCount,
        bestRewardRate: state.bestRewardRate,
        lastRollbackAt: state.lastRollbackAt > 0
          ? new Date(state.lastRollbackAt).toISOString()
          : null,
        // Note: individual snapshot params not exposed via public API to avoid
        // leaking internal strategy weights. Only aggregate metrics shown.
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/benchmark/bandit/snapshot
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/benchmark/bandit/snapshot',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Force a manual Success-Story snapshot',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              snapshotId: { type: 'string', nullable: true },
              rewardRate: { type: 'number', nullable: true },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const snapshot = strategyBandit.takeSnapshot();

      if (!snapshot) {
        return reply.send({
          snapshotId: null,
          rewardRate: null,
          message: 'Cannot take snapshot — not enough recent execution data (need >= 10)',
        });
      }

      log.info({ snapshotId: snapshot.snapshotId }, 'Manual snapshot taken by admin');

      return reply.send({
        snapshotId: snapshot.snapshotId,
        rewardRate: snapshot.rewardRate,
        message: 'Snapshot taken successfully',
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/suite-stats
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/suite-stats',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get benchmark suite coverage statistics',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const stats = getSuiteStats();

      // Build per-category breakdown
      const categories = [
        'coding-generate', 'coding-edit', 'coding-debug', 'coding-review',
        'analysis-data', 'analysis-technical', 'analysis-text',
        'factual-qa', 'creative', 'multi-step', 'reasoning', 'tool-use',
      ] as BenchmarkCategory[];

      const categoryBreakdown = categories.map(cat => {
        const tasks = getTasksByCategory(cat);
        return {
          category: cat,
          taskCount: tasks.length,
          difficulties: {
            easy: tasks.filter(t => t.difficulty === 'easy').length,
            medium: tasks.filter(t => t.difficulty === 'medium').length,
            hard: tasks.filter(t => t.difficulty === 'hard').length,
          },
          evaluationMethods: [...new Set(tasks.map(t => t.evaluationMethod))],
        };
      }).filter(c => c.taskCount > 0);

      return reply.send({
        ...stats,
        categoryBreakdown,
        totalTasks: BENCHMARK_SUITE.length,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/archive — Configuration Archive state (OI-06)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/archive',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get quality-diversity configuration archive state (OI-06)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            taskType: { type: 'string', nullable: true },
            complexity: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { taskType?: string; complexity?: string };

      // Update Prometheus gauges
      const stats = configurationArchive.getStats();
      recordArchiveState({
        cellCount: stats.cellCount,
        avgFitness: stats.avgFitness,
      });

      // If taskType/complexity specified, return alternatives for that niche
      if (query.taskType && query.complexity) {
        const alternatives = configurationArchive.getAlternatives(
          query.taskType,
          query.complexity,
        );
        return reply.send({
          query: { taskType: query.taskType, complexity: query.complexity },
          alternatives: alternatives.map(a => ({
            dimension: a.dimension,
            strategy: a.elite.strategy,
            fitness: a.elite.fitness,
            avgQuality: a.elite.avgQuality,
            avgCost: a.elite.avgCost,
            avgLatency: a.elite.avgLatency,
            successRate: a.elite.successRate,
            sampleCount: a.elite.sampleCount,
            source: a.elite.promotionSource,
            lastUpdated: new Date(a.elite.lastUpdated).toISOString(),
          })),
          stats,
        });
      }

      // Otherwise return full snapshot
      const snapshot = configurationArchive.getSnapshot();
      return reply.send({
        ...snapshot,
        stats,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/archive/recommend — Get archive recommendation
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/archive/recommend',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get strategy recommendation from archive for a specific niche',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          required: ['taskType', 'complexity', 'preference'],
          properties: {
            taskType: { type: 'string' },
            complexity: { type: 'string' },
            preference: {
              type: 'string',
              enum: ['speed', 'cost', 'quality', 'balanced', 'adaptive'],
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        taskType: string;
        complexity: string;
        preference: string;
      };

      const recommendation = configurationArchive.getRecommendation(
        query.taskType,
        query.complexity,
        query.preference,
      );

      if (!recommendation) {
        return reply.send({
          recommendation: null,
          message: 'No elite found for this niche. Run benchmark or wait for production data.',
        });
      }

      return reply.send({
        recommendation,
        query,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/triage — Triage Calibrator state (OI-07)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/triage',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get triage calibrator state, rules, and calibration history (OI-07)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const state = triageCalibrator.getState();

      // Update Prometheus
      if (state.latestCalibration) {
        recordTriageCalibration({
          overall: state.latestCalibration.overall,
          complexityAccuracy: state.latestCalibration.complexityAccuracy,
          underestimationRate: state.latestCalibration.underestimationRate,
          activeRuleCount: state.activeRules.length,
        });
      }

      return reply.send(state);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/benchmark/triage/calibrate — Force calibration
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/benchmark/triage/calibrate',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Force a triage calibration pass',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const calibration = triageCalibrator.forceCalibration();

      // Update Prometheus
      recordTriageCalibration({
        overall: calibration.overall,
        complexityAccuracy: calibration.complexityAccuracy,
        underestimationRate: calibration.underestimationRate,
        activeRuleCount: triageCalibrator.getState().activeRules.length,
      });

      log.info({
        overall: calibration.overall.toFixed(3),
        complexityAccuracy: calibration.complexityAccuracy.toFixed(3),
      }, 'Manual triage calibration triggered by admin');

      return reply.send(calibration);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/benchmark/triage/reset-rules — Emergency rule reset
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/benchmark/triage/reset-rules',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Reset all triage correction rules (emergency valve)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      triageCalibrator.resetRules();
      log.info('Admin triggered triage rules reset');

      return reply.send({
        message: 'All triage correction rules have been reset',
        activeRulesAfterReset: 0,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/quality-targets — Adaptive quality target profiles (OI-08)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/quality-targets',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get all cached adaptive quality target profiles with recommendations (OI-08)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const profiles = getCachedProfiles();
      const { task_type, complexity } = (request.query || {}) as {
        task_type?: string;
        complexity?: string;
      };

      // If specific niche requested, compute live target
      let liveTarget = null;
      if (task_type && complexity) {
        liveTarget = await getAdaptiveQualityTarget(task_type, complexity);

        // Emit metric
        recordAdaptiveQualityTarget({
          taskType: task_type,
          complexity,
          target: liveTarget.target,
          confidence: liveTarget.confidence,
          source: liveTarget.source,
          profileCount: profiles.length,
        });
      }

      return reply.send({
        cachedProfileCount: profiles.length,
        profiles,
        liveTarget,
        config: {
          minTarget: 0.65,
          maxTarget: 0.96,
          defaultTarget: 0.85,
          minSamplesForLearned: 15,
          headroomFactor: 0.08,
        },
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/benchmark/quality-targets/refresh — Force profile refresh (OI-08)
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/benchmark/quality-targets/refresh',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Force refresh of all adaptive quality target profiles from DB (OI-08)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const refreshed = await refreshAllProfiles();
      log.info({ refreshed }, 'Admin triggered adaptive quality target profile refresh (OI-08)');

      return reply.send({
        message: `Refreshed ${refreshed} quality target profiles`,
        refreshedCount: refreshed,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/pareto — Pareto frontier snapshot (OI-09)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/pareto',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get current Pareto frontier snapshot across all niches (OI-09)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const snapshot = getParetoSnapshot();

      // Emit metrics
      recordParetoEvaluation({
        frontiers: snapshot.frontiers.map(f => ({
          taskType: f.taskType,
          complexity: f.complexity,
          frontierSize: f.frontierSize,
        })),
        newEntries: 0,
        dropped: 0,
        totalDominated: snapshot.totalDominated,
      });

      return reply.send(snapshot);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/pareto/history — Pareto evaluation history (OI-09)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/pareto/history',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get Pareto evaluation history for trend analysis (OI-09)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const history = getParetoHistory();

      return reply.send({
        evaluationCount: history.length,
        history: history.map(h => ({
          timestamp: h.timestamp,
          totalNiches: h.totalNiches,
          avgFrontierSize: h.avgFrontierSize,
          newFrontierEntries: h.newFrontierEntries,
          droppedFromFrontier: h.droppedFromFrontier,
        })),
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/benchmark/knowledge-graph — Knowledge graph stats (OI-11)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/benchmark/knowledge-graph',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Benchmark'],
        description: 'Get knowledge graph statistics including benchmark and archive data (OI-11)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await knowledgeGraphService.getGraphStats();
      const { task_type } = (request.query || {}) as { task_type?: string };

      // Emit metrics
      recordKnowledgeGraphState({
        edgesByType: stats.edgesByType,
        uniqueNodes: stats.uniqueNodes,
      });

      // If task_type requested, also get best strategies for that task
      let bestStrategies = null;
      if (task_type) {
        bestStrategies = await knowledgeGraphService.getBestStrategiesForTask(task_type);
      }

      return reply.send({
        ...stats,
        bestStrategies,
        edgeTypeDescriptions: {
          model_task: 'Model performance on task types (production)',
          model_model: 'Model complementarity (co-execution quality)',
          strategy_model: 'Strategy-model affinity',
          strategy_task: 'Strategy effectiveness per task (benchmark + archive)',
          benchmark_task: 'Benchmark coverage per task',
          archive_strategy: 'Archive elite designations',
        },
      });
    }
  );

  log.info(
    '✅ Benchmark admin routes registered (/v1/admin/benchmark/* — OI-01 through OI-11)',
  );
}
