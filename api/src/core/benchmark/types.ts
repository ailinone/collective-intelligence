// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark Harness Types
 *
 * Core type definitions for the CI/API benchmark evaluation system.
 * Used by the benchmark suite, evaluator, reporter, and reward integrity modules.
 */

// ─── Benchmark Task Definition ───────────────────────────────────────────────

export type BenchmarkCategory =
  | 'coding-generate'
  | 'coding-edit'
  | 'coding-debug'
  | 'coding-review'
  | 'analysis-data'
  | 'analysis-technical'
  | 'analysis-text'
  | 'factual-qa'
  | 'creative'
  | 'multi-step'
  | 'reasoning'
  | 'tool-use';

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export type EvaluationMethod =
  | 'pattern-match'     // exact/regex match against expected output
  | 'llm-judge'         // LLM evaluates quality (subjective tasks)
  | 'rubric-checklist'  // LLM checks specific rubric items (structured)
  | 'diff-format'       // validates diff format compliance (coding edits)
  | 'composite';        // combines multiple methods

export interface BenchmarkTask {
  /** Unique task identifier (e.g., "coding-gen-001") */
  id: string;
  /** Human-readable description */
  name: string;
  /** Category for grouping and filtering */
  category: BenchmarkCategory;
  /** Difficulty level */
  difficulty: BenchmarkDifficulty;
  /** The prompt to send to the system */
  prompt: string;
  /** System prompt override (if needed) */
  systemPrompt?: string;
  /** How to evaluate the response */
  evaluationMethod: EvaluationMethod;
  /** For pattern-match: regex or exact string to match */
  expectedPattern?: string;
  /** For llm-judge/rubric-checklist: what to evaluate */
  judgeRubric: string;
  /** Specific checklist items the response must contain (for rubric-checklist) */
  checklistItems?: string[];
  /** Strategies to test this task against */
  strategies: string[];
  /** Maximum acceptable cost per execution (USD) */
  maxCostUsd?: number;
  /** Maximum acceptable latency (ms) */
  maxLatencyMs?: number;
  /** Weight for this task in aggregate scoring (default: 1.0) */
  weight?: number;
  /** Tags for filtering */
  tags?: string[];
}

// ─── Benchmark Execution Result ──────────────────────────────────────────────

export interface BenchmarkExecutionResult {
  /** Task that was executed */
  taskId: string;
  /** Strategy used */
  strategy: string;
  /** Model(s) used (if reported) */
  modelsUsed?: string[];
  /** Raw response content */
  responseContent: string;
  /** Quality score from heuristic scorer */
  heuristicScore: number;
  /** Quality score from LLM judge (if evaluated) */
  llmJudgeScore?: number;
  /** Per-dimension quality scores */
  dimensions?: {
    correctness: number;
    completeness: number;
    clarity: number;
    efficiency: number;
    relevance: number;
  };
  /** Checklist evaluation (for rubric-checklist method) */
  checklistResults?: ChecklistResult[];
  /** Diff format compliance (for coding-edit tasks) */
  diffFormatCompliance?: number;
  /** Whether execution succeeded (no errors) */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution duration in ms */
  durationMs: number;
  /** Estimated cost in USD */
  costUsd: number;
  /** Token usage */
  tokenUsage?: { prompt: number; completion: number; total: number };
  /** Timestamp */
  timestamp: string;
}

export interface ChecklistResult {
  item: string;
  passed: boolean;
  evidence?: string;
}

// ─── Benchmark Run (aggregated) ──────────────────────────────────────────────

export interface BenchmarkRun {
  /** Unique run identifier */
  runId: string;
  /** When the run started */
  startedAt: string;
  /** When the run completed */
  completedAt: string;
  /** Total duration */
  durationMs: number;
  /** All individual results */
  results: BenchmarkExecutionResult[];
  /** Aggregate metrics per category */
  categoryScores: CategoryScore[];
  /** Aggregate metrics per strategy */
  strategyScores: StrategyScore[];
  /** Overall system score */
  overallScore: number;
  /** Total cost of run */
  totalCostUsd: number;
  /** Reward integrity metrics (if cross-validation ran) */
  rewardIntegrity?: RewardIntegrityResult;
  /** Comparison with previous run */
  trend?: BenchmarkTrend;
}

export interface CategoryScore {
  category: BenchmarkCategory;
  avgQuality: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  successRate: number;
  taskCount: number;
}

export interface StrategyScore {
  strategy: string;
  avgQuality: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  successRate: number;
  taskCount: number;
}

// ─── Benchmark Trend (cross-run comparison) ──────────────────────────────────

export interface BenchmarkTrend {
  /** Previous run overall score */
  previousOverallScore: number;
  /** Current run overall score */
  currentOverallScore: number;
  /** Delta */
  delta: number;
  /** Per-category deltas */
  categoryDeltas: Array<{
    category: BenchmarkCategory;
    previous: number;
    current: number;
    delta: number;
  }>;
  /** Whether the system improved, degraded, or stayed stable */
  verdict: 'improved' | 'degraded' | 'stable';
  /** Degradation alerts */
  alerts: string[];
}

// ─── Reward Integrity (OI-02) ────────────────────────────────────────────────

export interface RewardIntegrityResult {
  /** Number of tasks cross-validated */
  sampleCount: number;
  /** Pearson correlation between heuristic and LLM judge scores */
  correlation: number;
  /** Mean absolute difference between heuristic and LLM judge */
  meanAbsoluteDiff: number;
  /** Tasks where heuristic and judge diverge significantly */
  divergentTasks: Array<{
    taskId: string;
    heuristicScore: number;
    llmJudgeScore: number;
    diff: number;
  }>;
  /** Whether drift is detected (correlation < 0.7) */
  driftDetected: boolean;
  /** Gaming signals detected */
  gamingSignals: GamingSignal[];
}

export interface GamingSignal {
  type: 'long-low-info' | 'repetitive-padding' | 'keyword-stuffing' | 'format-without-substance';
  taskId: string;
  evidence: string;
  severity: 'low' | 'medium' | 'high';
}

// ─── Success-Story Snapshot (OI-03) ──────────────────────────────────────────

export interface BanditSnapshot {
  /** Snapshot identifier */
  snapshotId: string;
  /** When the snapshot was taken */
  timestamp: string;
  /** Strategy weights at this point */
  weights: Array<{
    taskType: string;
    complexity: string;
    strategy: string;
    alpha: number;
    beta: number;
    weight: number;
  }>;
  /** Reward rate at snapshot time */
  rewardRate: number;
  /** Whether this snapshot is currently the active (champion) config */
  isActive: boolean;
}

// ─── Benchmark Configuration ─────────────────────────────────────────────────

export interface BenchmarkConfig {
  /** Whether benchmark harness is enabled */
  enabled: boolean;
  /** Cron schedule for nightly runs */
  cronSchedule: string;
  /** API base URL to test against */
  apiBase: string;
  /** Bearer token for API calls */
  bearerToken: string;
  /** Delay between API calls (ms) */
  delayBetweenCallsMs: number;
  /** Maximum tasks per run (for cost control) */
  maxTasksPerRun: number;
  /** Whether to run reward integrity cross-validation */
  enableRewardIntegrity: boolean;
  /** Percentage of tasks to cross-validate with LLM judge (0-1) */
  rewardIntegritySampleRate: number;
  /** Correlation threshold below which drift is flagged */
  driftCorrelationThreshold: number;
  /** Maximum budget per run (USD) */
  maxBudgetPerRun: number;
  /** Whether to store results in database */
  persistResults: boolean;
}
