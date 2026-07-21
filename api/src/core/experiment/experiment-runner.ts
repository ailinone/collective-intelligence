// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Runner
 *
 * Orchestrates Mode A/B/C comparative executions across the task suite.
 * Executes via the /v1/chat/completions API (same pattern as continuous-benchmark-job),
 * scores via LLM-as-judge, and persists results to the experiment_executions table.
 *
 * Supports:
 * - Pause/resume via checkpoint state
 * - Budget limits (abort if exceeded)
 * - Configurable delay and concurrency
 * - Progress tracking
 *
 * Mode A: { model: '<specific>', strategy: 'single' }
 * Mode B: { model: 'auto', strategy: '<collective>' }
 * Mode C: { model: 'auto', strategy: 'auto' }
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma';
import { logger } from '@/utils/logger';
import { toInputJson } from '@/utils/json';
import { narrowAs } from '@/utils/type-guards';
import {
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
  normalizeJudgeOutput,
} from '@/core/quality/judge-schema';
import type { ChatResponse, ChatRequest, OrchestrationContext } from '@/types';
import { STRATEGY_INPUT_VALUES, canonicalizeStrategyInput } from '@/core/orchestration/strategy-contract';
import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';
import { extractFinalAnswer } from '@/core/orchestration/verification/best-of-n-verifier';
import { EXPERIMENT_SUITE } from './experiment-suite';
import { registerExperimentBenchmarkTools } from './experiment-tool-catalog';
import {
  gradeToolCallingResponse,
  isToolCallingTask,
  type ObservedToolCall,
} from './tool-calling-grader';
import type {
  ExperimentConfig,
  ExperimentExecutionResult,
  ExperimentProgress,
  ExperimentState,
  ExperimentPhase,
  ExperimentTask,
  ExecutionMode,
  FailureMode,
  ModeConfig,
} from './experiment-types';

const log = logger.child({ component: 'experiment-runner' });

// ─── Judge instrument (review F1 — split-brain guard) ───────────────────────
// The judge identity is resolved ONCE, here, at module load — not re-read from
// process env ad-hoc at each scoring call — and stamped on every result row.
// This closes the "split-brain" hole: without a single frozen instrument, the
// calibration phase could validate one judge (e.g. a pinned model) while the
// scored run silently used another (e.g. a floating 'auto' that resolves to a
// different model per request), making the run's scores non-reproducible and
// the calibration meaningless. `assertJudgeInstrumentPinned()` (called by the
// driver at run start) refuses to begin a paid run with a floating judge.
const JUDGE_MODE: 'dynamic' | 'pinned' =
  (process.env.JUDGE_MODE || '').toLowerCase() === 'dynamic' ? 'dynamic' : 'pinned';
const JUDGE_MODEL_ID: string = process.env.EXPERIMENT_JUDGE_MODEL || 'auto';
/** The frozen judge instrument, stamped on every row for audit. In dynamic mode
 *  the concrete scoring model is the in-process cascade's choice; we mark it
 *  'dynamic-cascade' and let judgeResponse override with the real id when known. */
const JUDGE_IDENTITY = {
  mode: JUDGE_MODE,
  modelId: JUDGE_MODE === 'dynamic' ? 'dynamic-cascade' : JUDGE_MODEL_ID,
} as const;

/**
 * Refuse to start a paid run whose judge instrument is not pinned to a concrete,
 * reproducible model. A floating 'auto' judge picks a (possibly different) model
 * per request and per phase, so calibration cannot certify the instrument the
 * run actually scored with. Call this at run start (driver). (review F1)
 */
export function assertJudgeInstrumentPinned(): void {
  if (JUDGE_MODE === 'pinned' && (JUDGE_MODEL_ID === '' || JUDGE_MODEL_ID.toLowerCase() === 'auto')) {
    throw new Error(
      'Judge instrument not pinned: set EXPERIMENT_JUDGE_MODEL to a concrete model id, ' +
        'or JUDGE_MODE=dynamic to use the in-process provider-diverse cascade. Refusing to ' +
        'score a paid run with a floating "auto" judge — the scoring instrument must be fixed ' +
        'and reproducible, and must match the instrument the calibration phase certified.',
    );
  }
}

// ─── Arm-budget dimensioning (review F1 — starvation guard) ─────────────────
// A collective arm makes several model calls + a synthesis pass per execution,
// so an EQUAL split (maxBudget / #arms) starves it next to a single-call arm.
// With the union-inflated single-arm count, each arm got ~$0.31-0.95 while a
// collective arm needs $3-20 — the exact mechanism behind v4's "655/768 skipped
// as arm budget exhausted; run ended at 17% INCONCLUSIVE" collapse. Weight the
// split by expected per-arm cost so collectives get a proportionally larger
// slice while the total stays within maxBudgetUsd.
const COLLECTIVE_COST_WEIGHT = Number(process.env.EXPERIMENT_COLLECTIVE_COST_WEIGHT ?? 6);

/**
 * Whether a task's forced strategy should override THIS arm's strategy. False
 * for single-model/single-budget arms — applying a collective strategy (e.g.
 * 'debate') to a single arm silently turns it collective and contaminates the
 * single-vs-collective attribution (review F11). Also false for a strategy the
 * chat schema does not accept (e.g. 'compositor'), which used to 400 every arm.
 */
export function shouldApplyTaskStrategyOverride(mode: ModeConfig, taskStrategy: string | undefined): boolean {
  if (!taskStrategy) return false;
  if (!(STRATEGY_INPUT_VALUES as readonly string[]).includes(taskStrategy)) return false;
  return mode.mode !== 'single-model' && mode.mode !== 'single-budget';
}

/** Relative expected cost of one execution of an arm (single call = 1). */
export function armCostWeight(mode: ModeConfig): number {
  switch (mode.mode) {
    case 'single-model':
    case 'single-budget':
      return 1;
    default:
      // collective / forced-pool-collective / adaptive / ablation — multi-call.
      return Math.max(1, COLLECTIVE_COST_WEIGHT);
  }
}

/** Distribute maxBudgetUsd across arms in proportion to expected per-arm cost.
 *  Keyed by getModeKey(mode); the sum stays ≤ maxBudgetUsd. PURE. (review F1) */
export function computeArmBudgets(config: ExperimentConfig): Record<string, number> {
  const modes = config.modes ?? [];
  if (modes.length === 0) return {};
  const weights = modes.map((m) => [getModeKey(m), armCostWeight(m)] as const);
  const total = weights.reduce((s, [, w]) => s + w, 0) || 1;
  return Object.fromEntries(weights.map(([k, w]) => [k, (config.maxBudgetUsd * w) / total]));
}

export interface ArmBudgetFeasibility {
  perArm: Record<string, number>;
  minCollectiveFloorUsd: number;
  starvedCollectiveArms: Array<{ key: string; budgetUsd: number }>;
}

/** Flag collective arms whose allocated budget is below a viable floor — they
 *  will truncate mid-run (the invisible skips that ended v4 at 17%). PURE. */
export function summarizeArmBudgetFeasibility(config: ExperimentConfig): ArmBudgetFeasibility {
  const perArm = computeArmBudgets(config);
  const minCollectiveFloorUsd = Number(process.env.EXPERIMENT_MIN_COLLECTIVE_ARM_USD ?? 2);
  const starvedCollectiveArms: Array<{ key: string; budgetUsd: number }> = [];
  for (const m of config.modes ?? []) {
    const isCollective = m.mode !== 'single-model' && m.mode !== 'single-budget';
    if (!isCollective) continue;
    const budgetUsd = perArm[getModeKey(m)] ?? 0;
    if (budgetUsd < minCollectiveFloorUsd) starvedCollectiveArms.push({ key: getModeKey(m), budgetUsd });
  }
  return { perArm, minCollectiveFloorUsd, starvedCollectiveArms };
}

/** Refuse (strict) or loudly warn (default) about a run that will silently
 *  truncate. Always surfaces the per-arm allocation so starvation is VISIBLE
 *  before spending — not discovered at row 113. Call at run start. (review F1) */
export function assertArmBudgetFeasible(config: ExperimentConfig): void {
  const f = summarizeArmBudgetFeasibility(config);
  if (f.starvedCollectiveArms.length === 0) {
    log.info(
      { arms: Object.keys(f.perArm).length, floorUsd: f.minCollectiveFloorUsd },
      'Arm-budget feasibility OK — no collective arm under floor',
    );
    return;
  }
  const strict = ['1', 'true'].includes((process.env.EXPERIMENT_STRICT_BUDGET ?? '').toLowerCase());
  const detail = {
    starved: f.starvedCollectiveArms.length,
    floorUsd: f.minCollectiveFloorUsd,
    examples: f.starvedCollectiveArms.slice(0, 5),
  };
  if (strict) {
    throw new Error(
      `Arm-budget starvation: ${f.starvedCollectiveArms.length} collective arm(s) allocated < ` +
        `$${f.minCollectiveFloorUsd}/arm and WILL truncate mid-run. Raise maxBudgetUsd or reduce arm ` +
        `count (tune the floor with EXPERIMENT_MIN_COLLECTIVE_ARM_USD).`,
    );
  }
  log.warn(
    detail,
    'Arm-budget starvation risk — collective arms under floor will truncate mid-run; raise ' +
      'maxBudgetUsd or reduce arms (set EXPERIMENT_STRICT_BUDGET=1 to hard-fail instead of warn)',
  );
}

// ─── Queue Classification ─────────────────────────────────────────────────

type QueueType = 'chat' | 'multimodal' | 'compositor' | 'leader';

function classifyTask(task: ExperimentTask): QueueType {
  if (task.queueType) return task.queueType as QueueType;
  if (task.modality && task.modality !== 'chat') return 'multimodal';
  if (task.strategy === 'compositor') return 'compositor';
  if (task.forceFailProvider) return 'leader';
  return 'chat';
}

// ─── Provider Rate Limiter ────────────────────────────────────────────────

class ProviderRateLimiter {
  private activeCounts = new Map<string, number>();
  private readonly limits: Record<string, number> = {
    openai: 5, anthropic: 3, google: 5,
    cometapi: 3, openrouter: 5, default: 2,
  };

  async acquire(provider: string): Promise<void> {
    const limit = this.limits[provider] || this.limits.default;
    while ((this.activeCounts.get(provider) || 0) >= limit) {
      await new Promise(r => setTimeout(r, 100));
    }
    this.activeCounts.set(provider, (this.activeCounts.get(provider) || 0) + 1);
  }

  release(provider: string): void {
    const current = this.activeCounts.get(provider) || 1;
    this.activeCounts.set(provider, Math.max(0, current - 1));
  }
}

/** Singleton rate limiter shared across all experiment workers. */
const providerRateLimiter = new ProviderRateLimiter();

// ─── Configuration ─────────────────────────────────────────────────────────

const API_CONFIG = {
  apiBase: process.env.BOOTSTRAP_API_BASE
    ?? (process.env.EVAL_API_BASE_URL
      ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
      : 'http://localhost:3000/v1/chat/completions'),
  bearerToken: process.env.BOOTSTRAP_BEARER_TOKEN ?? process.env.EVAL_BEARER_TOKEN ?? '',
};

// ─── State ─────────────────────────────────────────────────────────────────

/** In-memory state for the active experiment. Only one experiment runs at a time. */
let activeExperiment: {
  experimentId: string;
  config: ExperimentConfig;
  progress: ExperimentProgress;
  state: ExperimentState;
  abortController: AbortController;
} | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new experiment in the database.
 * Does not start execution — call `startExperiment()` for that.
 */
export async function createExperiment(config: ExperimentConfig): Promise<string> {
  // Task universe: an explicit config.tasks (e.g. loaded HumanEval/GSM8K)
  // overrides the built-in suite; taskIndices still narrows it when set.
  const universe = config.tasks ?? EXPERIMENT_SUITE;
  const tasks = config.taskIndices.length > 0
    ? universe.filter((t) => config.taskIndices.includes(t.index))
    : universe;

  const totalExecutions = tasks.length * config.modes.length * config.repetitions;

  const experiment = await prisma.experiment.create({
    data: {
      name: config.name,
      description: config.description,
      config: toInputJson(config),
      state: 'pending',
      progress: {
        total: totalExecutions,
        completed: 0,
        currentTaskIndex: null,
        currentMode: null,
        currentRepetition: null,
        totalCostUsd: 0,
        judgeCostUsd: 0,
        lastCompletedAt: null,
        errors: 0,
        currentPhase: config.warmupExecutions > 0 ? 'warmup' : 'frozen',
        warmupCompleted: 0,
        frozenCompleted: 0,
      },
      totalExecutions,
    },
  });

  log.info({ experimentId: experiment.id, totalExecutions, taskCount: tasks.length, modes: config.modes.length }, 'Experiment created');
  return experiment.id;
}

/**
 * Start (or resume) an experiment. Runs asynchronously in the background.
 * Returns immediately after launching.
 */
export interface StartExperimentResult {
  started: boolean;
  canaryPassed: boolean | null; // null = canary skipped or errored
  canaryDiagnostics?: unknown;
  error?: string;
}

export async function startExperiment(experimentId: string): Promise<StartExperimentResult> {
  // Runtime hygiene: if activeExperiment is set but the DB shows it's not running,
  // clear the stale in-memory flag. This handles the case where the background loop
  // silently died (unhandled rejection) but the flag was never cleared.
  if (activeExperiment) {
    try {
      const staleCheck = await prisma.experiment.findUnique({
        where: { id: activeExperiment.experimentId },
        select: { state: true, updatedAt: true },
      });
      const isStale = !staleCheck
        || staleCheck.state === 'completed'
        || staleCheck.state === 'failed'
        || staleCheck.state === 'paused'
        || (staleCheck.updatedAt && staleCheck.updatedAt.getTime() < Date.now() - 3_600_000); // >1h stale

      if (isStale) {
        log.warn(
          { staleExperimentId: activeExperiment.experimentId, dbState: staleCheck?.state },
          'Clearing stale activeExperiment flag (DB shows not running or stale >1h)'
        );
        activeExperiment = null;
      } else {
        throw new Error(`Experiment ${activeExperiment.experimentId} is already running. Pause or wait for it to complete.`);
      }
    } catch (checkErr) {
      if (activeExperiment) {
        // DB check failed — keep the guard to be safe
        throw new Error(`Experiment ${activeExperiment.experimentId} is already running (DB check failed: ${String(checkErr)})`);
      }
    }
  }

  const experiment = await prisma.experiment.findUnique({ where: { id: experimentId } });
  if (!experiment) throw new Error(`Experiment ${experimentId} not found`);
  if (experiment.state === 'completed') throw new Error('Experiment already completed');
  if (experiment.state === 'failed') throw new Error('Experiment failed — create a new one');

  if (!API_CONFIG.bearerToken) {
    throw new Error('No bearer token configured (set BOOTSTRAP_BEARER_TOKEN or EVAL_BEARER_TOKEN)');
  }

  // Refuse to start with a floating judge instrument (review F1). A paid run
  // MUST be scored by the same fixed, reproducible judge the calibration phase
  // certified — never a per-request 'auto' that can resolve to a different model.
  assertJudgeInstrumentPinned();

  // Prisma's `JsonValue` is structurally compatible with `ExperimentConfig`/
  // `ExperimentProgress` at runtime (we wrote them via toInputJson). Route
  // the narrow through the sanctioned `narrowAs<T>` helper — its name
  // documents the trust boundary (column we own → typed shape) and its
  // single-call site keeps the lint rule against `as unknown as` clean.
  let config = narrowAs<ExperimentConfig>(experiment.config);
  let progress = narrowAs<ExperimentProgress>(experiment.progress);

  // Surface (or, under EXPERIMENT_STRICT_BUDGET, refuse) arm-budget starvation
  // BEFORE spending, so a run can't silently truncate at 17% (review F1).
  assertArmBudgetFeasible(config);

  const abortController = new AbortController();
  activeExperiment = {
    experimentId,
    config,
    progress,
    state: 'running',
    abortController,
  };

  await prisma.experiment.update({
    where: { id: experimentId },
    data: { state: 'running' },
  });

  // ── Initialize CreditGovernor (Hardening Bloco B) ──────────────────
  // Provides route-level credit tracking and structural failure detection
  try {
    const { initCreditGovernor } = await import('@/core/budget/credit-governor');
    initCreditGovernor({
      experimentBudgetUsd: config.maxBudgetUsd,
      minBufferUsd: Math.max(0.50, config.maxBudgetUsd * 0.02), // 2% buffer
      // Per-arm budget keyed by the FULL arm id (2026-06-30). The previous
      // `getModeKey(m).split(':')[0]` collapsed every arm of a mode into ONE
      // bucket (only 4 keys), so all 31 collective strategies SHARED a single
      // bucket and exhausted it after ~1 execution. Now WEIGHTED by expected
      // per-arm cost (review F1): an equal split still starved collective arms
      // ($0.31-0.95 vs $3-20 needed) once the single-arm count inflated —
      // computeArmBudgets gives collectives a proportionally larger slice.
      armBudgets: computeArmBudgets(config),
    });
    log.info({ budget: config.maxBudgetUsd, modes: config.modes?.length ?? 0 }, 'CreditGovernor initialized for experiment');
  } catch (govErr) {
    log.warn({ error: String(govErr) }, 'CreditGovernor init failed (proceeding with fallback budget checks)');
  }

  // L6: Smart Canary — policy-aware multi-bucket gate.
  // Replaces the legacy single-arm canary. Stratifies by (policyKind,
  // providerId, modelFamily, mode) and probes one representative per
  // bucket in parallel. Gates on coverage, not raw success rate, so a
  // single exhausted provider doesn't abort an experiment with 38 arms.
  try {
    const { runSmartCanary, resolveExperimentArm } = await import('./policy');
    const resolvedArms = (config.modes ?? []).map((m) => resolveExperimentArm(m));

    if (resolvedArms.length > 0) {
      // Thresholds tunable via env so degraded environments (most providers
      // exhausted) can still launch experiments. Defaults are conservative.
      // Defaults aligned with smart-canary's DEFAULT_OPTS (the runner always
      // passes values, so a lower fallback here silently overrode the fixed
      // 30s/3 defaults — observed as canary false-negatives on slow collectives).
      const minProvidersHealthy = Number(process.env.EXPERIMENT_CANARY_MIN_PROVIDERS_HEALTHY ?? 3);
      const minPolicyKindsCovered = Number(process.env.EXPERIMENT_CANARY_MIN_POLICY_KINDS_COVERED ?? 1);
      const perCanaryTimeoutMs = Number(process.env.EXPERIMENT_CANARY_PER_TIMEOUT_MS ?? 30_000);
      // 12 → 100 (2026-07-19): see smart-canary.ts DEFAULT_OPTS.maxCanariesGlobal —
      // 12 silently truncated pre-flight coverage to the first N stratified
      // buckets in arm order, not by health; a safety ceiling now, not a
      // routine cap (probes run in parallel, one per distinct provider/model).
      const maxCanariesGlobal = Number(process.env.EXPERIMENT_CANARY_MAX_GLOBAL ?? 100);

      const canaryResult = await runSmartCanary({
        experimentId,
        arms: resolvedArms,
        apiBase: API_CONFIG.apiBase,
        bearerToken: API_CONFIG.bearerToken,
        minProvidersHealthy,
        minPolicyKindsCovered,
        perCanaryTimeoutMs,
        maxCanariesGlobal,
      });

      if (!canaryResult.passed) {
        // Optional gate bypass for degraded environments. The integrity guard
        // continues to validate each execution policy-aware, so contaminated
        // executions are still caught — this only changes WHEN the experiment
        // aborts (now: per-arm at exec time, instead of pre-flight at canary time).
        const skipGate = process.env.EXPERIMENT_CANARY_SKIP_GATE === 'true';

        log.error(
          {
            experimentId,
            gates: canaryResult.gates,
            distinctHealthyProviders: canaryResult.distinctHealthyProviders,
            distinctPolicyKindsCovered: canaryResult.distinctPolicyKindsCovered,
            diagnostics: canaryResult.diagnostics,
            skipGate,
          },
          skipGate
            ? 'Smart canary FAILED — proceeding because EXPERIMENT_CANARY_SKIP_GATE=true'
            : 'Smart canary FAILED — experiment aborted to save budget',
        );

        if (!skipGate) {
          await prisma.experiment.update({
            where: { id: experimentId },
            data: {
              state: 'failed',
              progress: {
                ...progress,
                errors: (progress.errors ?? 0) + 1,
                canaryGateFailed: true,
                canaryDiagnostics: [...canaryResult.diagnostics],
              },
            },
          });
          activeExperiment = null;
          return {
            started: false,
            canaryPassed: false,
            canaryDiagnostics: [...canaryResult.diagnostics],
          };
        }
        // Falling through with skipGate=true — record warning in progress
        progress = {
          ...progress,
          canaryGateBypassed: true,
          canaryDiagnostics: [...canaryResult.diagnostics],
        } as ExperimentProgress;
      }
      log.info(
        {
          experimentId,
          gates: canaryResult.gates,
          distinctHealthyProviders: canaryResult.distinctHealthyProviders,
          distinctPolicyKindsCovered: canaryResult.distinctPolicyKindsCovered,
          skipPlanLength: canaryResult.skipPlan.length,
          totalDurationMs: canaryResult.totalDurationMs,
        },
        'Smart canary PASSED',
      );

      // CONSUME the skip plan (c3-v4 finding: it was computed and only logged,
      // so arms whose canary failed still burned budget across every task ×
      // repetition). Remove those arms up front and record auditable skips.
      // Never remove ALL arms — if everything failed the gates above decide.
      if (canaryResult.skipPlan.length > 0 && Array.isArray(config.modes)) {
        const skipByArmId = new Map(canaryResult.skipPlan.map((s) => [s.armId, s]));
        const armIdToMode = new Map(config.modes.map((m) => [resolveExperimentArm(m).armId, m] as const));
        const kept = config.modes.filter(
          (m) => !skipByArmId.has(resolveExperimentArm(m).armId),
        );
        if (kept.length > 0 && kept.length < config.modes.length) {
          const tasksCount = config.taskIndices.length > 0
            ? config.taskIndices.length
            : EXPERIMENT_SUITE.length;
          const perArmExecutions = tasksCount * config.repetitions;
          for (const [armId, s] of skipByArmId) {
            recordSkip(progress, buildCanarySkipKey(s.errorClass, armId, armIdToMode), perArmExecutions);
          }
          log.warn(
            {
              experimentId,
              removedArms: config.modes.length - kept.length,
              keptArms: kept.length,
              skippedExecutions: (config.modes.length - kept.length) * perArmExecutions,
              skipPlan: canaryResult.skipPlan,
            },
            'Canary skip plan CONSUMED — dead arms removed before spending budget',
          );
          config = { ...config, modes: kept };
        }
      }
    }
  } catch (canaryErr) {
    // L13: Canary gate failure is non-critical — proceed with experiment
    log.warn(
      { error: canaryErr instanceof Error ? canaryErr.message : String(canaryErr) },
      'Smart canary failed to run (proceeding anyway)',
    );
  }

  // Fire-and-forget: run in background
  log.info({ experimentId, bearerToken: API_CONFIG.bearerToken ? `${API_CONFIG.bearerToken.substring(0, 10)}...` : 'EMPTY' }, 'About to start experiment loop');
  runExperimentLoop(experimentId, config, progress, abortController.signal)
    .then(() => log.info({ experimentId }, 'Experiment loop completed normally'))
    .catch(err => {
      log.error({ error: String(err), stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined, experimentId }, 'Experiment loop CRASHED');
    });

  return { started: true, canaryPassed: true };
}

/**
 * Pause the active experiment. Can be resumed later with startExperiment().
 */
export async function pauseExperiment(): Promise<void> {
  if (!activeExperiment) throw new Error('No experiment is running');

  activeExperiment.abortController.abort();

  await prisma.experiment.update({
    where: { id: activeExperiment.experimentId },
    data: {
      state: 'paused',
      progress: toInputJson(activeExperiment.progress),
    },
  });

  log.info({ experimentId: activeExperiment.experimentId, progress: activeExperiment.progress }, 'Experiment paused');
  activeExperiment = null;
}

/**
 * Get current experiment status.
 */
export function getExperimentStatus(): {
  experimentId: string | null;
  state: ExperimentState | null;
  progress: ExperimentProgress | null;
} {
  if (!activeExperiment) {
    return { experimentId: null, state: null, progress: null };
  }
  return {
    experimentId: activeExperiment.experimentId,
    state: activeExperiment.state,
    progress: activeExperiment.progress,
  };
}

/**
 * Get all experiment executions for analysis.
 */
export async function getExperimentResults(
  experimentId: string,
  filters?: { executionMode?: ExecutionMode; taskType?: string; complexity?: string; strategy?: string },
): Promise<ExperimentExecutionResult[]> {
  const where: Record<string, unknown> = { experimentId };
  if (filters?.executionMode) where.executionMode = filters.executionMode;
  if (filters?.taskType) where.taskType = filters.taskType;
  if (filters?.complexity) where.complexity = filters.complexity;
  if (filters?.strategy) where.strategy = filters.strategy;

  const rows = await prisma.experimentExecution.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(row => ({
    experimentId: row.experimentId,
    taskIndex: row.taskIndex,
    repetition: row.repetition,
    executionMode: row.executionMode as ExecutionMode,
    strategy: row.strategy,
    model: row.model,
    taskType: row.taskType,
    complexity: row.complexity,
    domain: row.domain ?? '',
    prompt: row.prompt,
    qualityScore: row.qualityScore ? Number(row.qualityScore) : null,
    costUsd: Number(row.costUsd),
    costMissing: readMeta(row.structuredMetadata).costMissing === true,
    latencyMs: row.latencyMs,
    totalTokens: row.totalTokens,
    success: row.success,
    modelsUsed: row.modelsUsed,
    judgeScore: row.judgeScore ? Number(row.judgeScore) : null,
    judgeRubric: row.judgeRubric ?? '',
    faithfulnessScore: null,
    instructionFollowingScore: null,
    // P1-3: failureMode has its OWN column (was hardcoded null, discarding real
    // data); scoringPolicy/judgeUsed/heuristicScoreRaw/ablation* live in the
    // structured_metadata JSON (there are NO top-level columns for them, so the
    // old `(row as ...).X` reads were always undefined → null/false).
    failureMode: (row.failureMode ?? null) as FailureMode | null,
    phase: (row.phase ?? 'frozen') as ExperimentPhase,
    responseSummary: row.responseSummary ?? null,
    ablationDisabled: (readMeta(row.structuredMetadata).ablationDisabled as string[] | undefined) ?? [],
    ablationCondition: (readMeta(row.structuredMetadata).ablationCondition as string | undefined) ?? null,
    scoringPolicy: (readMeta(row.structuredMetadata).scoringPolicy as string | undefined) ?? null,
    judgeUsed: readMeta(row.structuredMetadata).judgeUsed === true,
    judgeFailed: readMeta(row.structuredMetadata).judgeFailed === true,
    scoreSource: (readMeta(row.structuredMetadata).scoreSource as ExperimentExecutionResult['scoreSource']) ?? null,
    judgeMode: (readMeta(row.structuredMetadata).judgeMode as string | undefined) ?? null,
    judgeModelId: (readMeta(row.structuredMetadata).judgeModelId as string | undefined) ?? null,
    judgeCostUsd: readMeta(row.structuredMetadata).judgeCostUsd != null
      ? Number(readMeta(row.structuredMetadata).judgeCostUsd)
      : undefined,
    armKey: (readMeta(row.structuredMetadata).armKey as string | undefined) ?? undefined,
    heuristicScoreRaw: readMeta(row.structuredMetadata).heuristicScoreRaw != null
      ? Number(readMeta(row.structuredMetadata).heuristicScoreRaw)
      : null,
  }));
}

/** Safely read the structured_metadata JSON blob as a plain object. */
function readMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

// ─── Core Loop ─────────────────────────────────────────────────────────────

/**
 * Count a planned execution that will NOT produce a persisted row. Run
 * 9590ff41 (2026-07-05) ended state='completed' at 392/532 frozen with zero
 * errors because arm_budget_exceeded skips were invisible — a benchmark that
 * silently truncates its plan is not auditable. Every skip/abort path must
 * go through here so `progress.skipped`/`skipReasons` make the shortfall
 * self-describing in the persisted progress JSON.
 */
function recordSkip(progress: ExperimentProgress, reason: string, count: number): void {
  if (count <= 0) return;
  progress.skipped = (progress.skipped ?? 0) + count;
  progress.skipReasons = progress.skipReasons ?? {};
  progress.skipReasons[reason] = (progress.skipReasons[reason] ?? 0) + count;
}

/**
 * Explicit output-token OVERRIDE for a task, or `undefined` to let the SERVER
 * derive the ceiling from the selected model's own maxOutputTokens (the fully-
 * dynamic, frontier-parity default). The runner is an HTTP client and does NOT
 * know which model the engine will select (especially the adaptive arm), so it
 * MUST NOT stamp a static number: a fixed 8192/4096 became the effective ceiling
 * for EVERY arm and clipped frontier models that can emit far more — a static
 * soft-pin that both violates the no-static rule and caps the benchmark below
 * frontier output. When this returns undefined the request omits max_tokens and
 * the engine fills it per-model (see dynamic-output-budget + base-strategy).
 * An operator can still force a value via task.maxTokens or EXPERIMENT_MAX_TOKENS.
 */
function resolveTaskMaxTokens(task: ExperimentTask): number | undefined {
  if (typeof task.maxTokens === 'number' && task.maxTokens > 0) return task.maxTokens;
  const envDefault = Number(process.env.EXPERIMENT_MAX_TOKENS ?? 0);
  if (envDefault > 0) return envDefault;
  return undefined;
}

async function runExperimentLoop(
  experimentId: string,
  config: ExperimentConfig,
  progress: ExperimentProgress,
  signal: AbortSignal,
): Promise<void> {
  // Shared across every queue's workers (closed over below): without this,
  // each of up to ~15 concurrent workers across 4 queues independently
  // discovers the same exhausted experiment budget on its own schedule,
  // letting further (possibly expensive) executions land from queues that
  // haven't noticed yet — the H-B mini-run overshot its $20 cap by ~25%
  // ($25.12) this way. Once ANY worker sees experiment_budget_exceeded,
  // every worker in every queue skips its remaining items (with full
  // recordSkip accounting, same as today) on its very next loop tick.
  let budgetExhausted = false;
  // Task universe: an explicit config.tasks (e.g. loaded HumanEval/GSM8K)
  // overrides the built-in suite; taskIndices still narrows it when set.
  const taskUniverse = config.tasks ?? EXPERIMENT_SUITE;
  const rawTasks = config.taskIndices.length > 0
    ? taskUniverse.filter((t) => config.taskIndices.includes(t.index))
    : taskUniverse;

  // Reorder tasks: VERIFIABLE tasks first (they carry answerCheck — the H-A
  // objective adjudication; in c3-v4 the complexity-first order buried them at
  // the end of the queue and a 17% partial run never reached them), then high
  // complexity, then medium, then low (warmup trains the adaptive system on
  // challenging scenarios before freezing).
  const complexityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const tasks = [...rawTasks].sort((a, b) => {
    const aVerifiable = a.answerCheck ? 0 : 1;
    const bVerifiable = b.answerCheck ? 0 : 1;
    if (aVerifiable !== bVerifiable) return aVerifiable - bVerifiable;
    return (complexityOrder[a.complexity] ?? 1) - (complexityOrder[b.complexity] ?? 1);
  });

  const startTime = Date.now();
  log.info({ experimentId, taskCount: tasks.length, modes: config.modes.length, repetitions: config.repetitions, taskOrder: 'complexity-first (high→medium→low)' }, 'Experiment loop started (round-robin: rep → task → mode)');

  // DB-backed completion set for robust resume after pause
  const completedSet = new Set<string>();
  if (progress.completed > 0) {
    const existing = await prisma.experimentExecution.findMany({
      where: { experimentId },
      select: { taskIndex: true, executionMode: true, strategy: true, model: true, repetition: true, structuredMetadata: true },
    });
    for (const row of existing) {
      // The completion key MUST match what the execution queue builds with
      // getModeKey(mode) from the CONFIG. Prefer the persisted armKey (review
      // F9) — reconstructing it from the row's `strategy` fails when that value
      // was resolved/normalized away from the config's raw strategy (e.g. an
      // 'auto'/adaptive resolution), keying the arm differently and forcing a
      // full, double-paid re-run. Fall back to reconstruction for legacy rows
      // written before armKey existed.
      const persistedArmKey = readMeta(row.structuredMetadata).armKey as string | undefined;
      const modeKey = persistedArmKey ?? (
        row.executionMode === 'collective' ? `collective:${row.strategy}`
        : row.executionMode === 'collective-tier1' ? `collective-tier1:${row.strategy}`
        : row.executionMode === 'single-model' ? `single-model:${row.model}`
        : row.executionMode === 'single-budget' ? `single-budget:${row.model}`
        : row.executionMode
      );
      completedSet.add(`${row.taskIndex}|${modeKey}|${row.repetition}`);
    }
    log.info({ experimentId, resumeFrom: existing.length }, 'Loaded completion set for resume');
  }

  try {
    // Build execution queue: all (rep, task, mode) triples in round-robin order
    type QueueItem = {
      rep: number;
      task: typeof tasks[number];
      mode: ModeConfig;
      completionKey: string;
    };

    const executionQueue: QueueItem[] = [];

    for (let rep = 1; rep <= config.repetitions; rep++) {
      for (const task of tasks) {
        for (const mode of config.modes) {
          const modeKey = getModeKey(mode);
          const completionKey = `${task.index}|${modeKey}|${rep}`;
          if (!completedSet.has(completionKey)) {
            executionQueue.push({ rep, task, mode, completionKey });
          }
        }
      }
    }

    // ── Queue Classification: distribute items to separate queues ──────
    const queues: Record<QueueType, { items: QueueItem[]; maxWorkers: number }> = {
      chat: { items: [], maxWorkers: 8 },
      multimodal: { items: [], maxWorkers: 3 },
      compositor: { items: [], maxWorkers: 2 },
      leader: { items: [], maxWorkers: 2 },
    };

    for (const item of executionQueue) {
      const queueType = classifyTask(item.task);
      queues[queueType].items.push(item);
    }

    const queueSizes = Object.fromEntries(
      Object.entries(queues).map(([type, q]) => [type, q.items.length]),
    );

    log.info({
      experimentId,
      totalQueued: executionQueue.length,
      alreadyCompleted: completedSet.size,
      concurrency: config.maxConcurrency,
      queues: queueSizes,
      taskOrder: 'complexity-first (high→medium→low), round-robin (rep → task → mode)',
    }, 'Experiment loop started with separated queue workers');

    // ── Worker function shared across all queues ──────────────────────
    const runQueueWorkers = async (
      items: QueueItem[],
      maxQueueWorkers: number,
      queueType: string,
    ): Promise<void> => {
      if (items.length === 0) return;

      // Cap queue workers by global maxConcurrency and the queue's own limit
      const effectiveWorkers = Math.max(1, Math.min(maxQueueWorkers, config.maxConcurrency, 10));
      let queueIndex = 0;

      const runWorker = async (workerId: number): Promise<void> => {
        while (queueIndex < items.length) {
          if (signal.aborted) {
            log.info({ experimentId, workerId, queueType }, 'Worker stopped — experiment paused');
            return;
          }
          if (budgetExhausted) {
            log.info({ experimentId, workerId, queueType }, 'Worker stopped — experiment budget exceeded (signaled by another queue)');
            recordSkip(progress, 'experiment_budget_exceeded', items.length - queueIndex);
            return;
          }

          // Atomically claim next item from queue
          const idx = queueIndex++;
          if (idx >= items.length) break;
          const item = items[idx];

          // ── Budget / Credit Governor check (Hardening Bloco B) ────────
          // Uses CreditGovernor for route-level credit awareness.
          // Falls back to simple budget check if governor not available.
          // Full mode key (no split) so the per-arm budget bucket matches the
          // armBudgets keys above — one budget per ARM, not per mode-type.
          const armName = getModeKey(item.mode);
          try {
            const { getCreditGovernor } = await import('@/core/budget/credit-governor');
            const governor = getCreditGovernor();
            const provider = extractProviderFromMode(item.mode) ?? 'auto';
            const modelId = extractModelIdFromMode(item.mode) ?? 'auto';
            // Use the ACTUAL task count (`tasks`, resolved above: the filtered
            // indices OR the full EXPERIMENT_SUITE when taskIndices is empty). The
            // prior `config.taskIndices?.length ?? 10` divided by 0 when taskIndices
            // was [] (the "all tasks" sentinel) — `??` does not treat 0 as a miss —
            // making estimatedCost = Infinity, so canExecute reported
            // experiment_budget_exceeded at $0 spend and EVERY worker aborted before
            // a single execution (2026-06-29). Math.max(1,…) is a divide-by-zero belt.
            // Judge-cost headroom: ~one judge call follows every persisted
            // execution and bills the same wallet, so the gate must reserve
            // room for it or the run drifts past the cap by the judge total.
            // No static estimate (no-static rule): use this run's own observed
            // average judge cost per completed execution. 0 until the first
            // completion — the gate self-corrects as real judge costs land.
            // Side effect (accepted): canExecute also applies estimatedCost to
            // the per-arm bucket, so each arm stops ~one avg-judge-cost early —
            // negligible next to arm budgets and on the safe side of the cap.
            const judgeHeadroomUsd = progress.completed > 0
              ? (progress.judgeCostUsd ?? 0) / progress.completed
              : 0;
            const estimatedCost =
              config.maxBudgetUsd /
              Math.max(1, config.modes.length * (config.repetitions ?? 1) * tasks.length) +
              judgeHeadroomUsd;

            const creditCheck = governor.canExecute(provider, modelId, estimatedCost, armName);
            if (!creditCheck.canProceed) {
              if (creditCheck.reason === 'structural_failure') {
                log.error({ experimentId, queueType, reason: creditCheck.reason }, 'Structural failure — all external routes exhausted');
                // Don't abort entire experiment — try self-hosted fallback in executeSingleRun
              } else if (creditCheck.reason === 'experiment_budget_exceeded') {
                log.warn({ experimentId, totalCost: governor.getTotalSpendUsd(), budget: config.maxBudgetUsd, queueType }, 'Budget exceeded — aborting worker');
                budgetExhausted = true;
                recordSkip(progress, 'experiment_budget_exceeded', items.length - idx);
                return;
              } else if (creditCheck.reason === 'arm_budget_exceeded') {
                log.warn({ experimentId, arm: armName, reason: creditCheck.reason, queueType }, 'Arm budget exhausted — skipping');
                recordSkip(progress, `arm_budget_exceeded:${armName}`, 1);
                continue;
              } else if (creditCheck.reason === 'route_exhausted' || creditCheck.reason === 'route_rate_limited') {
                // Route-level issue — skip this specific dispatch but continue experiment
                log.info({ experimentId, route: creditCheck.routeKey, reason: creditCheck.reason, queueType }, 'Route unavailable — execution will try alternative routes');
                // Don't skip — let executeSingleRun handle cross-provider fallback
              }
            }
          } catch {
            // CreditGovernor not available — fall back to simple budget check.
            // The cap protects the whole wallet, so judge spend counts too
            // (mirrors the governor path, where recordSpend('judge', …) feeds
            // the same totalSpendUsd the global gate checks).
            if (progress.totalCostUsd + (progress.judgeCostUsd ?? 0) >= config.maxBudgetUsd) {
              log.warn({ experimentId, totalCost: progress.totalCostUsd, judgeCost: progress.judgeCostUsd ?? 0, budget: config.maxBudgetUsd, queueType }, 'Budget exceeded — aborting');
              budgetExhausted = true;
              recordSkip(progress, 'experiment_budget_exceeded', items.length - idx);
              return;
            }
            const armBudget = config.maxBudgetUsd / config.modes.length;
            const armSpent = progress.totalCostUsd * (1 / config.modes.length);
            if (armSpent >= armBudget) {
              log.warn({ experimentId, arm: armName, armSpent, armBudget, queueType }, 'Arm budget exhausted — skipping');
              recordSkip(progress, `arm_budget_exceeded:${armName}`, 1);
              continue;
            }
          }

          // Phase management (based on completed count)
          const warmupLimit = config.warmupExecutions ?? 0;
          const sanityLimit = Math.min(Math.ceil(warmupLimit * 0.1), 100);
          let currentPhase: ExperimentPhase;
          if (progress.completed < sanityLimit && warmupLimit > 0) {
            currentPhase = 'sanity-check';
          } else if (warmupLimit > 0 && progress.warmupCompleted < warmupLimit) {
            currentPhase = 'warmup';
          } else {
            currentPhase = 'frozen';
          }

          // Detect phase transitions
          if (currentPhase !== progress.currentPhase) {
            if (currentPhase === 'warmup' && progress.currentPhase === 'sanity-check') {
              log.info({ experimentId, sanityCompleted: progress.completed }, 'Sanity check passed — transitioning to warm-up');
            } else if (currentPhase === 'frozen' && (progress.currentPhase === 'warmup' || progress.currentPhase === 'sanity-check')) {
              log.info({ experimentId, warmupCompleted: progress.warmupCompleted }, 'Warm-up complete — transitioning to frozen evaluation phase');
              if (config.freezeLearningDuringEval ?? true) {
                log.info({ experimentId }, 'Learning systems frozen for measurement phase');
              }
            }
            progress.currentPhase = currentPhase;
          }

          // Provider-level rate limiting: extract provider from mode config
          const provider = extractProviderFromMode(item.mode);
          if (provider) await providerRateLimiter.acquire(provider);

          try {
            // Execute with retry
            const freezeHeader = currentPhase === 'frozen' && (config.freezeLearningDuringEval ?? true);
            const result = await executeSingleRunWithRetry(experimentId, item.task, item.mode, item.rep, currentPhase, freezeHeader);

            // Record in DB (Prisma is concurrency-safe). Pass the originating
            // ModeConfig so persistExecution can run policy-aware integrity
            // validation and persist the result in structuredMetadata.
            await persistExecution(result, item.mode);
            completedSet.add(item.completionKey);

            // Record spend in CreditGovernor (route-level tracking)
            if (result.costUsd > 0) {
              try {
                const { getCreditGovernor } = await import('@/core/budget/credit-governor');
                const provider = extractProviderFromMode(item.mode) ?? 'auto';
                const modelId = extractModelIdFromMode(item.mode) ?? result.model ?? 'auto';
                getCreditGovernor().recordSpend(provider, modelId, result.costUsd, armName);
              } catch { /* non-critical */ }
            }

            // Judge spend: a SEPARATE accounting line. It must enter the
            // governor's totalSpendUsd (the judge bills the same wallet the
            // maxBudgetUsd cap protects — before this, a run could overspend
            // by the entire judge total invisibly) but NEVER the arm buckets:
            // the judge is arm-neutral instrumentation, and folding its cost
            // into an arm's costUsd would pollute the cross-arm
            // cost-effectiveness comparison the experiment exists to make.
            // armKey 'judge' has no entry in computeArmBudgets(config), so it
            // can never trip arm_budget_exceeded — it only feeds the global gate.
            const judgeCostUsd = result.judgeCostUsd ?? 0;
            if (judgeCostUsd > 0) {
              try {
                const { getCreditGovernor } = await import('@/core/budget/credit-governor');
                getCreditGovernor().recordSpend('judge', result.judgeModelId ?? JUDGE_IDENTITY.modelId, judgeCostUsd, 'judge');
              } catch { /* non-critical */ }
            }

            // Update progress (synchronized via single-threaded JS event loop)
            progress.completed++;
            progress.totalCostUsd += result.costUsd;
            progress.judgeCostUsd = (progress.judgeCostUsd ?? 0) + judgeCostUsd;
            progress.lastCompletedAt = new Date().toISOString();
            progress.currentTaskIndex = item.task.index;
            progress.currentMode = getModeType(item.mode);
            progress.currentRepetition = item.rep;
            if (!result.success) progress.errors++;
            if (currentPhase === 'warmup' || currentPhase === 'sanity-check') progress.warmupCompleted++;
            else progress.frozenCompleted++;

            // Persist progress checkpoint every 10 executions
            if (progress.completed % 10 === 0) {
              await updateProgress(experimentId, progress);
            }
          } finally {
            if (provider) providerRateLimiter.release(provider);
          }

          // Delay between calls (per worker)
          if (config.delayBetweenCallsMs > 0) {
            await sleep(config.delayBetweenCallsMs);
          }
        }
      };

      // Launch N parallel workers for this queue
      if (effectiveWorkers <= 1) {
        await runWorker(0);
      } else {
        log.info({ experimentId, workers: effectiveWorkers, queueType, items: items.length }, 'Launching queue workers');
        const workers = Array.from({ length: effectiveWorkers }, (_, i) => runWorker(i));
        await Promise.all(workers);
      }
    };

    // ── Run all queues in parallel, each with its own worker pool ─────
    await Promise.all(
      Object.entries(queues).map(([type, queue]) =>
        runQueueWorkers(queue.items, queue.maxWorkers, type),
      ),
    );

    // Experiment completed
    const durationMs = Date.now() - startTime;
    if ((progress.skipped ?? 0) > 0) {
      log.warn(
        { experimentId, skipped: progress.skipped, skipReasons: progress.skipReasons, completed: progress.completed, planned: progress.total },
        'Experiment completed WITH SKIPS — plan not fully executed (see skipReasons)',
      );
    }
    log.info({ experimentId, completed: progress.completed, skipped: progress.skipped ?? 0, totalCost: progress.totalCostUsd, judgeCost: progress.judgeCostUsd ?? 0, durationMs }, 'Experiment completed');
    await finalizeExperiment(experimentId, 'completed', progress);
  } catch (err) {
    log.error({ error: String(err), experimentId }, 'Experiment loop error');
    await finalizeExperiment(experimentId, 'failed', progress);
  } finally {
    if (activeExperiment?.experimentId === experimentId) {
      activeExperiment = null;
    }
  }
}

// ─── Retry Wrapper ────────────────────────────────────────────────────────

const RETRY_DELAYS = [5_000, 15_000]; // 3 total attempts: immediate + 5s + 15s

async function executeSingleRunWithRetry(
  experimentId: string,
  task: typeof EXPERIMENT_SUITE[number],
  mode: ModeConfig,
  repetition: number,
  phase: ExperimentPhase,
  freezeLearning: boolean,
): Promise<ExperimentExecutionResult> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const result = await executeSingleRun(experimentId, task, mode, repetition, phase, freezeLearning);
    if (result.success) return result;

    // Only retry transient errors, not client errors (4xx)
    const summary = result.responseSummary ?? '';
    const isTransient = /status 5|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|status 429|rate[._-]limit|fetch failed|Failed to fetch|NetworkError|socket hang up/i.test(summary);
    if (!isTransient || attempt >= RETRY_DELAYS.length) return result;

    log.warn({
      task: task.index,
      mode: getModeType(mode),
      attempt: attempt + 1,
      nextDelayMs: RETRY_DELAYS[attempt],
      error: summary.slice(0, 150),
    }, 'Transient error — retrying');
    await sleep(RETRY_DELAYS[attempt]);
  }
  // Unreachable, but TypeScript needs it
  return buildFailedResult(experimentId, task, mode, repetition, 0, phase, 'All retries exhausted');
}

// ─── Single Execution ──────────────────────────────────────────────────────

async function executeSingleRun(
  experimentId: string,
  task: typeof EXPERIMENT_SUITE[number],
  mode: ModeConfig,
  repetition: number,
  phase: ExperimentPhase = 'frozen',
  freezeLearning: boolean = false,
): Promise<ExperimentExecutionResult> {
  // F3.2 — Adversarial scenario synthetic dispatch.
  // When the mode carries an `adversarialScenario` tag (set by
  // `buildC3AdversarialRobustness`), short-circuit the HTTP path and
  // run the deterministic synthetic-signal pipeline. No model calls,
  // no API budget — measures detector accuracy against canned
  // attack patterns.
  const { isAdversarialScenarioMode, runAdversarialScenarioSynthetic } = await import('./adversarial-scenario-runner');
  if (isAdversarialScenarioMode(mode)) {
    return runAdversarialScenarioSynthetic({
      experimentId,
      task,
      mode,
      repetition,
      phase,
      scenario: mode.adversarialScenario,
    });
  }

  const requestParams = buildRequestParams(mode);
  let { model, strategy } = requestParams;
  const startMs = Date.now();

  // ── Pre-dispatch validation + degradation (Hardening Blocos E+F) ──────
  // Check if the ecosystem can support this execution BEFORE making any
  // API calls. This prevents the 156 "requires at least N models" errors
  // observed in the C3 pilot by catching predictable failures early.
  try {
    const { validatePreDispatch, validatePreDispatchWithPool } = await import('./pre-dispatch-validator');
    const { resolveWithDegradation, getMinModels } = await import('@/core/orchestration/strategy-degradation');
    const { getStrategyTierConfig } = await import('@/core/orchestration/strategy-tiers');
    const { getChatEligibleModels } = await import('@/services/model-catalog-service');

    const chatPool = await getChatEligibleModels();
    const tierConfig = getStrategyTierConfig(strategy || 'single');
    const minModels = getMinModels(strategy || 'single');

    // Use PoolBuilder-enhanced validator when available (provides stage-level diagnostics)
    let preCheck;
    try {
      const { buildChatExecutionPool } = await import('@/core/pool/pool-builder');
      const poolResult = buildChatExecutionPool(chatPool, 0.4);
      preCheck = validatePreDispatchWithPool({
        strategyName: strategy || 'single',
        strategyMinModels: minModels,
        strategyTimeoutMs: tierConfig.timeoutMultiplier * 300_000,
        taskType: task.taskType,
        complexity: task.complexity,
        chatEligiblePoolSize: poolResult.poolSize,
      }, poolResult);
      log.debug({
        strategy,
        poolSize: poolResult.poolSize,
        selfHosted: poolResult.selfHostedAvailable,
        providers: poolResult.providerDiversity,
        stages: poolResult.stages.map(s => `${s.name}:${s.inputCount}→${s.outputCount}`).join(','),
      }, 'Pre-dispatch pool analysis');
    } catch {
      // Fallback to basic validator
      preCheck = validatePreDispatch({
        strategyName: strategy || 'single',
        strategyMinModels: minModels,
        strategyTimeoutMs: tierConfig.timeoutMultiplier * 300_000,
        taskType: task.taskType,
        complexity: task.complexity,
        chatEligiblePoolSize: chatPool.length,
      });
    }

    if (!preCheck.canProceed) {
      // Attempt degradation chain before giving up
      const degradation = resolveWithDegradation(
        strategy || 'single',
        chatPool.length,
        preCheck.skipReason || 'pre_dispatch_failed',
      );

      if (degradation.isDegraded) {
        log.info({
          original: strategy,
          degradedTo: degradation.executedStrategy,
          reason: degradation.degradationReason,
          path: degradation.degradationPath,
          poolSize: chatPool.length,
        }, 'Strategy degraded via pre-dispatch validation');
        strategy = degradation.executedStrategy;
        // Re-validate with degraded strategy
      } else {
        // No viable degradation — check self-hosted last-resort before giving up
        // (Hardening Bloco C: self-hosted only when ALL external routes exhausted)
        try {
          const { evaluateLastResort, buildLastResortMetadata } = await import('@/core/resilience/last-resort-policy');
          const lastResort = evaluateLastResort(preCheck.eligibleModelCount, chatPool);
          if (lastResort.activated && lastResort.fallbackModels.length > 0) {
            const fallbackModel = lastResort.fallbackModels[0];
            log.warn({
              strategy,
              fallbackModel: fallbackModel.id,
              reason: lastResort.reason,
            }, 'All external exhausted — activating self-hosted last-resort fallback');

            // `meta` is reserved here for the responseSummary append (see
            // comment below); preserved for the planned wiring without
            // failing lint via underscore prefix.
            const _meta = buildLastResortMetadata(fallbackModel, lastResort.reason);
            // Execute via self-hosted but tag as last-resort
            model = fallbackModel.id;
            strategy = 'single'; // self-hosted always uses single strategy
            // The metadata will be appended in responseSummary below
            void _meta;
          }
        } catch { /* last-resort policy not available — proceed to skip */ }

        // Still no viable path — record as skip
        log.warn({
          strategy,
          skipReason: preCheck.skipReason,
          detail: preCheck.skipDetail,
          poolSize: chatPool.length,
          usableProviders: preCheck.usableProviders.length,
        }, 'Execution skipped — pre-dispatch validation failed, no degradation possible');

        return {
          experimentId,
          taskIndex: task.index,
          repetition,
          executionMode: getModeType(mode),
          strategy: strategy || 'single',
          model: model || 'auto',
          taskType: task.taskType,
          complexity: task.complexity,
          domain: task.domain || 'general',
          prompt: task.prompt,
          qualityScore: 0,
          costUsd: 0,
          latencyMs: Date.now() - startMs,
          totalTokens: 0,
          success: false,
          modelsUsed: [],
          phase,
          judgeScore: null,
          judgeRubric: task.judgeRubric,
          faithfulnessScore: null,
          instructionFollowingScore: null,
          failureMode: 'skipped-predispatch',
          responseSummary: `[SKIPPED] ${preCheck.skipReason}: ${preCheck.skipDetail}`,
          ablationDisabled: mode.mode === 'ablation' ? mode.disableComponents : [],
          ablationCondition: mode.mode === 'ablation' ? `-${mode.disableComponents.join('-')}` : null,
          scoringPolicy: null,
          judgeUsed: false,
          heuristicScoreRaw: null,
          armKey: getModeKey(mode), // resume-stable arm identity (review F9)
        };
      }
    }
  } catch (preDispatchErr) {
    // Pre-dispatch is non-critical — if it fails, proceed with original strategy
    log.debug({ error: String(preDispatchErr) }, 'Pre-dispatch validation failed (non-critical, proceeding)');
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${API_CONFIG.bearerToken}`,
      'Content-Type': 'application/json',
      // Anti-cache: ensure every experiment execution is a fresh inference
      'X-No-Cache': 'true',
      'X-Experiment-Run': 'true',
    };
    // Signal the orchestration engine to freeze learning during frozen evaluation.
    // The header is kept for backwards compat but is INERT server-side (no route
    // reads it); the effective signal is the body flag `freeze_learning` set below.
    if (freezeLearning) {
      headers['X-Experiment-Freeze-Learning'] = 'true';
    }
    // C3 P0.2: Signal ablation mode to the orchestration engine
    if (mode.mode === 'ablation' && mode.disableComponents.length > 0) {
      headers['X-Ablation-Disable'] = mode.disableComponents.join(',');
    }

    // Build request body with strategy-specific fields
    const requestBody: Record<string, unknown> = {
      model,
      strategy,
      no_cache: true,
      messages: [{ role: 'user', content: task.prompt }],
      // C3 P0.4: Force benchmark scoring policy
      scoring_policy: 'benchmark',
      // Full-flow capture: every subcall (voter/coordinator/synthesis) returns
      // its actual output text + extracted reasoning + prompt-variant
      // provenance, persisted per row in structuredMetadata.subcalls — the
      // benchmark must be auditable from input through the WHOLE strategy
      // flow, not just the final answer and per-subcall cost/latency.
      include_subcall_content: true,
      // Freeze learning during the frozen phase (body flag — the header is inert
      // server-side). Keeps the measured system fixed so cross-phase comparisons
      // are not contaminated by mid-run bandit/learning drift.
      ...(freezeLearning ? { freeze_learning: true } : {}),
    };
    // Output ceiling: only send an explicit max_tokens when the operator forced
    // one (task/env). Otherwise OMIT it so the engine derives the ceiling from
    // the selected model's own maxOutputTokens (frontier-parity, per-model, no
    // static pin) instead of the runner guessing a number it can't know.
    const taskMaxTokens = resolveTaskMaxTokens(task);
    if (taskMaxTokens !== undefined) requestBody.max_tokens = taskMaxTokens;
    if (requestParams.quality_target != null) requestBody.quality_target = requestParams.quality_target;
    if (requestParams.ailin_constraints) requestBody.ailin_constraints = requestParams.ailin_constraints;

    // C3 P0.2: Pass ablation disable list in request body
    if (mode.mode === 'ablation' && mode.disableComponents.length > 0) {
      requestBody.ablation_disable = mode.disableComponents;
    }

    // Strategy-specific: task-level strategy override takes precedence — but
    // ONLY when the value is accepted by the chat schema (2026-07-04, c3-v4
    // defect B leg 1): tasks carrying strategy 'compositor' (95, 96, 112-115)
    // are not a valid /v1/chat/completions strategy enum member, so the
    // override 400'd EVERY arm on those tasks (33 arms × 6 tasks × reps —
    // the bulk of the run's 'Request validation failed' rows). Schema-invalid
    // task strategies now leave the arm's own strategy in place.
    //
    // AND never override a SINGLE arm's strategy (review F11): applying a task's
    // collective strategy (e.g. 'debate') to a single-model/single-budget arm
    // silently turns that "single" into a collective run, contaminating the very
    // single-vs-collective attribution the experiment measures. A single arm
    // must always run as its one model; only collective-family arms adopt the
    // task's strategy.
    if (shouldApplyTaskStrategyOverride(mode, task.strategy)) {
      requestBody.strategy = task.strategy;
    }

    // Best-of-N (#2): forward the task's objective answer check so the
    // collective can SELECT the checker-verified candidate over the LLM judge.
    // Merges into any existing ailin_constraints without clobbering it.
    if (task.answerCheck) {
      const existing = (requestBody.ailin_constraints as Record<string, unknown> | undefined) ?? {};
      requestBody.ailin_constraints = {
        ...existing,
        answer_check: task.answerCheck,
        ...(task.answerCheckAmong ? { answer_check_among: task.answerCheckAmong } : {}),
        ...(task.answerCheckScope ? { answer_check_scope: task.answerCheckScope } : {}),
        // Completion signals travel with the check so the collective's SELECTION
        // is held to the same completeness gates as the grading (a token-cap-
        // clipped candidate must not be picked as "verified").
        ...(task.answerCheckCompletionAnyOf?.length
          ? { answer_check_completion_any_of: task.answerCheckCompletionAnyOf }
          : {}),
      };
    }

    // Compositor: pass strategyPipeline or strategyWorkflow from task config
    if (task.strategyConfig?.strategyPipeline) {
      requestBody.strategyPipeline = task.strategyConfig.strategyPipeline;
    }
    if (task.strategyConfig?.strategyWorkflow) {
      requestBody.strategyWorkflow = task.strategyConfig.strategyWorkflow;
    }

    // Tool-calling: forward the task's tool spec so the model must decide to call
    // a function. The FINAL result is graded objectively via answer_check (only
    // reachable by actually calling the tool).
    if (task.tools && task.tools.length > 0) {
      // Register the deterministic benchmark tools FIRST (idempotent) so the
      // server's agentic loop (base-strategy.executeModelWithTools) can actually
      // EXECUTE them via the registry and feed the real (fictional) datum back —
      // without this the loop would only feed an "unknown tool" error back and no
      // model could ever reach the checked answer.
      await registerExperimentBenchmarkTools();
      requestBody.tools = task.tools;
      requestBody.tool_choice = task.toolChoice ?? 'auto';
      // Require function_calling so a model that cannot call tools is never
      // selected for a tool task (it would fail the task for the wrong reason).
      const existing = (requestBody.ailin_constraints as Record<string, unknown> | undefined) ?? {};
      const existingCaps = Array.isArray(existing.requiredCapabilities)
        ? (existing.requiredCapabilities as string[])
        : [];
      requestBody.ailin_constraints = {
        ...existing,
        requiredCapabilities: [...new Set([...existingCaps, 'chat', 'function_calling'])],
      };
    }

    const fetchTimeout = AbortSignal.timeout(300_000); // 5 min per execution
    const resp = await fetch(API_CONFIG.apiBase, {
      method: 'POST',
      headers,
      signal: fetchTimeout,
      body: JSON.stringify(requestBody),
    });

    const latencyMs = Date.now() - startMs;
    const json = await resp.json() as {
      error?: { message?: string; code?: string; details?: unknown };
      model?: string;
      choices?: Array<{
        message?: { content?: string; tool_calls?: ObservedToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
      ailin_metadata?: {
        strategy_used?: string;
        models_used?: string[];
        model_count?: number;
        execution_time_ms?: number;
        cost_usd?: number;
        resolved_strategy?: string;
        resolved_model?: string;
        final_decider_model_id?: string;
        final_decider_model_name?: string;
        final_decider_role?: string;
        fallback_chain?: string[];
        quality_score?: number;
        cache_hit?: boolean;
      };
    };

    if (json.error || !resp.ok) {
      // Failure taxonomy (2026-07-04, c3-v4 defect D): persist the HTTP status
      // + machine-readable code + details, not just the human message. The old
      // shape collapsed ALL 1138 v4 failures into the opaque string 'Request
      // validation failed', making provider-funding errors (402/403/429)
      // indistinguishable from harness schema bugs (400). With the status in
      // the text, classifyFailureMode's existing substring checks fire on the
      // real code and the go/no-go error segregation becomes auditable.
      const apiErr = json.error;
      const detail =
        apiErr?.details !== undefined ? ` details=${JSON.stringify(apiErr.details).slice(0, 300)}` : '';
      const errorText = `HTTP ${resp.status} [${apiErr?.code ?? 'no_code'}] ${apiErr?.message ?? 'no message'}${detail}`;
      log.warn(
        { task: task.index, mode: getModeType(mode), strategy, status: resp.status, code: apiErr?.code, error: errorText },
        'Execution failed',
      );
      return buildFailedResult(experimentId, task, mode, repetition, latencyMs, phase, errorText);
    }

    const responseMessage = json.choices?.[0]?.message;
    const content = responseMessage?.content ?? '';
    const observedToolCalls = responseMessage?.tool_calls;
    const isToolTask = isToolCallingTask(task);
    // A tool task may legitimately return empty content when a path surfaces the
    // raw tool_calls without executing the loop — don't treat that as a failure.
    if (!content && !(isToolTask && observedToolCalls && observedToolCalls.length > 0)) {
      return buildFailedResult(experimentId, task, mode, repetition, latencyMs, phase, 'Empty response content');
    }
    // The orchestration engine fabricates this placeholder (200 OK, non-empty
    // content) when every provider attempt failed — without this check it
    // sails through as success:true with 0 tokens (DEGRADED-as-success defect).
    if (content.startsWith('[DEGRADED]')) {
      return buildFailedResult(experimentId, task, mode, repetition, latencyMs, phase, 'Degraded placeholder response — all execution attempts failed upstream');
    }

    // Truncation signal: finish_reason='length' means the reply was cut at the
    // token cap — for 'full'-scope structural checks (canvas) that MUST grade 0,
    // not 1 (the needles all sit in the first few hundred bytes of the file, so
    // a clipped, non-runnable file still contains them). Absent/unknown
    // finish_reason is treated as not-truncated; the completion-signal gate in
    // gradeObjectiveAnswer covers providers that never report it.
    const finishReason = json.choices?.[0]?.finish_reason ?? null;
    const truncated = finishReason === 'length';
    if (truncated) {
      log.warn(
        { task: task.index, mode: getModeType(mode), strategy, finishReason },
        'Response truncated at token cap — full-scope objective checks will score 0',
      );
    }

    // Score the response. Prefer OBJECTIVE signals over the fuzzy judge where the
    // task provides them: executed-code pass rate (codeTest) is authoritative;
    // tool-calling tasks are graded on the tool evidence; long-generation length
    // compliance is blended with the judge.
    const scored = await scoreResponse(content, task, truncated, observedToolCalls);
    // A failed judge is NOT a measurement (review F2): void qualityScore and
    // judgeScore, keep the length heuristic only in heuristicScoreRaw. A null
    // qualityScore is cleanly excluded by every paired/pooled analysis (they all
    // filter `qualityScore != null`), exactly like a missing measurement should
    // be — a length proxy must never enter the quality means.
    const qualityScore: number | null = scored.judgeFailed ? null : scored.score;
    // judgeScore is only meaningful when the LLM judge actually produced it;
    // for objective grades (answer_check / code_execution / tool_call) there is no judge.
    const judgeScoreCol: number | null = scored.scoreSource === 'llm_judge' ? scored.score : null;
    const heuristicScoreRaw: number | null = scored.judgeFailed ? scored.score : null;

    // Extract metadata from ailin_metadata (the correct field)
    const meta = json.ailin_metadata as Record<string, unknown> | undefined;
    const actualStrategy = (meta?.resolved_strategy ?? meta?.strategy_used ?? strategy) as string;
    const modelsUsed = (meta?.models_used ?? []) as string[];
    const resolvedModel = (meta?.resolved_model ?? json.model ?? null) as string | null;
    const usage = json.usage as Record<string, number> | undefined;
    const totalTokens = usage?.total_tokens ?? 0;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const reportedCost = Number(meta?.cost_usd ?? 0);
    // Use reported cost if available; otherwise estimate from DB model pricing
    const costUsd = reportedCost > 0
      ? reportedCost
      : await lookupModelCost(
          resolvedModel ?? model,
          promptTokens,
          completionTokens,
        );
    const finalDecider = (meta?.final_decider_model_id ?? null) as string | null;
    const fallbackChain = (meta?.fallback_chain ?? []) as string[];
    const cacheHit = (meta?.cache_hit ?? false) as boolean;

    // Per-subcall decomposition — cost/latency AND, under
    // include_subcall_content (set above), the full intra-collective
    // transcript: each voter/coordinator's output text, extracted reasoning,
    // and prompt-variant provenance.
    const subcalls = (meta?.subcalls ?? []) as Array<{
      model_id: string; model_name: string; role: string;
      cost_usd: number; latency_ms: number; success: boolean;
      error: string | null; tokens: Record<string, number> | null;
      content?: string | null; reasoning?: string | null;
      prompt_key?: string | null; prompt_variant_id?: string | null;
      content_truncated?: boolean;
    }>;
    const decisionSource = (meta?.decision_source ?? null) as string | null;

    // Build rich summary: response preview + execution metadata
    const subcallSummary = subcalls.length > 0
      ? subcalls.map(s => `${s.role}:${s.model_name}($${s.cost_usd?.toFixed(4) ?? '?'}/${s.latency_ms}ms)`).join(', ')
      : 'no-subcall-data';
    // Best-of-N observability (#2): how the collective selected its answer and
    // what the objective checker saw — makes H-A adjudicable from the benchmark
    // row alone (aggregation 'verified_individual' = checker override fired).
    const aggregationMethod = (meta?.aggregation_method ?? null) as string | null;
    const verification = (meta?.verification ?? null) as {
      decision: string; method: string; confidence: number;
      verified_count: number; total_count: number; verified_model_id: string | null;
    } | null;
    const metaSummary = [
      `[models: ${modelsUsed.length > 0 ? [...new Set(modelsUsed)].join(', ') : resolvedModel ?? 'unknown'}]`,
      `[decider: ${finalDecider ?? resolvedModel ?? 'N/A'}]`,
      `[subcalls: ${subcallSummary}]`,
      `[source: ${decisionSource ?? 'unknown'}]`,
      `[chain: ${fallbackChain.length > 0 ? fallbackChain.join(' → ') : 'direct'}]`,
      aggregationMethod ? `[aggregation: ${aggregationMethod}]` : '',
      verification
        ? `[verified: ${verification.decision}/${verification.method} ${verification.verified_count}/${verification.total_count}${verification.verified_model_id ? ` by ${verification.verified_model_id}` : ''}]`
        : '',
      cacheHit ? '[CACHE HIT]' : '',
      scored.scoreSource === 'tool_call'
        ? `[tool-grade: objective → ${scored.score}]`
        : '',
    ].filter(Boolean).join(' ');
    const fullSummary = `${metaSummary}\n---\n${content}`;

    log.info({
      task: task.index,
      taskType: task.taskType,
      mode: getModeType(mode),
      strategy: actualStrategy,
      rep: repetition,
      qualityScore: qualityScore != null ? qualityScore.toFixed(3) : 'void(judge-failed)',
      scoreSource: scored.scoreSource,
      latencyMs,
      costUsd: costUsd.toFixed(4),
      judgeCostUsd: scored.judgeCostUsd.toFixed(4),
      modelsCount: modelsUsed.length,
      resolvedModel,
      finalDecider,
      cacheHit,
    }, 'Execution completed');

    return {
      experimentId,
      taskIndex: task.index,
      repetition,
      executionMode: getModeType(mode),
      strategy: actualStrategy,
      model: (mode.mode === 'single-model' || mode.mode === 'single-budget') ? mode.modelId : (resolvedModel ?? null),
      taskType: task.taskType,
      complexity: task.complexity,
      domain: task.domain,
      prompt: task.prompt,
      qualityScore,
      costUsd,
      judgeCostUsd: scored.judgeCostUsd,
      latencyMs,
      totalTokens,
      success: true,
      modelsUsed: [...new Set(modelsUsed)], // deduplicate
      judgeScore: judgeScoreCol,
      judgeRubric: task.judgeRubric,
      faithfulnessScore: null,
      instructionFollowingScore: null,
      failureMode: null,
      phase,
      responseSummary: fullSummary, // Full response stored (TEXT field, no truncation)
      // C3: Ablation metadata
      ablationDisabled: mode.mode === 'ablation' ? mode.disableComponents : [],
      ablationCondition: mode.mode === 'ablation'
        ? (mode.disableComponents.length > 0 ? `-${mode.disableComponents.join('-')}` : 'full')
        : null,
      scoringPolicy: 'benchmark',
      judgeUsed: scored.judgeUsed,
      judgeFailed: scored.judgeFailed,
      scoreSource: scored.scoreSource,
      judgeMode: JUDGE_IDENTITY.mode,
      judgeModelId: scored.judgeModelId ?? (scored.judgeUsed ? JUDGE_IDENTITY.modelId : null),
      heuristicScoreRaw,
      armKey: getModeKey(mode), // resume-stable arm identity (review F9)
      subcalls: subcalls.length > 0 ? subcalls : undefined,
    };
  } catch (err) {
    const errorText = String(err);
    log.warn({ error: errorText, task: task.index, mode: getModeType(mode) }, 'Execution error');
    return buildFailedResult(experimentId, task, mode, repetition, Date.now() - startMs, phase, errorText);
  }
}

// ─── Response scoring (objective-first) ──────────────────────────────────────

/** Extract a fenced code block (```lang ... ```), else return the whole content. */
function extractCode(content: string): string {
  const fence = content.match(/```(?:[a-zA-Z0-9_+-]*)\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return content.trim();
}

/** Word count over the visible text (ignores the metadata prefix the runner adds). */
function countWords(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

/**
 * Score a response, preferring OBJECTIVE signals over the fuzzy LLM judge:
 *  - codeTest → EXECUTE the code in the sandbox; score = passedCases/totalCases.
 *  - minWords/maxWords → blend the judge score with a length-compliance factor.
 *  - otherwise → the LLM judge alone.
 */
interface ScoreOutcome {
  score: number;
  judgeUsed: boolean;
  judgeFailed: boolean;
  scoreSource: NonNullable<ExperimentExecutionResult['scoreSource']>;
  judgeModelId: string | null;
  /** Billable judge cost for scoring this response; 0 on objective paths. */
  judgeCostUsd: number;
}

/**
 * Objective grade for a task carrying an `answer_check`: 1 when the checker
 * passes, 0 when it fails, `null` when the task has no check OR its spec is
 * structurally unresolvable (the caller then falls back to the LLM judge — a
 * broken check must WITHHOLD, never fabricate a 1.0). PURE, no I/O; uses the
 * SAME resolver the collective's best-of-N uses, so single and collective arms
 * are graded by one instrument. Exported for unit testing. (review TS-04)
 *
 * `truncated` (finish_reason='length') zeroes 'full'-scope grades: a structural
 * check's needles sit near the START of the artifact (a canvas file emits all
 * three in its first few hundred bytes), so a reply clipped at the token cap
 * still contains them while being non-runnable. 'final'-scope grades are
 * unaffected — a FINAL line that survived the cut is still the model's answer.
 */
export function gradeObjectiveAnswer(
  content: string,
  task: ExperimentTask,
  truncated = false,
): number | null {
  if (!task.answerCheck) return null;
  const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec);
  if (!checker) return null;
  if (task.answerCheckScope === 'full') {
    // 'full' scope inspects the entire reply (canvas structural check). Two
    // completeness gates before the needles get a say:
    //  (a) provider-reported truncation — the file is broken by definition;
    //  (b) declared completion signals (closing tags) — covers providers that
    //      omit finish_reason AND fails prose-only replies that merely name
    //      the needle APIs without emitting a file.
    if (truncated) return 0;
    const signals = task.answerCheckCompletionAnyOf;
    if (signals && signals.length > 0) {
      const hay = content.toLowerCase();
      if (!signals.some((s) => hay.includes(String(s).toLowerCase()))) return 0;
    }
    return checker(content) ? 1 : 0;
  }
  // 'final' (default) inspects the extracted FINAL: line, falling back to the
  // whole reply when no FINAL line is present.
  const candidate = extractFinalAnswer(content) ?? content;
  return checker(candidate) ? 1 : 0;
}

async function scoreResponse(
  content: string,
  task: ExperimentTask,
  truncated = false,
  toolCalls?: ReadonlyArray<ObservedToolCall>,
): Promise<ScoreOutcome> {
  // 0) Tool-calling tasks (capability #4): objective TOOL evidence, no judge.
  // Must precede the generic answer_check branch below: these tasks carry an
  // answerCheck too, but tool_calls are an ADDITIONAL objective signal that the
  // generic path structurally cannot see (it only receives `content`). The
  // grader ORs them: answer_check on the post-loop FINAL answer (the server's
  // agentic loop consumes the calls and returns the grounded answer) OR a raw
  // tool_call matching the expected function+args (when a path returns the call
  // un-consumed). The tools return FICTIONAL data, so a blind answer scores 0.
  if (isToolCallingTask(task)) {
    const g = gradeToolCallingResponse(task, { content, toolCalls });
    log.info(
      {
        task: task.index,
        objectiveScore: g.objectiveScore,
        method: g.method,
        answerMatched: g.answerMatched,
        toolMatched: g.toolMatched,
        finalAnswer: g.finalAnswer.slice(0, 60),
      },
      'Tool-calling task graded objectively',
    );
    return {
      score: g.objectiveScore,
      judgeUsed: false,
      judgeFailed: false,
      scoreSource: 'tool_call',
      judgeModelId: null,
      judgeCostUsd: 0, // objective grade — no judge was called
    };
  }

  // 1) Executed-code tasks: objective pass rate, no judge.
  if (task.codeTest) {
    try {
      const { CodeExecutionService } = await import('@/services/code-execution-service');
      const svc = new CodeExecutionService();
      // HumanEval-style native harness: concatenate the model's code, the
      // dataset's own check(candidate) harness, and a zero-arg wrapper that
      // returns True iff every assert passes. Reuses the EXACT structured
      // sandbox path with a single {args:[],expected:true} vector — score is
      // 1.0 (all asserts pass) or 0.0, a faithful binary pass@1 that runs
      // HumanEval's harness unmodified (no float/tuple-comparison lossiness).
      const isNativeHarness = typeof task.codeTest.checkSource === 'string' && !!task.codeTest.entryPoint;
      const code = isNativeHarness
        ? `${extractCode(content)}\n\n${task.codeTest.checkSource}\n\ndef __ailin_check():\n    check(${task.codeTest.entryPoint})\n    return True\n`
        : extractCode(content);
      const result = await svc.executeCode({
        code,
        language: task.codeTest.language,
        functionName: task.codeTest.functionName,
        tests: task.codeTest.tests as Array<{ args: unknown[]; expected: unknown }>,
        timeoutMs: Number(process.env.EXPERIMENT_CODE_TIMEOUT_MS ?? 10_000),
        // userContext is unused by executeCode (test path); a minimal stub satisfies the type.
        userContext: {} as never,
        requestId: `exp-${task.index}`,
      });
      const t = result.testResult;
      const score = t && t.totalCases > 0 ? t.passedCases / t.totalCases : 0;
      return { score, judgeUsed: false, judgeFailed: false, scoreSource: 'code_execution', judgeModelId: null, judgeCostUsd: 0 };
    } catch (err) {
      log.warn({ task: task.index, error: String(err) }, 'codeTest execution failed — scoring 0');
      return { score: 0, judgeUsed: false, judgeFailed: false, scoreSource: 'code_execution', judgeModelId: null, judgeCostUsd: 0 };
    }
  }

  // 1.5) Objective answer_check: AUTHORITATIVE, no judge (review TS-04). A
  // verifiable task's correctness IS its score — grading it with the fuzzy LLM
  // judge is exactly the leniency that lets a wrong-but-well-reasoned answer
  // score ~0.75 and erases the H-A separation the experiment exists to measure.
  // This is the SAME objective checker the collective uses for best-of-N, so the
  // single arm is now graded by the same instrument as the collective arm.
  // Scoping the check to 'final' (default) inspects the extracted `FINAL:` line;
  // 'full' inspects the entire reply (used by the canvas structural check, which
  // also keeps that regime OFF the judge path entirely — a second guard against
  // the video-intercept hijack).
  const objective = gradeObjectiveAnswer(content, task, truncated);
  if (objective !== null) {
    return { score: objective, judgeUsed: false, judgeFailed: false, scoreSource: 'answer_check', judgeModelId: null, judgeCostUsd: 0 };
  }
  if (task.answerCheck) {
    // Spec present but unresolvable → fall through to the judge rather than
    // silently passing (a broken check must withhold, never fabricate a 1.0).
    log.warn({ task: task.index }, 'answerCheck did not resolve to a checker — falling back to LLM judge');
  }

  // 2) Everything else is judged; long-gen tasks blend in length compliance.
  const judged = await judgeResponse(content, task.judgeRubric);
  const scoreSource: ScoreOutcome['scoreSource'] = judged.judgeFailed ? 'heuristic_fallback' : 'llm_judge';
  if (task.minWords || task.maxWords) {
    const words = countWords(content);
    const min = task.minWords ?? 0;
    const max = task.maxWords ?? Number.POSITIVE_INFINITY;
    // Compliance: 1.0 within [min,max]; degrade proportionally below min (a
    // clipped/short answer is objectively incomplete) and mildly above max.
    let compliance = 1;
    if (words < min) compliance = min > 0 ? words / min : 1;
    else if (words > max) compliance = Math.max(0.5, max / words);
    // Blend: length gates the judge score (an incomplete answer cannot score full).
    return { score: judged.score * compliance, judgeUsed: true, judgeFailed: judged.judgeFailed, scoreSource, judgeModelId: judged.judgeModelId, judgeCostUsd: judged.judgeCostUsd };
  }
  return { score: judged.score, judgeUsed: true, judgeFailed: judged.judgeFailed, scoreSource, judgeModelId: judged.judgeModelId, judgeCostUsd: judged.judgeCostUsd };
}

// ─── LLM-as-Judge ──────────────────────────────────────────────────────────

/** Judge outcome. `judgeFailed` is true only when EVERY retry failed and the
 *  score is the length-based heuristic — the caller MUST NOT record such a score
 *  as a real quality measurement (review F2). `judgeModelId` is the concrete
 *  model that produced the verdict, for the split-brain audit trail (review F1).
 *  `judgeCostUsd` is the billable cost of every judge call made while scoring
 *  this response (retries and a failed dynamic attempt included — money spent
 *  on a verdict that didn't parse is still money spent). It is accounted as a
 *  SEPARATE spend line by the loop, never folded into the arm's costUsd. */
interface JudgeOutcome {
  score: number;
  judgeFailed: boolean;
  judgeModelId: string | null;
  judgeCostUsd: number;
}

/**
 * Billable cost of ONE pinned-path judge HTTP call. Prefers the hub-reported
 * `ailin_metadata.cost_usd` (the same field the main-execution path reads);
 * falls back to DB pricing for the resolved model when the hub omitted it but
 * returned token usage. 0 when neither is available (cost unattributable).
 */
async function extractJudgeCallCost(json: {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  ailin_metadata?: { cost_usd?: number };
}): Promise<number> {
  const reported = Number(json.ailin_metadata?.cost_usd ?? 0);
  if (reported > 0) return reported;
  const promptTokens = json.usage?.prompt_tokens ?? 0;
  const completionTokens = json.usage?.completion_tokens ?? 0;
  if (promptTokens + completionTokens <= 0) return 0;
  try {
    return await lookupModelCost(json.model ?? JUDGE_MODEL_ID, promptTokens, completionTokens);
  } catch {
    return 0;
  }
}

/**
 * Canonicalize a model id for pinned-judge identity comparison: lowercase,
 * strip a trailing variant tag (`:free`/`:paid`/`:beta`…), and expose the
 * segment after the last `/`. The hub echoes the resolved offering id, which
 * may carry a `:free` suffix or a provider prefix the pin didn't
 * (e.g. pin `qwen/qwen3.6-plus:free` vs echoed `qwen3.6-plus`), so a raw
 * `===` would false-negative on legitimate matches.
 */
function canonicalJudgeId(id: string): { full: string; tail: string } {
  const base = id.toLowerCase().trim().replace(/:(free|paid|beta|preview|latest)$/i, '');
  const slash = base.lastIndexOf('/');
  return { full: base, tail: slash >= 0 ? base.slice(slash + 1) : base };
}

/**
 * True when the model that actually answered the judge call is the pinned
 * judge instrument. Compares canonically (see canonicalJudgeId) on both the
 * full id and the post-slash tail, so prefix/suffix drift from the hub
 * doesn't read as a substitution. Exported for unit testing.
 */
export function judgeModelMatchesPin(respondedModelId: string | undefined, pinnedModelId: string): boolean {
  if (!respondedModelId) return false; // unverifiable → treat as NOT the pin (fail-closed)
  const r = canonicalJudgeId(respondedModelId);
  const p = canonicalJudgeId(pinnedModelId);
  return r.full === p.full || r.tail === p.tail;
}

/** Exported for unit testing (judge-cost accounting). */
export async function judgeResponse(content: string, rubric: string): Promise<JudgeOutcome> {
  const MAX_JUDGE_RETRIES = 3;

  // Accumulates the billable cost of EVERY judge call made for this response:
  // the dynamic-cascade attempt (even when it fails and we fall through) and
  // each pinned HTTP attempt (even when its verdict doesn't parse). The wallet
  // is charged per call, not per successful verdict.
  let judgeCostUsd = 0;

  // Pass full response to judge — truncation would penalize completeness unfairly
  const evaluatedContent = content;

  // JUDGE_MODE=dynamic: score with the REAL production judge — the in-process
  // provider-diverse fallback cascade (ba654a5), NOT a pinned HTTP self-call.
  // This is the "validate the system as it runs" path. The case rubric is
  // supplied as the judge's request context so the cascade's generic-criteria
  // prompt still sees it. Falls THROUGH to the pinned HTTP path below if the
  // cascade can't produce a verdict, so a run never stalls on the judge.
  if (JUDGE_MODE === 'dynamic') {
    try {
      const { getQualityScorer } = await import('@/core/quality/quality-scorer.js');
      const response = narrowAs<ChatResponse>({
        id: 'bench-judge', object: 'chat.completion', created: 0, model: 'bench',
        choices: [{ index: 0, message: { role: 'assistant', content: evaluatedContent }, finish_reason: 'stop' }],
      });
      const context = narrowAs<OrchestrationContext>({ taskType: 'analysis', models: [], contextSize: 0 });
      // disable_media_generation: a rubric that mentions "clip"/"render"/"create"
      // must never reroute the judge call into (costly, wrong) media generation.
      const originalRequest = narrowAs<ChatRequest>({
        model: 'auto', disable_media_generation: true,
        messages: [{ role: 'user', content: `Evaluate the response against this rubric:\n${rubric}` }],
      });
      const r = await getQualityScorer().calculatePolicyAwareScore(response, context, undefined, 'benchmark', { originalRequest });
      // The scorer already carries the judge sub-call's billable cost —
      // accumulate it even on fall-through: a failed verdict was still billed.
      judgeCostUsd += Math.max(0, r.judgeCostUsd ?? 0);
      const dynScore = r.judgeScore ?? r.overall;
      if (!r.judgeFailed && r.method === 'llm-judge' && typeof dynScore === 'number') {
        return { score: dynScore, judgeFailed: false, judgeModelId: JUDGE_IDENTITY.modelId, judgeCostUsd };
      }
      log.warn({ judgeFailed: r.judgeFailed, method: r.method }, 'Dynamic judge produced no verdict — falling back to pinned judge path');
    } catch (err) {
      log.warn({ error: String(err) }, 'Dynamic judge errored — falling back to pinned judge path');
    }
  }

  for (let attempt = 0; attempt <= MAX_JUDGE_RETRIES; attempt++) {
    try {
      const resp = await fetch(API_CONFIG.apiBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_CONFIG.bearerToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(60_000), // 60s max — judge should be fast
        body: JSON.stringify({
          // Pinned judge instrument (frozen once at module load — review F1).
          model: JUDGE_MODEL_ID,
          strategy: 'single',
          no_cache: true,
          // Never let a rubric/response containing "clip"/"render"/"create"
          // reroute the judge call into media generation (review TS-01).
          disable_media_generation: true,
          ailin_constraints: {
            requiredCapabilities: ['chat'],
          },
          messages: [
            {
              role: 'system',
              content:
                `You are a strict scoring machine. Return ONLY a canonical Ailin¹ JudgeVerdict JSON. No other text.\n\n` +
                `${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`,
            },
            {
              role: 'user',
              content: `Score this response against the rubric.

RUBRIC: ${rubric}

RESPONSE: ${evaluatedContent}

Return the canonical JudgeVerdict JSON.`,
            },
          ],
        }),
      });

      // Parse HTTP response safely. JSON.parse returns `unknown`; we narrow
      // structurally to keep TS honest about what we're reading.
      const respText = await resp.text();
      type JudgeHttpResponse = {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        ailin_metadata?: { cost_usd?: number };
      };
      let json: JudgeHttpResponse;
      try {
        const parsed: unknown = JSON.parse(respText);
        json = (typeof parsed === 'object' && parsed !== null)
          ? (parsed as JudgeHttpResponse)
          : {};
      } catch {
        log.warn({ attempt, statusCode: resp.status, responsePreview: respText.slice(0, 200) }, 'Judge: HTTP response not JSON');
        continue;
      }

      // Bill the attempt as soon as the response parses — an empty or
      // unparseable verdict below was still a real, charged inference.
      judgeCostUsd += await extractJudgeCallCost(json);

      // Fail-closed pinned-judge guard. The judge dispatches through the
      // /v1/chat/completions router with the pinned id as a SOFT `model`
      // hint: when the pinned model isn't in the operational pool (unfunded/
      // rate-limited), SingleModelStrategy silently falls through to
      // DynamicModelSelector and a DIFFERENT model answers — historically
      // Llama-3.3-70B graded ~74% of a run whose pin was qwen/qwen3.6-plus.
      // A substituted judge is a different scoring instrument, so its score
      // is not comparable across arms. Verify the responder IS the pin; if a
      // concrete-but-different model answered (or the responder is
      // unverifiable), void this attempt and break to the judge-failure path
      // below — the caller then nulls qualityScore (keeping the number only
      // in heuristicScoreRaw). Retrying is pointless (the router will
      // substitute again), so break rather than continue. Only enforced in
      // pinned mode; dynamic mode expects the cascade to pick the model.
      if (JUDGE_MODE === 'pinned' && !judgeModelMatchesPin(json.model, JUDGE_MODEL_ID)) {
        log.warn(
          { attempt, respondedModel: json.model ?? '(none)', pinnedModel: JUDGE_MODEL_ID },
          'Judge: responder is NOT the pinned instrument (silent router substitution) — voiding score',
        );
        break;
      }

      const judgeContent = json.choices?.[0]?.message?.content ?? '';
      if (!judgeContent.trim()) {
        log.warn({ attempt, model: json.model }, 'Judge: empty content');
        continue;
      }

      // J-Final (Lote 4): route through the unified judge normalizer. This
      // accepts canonical JudgeVerdict JSON, markdown-wrapped JSON, legacy
      // dimensional payloads, and the legacy `{score, reasoning}` shape the
      // previous prompt asked for. Any successful normalization returns the
      // [0,1] score directly.
      const verdict = normalizeJudgeOutput(judgeContent, { where: 'experiment-runner.judge' });
      if (verdict) {
        return { score: verdict.score, judgeFailed: false, judgeModelId: json.model ?? JUDGE_MODEL_ID, judgeCostUsd };
      }

      // Last-resort back-compat: plain-number extraction for very old judges.
      const numMatch = judgeContent.match(/(?:score[:\s]*)?(\d+\.?\d*)/i);
      if (numMatch) {
        const raw = parseFloat(numMatch[1]);
        const score = raw > 1 ? raw / 100 : raw;
        log.info({ attempt, model: json.model, rawScore: raw }, 'Judge: extracted score from plain text');
        return { score: Math.max(0, Math.min(1, score)), judgeFailed: false, judgeModelId: json.model ?? JUDGE_MODEL_ID, judgeCostUsd };
      }

      log.warn(
        { attempt, model: json.model, responsePreview: judgeContent.slice(0, 150) },
        'Judge: no canonical verdict or score found in response',
      );
      continue;
    } catch (err) {
      log.warn({ attempt, error: String(err) }, 'Judge call failed');
      continue;
    }
  }

  // Judge failed ALL retries. Return a length-based heuristic BUT flag it as a
  // failure (review F2): the caller voids qualityScore/judgeScore and keeps this
  // number only in heuristicScoreRaw, so a length proxy can never be mistaken
  // for a real judgment in the analysis. Previously this returned 0.6 silently,
  // indistinguishable from a genuine judge score.
  const len = content.trim().length;
  let heuristic: number;
  if (len === 0) heuristic = 0;
  else if (len < 50) heuristic = 0.2;
  else if (len < 200) heuristic = 0.4;
  else if (len < 500) heuristic = 0.5;
  else heuristic = 0.6;
  log.warn({ contentLength: len, heuristic }, 'Judge failed all retries — recording heuristicScoreRaw, voiding qualityScore');
  // judgeCostUsd carries whatever the FAILED attempts still billed (usually 0
  // when every attempt errored before a response; > 0 when responses arrived
  // but no verdict parsed) — failed judging is not free judging.
  return { score: heuristic, judgeFailed: true, judgeModelId: null, judgeCostUsd };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildRequestParams(mode: ModeConfig): {
  model: string;
  strategy: string;
  quality_target?: number;
  ailin_constraints?: Record<string, unknown>;
} {
  // Base capabilities required for ALL experiment arms — prevents video/animation
  // models from being selected for chat tasks. Individual arms can override or extend.
  const DEFAULT_CAPABILITIES: string[] = ['chat'];

  /** Merge per-mode qualityTarget and requiredCapabilities into the result. */
  function applyModeConstraints(
    result: { model: string; strategy: string; quality_target?: number; ailin_constraints?: Record<string, unknown> },
    modeConfig: ModeConfig,
  ) {
    // Apply qualityTarget from mode config (overrides any hardcoded default)
    if ('qualityTarget' in modeConfig && modeConfig.qualityTarget != null) {
      result.quality_target = modeConfig.qualityTarget;
    }

    // Merge requiredCapabilities: use mode-level if set, otherwise use defaults
    const capabilities = ('requiredCapabilities' in modeConfig && modeConfig.requiredCapabilities?.length)
      ? modeConfig.requiredCapabilities
      : DEFAULT_CAPABILITIES;

    if (capabilities.length > 0) {
      if (!result.ailin_constraints) result.ailin_constraints = {};
      // Merge with any existing requiredCapabilities (e.g., from forced-pool)
      const existing = (result.ailin_constraints.requiredCapabilities as string[]) ?? [];
      const merged = [...new Set([...existing, ...capabilities])];
      result.ailin_constraints.requiredCapabilities = merged;
    }

    // Pin to preferred providers if specified (e.g., use anthropic native for claude models)
    if ('preferredProviders' in modeConfig && Array.isArray(modeConfig.preferredProviders) && modeConfig.preferredProviders.length > 0) {
      if (!result.ailin_constraints) result.ailin_constraints = {};
      result.ailin_constraints.preferredProviders = modeConfig.preferredProviders;
    }

    return result;
  }

  switch (mode.mode) {
    case 'single-model':
      return applyModeConstraints(
        { model: mode.modelId, strategy: 'single' },
        mode,
      );
    case 'collective':
      return applyModeConstraints(
        { model: 'auto', strategy: mode.strategy },
        mode,
      );
    case 'adaptive':
      return applyModeConstraints(
        { model: 'auto', strategy: 'auto' },
        mode,
      );
    case 'forced-pool-collective':
      // Arm C: Collective with forced model pool.
      // qualityTarget from mode config (default 1.0 for backward compat).
      return applyModeConstraints(
        {
          model: 'auto',
          strategy: mode.strategy,
          quality_target: mode.qualityTarget ?? 1.0,
          ailin_constraints: {
            requiredCapabilities: ['chat', 'reasoning'],
            preferredProviders: extractProviders(mode.forcedModelPool),
          },
        },
        mode,
      );
    case 'single-budget':
      // Arm D: Single budget model (control)
      return applyModeConstraints(
        { model: mode.modelId, strategy: 'single' },
        mode,
      );
    case 'ablation':
      // C3 P0.2: Ablation mode — run strategy with components disabled
      // Ablation flags are communicated via X-Ablation-Disable header
      return applyModeConstraints(
        { model: 'auto', strategy: mode.strategy },
        mode,
      );
  }
}

function getModeType(mode: ModeConfig): ExecutionMode {
  switch (mode.mode) {
    case 'forced-pool-collective': return 'collective-tier1';
    case 'single-budget': return 'single-budget';
    default: return mode.mode;
  }
}

export function getModeKey(mode: ModeConfig): string {
  switch (mode.mode) {
    case 'single-model': return `single-model:${mode.modelId}`;
    case 'collective': return `collective:${mode.strategy}`;
    case 'forced-pool-collective': return `collective-tier1:${mode.strategy}`;
    case 'single-budget': return `single-budget:${mode.modelId}`;
    case 'adaptive': return 'adaptive';
    case 'ablation': return `ablation:${mode.strategy}:${mode.disableComponents.join(',')}`;
    default: return String((mode as { mode: string }).mode);
  }
}

/**
 * Build a canary-skip reason key for recordSkip(). armId (from
 * resolveExperimentArm/deriveArmId) uses a `mode::strategy` double-colon
 * scheme (see policy-arm-resolver.ts), a different delimiter convention from
 * getModeKey()'s single-colon `mode:key` scheme that every other
 * recordSkip() call site in this file uses (e.g. arm_budget_exceeded).
 * Concatenating `canary_skip:${errorClass}:` (single colon) directly with a
 * double-colon armId produced keys like
 * "canary_skip:timeout:collective::collaborative" that read as having an
 * empty segment. Takes a precomputed armId→ModeConfig map (built by the
 * caller, which already has resolveExperimentArm in scope) so the key uses
 * the same single-colon scheme as everything else; falls back to the raw
 * armId if no matching mode is found (should not happen — the map is built
 * from the same `modes` list the skip plan's armIds are derived from).
 */
export function buildCanarySkipKey(
  errorClass: string,
  armId: string,
  armIdToMode: ReadonlyMap<string, ModeConfig>,
): string {
  const mode = armIdToMode.get(armId);
  return `canary_skip:${errorClass}:${mode ? getModeKey(mode) : armId}`;
}

function extractProviders(modelIds: string[]): string[] {
  // Extract unique provider prefixes from model IDs like "openai/gpt-5.4" → "openai"
  const providers = new Set<string>();
  for (const id of modelIds) {
    const slash = id.indexOf('/');
    if (slash > 0) providers.add(id.substring(0, slash));
  }
  return [...providers];
}

/** Extract provider slug from a mode config for rate limiting. */
function extractProviderFromMode(mode: ModeConfig): string | null {
  if (mode.mode === 'single-model' || mode.mode === 'single-budget') {
    const slash = mode.modelId.indexOf('/');
    return slash > 0 ? mode.modelId.substring(0, slash) : null;
  }
  // For collective/adaptive modes the provider is resolved dynamically — skip rate limiting
  return null;
}

function extractModelIdFromMode(mode: ModeConfig): string | null {
  if (mode.mode === 'single-model' || mode.mode === 'single-budget') {
    return mode.modelId;
  }
  return null;
}

function buildFailedResult(
  experimentId: string,
  task: typeof EXPERIMENT_SUITE[number],
  mode: ModeConfig,
  repetition: number,
  latencyMs: number,
  phase: ExperimentPhase = 'frozen',
  errorMessage?: string,
): ExperimentExecutionResult {
  return {
    experimentId,
    taskIndex: task.index,
    repetition,
    executionMode: getModeType(mode),
    strategy: (mode.mode === 'collective' || mode.mode === 'forced-pool-collective' || mode.mode === 'ablation') ? mode.strategy
      : (mode.mode === 'single-model' || mode.mode === 'single-budget') ? 'single' : 'auto',
    model: (mode.mode === 'single-model' || mode.mode === 'single-budget') ? mode.modelId : null,
    taskType: task.taskType,
    complexity: task.complexity,
    domain: task.domain,
    prompt: task.prompt,
    qualityScore: 0,
    costUsd: 0,
    latencyMs,
    totalTokens: 0,
    success: false,
    modelsUsed: [],
    judgeScore: null,
    judgeRubric: task.judgeRubric,
    faithfulnessScore: null,
    instructionFollowingScore: null,
    failureMode: classifyFailureMode(errorMessage),
    phase,
    responseSummary: errorMessage ? `[ERROR] ${errorMessage}` : null,
    ablationDisabled: mode.mode === 'ablation' ? mode.disableComponents : [],
    ablationCondition: mode.mode === 'ablation' ? `-${mode.disableComponents.join('-')}` : null,
    scoringPolicy: null,
    judgeUsed: false,
    heuristicScoreRaw: null,
    armKey: getModeKey(mode), // resume-stable arm identity (review F9)
  };
}

/** Classify failure into actionable categories for error analysis */
function classifyFailureMode(errorMessage?: string): FailureMode {
  if (!errorMessage) return 'unknown';
  const msg = errorMessage.toLowerCase();
  if (msg.includes('402') || msg.includes('insufficient credit') || msg.includes('insufficient ai credit')) return 'rate-limited'; // provider funding
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('quota') || msg.includes('exhausted')) return 'rate-limited';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')) return 'rate-limited';
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('404') || msg.includes('model not found')) return 'api-error';
  if (msg.includes('empty response') || msg.includes('empty content') || msg.includes('degraded placeholder')) return 'invalid-output';
  if (msg.includes('consensus requires') || msg.includes('insufficient')) return 'incomplete';
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return 'api-error';
  return 'api-error';
}

// isAlreadyCompleted removed — replaced by DB-backed completedSet in runExperimentLoop

// Cost estimation cache: model ID → { input, output } per 1k tokens
const modelPricingCache = new Map<string, { input: number; output: number }>();

// $/1k-token ceiling equivalent to $100/Mtok — above known real published
// API prices even for the priciest frontier output tokens (~$75/Mtok). A
// cross-provider match above this is corrupted catalog data (see the
// per-fetcher unit-scaling fixes in openai-compatible-hub-model-fetcher.ts
// and alibaba-model-fetcher.ts), not a genuine price — accepting it would
// poison the experiment budget governor exactly as observed in the H-B
// mini-run (quality_multipass blowing a $20 arm cap on 2 executions).
const PLAUSIBLE_MAX_PER_1K = 0.1;

export async function lookupModelCost(modelId: string, promptTokens: number, completionTokens: number): Promise<number> {
  if (!modelId) return estimateCostFallback(promptTokens + completionTokens);

  let pricing = modelPricingCache.get(modelId);
  if (!pricing) {
    try {
      // Step 1: Direct lookup by exact model ID
      const model = await prisma.model.findFirst({
        where: { id: modelId },
        select: { inputCostPer1k: true, outputCostPer1k: true, name: true },
      });
      if (model) {
        const input = Number(model.inputCostPer1k);
        const output = Number(model.outputCostPer1k);
        if (input > 0 || output > 0) {
          pricing = { input, output };
          modelPricingCache.set(modelId, pricing);
        } else {
          // Step 2: Cross-provider lookup — same model name, different provider with pricing > 0
          // Extract base model name: 'openai/gpt-5.4' → 'gpt-5.4', 'claude-opus-4-6' stays as-is
          const baseName = extractBaseModelName(modelId);
          const crossProvider = await prisma.model.findFirst({
            where: {
              name: { contains: baseName, mode: 'insensitive' },
              inputCostPer1k: { gt: 0, lt: PLAUSIBLE_MAX_PER_1K },
              status: 'active',
            },
            select: { inputCostPer1k: true, outputCostPer1k: true, id: true },
            // Prefer the lowest plausible price, not the highest: "prefer
            // highest" previously let a single corrupted (over-scaled) entry
            // for one provider's variant of a model name get selected AND
            // persisted back to every other same-named model, even when a
            // correct, lower entry existed for the same base name.
            orderBy: { inputCostPer1k: 'asc' },
          });
          if (crossProvider) {
            const cpPricing = { input: Number(crossProvider.inputCostPer1k), output: Number(crossProvider.outputCostPer1k) };
            pricing = cpPricing;
            // Run-local estimate ONLY — never persisted. The cross-provider
            // match is a fuzzy guess, and Model.inputCostPer1k/outputCostPer1k
            // are read by live billing/routing/display paths: an experiment
            // must not overwrite the catalog's true (unknown) price with it.
            modelPricingCache.set(modelId, cpPricing);
            log.info({ modelId, crossProviderId: crossProvider.id, pricing: cpPricing }, 'Cost: cross-provider pricing estimate (in-memory only)');
          }
        }
      }
    } catch { /* DB lookup failed — fall through to fallback */ }
  }

  if (pricing) {
    const dbCost = (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
    if (dbCost > 0) return dbCost;
  }
  return estimateCostFallback(promptTokens + completionTokens);
}

/**
 * A policy-invalid trajectory (per experiment-integrity-guard's own
 * contract) never counts as a clean success, regardless of what the
 * orchestrator itself reported. Only overrides success/failureMode —
 * qualityScore/judgeScore are left as recorded elsewhere (informational),
 * so the raw judge signal stays queryable while `success` correctly
 * excludes the row from aggregate quality stats (e.g.
 * `avg(quality_score) FILTER (WHERE success)`).
 */
export function applyPolicyGate(
  success: boolean,
  failureMode: FailureMode | null | undefined,
  policyViolationDetected: boolean,
): { success: boolean; failureMode: FailureMode | null } {
  if (policyViolationDetected) {
    return { success: false, failureMode: 'policy-violation' };
  }
  return { success, failureMode: failureMode ?? null };
}

/** Extract base model name from provider-prefixed ID: 'openai/gpt-5.4' → 'gpt-5.4' */
function extractBaseModelName(modelId: string): string {
  // Remove provider prefix: 'openai/gpt-5.4' → 'gpt-5.4'
  const slash = modelId.indexOf('/');
  const baseName = slash > 0 ? modelId.substring(slash + 1) : modelId;
  // Remove version suffixes for broader matching: 'gpt-5.4-2026-03-05' → 'gpt-5.4'
  // But keep the core version: 'gpt-5.4' stays 'gpt-5.4', 'claude-opus-4-6' stays 'claude-opus-4-6'
  return baseName;
}

function estimateCostFallback(totalTokens: number): number {
  // Blended rate from env or dynamic fallback
  // Default: ~$3/M input + ~$15/M output ≈ $0.009/1k blended
  const blendedRatePer1k = Number(process.env.EXPERIMENT_COST_FALLBACK_RATE_PER_1K ?? 0.009);
  return (totalTokens / 1000) * blendedRatePer1k;
}

async function persistExecution(result: ExperimentExecutionResult, mode?: ModeConfig): Promise<void> {
  try {
    // ─── Policy-aware integrity validation ───────────────────────────────
    // When the caller passes the originating ModeConfig we resolve the arm
    // and validate the recorded trajectory against its evaluation policy.
    // The result is persisted as `structuredMetadata.policyValidation` so
    // downstream reporting can filter contaminated executions.
    let policyValidation: Record<string, unknown> | undefined;
    // Gating is DISABLED (kept false): the ExecutionRecord fed to the
    // integrity guard here is synthetic (providerId:'unknown', index-based
    // roles), which makes the guard's per-attempt checks fire false
    // positives on healthy executions — see the detailed note at the
    // `if (!integrity.valid)` block below. policyValidation is still
    // computed and stored in structuredMetadata for offline analysis, but it
    // must not gate `success` until the guard receives real attempt records.
    const policyViolationDetected = false;
    if (mode) {
      try {
        const policyMod = await import('./policy');
        const { resolveExperimentArm, getDefaultIntegrityGuard } = policyMod;
        type ExecutionRecord = import('./policy').ExecutionRecord;
        const arm = resolveExperimentArm(mode);
        const guard = getDefaultIntegrityGuard();

        // Build synthetic ModelAttemptRecord[] from result.modelsUsed.
        // This is best-effort: subtleties (concurrent timestamps, hedged
        // role) require deeper orchestrator integration. For now we
        // detect substitution-level / identity / Ollama violations.
        const attempts = (result.modelsUsed ?? []).map((modelId, i) => ({
          attemptIndex: i,
          providerId: 'unknown', // resolved by classifier downstream
          modelId,
          modelFamily: 'unknown',
          roleInStrategy: (i === 0 ? 'primary' : 'fallback') as 'primary' | 'fallback',
          selectionReason: 'semantic_top_ranked' as const,
          status: result.success && i === (result.modelsUsed?.length ?? 1) - 1 ? 'succeeded' as const : 'attempted' as const,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
          timestampMs: Date.now() - result.latencyMs + i * 100, // synthetic but ordered
        }));

        const record: ExecutionRecord = {
          executionId: `${result.experimentId}::${result.taskIndex}::${result.repetition}`,
          arm,
          attempts,
          totalCostUsd: result.costUsd,
          totalDurationMs: result.latencyMs,
        };

        const integrity = await guard.assertExperimentIntegrity(record);
        policyValidation = {
          policyKind: integrity.policyKind,
          armId: integrity.armId,
          valid: integrity.valid,
          violationCount: integrity.violations.length,
          violations: integrity.violations.slice(0, 10), // cap for storage
        };

        if (!integrity.valid) {
          // Observability only — do NOT gate `success` on this result. The
          // ExecutionRecord fed to the guard here is SYNTHETIC (built from
          // result.modelsUsed a few lines above): every attempt carries
          // providerId:'unknown' and roleInStrategy inferred purely from
          // array index (i===0 ? primary : fallback). That makes the guard's
          // per-attempt checks fire FALSE POSITIVES on healthy executions:
          //   • providerId:'unknown' → computeSubstitutionLevel returns
          //     'degraded_answer_mode' → substitution_level_exceeded +
          //     degraded_answer_mode_forbidden on EVERY single-model row
          //     (observed: a HumanEval run voided all 6396 arms this way);
          //   • index-based roles label a legit N-expert collective's
          //     experts as N-1 "fallbacks" → false fallback_depth_exceeded,
          //     indistinguishable from a real fallback chain.
          // The video-model-leak this gate was meant to backstop is fixed at
          // the ROOT by the modality filter (PR #172), so gating on this
          // low-fidelity signal now only destroys valid data. Re-enable
          // gating only once the guard receives REAL attempt records (real
          // providerId + role) from the orchestration engine. policyValidation
          // is still stored in structuredMetadata below for offline analysis.
          log.warn(
            {
              experimentId: result.experimentId,
              armId: integrity.armId,
              violationCount: integrity.violations.length,
              violationKinds: [...new Set(integrity.violations.map((v) => v.kind))],
            },
            'Policy integrity violations detected (observability only — not gating success; synthetic attempt records)',
          );
        }
      } catch (err) {
        // Policy validation failure must not block persistence
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Policy validation skipped due to error',
        );
      }
    }

    // Normalize strategy name to canonical form before persisting. Route
    // through the strategy registry's alias map (handles the
    // quality_multipass/quality-multipass canonical-vs-execution-form
    // split, and any other registered alias) so success and failure rows
    // agree. Previously this only replaced whitespace: successful
    // executions arrive already canonicalized (resolved via
    // mapExecutionToCanonical in the orchestration engine's response
    // metadata), while buildFailedResult() uses the raw execution-form
    // config value — so e.g. quality-multipass failures and
    // quality_multipass successes persisted as two distinct "strategies"
    // (see strategy-tiers.ts's documented "naming bug": one showing 100%
    // success, the other 0%, for what was really one strategy).
    const normalizedStrategy = result.strategy
      ? (canonicalizeStrategyInput(result.strategy) ?? result.strategy.toLowerCase().replace(/\s+/g, '_'))
      : result.strategy;

    // Normalize cost (Bloco G hardening): detect $0.00 from hub failures,
    // estimate from tokens when possible, mark as missing when not.
    let normalizedCostUsd = result.costUsd;
    let costMetadata: string | undefined;
    // P1-7: when the cost is genuinely MISSING (hub failure, no tokens to
    // estimate from) the row's cost is NOT trustworthy. Flag it so cost averages
    // can EXCLUDE it — coercing a missing cost to $0 on a SUCCESSFUL row biases
    // the arm's mean cost down (pro-collective when collectives fail cost-attribution).
    let costMissing = false;
    try {
      const { normalizeCost } = await import('@/services/cost-normalization-service');
      const costRecord = normalizeCost(
        result.costUsd,
        // Use model as provider hint (imperfect but available at this level)
        result.model || 'unknown',
        result.model || 'unknown',
        result.totalTokens ? Math.floor(result.totalTokens * 0.3) : undefined, // rough input estimate
        result.totalTokens ? Math.floor(result.totalTokens * 0.7) : undefined, // rough output estimate
      );
      normalizedCostUsd = costRecord.normalizedCostUsd ?? result.costUsd;
      costMissing = costRecord.costSource === 'missing' || costRecord.normalizedCostUsd == null;
      costMetadata = `[cost:${costRecord.costSource},confidence:${costRecord.costConfidence}]`;

      if (costRecord.costSource !== 'provider_reported' && costRecord.costSource !== 'genuinely_free') {
        log.debug({
          model: result.model,
          rawCost: result.costUsd,
          normalizedCost: normalizedCostUsd,
          source: costRecord.costSource,
          reason: costRecord.normalizationReason,
        }, 'Cost normalized from raw value');
      }
    } catch { /* cost normalization is non-critical */ }

    // Append cost metadata to response_summary if available
    const responseSummary = costMetadata && result.responseSummary
      ? `${costMetadata} ${result.responseSummary}`
      : result.responseSummary;

    const { success: finalSuccess, failureMode: finalFailureMode } = applyPolicyGate(
      result.success,
      result.failureMode,
      policyViolationDetected,
    );

    // Build structured metadata for the new JSONB column (Hardening Bloco H)
    const structuredMeta: Record<string, unknown> = {};
    if (costMetadata) structuredMeta.cost = costMetadata;
    if (finalFailureMode) structuredMeta.failureMode = finalFailureMode;
    if (result.ablationDisabled && result.ablationDisabled.length > 0) structuredMeta.ablationDisabled = result.ablationDisabled;
    if (result.ablationCondition) structuredMeta.ablationCondition = result.ablationCondition;
    if (result.scoringPolicy) structuredMeta.scoringPolicy = result.scoringPolicy;
    if (result.judgeUsed) structuredMeta.judgeUsed = result.judgeUsed;
    if (result.judgeFailed) structuredMeta.judgeFailed = result.judgeFailed;
    if (result.scoreSource) structuredMeta.scoreSource = result.scoreSource;
    if (result.judgeMode) structuredMeta.judgeMode = result.judgeMode;
    if (result.judgeModelId) structuredMeta.judgeModelId = result.judgeModelId;
    // Per-row judge cost for auditability. Persisted whenever a judge ran —
    // including an explicit 0 (judge used but cost unattributable), which is
    // itself a signal distinct from "no judge ran" (field absent).
    if (result.judgeCostUsd != null && (result.judgeCostUsd > 0 || result.judgeUsed)) {
      structuredMeta.judgeCostUsd = result.judgeCostUsd;
    }
    if (result.armKey) structuredMeta.armKey = result.armKey;
    if (result.heuristicScoreRaw != null) structuredMeta.heuristicScoreRaw = result.heuristicScoreRaw;
    structuredMeta.normalizedCostUsd = normalizedCostUsd;
    structuredMeta.rawCostUsd = result.costUsd;
    if (costMissing) structuredMeta.costMissing = true;
    structuredMeta.phase = result.phase;
    // Per-subcall decomposition (cost/latency/role per voter/coordinator
    // call) — previously only reached response_summary as truncated text;
    // structured_metadata is what export-hardness-detail should read.
    if (result.subcalls && result.subcalls.length > 0) structuredMeta.subcalls = result.subcalls;
    if (policyValidation) structuredMeta.policyValidation = policyValidation;

    await prisma.experimentExecution.create({
      data: {
        experimentId: result.experimentId,
        taskIndex: result.taskIndex,
        repetition: result.repetition,
        executionMode: result.executionMode,
        strategy: normalizedStrategy,
        model: result.model,
        taskType: result.taskType,
        complexity: result.complexity,
        domain: result.domain,
        prompt: result.prompt,
        qualityScore: result.qualityScore,
        costUsd: normalizedCostUsd,
        latencyMs: result.latencyMs,
        totalTokens: result.totalTokens,
        success: finalSuccess,
        modelsUsed: result.modelsUsed,
        phase: result.phase ?? 'frozen',
        judgeScore: result.judgeScore,
        judgeRubric: result.judgeRubric,
        responseSummary,
        structuredMetadata: Object.keys(structuredMeta).length > 0
          ? (structuredMeta as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        failureMode: finalFailureMode,
      },
    });
  } catch (err) {
    log.warn({ error: String(err), taskIndex: result.taskIndex }, 'Failed to persist experiment execution');
  }
}

async function updateProgress(experimentId: string, progress: ExperimentProgress): Promise<void> {
  try {
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { progress: toInputJson(progress) },
    });
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to update experiment progress');
  }
}

async function finalizeExperiment(experimentId: string, state: ExperimentState, progress: ExperimentProgress): Promise<void> {
  try {
    await prisma.experiment.update({
      where: { id: experimentId },
      data: {
        state,
        progress: toInputJson(progress),
        totalExecutions: progress.completed,
        completedAt: state === 'completed' ? new Date() : undefined,
      },
    });
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to finalize experiment');
  }
  if (activeExperiment?.experimentId === experimentId) {
    activeExperiment = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
