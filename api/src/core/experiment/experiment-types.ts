// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Framework — Core Types
 *
 * Defines all interfaces for the comparative experiment between:
 * - Mode A: Single Tier 1 models (baseline)
 * - Mode B: Collective intelligence (multi-agent strategies)
 * - Mode C: Adaptive system (archive + Pareto + bandit)
 *
 * These types are consumed by the experiment runner, statistical analysis
 * engine, and report generator.
 */

// ─── Execution Modes ───────────────────────────────────────────────────────

/** The experimental conditions under comparison (4-arm benchmark + adaptive). */
export type ExecutionMode = 'single-model' | 'collective' | 'adaptive' | 'collective-tier1' | 'single-budget' | 'ablation';

/** Strategies available for collective intelligence mode. */
/**
 * All collective strategies available for CI experiments.
 * Matches the strategies registered in OrchestrationEngine,
 * excluding non-collective entries (single, cached, auto, compositor).
 */
export type CollectiveStrategy =
  | 'collaborative'
  | 'parallel'
  | 'sequential'
  | 'hybrid'
  | 'competitive'
  | 'expert-panel'
  | 'massive-parallel'
  | 'cost-cascade'
  | 'quality-multipass'
  | 'adaptive'
  | 'contextual'
  | 'hierarchical'
  | 'consensus'
  | 'reinforcement'
  | 'debate'
  | 'war-room'
  | 'blind-debate'
  | 'devil-advocate-consensus'
  | 'safety-quorum'
  | 'diversity-ensemble'
  | 'stigmergic-refinement'
  | 'swarm-explore'
  | 'clarification-first'
  | 'research-synthesize'
  | 'critique-repair'
  | 'double-diamond'
  | 'multi-hop-qa'
  | 'persona-exploration'
  | 'agentic'
  | 'sensitivity-consensus'
  | 'tri-role-collective';

/**
 * Runtime array of ALL collective strategies — used by experiment configs
 * to dynamically include every registered strategy without hardcoding.
 */
export const ALL_COLLECTIVE_STRATEGIES: CollectiveStrategy[] = [
  'collaborative', 'parallel', 'sequential', 'hybrid', 'competitive',
  'expert-panel', 'massive-parallel', 'cost-cascade', 'quality-multipass',
  'adaptive', 'contextual', 'hierarchical', 'consensus', 'reinforcement',
  'debate', 'war-room', 'blind-debate', 'devil-advocate-consensus',
  'safety-quorum', 'diversity-ensemble', 'stigmergic-refinement',
  'swarm-explore', 'clarification-first', 'research-synthesize',
  'critique-repair', 'double-diamond', 'multi-hop-qa',
  'persona-exploration', 'agentic',
  'sensitivity-consensus',
  'tri-role-collective',
];

/**
 * Strategies that are NOT genuine multi-model collectives and must be excluded
 * from the collective-vs-single BENCHMARK, else they contaminate the pooled
 * 'collective' aggregate. Currently: `hierarchical` is a stub — its execute()
 * runs ONLY the manager (a single model) yet reports as a collective, so
 * including it drags the collective mean toward single-model quality. Remove
 * from this set once it dispatches and synthesizes real workers.
 */
export const NON_COLLECTIVE_BENCHMARK_STRATEGIES: ReadonlySet<CollectiveStrategy> = new Set([
  'hierarchical',
]);

/** Genuine collectives for the benchmark (ALL minus the stubs above). */
export const BENCHMARK_COLLECTIVE_STRATEGIES: CollectiveStrategy[] =
  ALL_COLLECTIVE_STRATEGIES.filter((s) => !NON_COLLECTIVE_BENCHMARK_STRATEGIES.has(s));

/** Lifecycle state of an experiment run. */
export type ExperimentState = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

/** Experiment phase — 4-phase structure per SOTA runbook. */
export type ExperimentPhase = 'sanity-check' | 'warmup' | 'frozen' | 'confirmation';

/** Failure mode categorization for non-successful executions. */
export type FailureMode =
  | 'timeout'
  | 'rate-limited'
  | 'invalid-output'
  | 'incomplete'
  | 'off-topic'
  | 'hallucination'
  | 'api-error'
  | 'pool-collapse'
  | 'credit-exhaustion'
  | 'skipped-predispatch'
  | 'degraded'
  | 'policy-violation'
  | 'unknown';

// ─── Task Definitions ──────────────────────────────────────────────────────

/** A single task within the experiment suite. */
export interface ExperimentTask {
  /** Unique index within the suite. */
  index: number;
  /** Matches orchestration taxonomy. */
  taskType: string;
  /** Task complexity level. */
  complexity: 'low' | 'medium' | 'high';
  /** Domain tag for segmented analysis (tech, business, creative, etc.). */
  domain: string;
  /** The prompt sent to /v1/chat/completions. */
  prompt: string;
  /** LLM-as-judge rubric for scoring the response. */
  judgeRubric: string;
  /** Expected difficulty for calibration (0-1, higher = harder). */
  expectedDifficulty: number;

  /**
   * Output-token ceiling for this task's response. When unset the runner
   * derives a complexity-based default (see resolveTaskMaxTokens). Set an
   * explicit value on long-output tasks (essays, full implementations) so the
   * answer is never clipped — a truncated collective response is scored as if
   * the collective produced a worse answer, biasing the whole comparison.
   */
  maxTokens?: number;

  /**
   * Objective answer check (best-of-N, #2). When present, the runner forwards
   * it as `ailin_constraints.answer_check` so the collective can SELECT the
   * checker-verified candidate instead of relying on the LLM judge — the
   * winnable form of the thesis. Only set on tasks with a genuinely verifiable
   * answer; the prompt should request a `FINAL: <answer>` line so extraction is
   * unambiguous. Structural mirror of AnswerCheckSpec (kept inline to avoid an
   * orchestration import from the experiment layer). */
  answerCheck?: {
    readonly kind: 'string_equals' | 'numeric_equals' | 'contains_all' | 'one_of' | 'regex';
    readonly expected?: string | number;
    readonly tolerance?: number;
    readonly needles?: readonly string[];
    readonly accepted?: readonly string[];
    readonly pattern?: string;
    readonly flags?: string;
    readonly caseSensitive?: boolean;
  };
  /** Tie-break among checker-passers ('majority' default; 'min'/'max' extremal). */
  answerCheckAmong?: 'majority' | 'min' | 'max';
  /** What the check inspects: 'final' (default — the extracted FINAL line) or 'full'
   *  (the ENTIRE reply). Use 'full' for CODE tasks (e.g. a self-contained HTML canvas
   *  scene) where the objective property is structural over the whole output — this is
   *  what arms the collective to reject a structurally-broken candidate. */
  answerCheckScope?: 'final' | 'full';
  /** Completeness gate for 'full'-scope checks: the reply must ALSO contain at
   *  least ONE of these substrings (case-insensitive) to score 1. Needles of a
   *  structural check tend to appear near the START of the artifact (a canvas
   *  file emits all three in its first few hundred bytes), so they cannot tell
   *  a complete file from one clipped at the token cap — a closing signal
   *  (e.g. `</html>`, `</script>`) is the part a mid-file cut can never emit.
   *  Ignored for 'final'-scope checks. */
  answerCheckCompletionAnyOf?: readonly string[];

  // ─── Extended fields for strategy-specific / multimodal / leader / compositor tasks ───

  /** Force a specific strategy (instead of auto/dynamic triage). */
  strategy?: string;
  /** Compositor config for pipeline or workflow-based strategies. */
  strategyConfig?: {
    strategyPipeline?: string[];
    strategyDAG?: Record<string, string[]>;
    strategyWorkflow?: { steps: Array<{ id: string; strategy: string; depends_on?: string[] }> };
  };
  /** Modality for multimodal scenarios. */
  modality?: 'chat' | 'stt' | 'tts' | 'image' | 'video' | 'vision' | 'translation' | 'ocr' | 'pipeline';
  /** Multimodal payloads. */
  audioUrl?: string;
  imageUrl?: string;
  /** Leader testing: force the provider to fail so leader can intervene. */
  forceFailProvider?: boolean;
  /** Leader testing: minimum quality target for the execution. */
  minQualityTarget?: number;
  /** Queue classification for parallel execution. */
  queueType?: 'chat' | 'multimodal' | 'compositor' | 'leader';

  // ─── Real-capability coverage (2026-07-12) ─────────────────────────────────

  /**
   * CODE WITH REAL FUNCTIONAL DELIVERY. When set, the runner extracts the code
   * from the response, EXECUTES it in the sandbox against these hidden tests, and
   * sets the OBJECTIVE quality score = passedCases/totalCases (bypassing the fuzzy
   * LLM judge). This is the strongest coding signal — "does it actually run and
   * pass?", the reliability dimension the public contests reward. The prompt must
   * ask for a function with the given name and output ONLY the code.
   */
  codeTest?: {
    readonly language: 'javascript' | 'typescript' | 'python' | 'java' | 'csharp' | 'go';
    readonly functionName: string;
    readonly tests: ReadonlyArray<{ readonly args: readonly unknown[]; readonly expected: unknown }>;
    /**
     * HumanEval-style native harness. When set, grading does NOT use the
     * structured `{args, expected}` vectors above — instead the runner
     * concatenates the model's code, this `checkSource` (which defines a
     * `check(candidate)` function), and a zero-arg wrapper `def
     * __ailin_check(): check(entryPoint); return True`, then runs it through
     * the SAME sandbox path with a single `{args:[], expected:true}` vector.
     * The wrapper returns True iff every assert in `check` passes, so the
     * score is a faithful binary pass@1 — HumanEval's own harness runs
     * unmodified, with no float/tuple-comparison lossiness. `functionName`
     * must be `__ailin_check` and `tests` `[{args:[],expected:true}]` when
     * this is set (the loader sets them). See experiment-dataset-loader.ts.
     */
    readonly checkSource?: string;
    /** Entry-point function name the model must define (HumanEval harness input). */
    readonly entryPoint?: string;
  };

  /**
   * TOOL-CALLING. When set, the runner forwards `tools` (+ `tool_choice`) so the
   * model must decide to call a function. Grade objectively via `answerCheck` on
   * the FINAL result that is ONLY reachable by calling the tool. Structural mirror
   * of the OpenAI tools schema (kept inline to avoid an orchestration import). */
  tools?: ReadonlyArray<{
    readonly type: 'function';
    readonly function: { readonly name: string; readonly description?: string; readonly parameters?: Record<string, unknown> };
  }>;
  toolChoice?: 'auto' | 'none';
  /**
   * Complementary REQUEST-level assertion for a tool task. `answerCheck` on the
   * FINAL result is the primary signal (the server's agentic loop consumes the
   * tool_calls and returns the grounded answer), but when a path surfaces the raw
   * `message.tool_calls` WITHOUT executing the loop there is no grounded answer to
   * check. Then the runner scores 1 if some observed call matches `name` and every
   * key in `argsMatch` (loose, case-insensitive substring). ORed with `answerCheck`,
   * so a tool task stays objective under either server behaviour. */
  expectTool?: {
    readonly name: string;
    readonly argsMatch?: Record<string, string | number | boolean>;
  };

  /**
   * LONG GENERATION. Minimum (and optional maximum) word count the response must
   * meet. The runner computes an objective length-compliance sub-score and blends
   * it with the judge score, so "wrote enough / didn't get cut off" becomes a
   * measured signal instead of being left to the fuzzy rubric. */
  minWords?: number;
  maxWords?: number;
}

// ─── Mode Configuration ────────────────────────────────────────────────────

/** Configuration for a specific execution within Mode A. */
export interface SingleModelConfig {
  mode: 'single-model';
  /** Explicit model identifier (e.g., 'gpt-5.4', 'claude-opus-4-6'). */
  modelId: string;
  /** Display name for reports. */
  displayName: string;
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
  /** Preferred providers for model resolution (e.g., ['anthropic'] to pin claude to Anthropic's native adapter). */
  preferredProviders?: string[];
}

/** Configuration for a specific execution within Mode B. */
export interface CollectiveConfig {
  mode: 'collective';
  /** Which collective strategy to use. */
  strategy: CollectiveStrategy;
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
  /**
   * F2.9 — Optional adversarial scenario tag. When set, the
   * experiment-runner CAN use the corresponding generator from
   * `core/coordination/adversarial-scenarios.ts` to inject a
   * deterministic synthetic signal stream into the strategy's
   * aggregator. The tag is informational at the C3 reporting layer
   * even when the runner does not consume it directly — operators
   * can break down detector accuracy per (strategy, scenario) pair
   * post-run via the metadata.
   */
  adversarialScenario?: AdversarialScenarioName;
  /**
   * F2.9 — Display name override. Useful when the same strategy
   * appears multiple times under different scenarios; the report
   * generator surfaces this as the arm's label.
   */
  displayName?: string;
}

/**
 * F2.9 — Names of the canned adversarial scenarios produced by
 * `core/coordination/adversarial-scenarios.ts`. Mirrored here as a
 * narrow union so `experiment-types` does not depend on the
 * coordination layer at import time.
 */
export type AdversarialScenarioName =
  | 'sensitivity_poisoning'
  | 'herding_cascade'
  | 'confidence_spamming'
  | 'outlier_amplification'
  | 'hostile_minority';

/** Configuration for Mode C (no parameters — fully adaptive). */
export interface AdaptiveConfig {
  mode: 'adaptive';
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
}

/**
 * Configuration for forced-pool collective (Arm C in the benchmark protocol).
 * Same strategies as CollectiveConfig, but with an explicit model pool restriction.
 * Used for the "Tier 1 ceiling" experiment: what happens when CI uses only premium models.
 */
export interface ForcedPoolCollectiveConfig {
  mode: 'forced-pool-collective';
  /** Which collective strategy to use. */
  strategy: CollectiveStrategy;
  /** Explicit pool of model IDs to restrict routing to. */
  forcedModelPool: string[];
  /** Display name for reports (e.g., "Consensus (Tier 1 only)"). */
  displayName: string;
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
}

/**
 * Configuration for Arm D — single budget control.
 * Runs individual budget models that collective strategies typically select,
 * to isolate "orchestration gain" from "model swap gain".
 */
export interface SingleBudgetConfig {
  mode: 'single-budget';
  /** Explicit budget model identifier. */
  modelId: string;
  /** Display name for reports. */
  displayName: string;
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
}

/** C3 P0.2: Ablation mode configuration */
export interface AblationConfig {
  mode: 'ablation';
  strategy: CollectiveStrategy;
  displayName: string;
  disableComponents: ('memory' | 'bandit' | 'archive' | 'pareto' | 'critique' | 'feedback-loop' | 'shadow' | 'knowledge-graph' | 'triage' | 'debate-rounds')[];
  /** Quality target (0-1) passed to the orchestration engine for model selection. */
  qualityTarget?: number;
  /** Required capabilities to filter out incompatible models (e.g., video models for chat tasks). */
  requiredCapabilities?: string[];
}

/** Discriminated union of mode configurations. */
export type ModeConfig = SingleModelConfig | CollectiveConfig | AdaptiveConfig | ForcedPoolCollectiveConfig | SingleBudgetConfig | AblationConfig;

// ─── Experiment Configuration ──────────────────────────────────────────────

/** Full experiment configuration — what to run and how. */
export interface ExperimentConfig {
  /** Human-readable experiment name. */
  name: string;
  /** Description of the experiment's purpose. */
  description: string;
  /** Task indices from the suite to include (empty = all). */
  taskIndices: number[];
  /**
   * Explicit task universe. When set, tasks are resolved against THIS array
   * instead of the built-in `EXPERIMENT_SUITE` (still filtered by
   * `taskIndices` when non-empty). Lets a config carry externally-loaded
   * tasks — e.g. HumanEval / GSM8K from `experiment-dataset-loader.ts` — so
   * a public-benchmark run needs no change to the static suite. Travels
   * inside the persisted config JSON, so resume works. Keep it bounded
   * (a few hundred tasks) to avoid bloating the stored config.
   */
  tasks?: ExperimentTask[];
  /** Mode configurations to run for each task. */
  modes: ModeConfig[];
  /** Number of times to repeat each (task, mode) pair. */
  repetitions: number;
  /** Maximum total cost in USD (experiment aborted if exceeded). */
  maxBudgetUsd: number;
  /** Delay between API calls in milliseconds. */
  delayBetweenCallsMs: number;
  /** Maximum concurrent executions (within a mode). */
  maxConcurrency: number;
  /** Warm-up executions before frozen measurement (default: 0 = no warm-up). */
  warmupExecutions: number;
  /** Whether to freeze learning systems during measurement phase (default: true). */
  freezeLearningDuringEval: boolean;
}

// ─── Execution Results ─────────────────────────────────────────────────────

/** Result of a single experiment execution. */
export interface ExperimentExecutionResult {
  experimentId: string;
  taskIndex: number;
  repetition: number;
  executionMode: ExecutionMode;
  /** Actual strategy used (may differ from requested for adaptive mode). */
  strategy: string;
  /** Specific model used (for single-model mode). */
  model: string | null;
  taskType: string;
  complexity: string;
  domain: string;
  prompt: string;
  // ─── Metrics
  qualityScore: number | null;
  costUsd: number;
  /**
   * Billable cost (USD) of the LLM-judge call(s) that scored THIS row —
   * a SEPARATE accounting line from `costUsd`. The judge is arm-neutral
   * instrumentation (same model/rubric for every response), so folding it
   * into the arm's `costUsd` would pollute the cross-arm cost-effectiveness
   * comparison; keeping it separate still lets the budget cap cover it.
   * 0 when the judge ran but its cost could not be attributed; absent when
   * no judge ran (objective scoring / failed execution).
   */
  judgeCostUsd?: number;
  /** True when the cost could not be attributed (hub failure / no tokens). Such
   *  rows must be EXCLUDED from cost averages — a $0 missing cost on a success
   *  biases the arm's mean cost down. */
  costMissing?: boolean;
  latencyMs: number;
  totalTokens: number;
  success: boolean;
  modelsUsed: string[];
  // ─── Judge
  judgeScore: number | null;
  judgeRubric: string;
  // ─── Extended Metrics (SOTA runbook)
  faithfulnessScore: number | null;
  instructionFollowingScore: number | null;
  failureMode: FailureMode | null;
  /** Experiment phase this execution belongs to. */
  phase: ExperimentPhase;
  // ─── Response
  responseSummary: string | null;
  // ─── C3: Ablation & scoring metadata
  ablationDisabled: string[];
  ablationCondition: string | null;
  scoringPolicy: string | null;
  judgeUsed: boolean;
  heuristicScoreRaw: number | null;
  /**
   * True when the LLM-judge cascade failed ALL retries and no real judgment was
   * produced. Such rows carry `qualityScore = null` (a failed measurement is not
   * a measurement) with the length-based fallback preserved in
   * `heuristicScoreRaw` for debugging — so a heuristic can never masquerade as a
   * genuine judge score in the analysis. (review F2)
   */
  judgeFailed?: boolean;
  /**
   * Provenance of `qualityScore`: which mechanism produced it. Lets the analysis
   * separate objective grades (answer_check / executed code) from fuzzy LLM-judge
   * grades and from failed-judge heuristics. (review TS-04 / F2)
   */
  scoreSource?: 'answer_check' | 'code_execution' | 'tool_call' | 'llm_judge' | 'heuristic_fallback' | null;
  /**
   * The judge instrument this run was pinned to (mode + model id), stamped on
   * EVERY row so a calibration-vs-run instrument mismatch ("split-brain": the
   * calibration validated one judge, the run scored with another, incl. a
   * floating 'auto') is auditable after the fact. (review F1)
   */
  judgeMode?: string | null;
  judgeModelId?: string | null;
  /**
   * The arm's canonical mode key (getModeKey(mode)) at the time it ran, persisted
   * so a resume matches completed items by the SAME key the execution queue uses.
   * Reconstructing the key from the persisted (possibly resolved/normalized)
   * strategy could differ from the config's raw strategy → whole arms re-run and
   * double-pay. (review F9)
   */
  armKey?: string;
  /**
   * Per-subcall (voter/coordinator) decomposition for collective strategies
   * — cost/latency/role/success per model call within the strategy. Persisted
   * into `structuredMetadata.subcalls` so hardness-detail exports can read
   * structured per-subcall figures instead of regex-parsing the truncated
   * `responseSummary` text. Absent for single-model executions.
   */
  subcalls?: Array<{
    model_id: string; model_name: string; role: string;
    cost_usd: number; latency_ms: number; success: boolean;
    error: string | null; tokens: Record<string, number> | null;
    /** Full-flow capture (include_subcall_content): the subcall's actual
     *  output text, extracted reasoning, and prompt-variant provenance — the
     *  whole intra-collective transcript, persisted so every strategy's
     *  behavior is auditable per model per stage, not just its metrics. */
    content?: string | null; reasoning?: string | null;
    prompt_key?: string | null; prompt_variant_id?: string | null;
    content_truncated?: boolean;
  }>;
}

// ─── Experiment Progress ───────────────────────────────────────────────────

/** Tracks experiment progress for pause/resume and status reporting. */
export interface ExperimentProgress {
  /** Total planned executions. */
  total: number;
  /** Completed executions. */
  completed: number;
  /** Currently executing task index. */
  currentTaskIndex: number | null;
  /** Currently executing mode. */
  currentMode: ExecutionMode | null;
  /** Current repetition number. */
  currentRepetition: number | null;
  /** Total MAIN-execution cost accumulated so far (judge cost NOT included). */
  totalCostUsd: number;
  /**
   * Total LLM-judge cost accumulated so far — a separate line from
   * `totalCostUsd` (see ExperimentExecutionResult.judgeCostUsd for why the
   * two are never folded together). True run spend = totalCostUsd +
   * judgeCostUsd, and the budget checks gate on that sum. Optional for
   * backward compatibility with progress snapshots persisted before this
   * field existed.
   */
  judgeCostUsd?: number;
  /** Timestamp of last completed execution. */
  lastCompletedAt: string | null;
  /** Errors encountered (non-fatal). */
  errors: number;
  /** Current experiment phase. */
  currentPhase: ExperimentPhase;
  /** Warm-up executions completed. */
  warmupCompleted: number;
  /** Frozen-phase executions completed. */
  frozenCompleted: number;
  /**
   * Planned executions that were SKIPPED without a persisted row (e.g.
   * arm_budget_exceeded, worker budget-abort). 2026-07-05: run 9590ff41
   * finished state='completed' at 392/532 frozen with zero errors because
   * these skips were invisible — completed-with-shortfall is not auditable
   * unless the shortfall is counted. Optional for backward compatibility
   * with progress snapshots persisted before this field existed.
   */
  skipped?: number;
  /** Per-reason breakdown of `skipped` (reason → count). */
  skipReasons?: Record<string, number>;
}

// ─── Statistical Types ─────────────────────────────────────────────────────

/** Descriptive statistics for a set of scores. */
export interface DescriptiveStats {
  n: number;
  mean: number;
  median: number;
  stddev: number;
  variance: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  iqr: number;
}

/** Confidence interval result. */
export interface ConfidenceInterval {
  mean: number;
  lower: number;
  upper: number;
  marginOfError: number;
  confidenceLevel: number;
  n: number;
}

/** Result of a Welch's t-test. */
export interface TTestResult {
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  significant: boolean;
  confidenceLevel: number;
}

/** Cohen's d effect size interpretation. */
export type EffectSizeCategory = 'negligible' | 'small' | 'medium' | 'large';

/** Effect size result. */
export interface EffectSizeResult {
  cohensD: number;
  category: EffectSizeCategory;
}

/** Win rate comparison between two groups. */
export interface WinRateComparison {
  groupAWins: number;
  groupBWins: number;
  ties: number;
  groupAWinRate: number;
  groupBWinRate: number;
  total: number;
}

/** Multi-objective point for Pareto analysis. */
export interface ParetoPoint {
  label: string;
  quality: number;
  cost: number;
  latency: number;
  successRate: number;
}

/** Pareto dominance analysis result. */
export interface ParetoDominanceResult {
  frontier: ParetoPoint[];
  dominated: ParetoPoint[];
}

// ─── Report Types ──────────────────────────────────────────────────────────

/** Segment key for grouping results. */
export interface SegmentKey {
  taskType?: string;
  complexity?: string;
  domain?: string;
  executionMode?: ExecutionMode;
  strategy?: string;
  model?: string;
}

/** Segment-level analysis result. */
export interface SegmentAnalysis {
  segment: SegmentKey;
  quality: DescriptiveStats;
  cost: DescriptiveStats;
  latency: DescriptiveStats;
  successRate: number;
  stabilityIndex: number;
  sampleSize: number;
  confidenceInterval: ConfidenceInterval;
}

/** Head-to-head comparison between two modes/strategies. */
export interface HeadToHead {
  groupA: string;
  groupB: string;
  qualityTTest: TTestResult;
  effectSize: EffectSizeResult;
  winRate: WinRateComparison;
  qualityDelta: number;
  costDelta: number;
  latencyDelta: number;
}

/** Composite regret across multiple objectives. */
export interface CompositeRegret {
  qualityRegret: number;
  costRegret: number;
  latencyRegret: number;
  /** Weighted composite: sum(weight_i × regret_i). */
  compositeRegret: number;
  weights: { quality: number; cost: number; latency: number };
}

/** Composite efficiency score combining quality, cost, and latency. */
export interface CompositeEfficiency {
  qualityPerDollar: number;
  qualityPerSecond: number;
  /** Weighted composite: quality^wq / (cost^wc × latency^wl). */
  compositeScore: number;
  weights: { quality: number; cost: number; latency: number };
}

/** Confidence level for conclusions. */
export type ConclusionConfidence = 'high' | 'medium' | 'low' | 'inconclusive';

/** Strength rating for evidence. */
export type EvidenceStrength = 'strong' | 'moderate' | 'weak' | 'inconclusive';

/** Final verdict for the experiment. */
export type FinalVerdict =
  | 'single-model-wins'
  | 'collective-wins'
  | 'adaptive-wins'
  | 'depends-on-scenario'
  | 'inconclusive';

// ─── Document 1: Executive Summary ─────────────────────────────────────────

export interface ExecutiveSummary {
  experimentId: string;
  experimentName: string;
  generatedAt: string;
  totalExecutions: number;
  successfulExecutions: number;
  totalCostUsd: number;

  bestOverallApproach: { label: string; mode: ExecutionMode; avgQuality: number; evidence: EvidenceStrength };
  bestByScenario: Array<{ scenario: string; winner: string; avgQuality: number; evidence: EvidenceStrength }>;
  collectiveVsTier1: { verdict: string; confidence: ConclusionConfidence; qualityDelta: number; costMultiplier: number };
  adaptiveValue: { verdict: string; confidence: ConclusionConfidence; evidence: string };
  finalVerdict: FinalVerdict;
  verdictDetails: string;
  keyFindings: string[];
}

// ─── Document 2: Methodology ───────────────────────────────────────────────

export interface MethodologyDocument {
  modelsCompared: Array<{ id: string; displayName: string; provider: string; available: boolean; unavailableReason?: string }>;
  collectiveStrategies: string[];
  adaptiveDescription: string;
  taskSuite: { totalTasks: number; byTaskType: Record<string, number>; byComplexity: Record<string, number>; byDomain: Record<string, number> };
  evaluationCriteria: string[];
  segmentations: string[];
  phases: { warmupExecutions: number; frozenEvaluation: boolean; learningFrozenDuringMeasurement: boolean };
  statisticalMethods: string[];
  limitations: string[];
  threatsToValidity: string[];
}

// ─── Document 3: Detailed Results ──────────────────────────────────────────

export interface DetailedResults {
  overallRanking: Array<{ label: string; mode: ExecutionMode; avgQuality: number; avgCost: number; avgLatency: number; winRate: number; sampleSize: number; ci95: ConfidenceInterval }>;
  rankingByTaskType: Record<string, Array<{ label: string; avgQuality: number; sampleSize: number; ci95: ConfidenceInterval }>>;
  rankingByComplexity: Record<string, Array<{ label: string; avgQuality: number; sampleSize: number }>>;
  rankingByDomain: Record<string, Array<{ label: string; avgQuality: number; sampleSize: number }>>;
  segments: SegmentAnalysis[];
  headToHead: HeadToHead[];
  paretoDominance: ParetoDominanceResult;
  tradeoffs: {
    qualityVsCost: Array<{ label: string; avgQuality: number; avgCost: number; qualityPerDollar: number }>;
    qualityVsLatency: Array<{ label: string; avgQuality: number; avgLatency: number; qualityPerSecond: number }>;
  };
  consistencyAnalysis: {
    byMode: Array<{ mode: ExecutionMode; stabilityIndex: number; cv: number; sampleSize: number }>;
    mostConsistent: string;
    leastConsistent: string;
  };
  compositeRegret: Record<string, CompositeRegret>;
  compositeEfficiency: Record<string, CompositeEfficiency>;
}

// ─── Document 4: Statistical Appendix ──────────────────────────────────────

export interface StatisticalAppendix {
  sampleSizes: Record<string, { mode: ExecutionMode; n: number; nSuccessful: number; successRate: number }>;
  descriptiveStatsByGroup: Record<string, { quality: DescriptiveStats; cost: DescriptiveStats; latency: DescriptiveStats }>;
  confidenceIntervals: Record<string, ConfidenceInterval>;
  tTests: Array<{ groupA: string; groupB: string; result: TTestResult; interpretation: string }>;
  effectSizes: Array<{ groupA: string; groupB: string; result: EffectSizeResult; practicalSignificance: string }>;
  outliers: Record<string, { count: number; indices: number[]; impact: string }>;
  methodNotes: string[];
}

// ─── Document 5: Decision Memo ─────────────────────────────────────────────

export interface DecisionMemo {
  /** Q1: Best single model baseline? */
  bestSingleModel: { model: string; avgQuality: number; evidence: string };
  /** Q2: Does collective beat Tier 1? */
  collectiveBeatsTier1: { answer: 'yes' | 'no' | 'depends' | 'inconclusive'; evidence: EvidenceStrength; details: string };
  /** Q3: Where does collective win defensibly? */
  collectiveWinsWhere: Array<{ scenario: string; qualityGain: number; costMultiplier: number; evidenceStrength: EvidenceStrength }>;
  /** Q4: Where are single models still superior? */
  singleModelWinsWhere: Array<{ scenario: string; reason: string }>;
  /** Q5: Does adaptive beat both? */
  adaptiveBeatsBoth: { answer: 'yes' | 'no' | 'depends' | 'inconclusive'; evidence: EvidenceStrength; details: string };
  /** Q6: Does collective quality gain justify cost? */
  collectiveWorthCost: { answer: 'yes' | 'no' | 'marginal' | 'inconclusive'; qualityGain: number; costMultiplier: number; latencyMultiplier: number };
  /** Q7: What to use in production? */
  productionRecommendation: { defaultMode: string; escalationPolicy: string; guardrails: string[] };
  /** Q8: Overall conclusion strength? */
  conclusionStrength: EvidenceStrength;
  /** Proven facts. */
  proven: string[];
  /** Unproven claims. */
  notProven: string[];
  /** Context-dependent findings. */
  dependsOnContext: string[];
  /** Final verdict. */
  finalVerdict: FinalVerdict;
}

// ─── Full Report Bundle ────────────────────────────────────────────────────

/** Complete 5-document report bundle. */
export interface ExperimentReportBundle {
  executiveSummary: ExecutiveSummary;
  methodology: MethodologyDocument;
  detailedResults: DetailedResults;
  statisticalAppendix: StatisticalAppendix;
  decisionMemo: DecisionMemo;
}

/** @deprecated Use ExperimentReportBundle. Kept for backward compatibility. */
export type ExperimentReport = ExperimentReportBundle;

// ─── GO/NO-GO Decision Framework ───────────────────────────────────────────

/** GO/NO-GO verdict for a specific approach in a specific usage profile. */
export type GoNoGoVerdict = 'GO' | 'CONDITIONAL-GO' | 'NO-GO' | 'INCONCLUSIVE';

/** Usage profile that drives threshold selection. */
export type UsageProfile = 'max-quality' | 'low-cost' | 'low-latency' | 'high-robustness' | 'generalist';

/** Configurable thresholds for GO/NO-GO decisions. */
export interface GoNoGoThresholds {
  /** Minimum quality gain to justify collective over single (e.g., 0.07 = 7%). */
  minQualityGainForCollective: number;
  /** Maximum cost increase tolerable for collective (e.g., 1.5 = 50% more). */
  maxCostMultiplierForCollective: number;
  /** Maximum latency increase tolerable (e.g., 2.0 = 100% more). */
  maxLatencyMultiplierForCollective: number;
  /** Minimum quality score for production use. */
  qualityFloor: number;
  /** Minimum success rate for production use. */
  successRateFloor: number;
  /** Minimum consistency index for production use. */
  consistencyFloor: number;
  /** Minimum sample size per group for high confidence. */
  minSamplesHighConfidence: number;
  /** Minimum sample size per group for moderate confidence. */
  minSamplesModerateConfidence: number;
}

/** Default thresholds per SOTA runbook §14. */
export const DEFAULT_THRESHOLDS: GoNoGoThresholds = {
  minQualityGainForCollective: 0.07,
  maxCostMultiplierForCollective: 1.5,
  maxLatencyMultiplierForCollective: 2.0,
  qualityFloor: 0.75,
  successRateFloor: 0.95,
  consistencyFloor: 0.70,
  minSamplesHighConfidence: 50,
  minSamplesModerateConfidence: 20,
};

/** GO/NO-GO decision for a single approach in a usage profile. */
export interface GoNoGoDecision {
  approach: string;
  mode: ExecutionMode;
  profile: UsageProfile;
  verdict: GoNoGoVerdict;
  reason: string;
  metrics: {
    avgQuality: number;
    avgCost: number;
    avgLatency: number;
    successRate: number;
    consistencyIndex: number;
    sampleSize: number;
  };
  evidence: EvidenceStrength;
  thresholdsMet: string[];
  thresholdsFailed: string[];
}

/** Decision matrix row — one per (scenario × approach). */
export interface DecisionMatrixRow {
  scenario: string;
  approach: string;
  avgQuality: number;
  avgCost: number;
  avgLatencyMs: number;
  confidence: EvidenceStrength;
  verdict: GoNoGoVerdict;
}

/** Heatmap cell — quality score per (taskType/complexity × approach). */
export interface HeatmapCell {
  row: string;
  column: string;
  value: number;
  sampleSize: number;
}

/** Final GO/NO-GO report. */
export interface GoNoGoReport {
  generatedAt: string;
  experimentId: string;
  totalExecutions: number;
  phaseSummary: {
    sanityCheck: { executed: number; passed: boolean };
    warmup: { executed: number };
    frozen: { executed: number };
    confirmation: { executed: number; disputedScenarios: number };
  };
  thresholdsUsed: GoNoGoThresholds;
  decisions: GoNoGoDecision[];
  decisionMatrix: DecisionMatrixRow[];
  heatmap: HeatmapCell[];
  confidenceMap: Array<{ segment: string; confidence: EvidenceStrength }>;
  tradeoffCurves: {
    qualityVsCost: Array<{ label: string; quality: number; cost: number }>;
    qualityVsLatency: Array<{ label: string; quality: number; latency: number }>;
  };
  finalVerdict: {
    class: string;
    summary: string;
    productionDefault: string;
    premiumEscalation: string;
    blocked: string[];
  };
  mandatoryQuestions: {
    q1_bestTier1Baseline: string;
    q2_collectiveBeatsTier1: string;
    q3_collectiveWinsWhere: string[];
    q4_collectiveNotWorth: string[];
    q5_adaptiveSuperior: string;
    q6_collectiveJustifiesCost: string;
    q7_productionDefault: string;
    q8_premiumOnly: string;
    q9_go: string[];
    q10_noGo: string[];
    q11_inconclusive: string[];
  };
}
