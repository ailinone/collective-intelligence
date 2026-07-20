// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Core types for Ailin Dev API
 * These types match ailin-cli expectations
 */

import type { ToolResult } from './tool.js';
import type { InventoryRole } from '@/capability/inventory-role-policy';
import type { TierId, TierRate } from '@/services/pricing-tiers';

// ============================================
// Model & Provider Types
// ============================================

export interface Provider {
  id: string;
  name: string;
  displayName: string;
  status: 'active' | 'maintenance' | 'disabled';
  health: ProviderHealth;
  models: Model[];
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'down';
  lastCheck: Date;
  latency?: number;
  errorRate?: number;
}

export interface Model {
  id: string;
  providerId: string;
  provider: string; // Provider name
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  /**
   * Legacy capability array (DEPRECATED — derived projection of `capabilityUris`).
   * Kept on the Model shape for the migration window so existing scoring code
   * (capabilityFit, isChatGenerationCapable, etc.) keeps working unchanged.
   * New consumers should prefer `capabilityUris` (canonical post-HCRA).
   */
  capabilities: ModelCapability[];
  /**
   * Canonical capability URI list (HCRA, ADR-022). Populated from the
   * `capability_uris` DB column. URIs are of the form
   * `http://ailin.dev/cap/v1/<slug>` and reference rows in
   * `capability_ontology`. Empty array if HCRA hasn't backfilled this row yet
   * (in which case selectors should fall back to `capabilities`).
   */
  capabilityUris?: string[];
  /**
   * Per-URI fused confidence (0..1) over the 8-source noisy-OR. Optional —
   * present when the row was processed by the capability-merger.
   */
  capabilityConfidence?: Record<string, number>;
  performance: ModelPerformance;
  status: 'active' | 'deprecated' | 'disabled' | 'maintenance' | 'legacy' | 'preview';
  /** Runtime balance status set by discovery. Selection uses this for soft-scoring. */
  balanceStatus?: 'has-credits' | 'no-credits' | 'unknown' | 'local';
  /**
   * Structural role of this row in the catalog (Gap 2 closure, 2026-04-30).
   * Orthogonal to `status` (catalog availability) and `lifecycleStatus`
   * (observation freshness). See `src/capability/inventory-role-policy.ts`
   * for the four-bucket taxonomy: primary | secondary | community | synthetic.
   *
   * Hybrid storage (Option C): when present, this is the value persisted in
   * the `inventory_role` column at discovery time. When absent, downstream
   * consumers (notably /v1/models) should derive it from the classifier as
   * a fallback so callers always see a non-null value.
   */
  inventoryRole?: InventoryRole;
  metadata?: Record<string, unknown>;
  tags?: string[];
  specializations?: string[];
}

export type ModelCapability =
  | 'chat'
  | 'code_generation'
  | 'code_completion'
  | 'coding'
  | 'code_review'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'testing'
  | 'analysis'
  | 'qa'
  | 'vision'
  | 'multimodal'
  | 'function_calling'
  | 'tool_use'
  | 'streaming'
  | 'json_mode'
  | 'embeddings'
  | 'embedding'
  | 'reasoning'
  | 'thinking_mode'
  | 'text_generation'
  | 'web_search'
  | 'deep_research'
  | 'file_search'
  | 'image_generation'
  | 'image_editing'
  // Image-enhancement pipelines (e.g. Topaz): previously declared in
  // pinnedFallback inventories but missing from the enum, which broke the
  // pinned-fallback capability invariant. Added 2026-06-11.
  | 'image_upscale'
  | 'image_denoise'
  | 'video_generation'
  | 'video_editing'
  | 'video_understanding'
  | 'image_captioning'
  | 'visual_question_answering'
  | 'audio_generation'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'tts'
  | 'listen'
  | 'transcription'
  | 'audio_input'
  | 'audio_output'
  | 'audio_to_audio'
  | 'image_to_video'
  | 'video_to_video'
  | 'video_to_text'
  | 'video_transcription'
  | 'realtime_audio'
  | 'computer_use'
  | 'mcp'
  | 'deep_search'
  | 'completions'
  | 'code_interpreter'
  | 'diarization'
  | 'agents'
  | 'realtime'
  | 'audio'
  | 'deep_compute'
  | 'research'
  | 'health'
  | 'pdf_understanding'
  | 'translation'
  // Retrieval/rerank surfaces — Cohere `endpoints: ['rerank']`,
  // Voyage `rerank-2/2.5`, Jina rerank, etc. expose explicit endpoints
  // distinct from chat/embedding. Required for capability-search to
  // route "rerank" queries correctly.
  | 'reranking'
  | 'retrieval'
  // Specialty code-edit surface — Relace `apply-3` family and Morph
  // expose structured-edit application that is NOT general coding.
  // Distinct from `coding` (which covers code generation/completion).
  | 'code_edit'
  // Moderation / safety classifiers — `omni-moderation`, `text-moderation`,
  // `llamaguard`, `llama-guard` etc. are pure classifiers, distinct from
  // generative chat. The `safety` partner tag surfaces secondary uses
  // (assistance refusal, harm detection) so capability-search can group
  // them when policy routing requires "safety-rated" models.
  | 'moderation'
  | 'safety'
  // Long-context family — Moonshot Kimi (k2 line, 200k tokens), Claude
  // sonnet-4 (200k), GPT-4-turbo (128k), Gemini Pro (1M). Routing layer
  // uses this to direct workloads with long inputs to the right SKU
  // even when context-window numbers aren't comparable across families.
  | 'long_context';

/**
 * Enum-like pattern for string unions (single source of truth, no casts):
 * - Type: union type for typing
 * - Exported array: iteration, validation, documentation (public API)
 * - Internal Set: O(1) lookup for type guard (not exported)
 * - Type guard: narrows string to union (public API)
 * - Normalizer: unknown -> union with safe default (public API)
 */

/** Runtime list of all valid ModelCapability values. Public: use for iteration or validation. */
export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  'chat', 'code_generation', 'code_completion', 'coding', 'code_review', 'debugging', 'refactoring',
  'documentation', 'testing', 'analysis', 'qa', 'vision', 'multimodal', 'function_calling',
  'tool_use', 'streaming', 'json_mode', 'embeddings', 'embedding', 'reasoning', 'thinking_mode',
  'text_generation', 'web_search', 'deep_research', 'deep_search', 'file_search', 'image_generation',
  'image_editing', 'image_upscale', 'image_denoise',
  'video_generation', 'video_editing', 'video_understanding', 'image_captioning',
  'visual_question_answering', 'audio_generation', 'speech_to_text', 'text_to_speech', 'tts', 'listen',
  'transcription', 'audio_input', 'audio_output', 'audio_to_audio', 'image_to_video', 'video_to_video',
  'video_to_text', 'video_transcription', 'realtime_audio', 'computer_use', 'mcp', 'completions',
  'code_interpreter', 'diarization', 'agents', 'realtime', 'audio', 'deep_compute', 'research',
  'health', 'pdf_understanding', 'translation',
  // Retrieval/rerank + specialty code-edit (added 2026-04-28).
  'reranking', 'retrieval', 'code_edit',
  // Moderation/safety classifiers (added 2026-04-29 to mirror union).
  'moderation', 'safety',
  // Long-context routing target (≥128k tokens; added 2026-04-28).
  'long_context',
];

const MODEL_CAPABILITIES_SET = new Set<string>(MODEL_CAPABILITIES);

/** Type guard: true if string is a valid ModelCapability. Use for narrowing. */
export function isModelCapability(s: string): s is ModelCapability {
  return MODEL_CAPABILITIES_SET.has(s);
}

/** Normalize unknown to ModelCapability[]; invalid entries are filtered out. Use when parsing JSON/DB. */
export function ensureModelCapabilityArray(value: unknown): ModelCapability[] {
  const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return strings.filter(isModelCapability);
}

/** Model lifecycle status. Same as Model['status']. */
export type ModelStatus = Model['status'];

/** Runtime list of all valid ModelStatus values. Public: use for iteration or validation. */
export const MODEL_STATUSES: readonly ModelStatus[] = [
  'active', 'deprecated', 'disabled', 'maintenance', 'legacy', 'preview',
];

const MODEL_STATUS_SET = new Set<string>(MODEL_STATUSES);

/** Type guard: true if string is a valid ModelStatus. Use for narrowing. */
export function isModelStatus(s: string): s is ModelStatus {
  return MODEL_STATUS_SET.has(s);
}

/** Normalize unknown to ModelStatus; invalid values return 'active'. Use when parsing JSON/DB. */
export function ensureModelStatus(value: unknown): ModelStatus {
  return typeof value === 'string' && isModelStatus(value) ? value : 'active';
}

export interface ModelPerformance {
  latencyMs: number;
  throughput: number; // tokens/second
  quality: number; // 0-1 score
  reliability: number; // 0-1 score
  lastValidated?: Date;
}

// ============================================
// Chat Types (ailin-cli compatible)
// ============================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string | MessageContent[];
  name?: string;
  function_call?: FunctionCall;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_results?: ToolResult[];
}

export type MessageContent = TextContent | ImageContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export interface FunctionCall {
  name: string;
  arguments: string; // JSON string
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: FunctionCall;
}

export interface Tool {
  type: 'function';
  function: FunctionDefinition;
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface AilinRuntimeConstraints {
  requiredCapabilities?: ModelCapability[];
  requiredTools?: string[];
  requiredEndpoint?: string;
  preferredProviders?: string[];
  excludedProviders?: string[];
  maxInputCostPer1k?: number;
  maxOutputCostPer1k?: number;
  maxAverageCostPer1k?: number;
  minContextWindow?: number;
  /** Enable explicit chain-of-thought reasoning in collective strategies.
   *  Models are prompted to expose reasoning inside <reasoning> tags.
   *  Reasoning is captured in ModelExecution.reasoning and passed to synthesizers.
   *  Cost: ~30-50% more tokens per participant. Default: false. */
  enable_reasoning?: boolean;
  /** Enable the Observer/Narrator — a fast local model (Ollama sidecar) that
   *  narrates the collective intelligence process in real-time on a SEPARATE
   *  SSE channel (ailin_metadata.type='observer'; delta.content stays empty, so
   *  naive OpenAI clients are unaffected). The narration model is DISCOVERED
   *  from the sidecar's /v1/models (no hardcoded model). Degrades to a silent
   *  no-op if no backend resolves.
   *  Default: ON (undefined/true enable it); set enable_observer:false to opt
   *  out, or OBSERVER_DEFAULT_ENABLED=false as a global kill-switch. */
  enable_observer?: boolean;

  /** Inline "process header": promote the FIRST observer narration to the MAIN
   *  channel (delta.content) so a naive OpenAI client sees visible opening tokens
   *  in ~4s instead of the ~30-52s silence before the collective's synthesis. The
   *  remaining narrations stay off-channel. Trade-off: it places a short process
   *  preamble INSIDE the answer message — nice for an interactive UI, surprising for
   *  a programmatic caller. Default: OFF (opt-in). Global default override via
   *  COLLECTIVE_INLINE_NARRATION=true. */
  inline_narration?: boolean;

  /**
   * Objective answer check for a task with a verifiable answer (best-of-N, #2).
   * SERIALIZABLE form of `OrchestrationContext.answerVerifier` — the engine
   * resolves it (answer-check-resolver.ts) into the in-process predicate before
   * dispatch, so an HTTP caller (e.g. the v4 benchmark driver) can arm the
   * verifier. When set and the resolved strategy is collective, a
   * checker-verified candidate overrides the judge-driven selection. Omit for
   * open-ended tasks — without it the collective has no objective edge.
   */
  answer_check?: import('../core/orchestration/verification/answer-check-resolver').AnswerCheckSpec;
  /** Tie-break among checker-passing candidates ('majority' default; 'min'/'max'
   *  for extremal tasks). Ignored without `answer_check`. */
  answer_check_among?: 'majority' | 'min' | 'max';
  /** What the checker inspects: 'final' (default — the extracted FINAL line) or
   *  'full' (the ENTIRE reply — for CODE / structured artefacts like a self-contained
   *  HTML canvas scene where the objective property is structural). */
  answer_check_scope?: 'final' | 'full';
  /** Completion signals for a 'full'-scope check (SERIALIZABLE form of the
   *  experiment task's `answerCheckCompletionAnyOf`): at least ONE must appear
   *  in a candidate for it to be verifiable (e.g. ['</html>', '</script>']).
   *  A structural check's needles sit near the START of the artifact, so a
   *  reply clipped at the token cap still contains them while being
   *  non-runnable — without a closing signal such a candidate must not be
   *  selected as "verified". Ignored for 'final' scope. */
  answer_check_completion_any_of?: readonly string[];
}

export interface AilinBillingProfile {
  enabled?: boolean;
  inputMarkupMultiplier?: number;
  outputMarkupMultiplier?: number;
  flatFeeUsd?: number;
  minimumChargeUsd?: number;
  maximumChargeUsd?: number;
  minInputCostPer1kUsd?: number;
  minOutputCostPer1kUsd?: number;
}

export interface ChatRequest {
  model?: string; // Optional - let orchestration decide if not specified
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'json_object' | 'text' };

  // Ailin-specific extensions
  strategy?: ExecutionStrategyName | StrategyInputName;
  triageStrategy?: TriageStrategy; // Strategy for triage model selection (speed/cost/quality/balanced/adaptive)
  triageCollective?: number; // Number of models for collective triage (1-3, default: 1). Multiple models will vote/consensus
  max_cost?: number; // Maximum cost in USD
  quality_target?: number; // 0-1 target quality
  no_cache?: boolean; // Skip semantic cache lookup (for experiment validation)
  freeze_learning?: boolean; // Do not feed learning/bandit updates from this request (experiment 'frozen' phase — keeps the measured system fixed)
  disable_media_generation?: boolean; // Suppress video/image generation-intent interception. The experiment judge sets this so a rubric that mentions "clip"/"render"/"create" is evaluated as text, never rerouted to (costly, wrong) media generation.
  include_subcall_content?: boolean; // Return each subcall's full output text (+ extracted reasoning) in ailin_metadata.subcalls. Off by default — the intra-collective transcript can be hundreds of KB per response. The experiment runner sets this so every voter/coordinator output is persisted for full-flow auditability.
  prefer_speed?: boolean; // Explicitly prefer fast models (independent of quality_target)
  context_size?: number; // Estimated context size
  task_type?: TaskType;
  user_specified_model?: boolean;
  metadata?: Record<string, unknown>;
  ailin_alias?: string;
  ailin_constraints?: AilinRuntimeConstraints;
  ailin_billing?: AilinBillingProfile;
  /** Set when the model was a `<strategy>:<tier>` composite — the tier billed on user tokens. */
  ailin_tier?: TierId;
  ailin_tier_rate?: TierRate;

  /** Thinking budget for models with native extended thinking (DeepSeek-R1, QwQ).
   *  When set, the model uses its native thinking protocol instead of prompt injection. */
  thinking_budget?: number;

  // Multimodal extensions
  webSearch?: boolean;
  webSearchOptions?: {
    max_results?: number;
    search_context_size?: 'low' | 'medium' | 'high';
    engine?: 'native' | 'exa';
  };

  // Compositor extensions
  /** Pipeline of strategies for compositor (e.g., ['debate', 'collaborative']) */
  strategyPipeline?: string[];
  /** DAG workflow for compositor */
  strategyWorkflow?: { steps: Array<{ id: string; strategy: string; depends_on?: string[]; context?: string }> };

  // C3 Validation extensions
  /** Components to disable for ablation study (P0.2) */
  ablation_disable?: string[];
  /** Scoring policy override (P0.4): 'observability' | 'learning' | 'benchmark' */
  scoring_policy?: string;
  /**
   * LAT-1 (2026-06-11): force the LLM judge + learning tail to run SYNCHRONOUSLY
   * on the response path. Default (false) defers them for scoring_policy='learning'
   * so the response returns with a fast heuristic-preliminary score. Set true when a
   * caller needs the judged score/cost in the immediate response.
   */
  sync_judge?: boolean;

  /**
   * P5 — Native RAG. When present, the chat pipeline retrieves the most relevant
   * chunks from the named vector stores (via the P4 vector-search service, scoped
   * to the caller's organization) using the last user message as the query, then
   * injects them as a grounding `system` message BEFORE the conversation runs.
   * The retrieved sources are surfaced in `ailin_metadata.retrieval`.
   *
   * Omit the field for unchanged (no-retrieval) behaviour.
   */
  rag_config?: RagConfig;
}

/**
 * Native RAG configuration accepted on `POST /v1/chat/completions` (P5).
 */
export interface RagConfig {
  /** Vector store IDs to search. Only stores owned by the request's org are queried. */
  vector_store_ids: string[];
  /** Per-store kNN depth (default 5, clamped 1..50). */
  top_k?: number;
  /** Hard cap on total chunks injected across all stores (default 8, clamped 1..50). */
  max_chunks?: number;
  /** Drop chunks whose cosine similarity is below this threshold (0..1). */
  score_threshold?: number;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string; // "Ailin¹ Model" or requested model
  choices: ChatChoice[];
  usage?: Usage;

  // Ailin-specific metadata. Final completion responses carry the rich
  // `AilinMetadata` shape; SSE intermediate chunks (progress + observer +
  // clarification) use narrower discriminated variants. Discriminate via
  // the `type` field — absent on completion metadata, present on chunk
  // variants.
  ailin_metadata?: AilinMetadata | AilinProgressMetadata | AilinObserverMetadata | AilinClarificationMetadata;
}

/** SSE progress chunk: incremental step indicator emitted during long strategies. */
export interface AilinProgressMetadata {
  type: 'progress';
  message: string;
  step: number;
  total: number;
}

/** SSE observer chunk: narration emitted by the observer feed during execution.
 *  `observer` = off-channel (empty delta.content); `observer_inline` = the first
 *  narration promoted to the main channel (visible opening tokens, opt-in). */
export interface AilinObserverMetadata {
  type: 'observer' | 'observer_inline';
  event: string;
  narration: string;
  reasoning?: string;
  observer_duration_ms?: number;
}

/**
 * Clarification response: emitted by clarification-first strategy when the
 * user's request is ambiguous. The strategy returns an early response with
 * disambiguating questions instead of executing models speculatively.
 */
export interface AilinClarificationMetadata {
  type: 'clarification';
  ambiguity_score: number;
  questions: string;
}

export interface ChatChoice {
  index: number;
  message?: ChatMessage;
  delta?: Partial<ChatMessage>;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs?: null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============================================
// Embedding Types
// ============================================

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  user?: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

export interface EmbeddingData {
  object: 'embedding';
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
    completion_tokens?: number;
  };
}

export interface AilinMetadata {
  strategy_used: string;
  models_used: string[]; // Array of model names (hidden if branding enabled)
  model_count: number;
  execution_time_ms: number;
  cost_usd: number;
  resolved_strategy?: CanonicalStrategyName;
  resolved_model?: string;
  final_decider_model_id?: string;
  final_decider_model_name?: string;
  final_decider_role?: string;
  fallback_chain?: string[];
  provider?: string;
  quality_score?: number;
  cache_hit: boolean;
  triage_intent?: string;
  triage_complexity?: string;
  triage_strategy?: string;
  // Per-subcall decomposition for benchmark auditability
  subcalls?: Array<{
    model_id: string;
    model_name: string;
    role: string;
    cost_usd: number;
    latency_ms: number;
    success: boolean;
    error: string | null;
    tokens: Record<string, number> | null;
  }>;
  decision_source?: string | null;
  /** True when the orchestration engine returned the `[DEGRADED]` placeholder
   *  (every provider attempt failed) rather than a real model response. */
  degraded?: boolean;
  /** Machine-readable reason for `degraded` (e.g. 'empty_response_after_fallback'). */
  degraded_reason?: string;
  /**
   * Best-of-N observability (#2): how the collective selected its final answer
   * ('synthesis' | 'best_individual_fallback' | 'verified_individual' |
   * 'agreement_individual'). Absent for single-model executions.
   */
  aggregation_method?: string;
  /** Objective-checker telemetry (present only when the request carried an
   *  `answer_check` and a collective strategy evaluated it). */
  verification?: {
    decision: string;
    method: string;
    confidence: number;
    verified_count: number;
    total_count: number;
    verified_model_id: string | null;
  };
  /**
   * P5 — Native RAG retrieval provenance. Populated when the request carried a
   * `rag_config`. Lists the chunks injected into the prompt (with their source
   * store/file and similarity score), the queried store IDs, and the count.
   * Absent when no `rag_config` was supplied.
   */
  retrieval?: RetrievalMetadata;
  /**
   * Non-textual artifacts (image/video/audio) produced by media-generation
   * stages of a multi-stage triage plan. Absent for single-stage/purely
   * textual executions. Additive — `choices[].message.content` is unaffected.
   */
  artifacts?: AilinArtifact[];
  /** Prompt variant ID selected by the variant bandit (if active). */
  prompt_variant?: string;
  /** SHA-256 hash (truncated) of the prompt slot values used (for audit). */
  prompt_slot_hash?: string;
  /**
   * 01C.1B-R/P — dry-run fail-closed gate + plan-fingerprint parity metadata.
   * Populated ONLY on responses short-circuited by `applyDryRunFailClosedGate`
   * (eval.dryRun=true / eval.planOnly=true / eval.executionParityCheck=true).
   * Absent on every real (billable) execution response.
   */
  dryRun?: boolean;
  /** Sanitized consensus plan snapshot (no prompts/secrets) for the dry-run. */
  consensusPlan?: unknown;
  /** One-shot handoff token between a dry-run plan and its later real execution. */
  executionPlanId?: string;
  /** SHA-256 over the sanitized plan snapshot — see consensus-plan-fingerprint.ts. */
  planFingerprint?: string;
  planSource?: 'dry_run' | 'runtime_planner' | 'approved_dry_run_plan';
  plannerVersion?: string;
  registryScope?: 'full_system_registry';
  probeScope?: 'auxiliary';
  roleSpecificRetrieval?: boolean;
  /** True when this response answered an `executionParityCheck=true` request. */
  executionParityCheck?: boolean;
  /** True when the recomputed ("would execute") fingerprint matched `approvedPlanFingerprint`. */
  planFingerprintMatched?: boolean;
  approvedPlanFingerprint?: string;
  wouldExecutePlanFingerprint?: string;
  plannedJudgeModelId?: string | null;
  wouldExecuteJudgeModelId?: string | null;
  plannedSynthesizerModelId?: string | null;
  wouldExecuteSynthesizerModelId?: string | null;
  // Internal tracking (never exposed to client)
  _internal?: {
    actual_models?: string[];
    actual_providers?: string[];
    actual_strategy?: string;
    cache_layer?: string;
    cache_latency?: number;
  };
}

/**
 * P5 — Native RAG retrieval provenance surfaced in `ailin_metadata.retrieval`.
 * Real data sourced from the P4 vector-search service.
 */
export interface RetrievalMetadata {
  /** Chunks injected into the prompt, ordered by descending similarity. */
  chunks: Array<{
    vector_store_id: string;
    file_id: string;
    /** Cosine similarity in [0,1] (1 = identical). */
    score: number;
    /** Truncated preview of the chunk text (for auditability; not the full content). */
    content_preview: string;
  }>;
  /** Vector store IDs that were queried. */
  store_ids: string[];
  /** Number of chunks injected (== chunks.length). */
  chunk_count: number;
}

/**
 * A non-textual artifact produced by a media-generation stage of a
 * multi-stage triage plan (executeMultiStagePlan). Surfaced to the client
 * via `ailin_metadata.artifacts` — additive to the OpenAI-compatible
 * `choices[].message.content` contract, never a replacement for it.
 */
export interface AilinArtifact {
  modality: 'image' | 'video' | 'audio' | 'file';
  /** Name of the triage stage that generated this artifact. */
  stage_name: string;
  /** Index of the stage within the plan's `stages` array. */
  stage_index: number;
  url?: string;
  b64_json?: string;
  mime_type?: string;
  /** Suggested filename (extension included), populated for `modality: 'file'`. */
  filename?: string;
  /** Provider-echoed revised prompt (common for image generation). */
  revised_prompt?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  /** Real per-artifact cost is not tracked anywhere in the platform today
   *  (images/video/audio generation report cost_usd=0 uniformly) — absent
   *  rather than a fabricated number. See `ModelExecution.costSource`. */
  cost_usd?: number;
  /** Present when generation failed but the pipeline degraded gracefully
   *  (url/b64_json absent in this case). */
  error?: string;
  metadata?: Record<string, unknown>;
}

// ============================================
// Orchestration Types
// ============================================

export type CanonicalStrategyName =
  | 'single'
  | 'cost'
  | 'speed'
  | 'quality'
  | 'balanced'
  | 'parallel'
  | 'sequential'
  | 'collaborative'
  | 'hybrid'
  | 'competitive'
  | 'expert-panel'
  | 'massive-parallel'
  | 'cost-cascade'
  | 'quality_multipass'
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
  | 'compositor'
  | 'sensitivity-consensus'
  | 'tri-role-collective'
  | 'dynamic';

export type StrategyInputName =
  | CanonicalStrategyName
  | 'quality-multi-pass'
  | 'quality-multipass'
  | 'clarify'
  | 'research'
  | 'multi-hop'
  | 'personas'
  | 'fast'
  | 'auto';

export type ExecutionStrategyName =
  | 'single'
  | 'parallel'
  | 'sequential'
  | 'collaborative'
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
  | 'debate' // Multi-turn debate between models
  | 'war-room' // Commander decomposes → parallel specialists → critique → synthesis
  | 'blind-debate' // Parallel independent responses → adjudicator synthesis (anti-cascade)
  | 'devil-advocate-consensus' // N-1 propose + 1 critique → synthesis (anti-groupthink)
  | 'safety-quorum' // N models assess safety via majority vote (quorum sensing)
  | 'diversity-ensemble' // Max cross-provider diversity parallel + synthesis (diversity-yields-better-aggregation)
  | 'stigmergic-refinement' // Sequential: draft → refine → critique → synthesize (stigmergy)
  | 'swarm-explore' // Multi-angle parallel exploration + aggregation (swarm intelligence)
  | 'clarification-first' // Assess ambiguity → generate clarification questions → delegate
  | 'research-synthesize' // Parallel research → evidence ranking → confidence-based synthesis
  | 'critique-repair' // Adaptive loop: generate → critique → repair until quality target met
  | 'double-diamond' // Macro: discover → define → develop → deliver (4 phases with gates)
  | 'multi-hop-qa' // Decompose → topological execution with context accumulation → synthesize
  | 'persona-exploration' // 10-20 diverse personas respond → aggregator synthesizes best insights
  | 'agentic' // Autonomous: plan workflow → execute steps (tools + LLM) → deliver result
  | 'compositor' // Pipeline/DAG composition of multiple sub-strategies
  | 'sensitivity-consensus' // Iterative coordination: decision + sensitivity + state + convergence
  | 'tri-role-collective' // Cyclical Planner → Solver → Auditor with revise loop until acceptance
  | 'cached' // Response served from semantic cache
  | 'auto'; // Let system decide

export type TaskType =
  | 'code-generation'
  | 'code-review'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'testing'
  | 'analysis'
  | 'qa'
  | 'general'
  | 'caching'
  | 'reasoning'
  | 'decision-making'
  | 'architecture'
  | 'creative'
  | 'factual-qa'
  | 'adversarial'
  | 'document-understanding';

export interface ExecutionStrategy {
  id: string;
  name: ExecutionStrategyName;
  displayName: string;
  description: string;
  minModels: number;
  maxModels: number;
  estimatedCost: number; // Base cost multiplier
  estimatedQuality: number; // Expected quality improvement
  estimatedDuration: number; // Duration multiplier
  suitableFor: TaskType[];
  implementation: StrategyImplementation;
}

export interface StrategyImplementation {
  execute: (request: ChatRequest, context: OrchestrationContext) => Promise<OrchestrationResult>;
}

/**
 * Simple user context for route handlers and services
 * that don't need full orchestration context
 */
export interface RequestUserContext {
  organizationId: string;
  userId?: string;
  requestId: string;
}

/**
 * Full orchestration context for strategy execution
 */
export interface OrchestrationContext extends RequestUserContext {
  models: Model[];
  budget?: number;
  qualityTarget?: number;
  maxCost?: number;
  taskType: TaskType;
  contextSize: number;
  triage?: TriageDecision;
  preferredModelIds?: string[];
  preferSpeed?: boolean;
  preferQuality?: boolean;
  requiredCapabilities?: ModelCapability[];
  requiredTools?: string[];
  requiredEndpoint?: string;
  preferredProviders?: string[];
  excludedProviders?: string[];
  maxInputCostPer1k?: number;
  maxOutputCostPer1k?: number;
  maxAverageCostPer1k?: number;

  /**
   * Free-text semantic query forwarded to the DynamicModelSelector for
   * RRF-fused (lexical + vector) candidate reranking via the
   * CapabilitySearchService singleton (ADR-022). Populated by the
   * orchestration engine from the user's prompt when `model` is `auto`
   * or unspecified. When omitted, the selector skips the rerank and
   * falls back to legacy 6-component scoring only.
   */
  semanticQuery?: string;

  /** Heuristic capability inference result (Layer 3 — local, <1ms) */
  capabilityInference?: import('../core/orchestration/capability-inference.js').CapabilityInferenceResult;
  /** Semantic execution plan from triage (Layer 2) or inference (Layer 3) */
  executionPlan?: TriageExecutionPlan;

  /**
   * Capability invoker for cross-modal strategy execution.
   * Allows strategies to invoke STT, TTS, translation, etc.
   * alongside chat — enabling multimodal pipelines.
   */
  invoker?: import('../core/orchestration/capability-invoker.js').CapabilityInvoker;

  /** C3 P0.2: Ablation flags for controlled experiments */
  ablationFlags?: import('../core/validation/c3/ablation-config.js').AblationFlags;
  /** C3 P0.4: Scoring policy override */
  scoringPolicy?: import('../core/validation/c3/scoring-policy.js').ScoringPolicy;
  /**
   * LAT-3: set by the orchestration engine after it enriches the request with
   * semantic-memory context, so strategy-level enrichWithMemories() skips the
   * duplicate embedding + pgvector retrieval (and duplicate prompt block).
   */
  memoryEnriched?: boolean;
  /** LAT-1: when true, run the judge + learning tail synchronously (no deferral). */
  syncJudge?: boolean;

  /**
   * Speculative selection (2026-07-14): when the engine ran model selection
   * CONCURRENTLY with the triage LLM call (see
   * `resolveSpeculativeSingleSelection` in orchestration-engine.ts) and the
   * result is still valid once triage resolves, this carries the already-
   * resolved model+adapter so `SingleModelStrategy.selectBestModel()` can
   * reuse it instead of re-running `DynamicModelSelector.selectModels()`.
   * Absent when speculation wasn't attempted, was discarded (triage picked
   * a different model/strategy), or failed.
   */
  precomputedModelSelection?: {
    model: Model;
    adapter: import('../providers/base/provider-adapter.js').ProviderAdapter;
  };

  /**
   * Best-of-N verification (#2, the thesis lever): objective checker for verifiable
   * tasks. Returns true iff a candidate's extracted final answer satisfies the task's
   * checkable property (plug it back into the constraints — no intended-answer peeking).
   * When set, collective strategies let the checker override judge-scored selection:
   * a verified voter beats an unverified synthesis (see
   * core/orchestration/verification/verified-selection.ts). Leave unset for open-ended
   * tasks — without a checker the collective has no objective edge and triage prefers
   * a strong single.
   */
  answerVerifier?: (answer: string) => boolean;
  /** Tie-break among checker-passing candidates ('majority' default; 'min'/'max' for
   *  extremal tasks like "smallest N such that…"). Ignored without `answerVerifier`. */
  answerVerifierAmong?: 'majority' | 'min' | 'max';
  /** What the checker inspects: 'final' (default) or 'full' (entire reply — for CODE /
   *  structured artefacts). Ignored without `answerVerifier`. */
  answerVerifierScope?: 'final' | 'full';
  /** Completion signals for a 'full'-scope check: at least ONE must appear in a
   *  candidate before the checker gets a say (resolved from
   *  `ailin_constraints.answer_check_completion_any_of`). Guards best-of-N
   *  selection against a token-cap-clipped artifact that still contains the
   *  structural needles. Ignored without `answerVerifier` / for 'final' scope. */
  answerVerifierCompletionAnyOf?: readonly string[];

  /**
   * Whether the resolved top-level strategy is a collective (multi-model) strategy.
   * Single source of truth derived from `BaseStrategy.getMetadata().minModels > 1`
   * at orchestration-engine resolution time. Consumed by the execution-system-prompt
   * builder to decide whether to emit collective-intelligence framing, replacing a
   * previously hardcoded Set that missed several real collective strategies.
   */
  isCollectiveStrategy?: boolean;

  /**
   * Hardening Bloco F: degradation trace set by orchestration engine when
   * a strategy was degraded via pre-dispatch or runtime fallback. Read by
   * the engine's post-execution metadata assembly to emit degradation_path
   * and related fields into the response metadata.
   */
  degradation?: {
    originalStrategy: string;
    executedStrategy: string;
    degradationPath: string[];
    degradationReason: string;
    degradationDepth: number;
    isDegraded: boolean;
  };
}

/**
 * Engine-internal bookkeeping carried on `OrchestrationResult.metadata`.
 *
 * Double-underscore prefix = internal contract: these keys are written/read
 * only by the orchestration engine (scoring policy plumbing, LAT-1 deferral,
 * cost-fold guards) and persisted for offline analysis. They are NEVER copied
 * into the client-facing `ailin_metadata`, which chat-request-processor
 * builds from an explicit field allowlist. Typing them here lets the engine
 * access them without `as Record<string, unknown>` casts.
 */
export interface OrchestrationInternalMetadata {
  /** C3 P0.4: scoring policy that produced the quality score. */
  __scoringPolicy?: string;
  /** C3 P0.4: the mandatory LLM-Judge call failed (score is heuristic fallback). */
  __judgeFailed?: boolean;
  /** C3 P0.4: score passed the judge-validity gate and may feed learning. */
  __validForLearning?: boolean;
  /** LAT-1: response shipped with a heuristic-preliminary score; the judge ran post-response. */
  __judgeDeferred?: boolean;
  /** LAT-1: triage cost was already folded into totalCost synchronously (do not double-count). */
  __triageCostFolded?: boolean;
}

export interface OrchestrationResult {
  strategyUsed: ExecutionStrategyName;
  modelsUsed: ModelExecution[];
  finalResponse: ChatResponse;
  totalCost: number;
  totalDuration: number;
  qualityScore?: number;
  metadata: Record<string, unknown> & OrchestrationInternalMetadata;
  triage?: TriageDecision;
  /** Media artifacts (image/video/audio) produced by multi-stage generation
   *  stages. Undefined for single-stage/purely textual executions. */
  artifacts?: AilinArtifact[];
}

export interface ModelExecution {
  modelId: string;
  modelName: string;
  role: ModelRole;
  request: ChatRequest;
  response: ChatResponse;
  cost: number;
  /** Raw provider-reported cost BEFORE normalization (TIER 1, 2026-06-11).
   *  `cost` may be a token×pricing estimate when the executing hub reports $0
   *  despite consuming tokens; `rawCost` preserves what the adapter returned so
   *  the estimate is auditable. Absent when no normalization happened. */
  rawCost?: number;
  /** Provenance of the `cost` value when it was normalized
   *  (e.g. 'provider_reported', 'estimated_from_pricing_table',
   *  'imputed_from_model_family', 'genuinely_free', 'missing'). */
  costSource?: string;
  durationMs: number;
  success: boolean;
  error?: string;
  /** Explicit reasoning/chain-of-thought extracted from the model's response.
   *  Populated when enable_reasoning=true. Contains content from <reasoning> or <think> tags. */
  reasoning?: string;
  /** Token count of the reasoning portion (for cost/performance tracking). */
  reasoningTokens?: number;
  /** ID of the prompt variant selected by the prompt variant bandit (if active). */
  promptVariantId?: string;
  /** Prompt catalog key (e.g. 'consensusVoter') for the variant bandit feedback loop.
   *  Required alongside promptVariantId for the bandit to know which arm to reward. */
  promptKey?: string;
  /** SHA-256 hash (truncated 16 hex chars) of the prompt slot values used. */
  promptSlotHash?: string;
}

/** Observer event emitted during collective strategy execution. */
export interface ObserverEvent {
  type: 'phase_start' | 'model_response' | 'round_complete' | 'reasoning_extracted' | 'synthesis_start' | 'synthesis_complete' | 'quality_assessment';
  timestamp: number;
  strategy: string;
  round?: number;
  totalRounds?: number;
  models?: string[];
  modelId?: string;
  modelName?: string;
  summary?: string;
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

/** Observer narration generated by the local reasoning model. */
export interface ObserverNarration {
  event: ObserverEvent;
  narration: string;
  reasoning?: string;
  durationMs: number;
}

export interface TriageDecision {
  intent: TaskType | 'support' | 'data-request' | 'other';
  complexity: 'low' | 'medium' | 'high';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  recommendedStrategy?: ExecutionStrategyName;
  recommendedModels?: string[];
  requiresTools?: boolean;
  /**
   * Fast-path signal: `direct_response` for trivial social messages (greetings,
   * thanks) with no real task — the engine skips multi-stage plan construction
   * and answers directly with a single model. `planned_execution` (default)
   * otherwise. A client-explicit `request.tools` or `quality_target>=0.9`
   * always overrides this to `planned_execution`, regardless of what the
   * triage LLM set here.
   */
  route?: 'direct_response' | 'planned_execution';
  confidence?: number;
  reason?: string;
  estimatedTokens?: number;

  /**
   * Billable cost (USD) of the triage LLM call(s) that produced this decision.
   * Cost-accounting integrity (TIER 0): triage runs a real paid LLM call before
   * the strategy; its cost must be folded into the request totalCost. 0 for
   * heuristic (non-LLM) triage. Undefined when not computed.
   */
  costUsd?: number;

  /** Semantic execution plan generated by triage LLM — all parameters dynamic */
  executionPlan?: TriageExecutionPlan;
}

/**
 * Full execution plan produced by triage. Every field is semantically inferred
 * from the conversation content and available model capabilities — no hardcoded defaults.
 */
export interface TriageExecutionPlan {
  /** Estimated output tokens needed — derived from task complexity, not a fixed cap */
  maxTokens: number;
  /** 0-1 quality target — derived from risk profile and task criticality */
  qualityTarget: number;
  /** Whether speed is prioritized — derived from urgency signals in the conversation */
  preferSpeed: boolean;
  /** Required capabilities from the full 60-capability catalog */
  requiredCapabilities: string[];
  /** Estimated input context tokens the models need to process */
  estimatedInputTokens: number;

  /** Top-level orchestration strategy */
  strategy: ExecutionStrategyName;
  /** Number of models to involve (3-9) */
  modelCount: number;
  /** Whether the response may exceed a single model's output window, requiring continuation loops */
  requiresContinuation: boolean;
  /** Maximum deliberation rounds (review/refinement cycles). 0=single-pass, 1-5=iterative. Determined by triage based on complexity and quality requirements */
  maxDeliberationRounds?: number;
  /** Whether to enable explicit chain-of-thought reasoning in collective strategies.
   *  Triage recommends this for high-complexity reasoning/analysis tasks. */
  enableReasoning?: boolean;

  /**
   * Tool names (verbatim from the server's tool catalog, see
   * `ToolRegistryImpl.describeStrategyToolsForPrompt()`) the triage LLM
   * recommends enabling for this task. Only applied by the engine when the
   * client did not already supply its own `request.tools` — client-supplied
   * tools always win.
   */
  recommendedTools?: string[];

  /** Multi-stage execution plan with per-stage sub-strategies, roles, and SOTA system prompts */
  stages: TriageStage[];
}

/**
 * A single execution stage within a multi-stage plan.
 * Each stage can use a different strategy, different models, and different roles.
 */
export interface TriageStage {
  /** Semantic name for this stage (e.g., "security_audit", "code_generation", "validation") */
  name: string;
  /** Sub-strategy for this stage — can differ from the top-level strategy */
  strategy: ExecutionStrategyName;
  /** Model assignments with roles for this stage */
  modelRoles: TriageModelRole[];
  /** Capabilities required for models in this stage */
  requiredCapabilities: string[];
  /** Estimated output tokens for this stage */
  maxTokens: number;
  /**
   * Short, task-specific context that augments the canonical strategy prompt from the
   * SOTA catalog. NOT a full system prompt — must not restate identity, role or framing
   * that the strategy's catalog prompt already covers. Max ~400 chars. Prepended as an
   * auxiliary system message so the strategy's own role prompts still fire unchanged.
   *
   * Supersedes the legacy `systemPrompt` field which encouraged the triage LLM to
   * fabricate complete prompts that competed with the catalog and were partially or
   * fully discarded at runtime.
   */
  taskContext?: string;
  /**
   * Typed prompt slots for task-specific augmentation (preferred over blob taskContext).
   * Filled by the triage LLM with structured, bounded, Zod-validated values.
   * See `prompt-slots.ts` for the slot definitions and rendering.
   */
  promptSlots?: import('@/core/orchestration/prompts/prompt-slots').PromptSlotValues;
  /**
   * Free-form augmentation for novel tasks where structured slots can't capture
   * the needed guidance (<=1200 chars, deny-pattern validated). Only emitted when
   * triage confidence is low (<0.6). See `triage-schema.ts` for validation rules.
   */
  augmentation?: string;
  /**
   * Literal, self-contained prompt for media-generation stages (present only
   * when `requiredCapabilities` includes image_generation/video_generation/
   * audio_generation/text_to_speech). Must not depend on conversational
   * context ("the image above") — describes the content to generate in full.
   */
  generationPrompt?: string;
}

/**
 * A model role assignment within a stage.
 * Roles are differentiated by the catalog prompts (debate moderator, war-room specialist,
 * etc.), not by per-role system prompts fabricated by triage. Per-role prompt fabrication
 * was removed as part of R1 because the runtime only ever consumed the first role's prompt.
 */
export interface TriageModelRole {
  /** Role for this model — can be a known role or an ad-hoc contextual role */
  role: ModelRole | string;
  /** How many models fill this role */
  count: number;
  /** Preferred capabilities for models in this role */
  preferredCapabilities: string[];
  /** Minimum quality target for models in this role */
  qualityTarget: number;
}

export type ModelRole =
  | 'primary'
  | 'secondary'
  | 'validator'
  | 'reviewer'
  | 'arbitrator'
  | 'pre-analyzer'
  | 'decomposer'
  | 'coordinator'
  | 'voter'
  | 'quality-checker'
  // Ad-hoc roles generated by triage LLM (e.g., "security_auditor", "ux_expert")
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  metadata?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  statusCode: number;
}

// ============================================
// Usage & Analytics Types
// ============================================

export interface UsageStats {
  period: 'day' | 'month' | 'year';
  periodStart: Date;
  periodEnd: Date;
  requestCount: number;
  tokenCount: number;
  costUsd: number;
  avgDurationMs: number;
  errorRate: number;
  cacheHitRate: number;
  topModels: ModelUsage[];
  topStrategies: StrategyUsage[];
}

export interface ModelUsage {
  modelName: string;
  requestCount: number;
  tokenCount: number;
  costUsd: number;
}

export interface StrategyUsage {
  strategyName: string;
  executionCount: number;
  avgCost: number;
  avgQuality: number;
  successRate: number;
}

// ============================================
// Configuration Types
// ============================================

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  app: ApplicationMetadata;
  server: ServerConfig;
  api: ApiConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  /**
   * Money-path Redis (BullMQ queues + the idempotency store) — see
   * `getQueueRedisClient()`/`createRedisClient()` in cache/redis-client.ts.
   * Every field falls back to the matching `redis.*` value when unset, so an
   * unconfigured deployment keeps today's single-instance behavior; setting
   * `REDIS_QUEUE_*` env vars points this at a physically separate Redis so
   * cache/rate-limit churn on the general instance can't OOM or evict
   * in-flight jobs and idempotency records (docs/audit/16, Phase 5).
   */
  redisQueue: RedisConfig;
  queue: QueueConfig;
  providers: ProviderConfig[];
  orchestration: OrchestrationConfig;
  cache: CacheConfig;
  autoLearning: AutoLearningConfig;
  security: SecurityConfig;
  auth: AuthConfig;
  observability: ObservabilityConfig;
  secrets: SecretsConfig;
  payments: PaymentsConfig;
  resilience: ResilienceConfig;
  featureFlags: FeatureFlagsConfig;
  notifications: NotificationsConfig;
}

export interface ApiConfig {
  baseUrl: string;
}

export interface NotificationsConfig {
  apiKeys: ApiKeyNotificationsConfig;
}

export interface ApiKeyNotificationsConfig {
  emailEnabled: boolean;
  includePlainKeyInEmail: boolean;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  includePlainKeyInWebhook: boolean;
  webhookTimeoutMs: number;
}

export interface ApplicationMetadata {
  version: string;
  cliMinVersion: string;
  cliLatestVersion: string;
  commitSha?: string;
  buildTimestamp?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export interface DatabaseConfig {
  url: string;
  poolMin: number;
  poolMax: number;
  connectionTimeout: number;
  idleTimeout: number;
}

export interface RedisSentinelNode {
  host: string;
  port: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  /**
   * True horizontal Cluster/sharding mode. NOT currently safe to enable: the
   * `redis-global` cache layer (see cache-service.ts) relies on `db: 1` for
   * namespacing, and Redis Cluster only supports db 0; BullMQ's own key
   * scheme (queue-keys.js) has no hash-tag prefixing, so its multi-key Lua
   * scripts would hit CROSSSLOT errors once a queue's keys land on different
   * shards. Kept as recognized config (redis-client.ts fails fast rather than
   * silently ignoring it) pending that redesign — see docs/audit/16, Phase 5.
   */
  clusterEnabled: boolean;
  clusterNodes?: string[];
  /** Sentinel-monitored HA (automatic primary failover, no sharding) — safe for every current consumer. */
  sentinelEnabled: boolean;
  sentinels?: RedisSentinelNode[];
  sentinelName?: string;
}

export interface QueueConfig {
  enabled: boolean;
  queueName: string;
  workerCount: number;
  workerConcurrency: number;
  maxAttempts: number;
  backoffInitialDelayMs: number;
  backoffStrategy: 'exponential' | 'fixed';
  resultTtlSeconds: number;
  statusTtlSeconds: number;
  maxQueueTimeSeconds: number;
  pollIntervalMs: number;
  runWorkersInApiProcess: boolean;
  workerMetricsPort: number;
  forceQueue: boolean;
  priority: {
    enterprise: number;
    pro: number;
    free: number;
    jitter: number;
  };
  scale: QueueAutoScaleConfig;
}

export interface QueueAutoScaleConfig {
  enabled: boolean;
  minWorkers: number;
  maxWorkers: number;
  scaleStep: number;
  scaleUpUtilizationPercent: number;
  scaleDownUtilizationPercent: number;
  scaleUpQueueSize: number;
  scaleDownQueueSize: number;
  monitorIntervalMs: number;
  cooldownMs: number;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  enabled: boolean;
  /**
   * Scale-to-100k Phase 2: optional pool of additional API keys for this
   * provider, rotated round-robin alongside `apiKey` so a single upstream
   * account's rate limit isn't a hard ceiling on the provider's throughput.
   * Populated from `<PROVIDER>_API_KEY_POOL` (JSON string array) in
   * config/index.ts. Adapter support is opt-in per adapter (see
   * ProviderAdapter.getRequestApiKey / getRequestClient) — most adapters
   * still use only `apiKey` until they adopt it.
   */
  apiKeyPool?: string[];
}

/**
 * Triage strategy for model selection
 * Determines how triage models are selected based on different optimization goals
 */
export type TriageStrategy =
  | 'speed' // Prioritize fastest models (lowest latency)
  | 'cost' // Prioritize lowest cost models
  | 'quality' // Prioritize highest quality models
  | 'balanced' // Balance speed, cost, and quality
  | 'adaptive'; // Adapt based on request complexity and context

export interface OrchestrationConfig {
  maxModels: number;
  defaultStrategy: ExecutionStrategyName;
  enableParallel: boolean;
  enableCompetitive: boolean;
  enableArbitration: boolean;
  enableTriaging?: boolean;
  triageModel?: string;
  triageStrategy?: TriageStrategy; // Strategy for selecting triage models dynamically
  triageCollective?: number; // Number of models for collective triage (1-3, default: 1)
  triageTemperature?: number;
  triageMaxTokens?: number;
}

export interface CacheConfig {
  enabled: boolean;
  ttlDefault: number;
  ttlModels: number;
  ttlResponses: number;
  ttlEmbeddings: number;
  maxSizeMb: number;
  maxInMemoryEntries: number;
  invalidateChannel: string;
  circuitBreaker: CacheCircuitBreakerConfig;
}

export interface CacheCircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  disableCacheOnOpen?: boolean;
}

export interface AutoLearningConfig {
  enabled: boolean;
  bucketSizeHours: number;
  retentionDays: number;
}

export interface SecurityConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshExpiresIn: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAlgorithms: string[];
  jwtClockToleranceSeconds: number;
  federation: {
    enabled: boolean;
    sharedSecret?: string;
    jwksUri?: string;
    jwksCacheTtlSeconds: number;
    allowSharedSecretFallback: boolean;
    issuer: string;
    audience: string;
    algorithms: string[];
    clockToleranceSeconds: number;
    autoProvisionUsers: boolean;
    autoProvisionOrganizations: boolean;
  };
  // M2M service-token auth for internal endpoints (/v1/internal/*). Verifies
  // RS256 tokens minted by the ailin id OIDC provider against id's JWKS.
  serviceAuth: {
    enabled: boolean;
    jwksUri: string;
    issuer: string;
    audience: string;
    allowedClients: string[];
    jwksCacheTtlSeconds: number;
    clockToleranceSeconds: number;
  };
  corsEnabled: boolean;
  corsOrigin: string;
  helmetEnabled: boolean;
  compressionEnabled: boolean;
  rbac: {
    defaultRole: string;
    superRoles: string[];
    cacheTtlMs: number;
  };
  audit: {
    enabled: boolean;
    retentionDays: number;
  };
}

export type AuthMode = 'email_code' | 'password' | 'sso';

export interface AuthConfig {
  defaultMode: AuthMode;
  allowPasswordFallback: boolean;
  code: AuthCodeConfig;
  email: AuthEmailConfig;
  sso?: AuthSSOConfig;
}

export interface AuthCodeConfig {
  length: number;
  ttlSeconds: number;
  cooldownSeconds: number;
  maxAttempts: number;
}

export interface AuthEmailConfig {
  provider: 'sendgrid' | 'ses' | 'smtp';
  fromEmail?: string;
  fromName?: string;
  sendgrid?: {
    apiKey?: string;
  };
  ses?: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
  };
}

export interface AuthSSOConfig {
  enabled: boolean;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityConfig {
  otelEnabled: boolean;
  serviceName: string;
  jaegerEndpoint?: string;
  prometheusPort?: number;
  prometheusToken?: string;
}

export interface ResilienceConfig {
  forceDistributedCircuits: boolean;
  forceDistributedTokenBuckets: boolean;
  forceDistributedBulkheads: boolean;
}

export interface FeatureFlagsConfig {
  configRefreshSeconds: number;
  authStrictClaims: boolean;
  strictSecretsProd: boolean;
}

export interface PaymentsConfig {
  stripe: StripeConfig;
}

export interface StripeConfig {
  enabled: boolean;
  apiVersion: string;
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
  clientRetryMs: number;
  defaultCurrency: string;
  statementDescriptor?: string;
  successUrl?: string;
  cancelUrl?: string;
  customerPortalReturnUrl?: string;
  automaticTax: boolean;
  invoiceCollectionMethod: 'send_invoice' | 'charge_automatically';
  invoiceDaysUntilDue: number;
  apiBaseUrl?: string;
  usageReconciliationCron?: string;
}

export interface ServiceStatusResponse {
  service: string;
  environment: string;
  version: string;
  build?: {
    commitSha?: string;
    buildTimestamp?: string;
  };
  apiVersion: string;
  supportedVersions: Array<{
    key: string;
    version: string;
    status: 'active' | 'deprecated' | 'sunset';
    breaking: boolean;
    supportedUntil?: string;
  }>;
  cli: {
    minVersion: string;
    latestVersion: string;
  };
  features: Record<string, unknown>;
  timestamp: string;
}

// ============================================
// Secrets Manager Types
// ============================================

export type SecretsProviderType = 'vault' | 'aws' | 'azure' | 'gcp' | 'env';

export interface BaseSecretsProviderConfig {
  id: string;
  type: SecretsProviderType;
  priority: number;
  failOpen?: boolean;
}

export interface VaultSecretsProviderConfig extends BaseSecretsProviderConfig {
  type: 'vault';
  options: {
    address: string;
    token: string;
    namespace?: string;
    secretPath: string;
  };
}

export interface AwsSecretsProviderConfig extends BaseSecretsProviderConfig {
  type: 'aws';
  options: {
    region: string;
    secretPrefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    roleArn?: string;
  };
}

export interface AzureSecretsProviderConfig extends BaseSecretsProviderConfig {
  type: 'azure';
  options: {
    keyVaultUrl: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

export interface GcpSecretsProviderConfig extends BaseSecretsProviderConfig {
  type: 'gcp';
  options: {
    projectId: string;
    secretPrefix?: string;
    credentialsFile?: string;
    credentialsJson?: string;
  };
}

export interface EnvSecretsProviderConfig extends BaseSecretsProviderConfig {
  type: 'env';
  options: {
    prefix?: string;
  };
}

export type SecretsProviderConfig =
  | VaultSecretsProviderConfig
  | AwsSecretsProviderConfig
  | AzureSecretsProviderConfig
  | GcpSecretsProviderConfig
  | EnvSecretsProviderConfig;

export interface SecretsAuditConfig {
  enabled: boolean;
  persist: boolean;
}

export interface SecretsRotationConfig {
  cron?: string;
  managedKeys: Array<{
    key: string;
    providerId?: string;
    length: number;
    intervalDays: number;
    description?: string;
  }>;
}

export interface SecretsConfig {
  cacheTTL: number;
  autoRefresh: boolean;
  encryptCache: boolean;
  serviceAccount: string;
  providers: SecretsProviderConfig[];
  audit: SecretsAuditConfig;
  rotation: SecretsRotationConfig;
}

// ============================================
// Embeddings Types
// ============================================

export interface Embedding {
  object: 'embedding';
  embedding: number[];
  index: number;
}

// ============================================
// Codebase Indexing & Search Types
// ============================================

export interface CodebaseFilePayload {
  path: string;
  size: number;
  checksum: string;
  lastModified: number;
  language?: string;
  content?: string;
  encoding?: 'utf-8' | 'base64';
  executable?: boolean;
}

export interface CodebaseSyncRequest {
  projectId: string;
  rootPath: string;
  branch?: string;
  commitSha?: string;
  files: CodebaseFilePayload[];
  sequence: number;
  totalSequences: number;
  isFinalChunk: boolean;
}

export interface CodebaseSyncResponse {
  accepted: boolean;
  sequence: number;
  totalSequences: number;
  indexed?: boolean;
  message?: string;
  warnings?: string[];
}

export interface CodebaseSearchMatch {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  language?: string;
  highlights?: Array<{
    startLine: number;
    endLine: number;
  }>;
  context?: {
    before?: string;
    after?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CodebaseSearchResponse {
  query: string;
  totalResults: number;
  returnedResults: number;
  latencyMs?: number;
  matches: CodebaseSearchMatch[];
  truncated?: boolean;
}

// ============================================
// Enterprise Types (Quotas, Billing, Analytics)
// ============================================

export interface QuotaLimit {
  maxRequests?: number;
  maxTokens?: number;
  maxCost?: number;
  maxFiles?: number;
  maxFileSize?: number;
  period: 'minute' | 'hour' | 'day' | 'month';
}

export interface QuotaEntityRef {
  userId?: string;
  teamId?: string;
  organizationId?: string;
}

export interface QuotaConfig extends QuotaEntityRef {
  limits: QuotaLimit;
}

export interface QuotaUsage {
  requests: number;
  tokens: number;
  cost: number;
  files: number;
  periodStart: number;
  periodEnd: number;
}

export interface QuotaCheckRequest extends QuotaEntityRef {
  period?: QuotaLimit['period'];
  operation?: {
    requests?: number;
    tokens?: number;
    cost?: number;
    files?: number;
  };
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  remaining?: {
    requests?: number;
    tokens?: number;
    cost?: number;
    files?: number;
  };
  resetAt?: string;
}

export interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  metadata?: Record<string, unknown>;
}

export interface Invoice {
  id: string;
  organizationId: string;
  userId?: string;
  periodStart: number;
  periodEnd: number;
  items: InvoiceItem[];
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  status: 'draft' | 'pending' | 'paid' | 'overdue' | 'cancelled';
  dueDate: number;
  createdAt: number;
  paidAt?: number;
  hostedInvoiceUrl?: string;
  stripeInvoiceId?: string;
  stripePaymentIntentId?: string;
  stripeCustomerId?: string;
  lastSyncedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface BillingConfig {
  organizationId: string;
  billingEmail: string;
  paymentMethod?: string;
  defaultPaymentMethodId?: string;
  autoPay?: boolean;
  taxRate?: number;
  currency?: string;
  stripeCustomerId?: string;
  stripePortalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingSubscription {
  id: string;
  organizationId: string;
  plan: string;
  status: 'active' | 'cancelled' | 'expired';
  billingCycle: 'monthly' | 'yearly';
  amount: number;
  currency: string;
  startDate: number;
  endDate?: number;
  priceId?: string;
  price?: BillingPrice;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  stripeStatus?: string;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  defaultPaymentMethodId?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingPlan {
  id: string;
  organizationId?: string;
  name: string;
  description?: string;
  tier?: string;
  status: 'active' | 'inactive' | 'archived';
  features?: Record<string, unknown>;
  trialDays?: number;
  stripeProductId?: string;
  prices: BillingPrice[];
  metadata?: Record<string, unknown>;
}

export interface BillingPrice {
  id: string;
  billingPlanId: string;
  stripePriceId?: string;
  currency: string;
  amount: number;
  billingCycle: 'monthly' | 'yearly';
  intervalCount: number;
  usageType: 'licensed' | 'metered';
  taxBehavior?: string;
  active: boolean;
  metadata?: Record<string, unknown>;
}

export interface BillingPaymentMethod {
  id: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  funding?: string;
  country?: string;
  customerId?: string;
  default?: boolean;
}

export interface BillingSetupIntent {
  clientSecret: string;
  customerId: string;
}

export interface CostEvent {
  model?: string;
  cost: number;
  tokensUsed: number;
  category?: string;
}

export interface CostMetrics {
  totalCost: number;
  costByModel: Record<string, number>;
  costByProvider?: Record<string, number>;
  costByUser?: Record<string, number>;
  costByTeam?: Record<string, number>;
  tokenUsage: number;
  timeRange: {
    start: number;
    end: number;
  };
}

export interface CreateInvoiceRequest {
  organizationId: string;
  periodStart: number;
  periodEnd: number;
  costMetrics?: CostMetrics;
  costEvents?: CostEvent[];
  items?: InvoiceItem[];
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionRequest {
  organizationId: string;
  plan: string;
  billingCycle: 'monthly' | 'yearly';
  amount?: number;
  currency?: string;
  paymentMethodId?: string;
  priceId?: string;
  trialDays?: number;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UsageEvent {
  userId?: string;
  teamId?: string;
  organizationId?: string;
  eventType: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface UsageMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByUser: Record<string, number>;
  eventsByTeam: Record<string, number>;
  timeRange: {
    start: number;
    end: number;
  };
}

export interface UsageMetricsRequest {
  teamId?: string;
  userId?: string;
  start?: number;
  end?: number;
}

// ============================================
// Authentication Types
// ============================================

export interface AuthLoginChallenge {
  id: string;
  email: string;
  status: 'pending' | 'verified' | 'expired';
  expiresAt: number;
  lastSentAt?: number;
  attemptCount: number;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthChallengeRequest {
  email: string;
  organizationId?: string;
}

export interface AuthChallengeResponse {
  success: boolean;
  challengeId?: string;
  expiresAt?: number;
  cooldownExpiresAt?: number;
  loginMode: AuthMode;
  message?: string;
}

export interface AuthLoginWithCodeRequest {
  challengeId: string;
  code: string;
  rememberDevice?: boolean;
}

// ============================================
// Unified Orchestration Types (Fase 4)
// ============================================

/**
 * Modality identifies the type of processing a request requires.
 * The OrchestrationEngine.process() uses this to route to the
 * correct handler: chat → execute(), stt → AudioOrchestration,
 * tts → AudioOrchestration, translation → TranslationService.
 */
export type RequestModality = 'chat' | 'stt' | 'tts' | 'translation';

/** Base fields shared by all unified request variants. */
interface UnifiedRequestBase {
  /** Ailin alias or model name (e.g., 'ailin-stt-fast', 'deepgram/nova-3') */
  model?: string;
  /** Explicit modality override. If omitted, detected from request shape. */
  modality?: RequestModality;
  /** Organization scope for billing and model access. */
  organizationId: string;
  userId?: string;
  requestId?: string;
  /** Strategy override (e.g., 'parallel-race', 'single'). Usually resolved from alias. */
  strategy?: ExecutionStrategyName | StrategyInputName;
  /** Cost ceiling in USD. */
  maxCost?: number;
  /** Quality target 0-1. */
  qualityTarget?: number;
  /** Prefer latency over quality. */
  preferSpeed?: boolean;
  metadata?: Record<string, unknown>;
}

/** Chat request — standard LLM completion. */
export interface UnifiedChatRequest extends UnifiedRequestBase {
  modality: 'chat';
  /** The ChatRequest payload. */
  chatRequest: ChatRequest;
}

/** Speech-to-Text request. */
export interface UnifiedSTTRequest extends UnifiedRequestBase {
  modality: 'stt';
  audioBuffer: Buffer;
  filename?: string;
  language?: string;
  responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  prompt?: string;
  temperature?: number;
}

/** Text-to-Speech request. */
export interface UnifiedTTSRequest extends UnifiedRequestBase {
  modality: 'tts';
  input: string;
  voice?: string;
  format?: string;
  speed?: number;
}

/** Translation request. */
export interface UnifiedTranslationRequest extends UnifiedRequestBase {
  modality: 'translation';
  text: string;
  sourceLang?: string;
  targetLang: string;
}

/** Discriminated union of all unified request types. */
export type UnifiedRequest =
  | UnifiedChatRequest
  | UnifiedSTTRequest
  | UnifiedTTSRequest
  | UnifiedTranslationRequest;

/** Base result fields shared across modalities. */
interface UnifiedResultBase {
  modality: RequestModality;
  strategyUsed: ExecutionStrategyName | string;
  modelUsed: string;
  provider: string;
  durationMs: number;
  cost: number;
  metadata: Record<string, unknown>;
}

/** Result for chat modality. */
export interface UnifiedChatResult extends UnifiedResultBase {
  modality: 'chat';
  /** Full OrchestrationResult from the engine. */
  orchestrationResult: OrchestrationResult;
}

/** Result for STT modality. */
export interface UnifiedSTTResult extends UnifiedResultBase {
  modality: 'stt';
  text: string;
  language?: string;
  duration?: number;
  words?: unknown[];
  segments?: unknown[];
}

/** Result for TTS modality. */
export interface UnifiedTTSResult extends UnifiedResultBase {
  modality: 'tts';
  audioBuffer: Buffer;
  format: string;
}

/** Result for translation modality. */
export interface UnifiedTranslationResult extends UnifiedResultBase {
  modality: 'translation';
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

/** Discriminated union of all unified result types. */
export type UnifiedResult =
  | UnifiedChatResult
  | UnifiedSTTResult
  | UnifiedTTSResult
  | UnifiedTranslationResult;

export interface AuthLoginWithPasswordRequest {
  email: string;
  password: string;
  organizationId?: string;
}

export interface AuthLoginResponse {
  success: boolean;
  loginMode: AuthMode;
  user?: {
    id: string;
    email: string;
    name: string;
    organizationId: string;
    roles: string[];
  };
  tokens?: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  message?: string;
  requiresPasswordReset?: boolean;
}
