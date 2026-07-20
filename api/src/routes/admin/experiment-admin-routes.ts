// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Admin Routes
 *
 * Admin-only endpoints for the Comparative Experiment Framework.
 * Manages creation, execution, monitoring, and analysis of experiments
 * comparing Mode A (single model), Mode B (collective intelligence),
 * and Mode C (adaptive system).
 *
 * Endpoints:
 * - POST /v1/admin/experiment/create        — Create a new experiment
 * - POST /v1/admin/experiment/run            — Start or resume experiment (async, 202)
 * - GET  /v1/admin/experiment/status         — Current active experiment status
 * - POST /v1/admin/experiment/pause          — Pause active experiment
 * - GET  /v1/admin/experiment/results        — Raw execution results
 * - GET  /v1/admin/experiment/analysis       — Statistical analysis
 * - GET  /v1/admin/experiment/report         — Full comparative report
 * - GET  /v1/admin/experiment/go-no-go       — GO/NO-GO decision report
 * - GET  /v1/admin/experiment/segmented-benchmark — Confirmatory vs exploratory wins
 * - GET  /v1/admin/experiment/strategy-matrix    — Per-strategy W/T/L vs best single, per scenario (FDR-corrected)
 * - GET  /v1/admin/experiment/history        — List past experiments
 * - GET  /v1/admin/experiment/suite          — Task suite info
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import {
  createExperiment,
  startExperiment,
  pauseExperiment,
  getExperimentStatus,
  getExperimentResults,
} from '@/core/experiment/experiment-runner';
import { generateReport } from '@/core/experiment/experiment-report';
import { getSuiteCoverage, EXPERIMENT_SUITE } from '@/core/experiment/experiment-suite';
import {
  computeDescriptiveStats,
  computeConfidenceInterval,
  welchTTest,
  effectSize,
} from '@/core/experiment/statistical-analysis';
import type { ExperimentConfig, ExecutionMode } from '@/core/experiment/experiment-types';
import {
  C3_CONFIG_BUILDERS,
  getAllC3Configs,
} from '@/core/experiment/c3-experiment-configs';

const log = logger.child({ component: 'experiment-admin' });

export async function registerExperimentAdminRoutes(server: FastifyInstance): Promise<void> {
  // ─── Create Experiment ───────────────────────────────────────────────
  server.post(
    '/v1/admin/experiment/create',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<ExperimentConfig>;

      // Validate required fields
      if (!body.name) {
        return reply.status(400).send({ error: 'name is required' });
      }
      if (!body.modes || body.modes.length === 0) {
        return reply.status(400).send({ error: 'At least one mode is required' });
      }

      const config: ExperimentConfig = {
        name: body.name,
        description: body.description ?? '',
        taskIndices: body.taskIndices ?? [],
        modes: body.modes,
        repetitions: body.repetitions ?? 3,
        maxBudgetUsd: body.maxBudgetUsd ?? 50,
        delayBetweenCallsMs: body.delayBetweenCallsMs ?? 2000,
        maxConcurrency: body.maxConcurrency ?? 1,
        warmupExecutions: body.warmupExecutions ?? 0,
        freezeLearningDuringEval: body.freezeLearningDuringEval ?? true,
      };

      try {
        const experimentId = await createExperiment(config);
        return reply.status(201).send({ experimentId, config });
      } catch (err) {
        log.error({ error: String(err) }, 'Failed to create experiment');
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // ─── Start / Resume Experiment ───────────────────────────────────────
  server.post(
    '/v1/admin/experiment/run',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.body as { experimentId: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId is required' });
      }

      try {
        const result = await startExperiment(experimentId);

        if (!result.started) {
          // Canary gate failed — return 422 so caller knows experiment did NOT actually start
          return reply.status(422).send({
            error: 'Experiment canary gate failed — experiment aborted',
            experimentId,
            canaryPassed: false,
            canaryDiagnostics: result.canaryDiagnostics,
            note: 'The experiment was created but the canary gate detected infrastructure issues. Check provider availability and try again.',
          });
        }

        return reply.status(202).send({
          message: 'Experiment started',
          experimentId,
          canaryPassed: result.canaryPassed,
          note: 'Experiment runs asynchronously. Use GET /v1/admin/experiment/status to monitor progress.',
        });
      } catch (err) {
        return reply.status(400).send({ error: String(err) });
      }
    },
  );

  // ─── Status ──────────────────────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/status',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const status = getExperimentStatus();
      if (status.experimentId) return reply.send(status);

      // No in-memory handle. The in-memory state is cleared BOTH on completion
      // AND on API restart, so returning a bare null state conflates "finished"
      // with "the process restarted while the run is still active in the DB" —
      // a driver polling for `state === null` as a terminal signal would then
      // declare a mid-run restart "ended" and report on a partial run (review
      // F13). Fall back to the DB, which is authoritative, so the caller sees
      // the real state (running/paused/completed/failed).
      const q = req.query as { experimentId?: string };
      const dbExp = q.experimentId
        ? await prisma.experiment.findUnique({ where: { id: q.experimentId } })
        : await prisma.experiment.findFirst({ orderBy: { updatedAt: 'desc' } });
      if (!dbExp) return reply.send(status); // genuinely nothing to report
      return reply.send({
        experimentId: dbExp.id,
        state: dbExp.state,
        progress: dbExp.progress,
        source: 'db-fallback', // not the live in-memory handle
      });
    },
  );

  // ─── Pause ───────────────────────────────────────────────────────────
  server.post(
    '/v1/admin/experiment/pause',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        await pauseExperiment();
        return reply.send({ message: 'Experiment paused' });
      } catch (err) {
        return reply.status(400).send({ error: String(err) });
      }
    },
  );

  // ─── Raw Results ─────────────────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/results',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as {
        experimentId?: string;
        executionMode?: ExecutionMode;
        taskType?: string;
        complexity?: string;
        strategy?: string;
      };

      if (!query.experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const results = await getExperimentResults(query.experimentId, {
        executionMode: query.executionMode,
        taskType: query.taskType,
        complexity: query.complexity,
        strategy: query.strategy,
      });

      return reply.send({
        experimentId: query.experimentId,
        count: results.length,
        results,
      });
    },
  );

  // ─── Statistical Analysis ───────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/analysis',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.query as { experimentId?: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const results = await getExperimentResults(experimentId);
      const successful = results.filter(r => r.success && r.qualityScore !== null);

      if (successful.length === 0) {
        return reply.send({ experimentId, message: 'No successful executions yet', analysis: null });
      }

      // Per-mode analysis
      const modes: ExecutionMode[] = ['single-model', 'collective', 'adaptive'];
      const modeAnalysis: Record<string, unknown> = {};

      for (const mode of modes) {
        const modeResults = successful.filter(r => r.executionMode === mode);
        if (modeResults.length === 0) continue;

        const qualities = modeResults.map(r => r.qualityScore!);
        modeAnalysis[mode] = {
          sampleSize: modeResults.length,
          quality: computeDescriptiveStats(qualities),
          confidenceInterval: computeConfidenceInterval(qualities),
          cost: computeDescriptiveStats(modeResults.map(r => r.costUsd)),
          latency: computeDescriptiveStats(modeResults.map(r => r.latencyMs)),
          successRate: modeResults.filter(r => r.success).length / modeResults.length,
        };
      }

      // Pairwise t-tests
      const comparisons: Record<string, unknown> = {};
      for (let i = 0; i < modes.length; i++) {
        for (let j = i + 1; j < modes.length; j++) {
          const a = successful.filter(r => r.executionMode === modes[i]).map(r => r.qualityScore!);
          const b = successful.filter(r => r.executionMode === modes[j]).map(r => r.qualityScore!);
          if (a.length >= 2 && b.length >= 2) {
            comparisons[`${modes[i]}_vs_${modes[j]}`] = {
              tTest: welchTTest(a, b),
              effectSize: effectSize(a, b),
              meanDiff: a.reduce((s, v) => s + v, 0) / a.length - b.reduce((s, v) => s + v, 0) / b.length,
            };
          }
        }
      }

      return reply.send({
        experimentId,
        totalExecutions: results.length,
        successfulExecutions: successful.length,
        modeAnalysis,
        comparisons,
      });
    },
  );

  // ─── Full Report ─────────────────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/report',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.query as { experimentId?: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const experiment = await prisma.experiment.findUnique({ where: { id: experimentId } });
      if (!experiment) {
        return reply.status(404).send({ error: 'Experiment not found' });
      }

      const results = await getExperimentResults(experimentId);
      if (results.length === 0) {
        return reply.send({ experimentId, message: 'No executions yet', report: null });
      }

      const config = experiment.config as Record<string, unknown> | null;
      const report = generateReport(experimentId, experiment.name, results, {
        warmupExecutions: (config?.warmupExecutions as number) ?? 0,
        freezeLearningDuringEval: (config?.freezeLearningDuringEval as boolean) ?? true,
      });

      // Return specific document if requested, otherwise full bundle
      const { document } = req.query as { document?: string };
      if (document === 'executive-summary') return reply.send(report.executiveSummary);
      if (document === 'methodology') return reply.send(report.methodology);
      if (document === 'detailed-results') return reply.send(report.detailedResults);
      if (document === 'statistical-appendix') return reply.send(report.statisticalAppendix);
      if (document === 'decision-memo') return reply.send(report.decisionMemo);

      return reply.send(report);
    },
  );

  // ─── History ─────────────────────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/history',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { limit } = req.query as { limit?: string };
      const maxLimit = Math.min(parseInt(limit ?? '20', 10), 100);

      const experiments = await prisma.experiment.findMany({
        orderBy: { createdAt: 'desc' },
        take: maxLimit,
        select: {
          id: true,
          name: true,
          description: true,
          state: true,
          progress: true,
          totalExecutions: true,
          completedAt: true,
          createdAt: true,
        },
      });

      return reply.send({ experiments });
    },
  );

  // ─── Suite Info ──────────────────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/suite',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const coverage = getSuiteCoverage();
      return reply.send({
        ...coverage,
        tasks: EXPERIMENT_SUITE.map(t => ({
          index: t.index,
          taskType: t.taskType,
          complexity: t.complexity,
          domain: t.domain,
          expectedDifficulty: t.expectedDifficulty,
          promptPreview: t.prompt.slice(0, 100) + (t.prompt.length > 100 ? '...' : ''),
        })),
      });
    },
  );

  // ─── GO/NO-GO Decision Report ────────────────────────────────────────
  server.get(
    '/v1/admin/experiment/go-no-go',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.query as { experimentId?: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const results = await getExperimentResults(experimentId);
      if (results.length === 0) {
        return reply.send({ experimentId, message: 'No executions yet', report: null });
      }

      const { generateGoNoGoReport } = await import('@/core/experiment/go-no-go-engine.js');
      const report = generateGoNoGoReport(experimentId, results);
      return reply.send(report);
    },
  );

  // ─── Segmented Benchmark Report (CONFIRMATORY vs EXPLORATORY) ──────────
  // Answers "where does the collective win" honestly: pre-registered regimes
  // (c3-ha-hard/c3-code-verified/c3-canvas-physics — each with a mechanistic
  // hypothesis recorded BEFORE the run) get a real paired verdict; any other
  // scenario slice is exploratory-only, always labeled and never presented as
  // validation. See segmented-benchmark-report.ts for the full rationale.
  server.get(
    '/v1/admin/experiment/segmented-benchmark',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.query as { experimentId?: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const results = await getExperimentResults(experimentId);
      if (results.length === 0) {
        return reply.send({ experimentId, message: 'No executions yet', report: null });
      }

      const { generateSegmentedBenchmarkReport } = await import('@/core/experiment/segmented-benchmark-report.js');
      const report = generateSegmentedBenchmarkReport(experimentId, results);
      return reply.send(report);
    },
  );

  // ─── Strategy × Scenario Matrix (per-strategy W/T/L vs best single) ────
  // The descriptive companion to /segmented-benchmark: every collective
  // strategy's paired WIN/TIE/LOSS against the BEST frontier single, per
  // scenario, with Benjamini-Hochberg FDR correction across the whole matrix
  // (hundreds of simultaneous cells — raw p<0.05 would fabricate wins).
  // Leaderboard + hypothesis generator; confirmatory evidence stays with the
  // pre-registered regimes. See strategy-scenario-matrix.ts.
  server.get(
    '/v1/admin/experiment/strategy-matrix',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { experimentId } = req.query as { experimentId?: string };
      if (!experimentId) {
        return reply.status(400).send({ error: 'experimentId query parameter is required' });
      }

      const results = await getExperimentResults(experimentId);
      if (results.length === 0) {
        return reply.send({ experimentId, message: 'No executions yet', matrix: null });
      }

      const { generateStrategyScenarioMatrix } = await import('@/core/experiment/strategy-scenario-matrix.js');
      const matrix = generateStrategyScenarioMatrix(experimentId, results);
      return reply.send(matrix);
    },
  );

  // ── Judge Calibration Endpoint ──────────────────────────────────────────
  server.post(
    '/v1/admin/experiment/calibrate-judge',
    // Auth to match every other /v1/admin/experiment route: this endpoint fires
    // real (paid) judge calls, so an unauthenticated handler was a public
    // cost-amplification hole. The v4 driver already sends the admin bearer.
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const runs = Number(q?.runs ?? 10);
      // mode=dynamic exercises the REAL production judge (the in-process
      // provider-diverse cascade, no forced pick) and reports accuracy vs gold —
      // no external token / EXPERIMENT_JUDGE_MODEL needed. Default (pinned) keeps
      // the legacy HTTP self-call against EXPERIMENT_JUDGE_MODEL.
      if (q?.mode === 'dynamic') {
        const { calibrateDynamicJudge } = await import('@/core/experiment/judge-calibration.js');
        const report = await calibrateDynamicJudge(runs);
        return reply.send(report);
      }

      const { calibrateJudge } = await import('@/core/experiment/judge-calibration.js');
      const judgeModel = process.env.EXPERIMENT_JUDGE_MODEL || 'auto';
      const apiBase = process.env.BOOTSTRAP_API_BASE
        ?? (process.env.EVAL_API_BASE_URL
          ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
          : 'http://localhost:3000/v1/chat/completions');
      const bearerToken = process.env.BOOTSTRAP_BEARER_TOKEN ?? process.env.EVAL_BEARER_TOKEN ?? '';

      const report = await calibrateJudge({
        runs,
        apiBase,
        bearerToken,
        judgeModel,
      });

      return reply.send(report);
    },
  );

  // ─── C3 Validation: Pre-built experiment configs ─────────────────────
  server.get(
    '/v1/admin/experiment/c3-configs',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const configs = await getAllC3Configs();
      const summary = Object.entries(configs).map(([key, config]) => ({
        key,
        name: config.name,
        description: config.description,
        taskCount: config.taskIndices.length === 0 ? EXPERIMENT_SUITE.length : config.taskIndices.length,
        modeCount: config.modes.length,
        repetitions: config.repetitions,
        estimatedExecutions: (config.taskIndices.length === 0 ? EXPERIMENT_SUITE.length : config.taskIndices.length) * config.modes.length * config.repetitions,
        maxBudgetUsd: config.maxBudgetUsd,
        freezeLearning: config.freezeLearningDuringEval,
      }));
      return reply.send({ configs: summary });
    },
  );

  // ─── C3 Validation: Create experiment from pre-built config ─────────
  server.post(
    '/v1/admin/experiment/c3-create',
    { preHandler: [authenticate, requireRole('admin', 'owner')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { configKey, overrides } = req.body as {
        configKey: string;
        overrides?: Partial<ExperimentConfig>;
      };

      // Single source of truth — see c3-experiment-configs.ts. The
      // GET /c3-configs listing and this POST dispatcher BOTH read from
      // C3_CONFIG_BUILDERS, so the two surfaces cannot drift.
      const builder = C3_CONFIG_BUILDERS[configKey];
      if (!builder) {
        return reply.status(400).send({
          error: `Unknown config key: ${configKey}`,
          available: Object.keys(C3_CONFIG_BUILDERS),
        });
      }

      // Runtime hygiene: clean up stale experiments before creating new ones.
      // Mark experiments stuck in 'running' state for >6h as 'failed' (zombie cleanup).
      try {
        const staleThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const { count: staleCount } = await prisma.experiment.updateMany({
          where: { state: 'running', updatedAt: { lt: staleThreshold } },
          data: { state: 'failed' },
        });
        if (staleCount > 0) {
          log.warn({ staleCount }, 'Cleaned up stale experiments stuck in running state');
        }
      } catch (cleanupErr) {
        log.warn({ err: cleanupErr }, 'Stale experiment cleanup failed (non-fatal)');
      }

      let config: ExperimentConfig;
      try {
        config = { ...(await builder()), ...(overrides ?? {}) };
      } catch (buildErr) {
        log.error({ error: String(buildErr), configKey }, 'Config builder failed (likely DB/provider resolution issue)');
        return reply.status(500).send({
          error: `Config builder failed: ${String(buildErr)}`,
          configKey,
          hint: 'Check DB connectivity and model availability (resolveTopTierModels may need active models in the DB)',
        });
      }

      // Guard: warn if config has 0 modes or 0 tasks (likely DB resolution failure)
      // Modes carry a discriminator `mode: string` — narrow to that shape
      // for the count predicates below.
      const modes: Array<{ mode?: unknown }> = Array.isArray(config.modes)
        ? (config.modes as Array<{ mode?: unknown }>)
        : [];
      const diagnostics: Record<string, unknown> = {
        modesCount: modes.length,
        tasksCount: config.taskIndices?.length ?? 0,
        totalExecutions: (config.taskIndices?.length ?? 0) * modes.length * (config.repetitions ?? 1),
        singleModelArms: modes.filter((m) => m.mode === 'single-model' || m.mode === 'single-budget').length,
        collectiveArms: modes.filter((m) => m.mode === 'collective').length,
        adaptiveArms: modes.filter((m) => m.mode === 'adaptive').length,
      };

      if (diagnostics.modesCount === 0) {
        return reply.status(422).send({
          error: 'Config builder produced 0 modes — likely all model resolution failed',
          configKey,
          diagnostics,
          hint: 'Run resolveTopTierModels manually or check that active models exist in the DB',
        });
      }

      try {
        const experimentId = await createExperiment(config);
        log.info({ experimentId, configKey, name: config.name, ...diagnostics }, 'C3 experiment created');
        return reply.status(201).send({ experimentId, config, diagnostics });
      } catch (err) {
        log.error({ error: String(err), configKey }, 'Failed to create C3 experiment');
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  log.info('Experiment admin routes registered (including C3 validation endpoints)');
}
