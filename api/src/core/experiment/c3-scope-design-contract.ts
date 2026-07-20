// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN-R4 — Living contract for C3 experiment scope.
 *
 * R3 (Full Provider Expansion) fundamentally rethinks eligibility:
 *   - Eligibility gate: provider chat-ready + chat capability (NOT quality score)
 *   - Quality score: stratification + prioritization signal, updated from executions
 *   - Provider pool: 23 chat-ready providers (17 R3 baseline + 6 from reprobe)
 *   - Candidate pool: 13808 known chat-capable models (934 R3 + 12874 reprobe expansion)
 *   - Main thesis: equal/better quality at lower total cost vs single-best model
 *
 * R4 Integrity Lock (2026-06-06):
 *   - Provider census reconciled: 82 registered, 23 chat-ready, 0 unknown
 *   - Candidate pool canonical: 13808 (formula: 934 + 24 HZU + 12692 HuggingFace + 158 reprobe)
 *   - HuggingFace: provider_probe_validated (Qwen/Qwen2.5-7B-Instruct HTTP 200 via router.huggingface.co/v1)
 *   - HuggingFace allModelsCallableAssumed = false (catalog_candidate_pool, not model_probe_validated)
 *   - C3 execution NOT authorized. dryRun=false NOT authorized. Billable provider calls NOT authorized.
 *
 * Source decisions:
 *   - SM-R6:            CONSENSUS_01C_1B_SM_R6_STRATEGY_SEMANTIC_PLAN_DEPTH_COMPLETE
 *   - J2C-R6-HARDEN:    CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS
 *   - J1D-R4B:          CONSENSUS_01C_1B_J1D_R4B_INVENTORY_READY_FOR_CONTEXT_WINDOW_AND_DIVERSITY_FIX
 *   - J1D-R4D:          CONSENSUS_01C_1B_J1D_R4D_STRICT_EXECUTABLE_READY_FOR_QUALITY_COVERAGE
 *   - ADAPTER_READINESS: provider_adapter_readiness_01c1b_j1b_r2.json (17 chat-ready providers)
 *   - DB_CENSUS:         __census.out — 934 chat-capable models from 17 chat-ready providers
 *   - J1-R3-REPROBE:    CONSENSUS_01C_1B_J1_R3_REPROBE_COMPLETE_3_NEW_CHAT_READY_PROVIDERS
 *   - J1-R3-HZU:        CONSENSUS_01C_1B_J1_R3_HZU_COMPLETE_3_NEW_CHAT_READY_PROVIDERS_23_TOTAL
 *   - R4-LOCK:          CONSENSUS_01C_1B_C3_SCOPE_R4_INTEGRITY_LOCK_COMPLETE
 *
 * ABSOLUTE PROHIBITIONS:
 *   No C3 execution. No dryRun=false. No provider calls. No secrets.
 *   No schema changes. No package.json changes. No remote deploy.
 */

// ── Policy versioning ─────────────────────────────────────────────────────────

export const C3_SCOPE_POLICY_VERSION = '01C.1B-C3-SCOPE-DESIGN-R4-v1' as const;
export const C3_SCOPE_DATE = '2026-06-06' as const;
export const C3_R4_INTEGRITY_LOCK_DATE = '2026-06-06' as const;
export const SEMANTIC_PLAN_VERSION_C3 = '01c1b-sm-r6-v1' as const;

// ── Execution authorization (hard locks — never flip without explicit operator approval) ──
export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;

// ── Provider registry totals ──────────────────────────────────────────────────
/** Total registered providers in system (all buckets). Must sum to 82. */
export const C3_REGISTERED_PROVIDER_TOTAL = 82 as const;

// ── Candidate model classification (R4: explicit semantic distinction) ────────
/**
 * A model's classification determines what guarantees we have about its callability.
 *
 * catalog_candidate        — appeared in local DB census; provider is chat-ready;
 *                            NOT guaranteed callable (may be gated, deprecated, or require probe).
 * provider_probe_validated — at least one model from this provider returned HTTP 200;
 *                            validates the provider endpoint + credential only.
 * model_probe_validated    — this specific modelId returned HTTP 200 in a direct probe;
 *                            validated for sampling in the current session.
 * c3_sampling_eligible     — passes all C3 sampler filters: provider chat-ready, capability
 *                            present, cost known or policy applied, no blocklist flag.
 *                            May still require model-level probe before billable execution.
 */
export type C3CandidateClass =
  | 'catalog_candidate'
  | 'provider_probe_validated'
  | 'model_probe_validated'
  | 'c3_sampling_eligible';

// ── HuggingFace-specific classification (R4: explicit to prevent over-assumption) ─
/** HuggingFace provider is provider_probe_validated — NOT all models model_probe_validated */
export const HF_PROVIDER_STATUS: C3CandidateClass = 'provider_probe_validated' as const;
export const HF_CONFIRMED_MODEL = 'Qwen/Qwen2.5-7B-Instruct' as const;
export const HF_CONFIRMED_ENDPOINT = 'https://router.huggingface.co/v1' as const;
export const HF_ALL_MODELS_CALLABLE_ASSUMED = false as const;
export const HF_CATALOG_CANDIDATE_COUNT = 12692 as const;

// ── Source decision phrases ───────────────────────────────────────────────────

export const SM_R6_DECISION =
  'CONSENSUS_01C_1B_SM_R6_STRATEGY_SEMANTIC_PLAN_DEPTH_COMPLETE' as const;

export const J2C_HARDEN_DECISION =
  'CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS' as const;

export const J1D_R4B_DECISION =
  'CONSENSUS_01C_1B_J1D_R4B_INVENTORY_READY_FOR_CONTEXT_WINDOW_AND_DIVERSITY_FIX' as const;

export const J1D_R4D_DECISION =
  'CONSENSUS_01C_1B_J1D_R4D_STRICT_EXECUTABLE_READY_FOR_QUALITY_COVERAGE' as const;

export const J1_R3_REPROBE_DECISION =
  'CONSENSUS_01C_1B_J1_R3_REPROBE_COMPLETE_3_NEW_CHAT_READY_PROVIDERS_POOL_EXPANDED_17_TO_20_PROVIDERS_934_TO_1092_CANDIDATES_READY_FOR_C3_DRYRUN' as const;

export const J1_R3_HZU_DECISION =
  'CONSENSUS_01C_1B_J1_R3_HZU_COMPLETE_3_NEW_CHAT_READY_PROVIDERS_23_TOTAL_13808_CANDIDATES_READY_FOR_C3_DRYRUN' as const;

export const C3_R4_INTEGRITY_LOCK_DECISION =
  'CONSENSUS_01C_1B_C3_SCOPE_R4_INTEGRITY_LOCK_COMPLETE_READY_FOR_C3_DRYRUN_EXPERIMENT_DESIGN' as const;

// ── Main thesis ───────────────────────────────────────────────────────────────
// R3 makes the experiment thesis explicit as a typed contract constant.

export const C3_THESIS_PRIMARY =
  'consensus_strategies_achieve_equal_or_better_quality_at_lower_total_cost_vs_single_best_model' as const;

export const C3_THESIS_EFFICIENCY_METRIC = 'quality_per_dollar' as const;

export const C3_THESIS_SUCCESS_CRITERIA =
  'consensus_efficiency_gte_90pct_of_single_best_efficiency' as const;

export const C3_THESIS_QUALITY_METRIC = 'judge_score_weighted_rubric' as const;

export const C3_THESIS_COST_METRIC = 'total_cost_usd_per_cell' as const;

// ── Eligibility policy (R3: policy constants, not fixed model list) ────────────
// Quality score is NOT a gate — it is a stratification and priority signal.
// Any model from a chat-ready provider with chat capability is a candidate.

export const C3_ELIGIBILITY_GATE_1 = 'provider_passes_chat_ready_probe' as const;
export const C3_ELIGIBILITY_GATE_2 = 'model_has_chat_capability' as const;
export const C3_ELIGIBILITY_GATE_3 = 'no_unresolved_variant_flag' as const;

export const C3_QUALITY_SCORE_REQUIRED_FOR_ELIGIBILITY = false as const;
export const C3_QUALITY_SCORE_ROLE =
  'stratification_and_priority_not_eligibility_gate' as const;
export const C3_QUALITY_SCORE_UPDATE_POLICY =
  'updated_from_execution_results_bayesian_weighted' as const;

/** Alpha weight for Bayesian quality update: new = α·judgeScore + (1-α)·prior */
export const C3_QUALITY_UPDATE_ALPHA = 0.3 as const;

// Blocking policy rules (replaces fixed block list from R1/R2)
export const C3_BLOCK_POLICY_VARIANT =
  'model_blocked_if_variant_suffix_present_without_confirmed_alias' as const;
export const C3_BLOCK_POLICY_PROVIDER =
  'model_ineligible_if_provider_fails_chat_ready_probe' as const;
export const C3_BLOCK_POLICY_CAPABILITY =
  'model_ineligible_if_chat_capability_absent' as const;

// ── Provider pool (R4: 23 chat-ready — 17 R3 baseline + 6 from J1-R3-REPROBE+HZU) ───
// Source: provider_adapter_readiness_01c1b_j1b_r2.json (17) +
//         provider_adapter_readiness_01c1b_j1b_r3_reprobe (3: perplexity, nvidia, wandb) +
//         provider_adapter_readiness_01c1b_j1b_r3_hzu.json (2: inworld, infermatic) +
//         01c1b-hf-direct.mjs HTTP 200 (1: huggingface via router.huggingface.co/v1)
// All 23 passed: secret resolved + chat probe HTTP 200.

export const C3_CHAT_READY_PROVIDERS = [
  // R3 original 17 (provider_adapter_readiness_01c1b_j1b_r2.json)
  'deepseek',
  'mistral',
  'cohere',
  'openrouter',
  'groq',
  'fireworks-ai',
  'deepinfra',
  'cerebras',
  'sambanova',
  'vercel-ai-gateway',
  'moonshot',
  'minimax',
  'writer',
  'upstage',
  'rekaai',
  'avian',
  'alibaba',
  // R3 reprobe additions (+3, J1-R3-REPROBE 2026-05-26)
  'perplexity',
  'nvidia',
  'wandb',
  // HZU additions (+2, J1-R3-HZU 2026-05-26)
  'inworld',
  'infermatic',
  // HZU2 + user fix (+1, router.huggingface.co/v1, 2026-06-06)
  'huggingface',
] as const;

export type C3ChatReadyProvider = typeof C3_CHAT_READY_PROVIDERS[number];

export const C3_CHAT_READY_PROVIDER_COUNT = 23 as const;

// ── Candidate pool (R4: 13808 known + runtime discovery expansion) ────────────
// Formula: 934 (R3 baseline) + 158 (reprobe: perplexity 24 + nvidia 107 + wandb 27)
//        + 24 (HZU: inworld 6 + infermatic 18)
//        + 12692 (HuggingFace catalog — provider_probe_validated, NOT model_probe_validated)
// Total: 13808
//
// Breakdown by provider:
//   R3 baseline 17 providers (934):
//     openrouter: 365, alibaba: 156, vercel-ai-gateway: 134, deepinfra: 113,
//     mistral: 64, upstage: 17, groq: 14, fireworks-ai: 14, cohere: 14,
//     moonshot: 9, writer: 8, sambanova: 8, minimax: 7, cerebras: 4,
//     avian: 3, rekaai: 2, deepseek: 2
//   Reprobe additions (158):
//     perplexity: 24, nvidia: 107, wandb: 27
//   HZU additions (24):
//     inworld: 6, infermatic: 18
//   HuggingFace (12692):
//     catalog_candidate_pool via router.huggingface.co/v1;
//     provider_probe_validated, NOT all-models model_probe_validated
// Total: 13808

export const C3_KNOWN_CANDIDATE_COUNT = 13808 as const;
/** Original R3 baseline candidate count (17 providers, pre-reprobe). */
export const C3_R3_ORIGINAL_KNOWN_COUNT = 934 as const;
export const C3_CANDIDATE_POOL_SOURCE =
  'db_census_chat_ready_providers_chat_capable_active' as const;
export const C3_CANDIDATE_POOL_EXPANDABLE = true as const;
export const C3_CANDIDATE_POOL_EXPANSION_TRIGGER = 'runtime_discovery_at_dry_run' as const;
/** Auditable formula for the 13808 canonical pool total. */
export const C3_CANDIDATE_POOL_FORMULA =
  '934_r3_baseline + 158_reprobe_3providers + 24_hzu_2providers + 12692_huggingface = 13808' as const;

// Per-provider known candidate counts (design-time DB snapshot)
export const C3_KNOWN_CANDIDATES_BY_PROVIDER: Record<C3ChatReadyProvider, number> = {
  // R3 baseline 17 providers
  'openrouter': 365,
  'alibaba': 156,
  'vercel-ai-gateway': 134,
  'deepinfra': 113,
  'mistral': 64,
  'upstage': 17,
  'groq': 14,
  'fireworks-ai': 14,
  'cohere': 14,
  'moonshot': 9,
  'writer': 8,
  'sambanova': 8,
  'minimax': 7,
  'cerebras': 4,
  'avian': 3,
  'rekaai': 2,
  'deepseek': 2,
  // Reprobe additions (J1-R3-REPROBE 2026-05-26)
  'perplexity': 24,
  'nvidia': 107,
  'wandb': 27,
  // HZU additions (J1-R3-HZU 2026-05-26)
  'inworld': 6,
  'infermatic': 18,
  // HuggingFace (catalog_candidate_pool; provider_probe_validated)
  'huggingface': 12692,
};

// ── Quality stratification (NOT a gate — stratification + priority only) ───────
// Source: Artificial Analysis intelligenceIndex (0-100 scale), 523 AA models.
// Updated per execution via Bayesian update (C3_QUALITY_UPDATE_ALPHA).

export const C3_QUALITY_TIER_HIGH_THRESHOLD = 45 as const;  // intelligenceIndex ≥ 45
export const C3_QUALITY_TIER_MID_LOWER = 25 as const;       // 25 ≤ intelligenceIndex < 45
export const C3_QUALITY_TIER_HIGH_KNOWN_COUNT = 32 as const;
export const C3_QUALITY_TIER_MID_KNOWN_COUNT = 137 as const;
export const C3_QUALITY_TIER_LOW_KNOWN_COUNT = 303 as const;
// 462 original (R3 baseline, no AA match) + 12874 reprobe additions (no AA data yet)
// = 13336 unknown quality tier. high+mid+low+unknown = 32+137+303+13336 = 13808 ✓
export const C3_QUALITY_TIER_UNKNOWN_KNOWN_COUNT = 13336 as const;
/** AA intelligenceIndex coverage from R3 baseline (unchanged by reprobe). */
export const C3_QUALITY_TIER_AA_INDEXED_COUNT = 472 as const; // 32+137+303

// Quality score sources (priority order — first available wins)
export const C3_QUALITY_SCORE_SOURCES = [
  'execution_history',                      // highest priority — updated from C3 runs
  'artificial_analysis_intelligence_index', // AA normalized intelligenceIndex
  'benchlm_lmarena_composite',              // BenchLM + LMArena composite score
  'provider_tier_proxy',                    // provider reputation (last resort)
] as const;

export type C3QualityScoreSource = typeof C3_QUALITY_SCORE_SOURCES[number];

// ── Cost stratification ───────────────────────────────────────────────────────
// Used to track cost efficiency and validate thesis (quality/cost metric).

export const C3_COST_TIER_PREMIUM_USD_PER_1M = 3.0 as const;  // blended > $3 → premium
export const C3_COST_TIER_ECONOMY_USD_PER_1M = 0.5 as const;  // blended < $0.5 → economy
// $0.5–$3 → standard

export const C3_COST_KNOWN_CHEAP_COUNT = 368 as const;  // < $1/1M in AA dataset
export const C3_COST_KNOWN_MID_COUNT = 67 as const;     // $1–$3/1M
export const C3_COST_KNOWN_UPPER_COUNT = 45 as const;   // $3–$5/1M

// ── Participant sampling policy ───────────────────────────────────────────────
// Per strategy cell: sample from the candidate pool with tier diversity.
// Judge and synthesizer are NOT sampled — they are pre-selected high-tier models.

export const C3_PARTICIPANT_SAMPLE_SIZES: Record<string, number> = {
  'single': 1,
  'consensus': 5,
  'debate': 2,
  'expert-panel': 3,
  'cost-cascade': 3,
  'critique-repair': 2,
  'quality-multipass': 3,
};

// Tier distribution guidance for consensus sampling (5 participants)
export const C3_CONSENSUS_TIER_SAMPLE = { high: 2, mid: 2, low: 1 } as const;
// cost-cascade prefers economy tier (thesis: cheap models via cascade = quality at low cost)
export const C3_COST_CASCADE_PREFERS_ECONOMY = true as const;

// ── Strategy scope ────────────────────────────────────────────────────────────

export const C3_ELIGIBLE_STRATEGIES = [
  'single',
  'consensus',
  'debate',
  'expert-panel',
  'cost-cascade',
  'critique-repair',
  'quality-multipass',
] as const;

export type C3EligibleStrategy = typeof C3_ELIGIBLE_STRATEGIES[number];

export const C3_EXCLUDED_ALIASES = ['fast'] as const;
export const C3_PROXY_ENDPOINTS = ['sensitivity-consensus'] as const;
export const FAST_STRATEGY_DECISION = 'proxy_alias_excluded_from_c3' as const;

export const C3_STRATEGY_STEP_COUNTS: Record<C3EligibleStrategy, number> = {
  'single': 1,
  'consensus': 2,
  'debate': 2,
  'expert-panel': 2,
  'cost-cascade': 4,
  'critique-repair': 3,
  'quality-multipass': 4,
};

// ── Baselines ─────────────────────────────────────────────────────────────────
// Baselines use high-tier judge/synthesizer models (not sampled from pool).

export const C3_BASELINES = [
  'baseline-single-best',
  'baseline-single-secondary',
  'baseline-single-third',
  'baseline-no-synthesis',
] as const;

export type C3Baseline = typeof C3_BASELINES[number];

// ── Judge and synthesizer (high-tier pre-selected models) ─────────────────────
// These are NOT participants — they are pre-selected from the known high tier.
// Quality source: benchlm+lmarena and AA (confirmed, not fabricated).
// Pool separation invariant: judge NOT in synthesizer pool.

export const C3_SYNTHESIZER_POOL: readonly string[] = [
  'anthropic/claude-opus-4-7', // intelligenceIndex 57.3, quality 0.9625 (benchlm+lmarena)
];

export const C3_JUDGE_POOL: readonly string[] = [
  'deepseek-ai/DeepSeek-R1-0528', // intelligenceIndex ~45+, quality 0.753 (AA), independent
];

export const C3_POOL_SEPARATION_INVARIANT =
  'judge_not_in_synthesizer_pool' as const;

export const C3_JUDGE_TIER_REQUIRED = 'high' as const;
export const C3_SYNTHESIZER_TIER_REQUIRED = 'high' as const;

// Known quality scores for judge/synthesizer (from hardened snapshot — not fabricated)
export const C3_SYNTHESIZER_QUALITY_SCORE = 0.9625 as const;  // claude-opus-4-7
export const C3_SYNTHESIZER_QUALITY_SOURCE = 'benchlm+lmarena' as const;
export const C3_JUDGE_QUALITY_SCORE = 0.753 as const;          // deepseek-r1-0528
export const C3_JUDGE_QUALITY_SOURCE = 'artificial_analysis_api' as const;

// ── Task set ──────────────────────────────────────────────────────────────────

export const C3_TASK_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const;
export type C3TaskId = typeof C3_TASK_IDS[number];

export const C3_TASK_CATEGORIES: Record<C3TaskId, string> = {
  T1: 'mathematical_reasoning',
  T2: 'code_generation',
  T3: 'factual_retrieval',
  T4: 'logical_deduction',
  T5: 'creative_writing',
  T6: 'document_summarization',
  T7: 'instruction_following',
  T8: 'scientific_explanation',
};

// ── Quality rubric ────────────────────────────────────────────────────────────

export const C3_RUBRIC_DIMENSIONS = [
  'correctness',
  'completeness',
  'coherence',
  'conciseness',
  'relevance',
  'factuality',
  'helpfulness',
] as const;

export type C3RubricDimension = typeof C3_RUBRIC_DIMENSIONS[number];

export const C3_RUBRIC_WEIGHTS: Record<C3RubricDimension, number> = {
  correctness: 0.25,
  completeness: 0.20,
  coherence: 0.15,
  conciseness: 0.10,
  relevance: 0.15,
  factuality: 0.10,
  helpfulness: 0.05,
};

// ── Budget policy ─────────────────────────────────────────────────────────────
// Caps are per-cell (task × strategy). With economy-tier sampling, most consensus
// cells should run well under cap — that gap IS the thesis measurement opportunity.

export const C3_STRATEGY_BUDGET_CAPS_USD: Record<C3EligibleStrategy, number> = {
  'single': 0.010,
  'consensus': 0.050,
  'debate': 0.050,
  'expert-panel': 0.050,
  'cost-cascade': 0.030,
  'critique-repair': 0.040,
  'quality-multipass': 0.080,
};

// ── Provenance schema (R3: 3 new fields vs R2) ───────────────────────────────
// New: qualityTier, costTier, participantSampleId (tracks which sample was used)

export const C3_PROVENANCE_REQUIRED_FIELDS = [
  'executionId',
  'experimentId',
  'taskId',
  'strategyId',
  'dryRun',
  'planOnly',
  'planFingerprint',
  'semanticPlanVersion',
  'participantModels',
  'synthesizerModelId',
  'judgeModelId',
  'qualityScore',
  'qualityDimensions',
  'qualityTier',          // R3: high | mid | low | unknown
  'costTier',             // R3: premium | standard | economy | unknown
  'participantSampleId',  // R3: fingerprint of the sample drawn from candidate pool
  'latencyMs',
  'costUsdEstimated',
  'qualityPerDollar',     // R3: thesis metric = qualityScore / costUsdEstimated
  'timestamp',
  'providerIds',
  'c3EligibilityPolicyVersion',
  'qualityScoreSource',
  'stepCount',
] as const;

export type C3ProvenanceField = typeof C3_PROVENANCE_REQUIRED_FIELDS[number];

// ── Experiment matrix dimensions ──────────────────────────────────────────────
// Matrix cell count unchanged from R2 (88). The expansion is in DEPTH (more
// candidate models per cell via sampling), not in breadth (cell count).

export const C3_MATRIX_STRATEGY_CELLS =
  C3_TASK_IDS.length * C3_ELIGIBLE_STRATEGIES.length; // 8 × 7 = 56

export const C3_MATRIX_BASELINE_CELLS =
  C3_TASK_IDS.length * C3_BASELINES.length; // 8 × 4 = 32

export const C3_MATRIX_TOTAL_CELLS =
  C3_MATRIX_STRATEGY_CELLS + C3_MATRIX_BASELINE_CELLS; // 88

// ── R3 vs R2 delta markers ────────────────────────────────────────────────────

export const C3_R3_VS_R2 = {
  // Historical R3 baseline counts (what R3 introduced vs R2)
  candidatePool: { r2: 10,  r3: 934,  r3Extended: 13808 },
  chatReadyProviders: { r2: 4,   r3: 17,   r3Extended: 23    },
  eligibilityGate: { r2: 'quality_score_required', r3: 'chat_ready_provider_and_capability' },
  qualityScoreRole: { r2: 'eligibility_gate', r3: 'stratification_and_priority' },
  participantPool: { r2: 'fixed_3_models', r3: 'sampled_from_934_stratified' },
  thesisExplicit: { r2: false, r3: true },
  // R4 provenance tracking
  r4IntegrityLockDate: '2026-06-06',
  r4ProviderCensusTotal: 82,
} as const;

// ── Absolute prohibitions (design-level constants, not runtime flags) ─────────

export const C3_SCOPE_DESIGN_PROHIBITIONS = {
  c3Executed: false,
  dryRunFalseExecuted: false,
  providerCallsMade: false,
  realConsensusRun: false,
  kExecuted: false,
  secretsLeaked: 0,
  schemaChanged: false,
  packageJsonChanged: false,
  remoteDeployed: false,
  billableCostUsd: 0,
} as const;
