// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Orchestration Engine
 * Core component that coordinates multi-model execution strategies
 */

import { BaseStrategy, safeResponseContent } from './base-strategy';
// StrategyLeader removed — was a no-op pass-through
import { SingleModelStrategy } from './strategies/single-model-strategy';
import { ParallelStrategy } from './strategies/parallel-strategy';
import { SequentialStrategy } from './strategies/sequential-strategy';
import { CollaborativeStrategy } from './strategies/collaborative-strategy';
import { HybridStrategy } from './strategies/hybrid-strategy';
import { CompetitiveStrategy } from './strategies/competitive-strategy';
import { ExpertPanelStrategy } from './strategies/expert-panel-strategy';
import { MassiveParallelStrategy } from './strategies/massive-parallel-strategy';
import { CostCascadeStrategy } from './strategies/cost-cascade-strategy';
import { QualityMultiPassStrategy } from './strategies/quality-multipass-strategy';
import { AdaptiveStrategy } from './strategies/adaptive-strategy';
import { ContextualStrategy } from './strategies/contextual-strategy';
import { HierarchicalStrategy } from './strategies/hierarchical-strategy';
import { ConsensusStrategy } from './strategies/consensus-strategy';
import { ReinforcementStrategy } from './strategies/reinforcement-strategy';
import { DebateStrategy } from './strategies/debate-strategy';
import { WarRoomStrategy } from './strategies/war-room-strategy';
import { BlindDebateStrategy } from './strategies/blind-debate-strategy';
import { DevilAdvocateConsensusStrategy } from './strategies/devil-advocate-consensus-strategy';
import { SafetyQuorumStrategy } from './strategies/safety-quorum-strategy';
import { DiversityEnsembleStrategy } from './strategies/diversity-ensemble-strategy';
import { StigmergicRefinementStrategy } from './strategies/stigmergic-refinement-strategy';
import { SwarmExploreStrategy } from './strategies/swarm-explore-strategy';
import { ClarificationFirstStrategy } from './strategies/clarification-first-strategy';
import { ResearchSynthesizeStrategy } from './strategies/research-synthesize-strategy';
import { CritiqueRepairStrategy } from './strategies/critique-repair-strategy';
import { DoubleDiamondStrategy } from './strategies/double-diamond-strategy';
import { MultiHopQAStrategy } from './strategies/multi-hop-qa-strategy';
import { PersonaExplorationStrategy } from './strategies/persona-exploration-strategy';
import { AgenticStrategy } from './strategies/agentic-strategy';
import { SensitivityConsensusStrategy } from './strategies/sensitivity-consensus-strategy';
import { TriRoleCollectiveStrategy } from './strategies/tri-role-collective-strategy';
import { resolveAilinAlias, applyAliasToRequest } from './ailin-alias-resolver';
import { getROIEstimator } from '@/core/validation/c3/roi-estimator';
import { ObserverService, createNoOpObserverFeed, buildObserverChunk, buildInlineNarrationChunk } from './observer/observer-service';
import type { ObserverFeed } from './observer/observer-types';
import { ProviderRegistry } from '@/providers/provider-registry';
import { getErrorMessage } from '@/utils/type-guards';
import { toolRegistry, TRIAGE_RECOMMENDABLE_TOOLS } from '@/core/tools/tool-registry';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  OrchestrationContext,
  OrchestrationResult,
  ExecutionStrategyName,
  TaskType,
  TriageDecision,
  TriageExecutionPlan,
  TriageStage,
  TriageStrategy,
  ModelCapability,
  ChatMessage,
  UnifiedRequest,
  UnifiedResult,
  UnifiedChatResult,
  UnifiedSTTResult,
  UnifiedTTSResult,
  UnifiedTranslationResult,
  RequestModality,
  ObserverNarration,
  Tool,
  AilinArtifact,
} from '@/types';
import { isModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';
import { autoLearningSystem } from '@/core/learning/auto-learning-system';
import { TriagingService } from './triage-service';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { RealtimeFeedbackLoop } from '@/core/feedback/realtime-feedback-loop';
import { getQualityScorer } from '@/core/quality/quality-scorer';
import { getReasoningTransparency } from '@/core/transparency/reasoning-transparency';
import { getSemanticCache } from '@/core/cache/semantic-cache';
import { isCacheEnabled } from '@/cache/cache-runtime-state';
import { recordStrategyExecution, recordTriage, recordModelSelection, recordSpeculativeSelectionOutcome } from '@/observability/ci-metrics';
import { getMemoryContextService } from '@/core/memory/memory-context-service';
import { errorLearningSystem } from '@/core/learning/error-learning-system';
import { triageLearningSystem } from './triage-learning-system.js';
import {
  canonicalizeStrategyInput,
  mapExecutionToCanonical,
  resolveExecutionStrategy,
} from './strategy-contract';
import { writeDecisionAudit } from './decision-audit';
import { strategyBandit } from '@/core/learning/strategy-bandit';
import { configurationArchive } from '@/core/learning/configuration-archive';
import { triageCalibrator } from '@/core/learning/triage-calibrator';
import { knowledgeGraphService } from '@/core/learning/knowledge-graph-service';
import { inferCapabilities, type CapabilityInferenceResult } from './capability-inference.js';
import { modelPerformanceTracker } from '@/core/selection/model-performance-tracker';
import { getAdaptiveQualityTarget, refreshAllProfiles } from '@/core/quality/adaptive-quality-targets';
import {
  createAblationFlags,
  ALL_ABLATION_COMPONENTS,
  type AblationComponent,
} from '@/core/validation/c3/ablation-config';
import { getBestFromFrontier, loadFrontiersFromOutcomes } from '@/core/learning/pareto-champion-challenger';
import { injectExecutionSystemPrompt } from './execution-system-prompt';
import {
  injectPeerReviewPrompt,
  shouldInjectPeerReviewPrompt,
} from './prompts/peer-review-prompt';
import { recordOutcome } from '@/core/evaluation/outcome-measurement';
import { shouldRunShadowEval, recordShadowEvaluation } from '@/core/evaluation/shadow-evaluation';
import { trace, SpanStatusCode } from '@opentelemetry/api';

/**
 * Orchestration Engine Configuration
 */

export interface OrchestrationEngineConfig {
  providerRegistry: ProviderRegistry;
  defaultStrategy?: ExecutionStrategyName;
  enableAutoSelection?: boolean;
  maxConcurrentExecutions?: number;
  enableTriaging?: boolean;
  triageModel?: string;
  triageStrategy?: TriageStrategy; // Strategy for selecting triage models dynamically
  triageCollective?: number; // Number of models for collective triage (1-3, default: 1)
  triageTemperature?: number;
  triageMaxTokens?: number;
  enableFeedbackLoop?: boolean;
  maxFeedbackIterations?: number;
  qualityThreshold?: number;
}

export interface StreamingExecutionPlan {
  request: ChatRequest;
  model: Model;
  adapter: ProviderAdapter;
  context: OrchestrationContext;
  triage?: TriageDecision;
}

/**
 * Precise JSON Schema for the 8 highest-value tools triage can recommend
 * automatically. The other ~23 strategy-safe tools in the registry fall
 * back to `GENERIC_TOOL_PARAM_SCHEMA` below (stopgap — see
 * `applyRecommendedTools`, adding schemas for the rest is a follow-up).
 */
const TRIAGE_RECOMMENDABLE_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  web_search: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  code_execute: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      language: { type: 'string', description: 'Programming language of the code' },
    },
    required: ['code'],
  },
  file_search: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Glob pattern to search for' } },
    required: ['pattern'],
  },
  // Review fix: the executor (executeReadFileTool) reads `args.file_path`,
  // not `args.path` — the schema must advertise the exact name the handler
  // expects or every call fails deterministically.
  read_file: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'File path to read' } },
    required: ['file_path'],
  },
  semantic_search: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Semantic search query' } },
    required: ['query'],
  },
  grep_search: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Optional path/file to scope the search to' },
    },
    required: ['pattern'],
  },
  analyze_image: {
    type: 'object',
    properties: { image_url: { type: 'string', description: 'URL or path of the image to analyze' } },
    required: ['image_url'],
  },
  // Review fix: the executor requires `filePath` — see read_file note above.
  generate_tests: {
    type: 'object',
    properties: { filePath: { type: 'string', description: 'File to generate tests for' } },
    required: ['filePath'],
  },
};

const GENERIC_TOOL_PARAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
};

const IMAGE_GEN_CAPS = new Set(['image_generation']);
const VIDEO_GEN_CAPS = new Set(['video_generation', 'image_to_video', 'video_to_video']);
const AUDIO_GEN_CAPS = new Set(['audio_generation', 'text_to_speech', 'tts']);
/**
 * File-generation capability tags map directly to the target render format —
 * unlike image/video/audio (a single capability per modality, since each has
 * exactly one external generative service), file formats are distinguished
 * up front so the stage knows WHICH renderer to call. Extend this map when
 * adding a new format (docx/xlsx/pdf/pptx/zip/code) — no other code changes
 * needed in `detectMediaGenerationModality` itself.
 */
const FILE_GEN_FORMAT_CAPS: Record<string, 'csv' | 'json' | 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'zip' | 'code'> = {
  csv_generation: 'csv',
  json_generation: 'json',
  markdown_generation: 'markdown',
  docx_generation: 'docx',
  xlsx_generation: 'xlsx',
  pdf_generation: 'pdf',
  pptx_generation: 'pptx',
  zip_generation: 'zip',
  // Named `code_file_generation`, NOT `code_generation` — the latter is a
  // pre-existing catalog ModelCapability ("this model writes code well").
  // Reusing it here collided: an ordinary coding stage tagged
  // ['code_generation', 'reasoning'] (a legitimate thing for triage to emit
  // in the catalog sense) was silently hijacked into a file-download stage
  // by the `c in FILE_GEN_FORMAT_CAPS` check below. Confirmed exploitable by
  // the 2026-07-16 architecture audit; fixed by giving the file-generation
  // signal its own distinct string.
  code_file_generation: 'code',
  file_generation: 'markdown', // generic fallback tag — default to markdown
};

/**
 * Detect whether a triage stage is a media-GENERATION stage (as opposed to a
 * normal chat/text stage) from its raw `requiredCapabilities` strings. The
 * triage prompt is instructed to never mix a generation capability with
 * chat-only capabilities in the same stage — priority image > video > audio
 * > file below is a defensive fallback for a malformed plan, not the
 * expected path.
 */
export function detectMediaGenerationModality(
  requiredCapabilities: string[]
): 'image' | 'video' | 'audio' | 'file' | null {
  if (requiredCapabilities.some((c) => IMAGE_GEN_CAPS.has(c))) return 'image';
  if (requiredCapabilities.some((c) => VIDEO_GEN_CAPS.has(c))) return 'video';
  if (requiredCapabilities.some((c) => AUDIO_GEN_CAPS.has(c))) return 'audio';
  if (requiredCapabilities.some((c) => c in FILE_GEN_FORMAT_CAPS)) return 'file';
  return null;
}

/** Resolves the specific file format a file-generation stage should render,
 *  from the same requiredCapabilities strings `detectMediaGenerationModality`
 *  already inspected. */
export function detectFileGenerationFormat(requiredCapabilities: string[]): 'csv' | 'json' | 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'zip' | 'code' {
  for (const cap of requiredCapabilities) {
    const format = FILE_GEN_FORMAT_CAPS[cap];
    if (format) return format;
  }
  return 'markdown';
}

/**
 * Orchestration Engine
 *
 * Responsibilities:
 * - Strategy selection (automatic or manual)
 * - Model selection and allocation
 * - Execution coordination
 * - Result aggregation
 * - Cost optimization
 * - Quality assurance
 */
export class OrchestrationEngine {
  private providerRegistry: ProviderRegistry;
  private strategies: Map<ExecutionStrategyName, BaseStrategy> = new Map();
  private config: OrchestrationEngineConfig;
  private log = logger.child({ component: 'orchestration-engine' });
  private triageService?: TriagingService;
  private feedbackLoop: RealtimeFeedbackLoop;
  private qualityScorer = getQualityScorer();
  private reasoningTransparency = getReasoningTransparency();

  constructor(config: OrchestrationEngineConfig) {
    this.config = {
      defaultStrategy: 'auto',
      enableAutoSelection: true,
      maxConcurrentExecutions: 10,
      ...config,
    };

    this.providerRegistry = config.providerRegistry;
    
    // Log provider registry status at engine initialization
    const providerNamesAtInit = this.providerRegistry.getProviderNames();
    this.log.info(
      {
        providerCount: providerNamesAtInit.length,
        providerNames: providerNamesAtInit,
        registryType: this.providerRegistry.constructor.name,
      },
      'OrchestrationEngine initialized with provider registry'
    );
    
    this.feedbackLoop = new RealtimeFeedbackLoop();

    // Register available strategies (1-16) - ALL IMPLEMENTED ✅
    this.registerStrategy(new SingleModelStrategy());
    this.registerStrategy(new ParallelStrategy());
    this.registerStrategy(new SequentialStrategy());
    this.registerStrategy(new CollaborativeStrategy());
    this.registerStrategy(new HybridStrategy());
    this.registerStrategy(new CompetitiveStrategy());
    this.registerStrategy(new ExpertPanelStrategy());
    this.registerStrategy(new MassiveParallelStrategy());
    this.registerStrategy(new CostCascadeStrategy());
    this.registerStrategy(new QualityMultiPassStrategy());
    this.registerStrategy(new AdaptiveStrategy());
    this.registerStrategy(new ContextualStrategy());
    this.registerStrategy(new HierarchicalStrategy());
    this.registerStrategy(new ConsensusStrategy());
    this.registerStrategy(new ReinforcementStrategy());
    this.registerStrategy(new DebateStrategy()); // Multi-Turn Debate strategy
    this.registerStrategy(new WarRoomStrategy()); // Decompose → Specialists → Critique → Synthesize
    this.registerStrategy(new BlindDebateStrategy()); // Parallel blind responses → adjudicator (independence preservation)
    this.registerStrategy(new DevilAdvocateConsensusStrategy()); // N-1 propose + 1 critique → synthesis (anti-groupthink)
    this.registerStrategy(new SafetyQuorumStrategy()); // Majority vote safety assessment (quorum sensing)
    this.registerStrategy(new DiversityEnsembleStrategy()); // Max cross-provider diversity (diversity-yields-better-aggregation)
    this.registerStrategy(new StigmergicRefinementStrategy()); // Draft → refine → critique → synthesize (stigmergy)
    this.registerStrategy(new SwarmExploreStrategy()); // Multi-angle parallel exploration (swarm intelligence)
    this.registerStrategy(new ClarificationFirstStrategy()); // Ambiguity assessment → clarification questions → delegate
    this.registerStrategy(new ResearchSynthesizeStrategy()); // Parallel research → evidence ranking → synthesis
    this.registerStrategy(new CritiqueRepairStrategy()); // Adaptive loop: generate → critique → repair until quality met
    this.registerStrategy(new DoubleDiamondStrategy()); // Macro: discover → define → develop → deliver
    this.registerStrategy(new MultiHopQAStrategy()); // Decompose → topological execution → synthesize
    this.registerStrategy(new PersonaExplorationStrategy()); // 10-20 personas → aggregator
    this.registerStrategy(new AgenticStrategy()); // Plan workflow → execute steps (tools + LLM)
    this.registerStrategy(new SensitivityConsensusStrategy()); // Iterative sensitivity-based coordination
    this.registerStrategy(new TriRoleCollectiveStrategy()); // F2.1 — Planner / Solver / Auditor cyclical strategy

    // ── Strategy reachability (audited 2026-06-11) ──────────────────────────
    // All strategies above are registered and INVOCABLE, but only a subset has
    // an AUTOMATIC selection path. A request reaches a strategy via exactly one
    // of: (1) explicit `request.strategy` / a virtual-model alias that maps to
    // one; (2) the triage heuristic → strategy map (shouldRunTriage path);
    // (3) AdaptiveStrategy delegating to a sub-strategy; (4) the Thompson
    // Sampling bandit (seeded below). An adversarial audit found ~11 strategies
    // (e.g. war-room, massive-parallel, agentic, sensitivity-consensus,
    // tri-role-collective, hierarchical) have NO path via (2)/(3) and are
    // therefore EXPLICIT-ONLY — reachable only by a caller naming them in
    // `request.strategy`. The bandit (4) has a cold-start trap: it requires
    // ≥5 observations to consider an arm, which a never-auto-selected strategy
    // can never accumulate on its own. These strategies are intentionally
    // retained (they are valid explicit options), NOT dead code — see the
    // 2026-06-11 orphan-code audit. Do not delete on the basis of "no auto
    // path"; if reducing the portfolio, do a per-strategy value pass first.

    if (this.config.enableTriaging !== false) {
      // 100% dynamic - select triage model based on capabilities and performance, not hardcoded names
      // Initialize triage service with synchronous model selection
      this.initializeTriageService();
    }

    // Eagerly seed the Thompson Sampling bandit from strategy_weights table.
    // This runs async but fires immediately so the bandit has data before
    // the first request arrives (typical startup has > 1s before first request).
    strategyBandit.seedFromDB().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Bandit DB seed failed on startup')
    );

    // OI-06: Seed configuration archive from DB (same data, different indexing)
    configurationArchive.seedFromDB().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Configuration archive DB seed failed on startup')
    );

    // OI-08: Pre-warm adaptive quality target profiles from strategy_weights
    refreshAllProfiles().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Adaptive quality target profile refresh failed on startup')
    );

    // OI-09: Restore Pareto frontiers from recent execution outcomes
    // Without this, the Pareto gate is dark until the nightly benchmark runs.
    loadFrontiersFromOutcomes().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Pareto frontier restoration failed on startup')
    );

    // Pre-warm the COMMON selection shapes (general chat + streaming, single AND
    // collective) so the FIRST real request after boot does not pay the cold
    // selection cost (pool DB query + bounded runtime capability validation +
    // performance prefetch + semantic rerank ≈ ~5s cold, ~2.5s warm). The triage
    // pre-warm only warms an 'analysis'/maxModels=1 shape, which real chat/stream
    // requests (general + streaming, maxModels 1 and 5) do not hit. Fire-and-forget;
    // a warm-up failure never blocks startup and is purely a cache priming pass.
    this.prewarmCommonSelection().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Common selection pre-warm failed on startup')
    );

    // Pre-warm the shared observer-narration backend so the FIRST collective
    // request pays no sidecar probe latency (and never hits a cold-probe transient
    // obs=0). The resolution is cached + shared across all requests thereafter.
    ObserverService.prewarmBackend().catch((err) =>
      this.log.warn({ error: getErrorMessage(err) }, 'Observer backend pre-warm failed on startup')
    );

    this.log.info(
      {
        strategies: Array.from(this.strategies.keys()),
        providers: this.providerRegistry.getProviderNames(),
      },
      'Orchestration engine initialized'
    );
  }

  /**
   * Prime the DynamicModelSelector caches for the request shapes REAL traffic uses
   * (general chat + streaming, both single maxModels=1 and collective maxModels=5),
   * so the first post-boot request isn't cold. Fully dynamic + side-effect-free: it
   * runs selection only (no model is executed) and touches no static model list.
   */
  private async prewarmCommonSelection(): Promise<void> {
    const { getDynamicModelSelector } = await import('../selection/dynamic-model-selector.js');
    const selector = getDynamicModelSelector();
    const criteria = {
      taskType: 'general' as TaskType,
      complexity: 'low' as const,
      contextSize: 1000,
      preferSpeed: true,
      qualityTarget: 0.7,
      requiredCapabilities: ['chat', 'text_generation', 'streaming'] as ModelCapability[],
    };
    const ctx = {
      requestId: 'prewarm-selection',
      taskType: 'general',
      organizationId: '',
    } as OrchestrationContext;
    // Warm both the collective (maxModels>1) and the single (maxModels=1) paths.
    for (const n of [5, 1]) {
      try {
        await selector.selectModels(null, criteria, ctx, n);
      } catch (err) {
        this.log.debug(
          { error: getErrorMessage(err), maxModels: n },
          'Selection pre-warm pass failed (non-critical)'
        );
      }
    }
  }

  /**
   * Initialize triage service with dynamic model selection
   * Uses synchronous fallback approach to avoid async in constructor
   */
  private initializeTriageService(): void {
    // Use configured model if provided, otherwise will be dynamically resolved by TriagingService
    // No hardcoded model names - use dynamic discovery
    // Triage model selection is now based on capabilities and configurable triage strategy
    // Supports collective triage with multiple models (up to 3) for consensus-based decisions
    this.triageService = new TriagingService(this.providerRegistry, {
      model: this.config.triageModel, // Optional - will be resolved dynamically if not provided
      strategy: this.config.triageStrategy || 'balanced', // Triage strategy for dynamic selection
      collective: this.config.triageCollective || 1, // Number of models for collective triage (1-3)
      temperature:
        typeof this.config.triageTemperature === 'number' ? this.config.triageTemperature : 0,
      maxTokens: this.config.triageMaxTokens ?? 256,
    });

    // Async initialization to select optimal model (non-blocking).
    // Annotate `error: unknown` explicitly so the catch param doesn't widen
    // to `any` when `useUnknownInCatchVariables` is off in tsconfig.
    if (!this.config.triageModel) {
      this.initializeTriageAsync().catch((error: unknown) => {
        this.log.warn({ error }, 'Async triage model selection failed, using default');
      });
    }
  }

  /**
   * Dynamically select triage model using model selector (async initialization)
   * NOTE: This is now optional - TriagingService selects models dynamically per-request
   * This method is kept for backwards compatibility and pre-warming
   */
  async initializeTriageAsync(): Promise<void> {
    // Triage models are now selected dynamically per-request based on capabilities
    // This method is kept for backwards compatibility and pre-warming cache
    if (this.config.triageModel) {
      this.log.debug({ triageModel: this.config.triageModel }, 'Using configured triage model (will be used if available, otherwise dynamic selection applies)');
      return;
    }

    // Pre-warm triage model selection for common scenarios
    try {
      const { getDynamicModelSelector } = await import('../selection/dynamic-model-selector.js');
      const selector = getDynamicModelSelector();
      
      // Pre-warm cache by selecting a triage model (selection is still per-request based on capabilities)
      const selectedModels = await selector.selectModels(
        null,
        {
          taskType: 'analysis',
          complexity: 'low',
          contextSize: 1000,
          preferSpeed: true,
          maxCost: 0.001,
          qualityTarget: 0.7,
          requiredCapabilities: ['chat', 'analysis'] as ModelCapability[],
        },
        {
          requestId: 'triage-init',
          taskType: 'analysis',
          organizationId: '',
        } as OrchestrationContext,
        1
      );

      if (selectedModels.length > 0) {
        const triageModel = selectedModels[0].model.name;
        this.log.info(
          { 
            triageModel, 
            modelId: selectedModels[0].model.id,
            provider: selectedModels[0].model.provider,
            note: 'Model selection is now per-request based on capabilities'
          }, 
          'Pre-selected triage model for caching (dynamic selection still applies per-request)'
        );
      }
    } catch (error) {
      this.log.warn({ error }, 'Pre-selection of triage model failed, dynamic per-request selection will handle it');
    }
  }

  /**
   * Execute with GPT-5.1 awareness (November 2025)
   * Enhanced orchestration that recognizes GPT-5.1 capabilities
   */
  async executeWithGPT5Awareness(
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): Promise<OrchestrationResult> {
    // Enhance request with GPT-5.1 awareness
    const enhancedRequest = await this.enhanceRequestWithGPT5(request);
    return this.execute(enhancedRequest, organizationId, userId);
  }

  /**
   * Enhance request with GPT-5.1 awareness
   */
  private async enhanceRequestWithGPT5(request: ChatRequest): Promise<ChatRequest> {
    // Check if GPT-5.1 is requested or should be considered
    const shouldConsiderGPT5 = await this.shouldConsiderGPT5(request);

    if (shouldConsiderGPT5) {
      this.log.info(
        {
          originalModel: request.model,
          taskType: request.task_type,
        },
        'Enhancing request with GPT-5.1 awareness'
      );

      return {
        ...request,
        // GPT-5.1 awareness is handled internally without modifying request structure
      };
    }

    return request;
  }

  /**
   * Determine if GPT-5.1 should be considered for this request
   */
  private async shouldConsiderGPT5(request: ChatRequest): Promise<boolean> {
    // GPT-5.1 is ideal for:
    // - Complex reasoning tasks
    // - Code generation/analysis
    // - Multimodal requests
    // - High-stakes decisions

    const taskType = request.task_type;
    const reasonsToConsider = [
      taskType === 'code-generation',
      taskType === 'debugging',
      taskType === 'analysis',
      // Check if user explicitly requested a specific model (dynamic - no hardcoded model names)
      request.model !== 'auto' && request.model !== undefined && request.model !== null,
      this.hasMultimodalContent(request),
      this.isHighComplexity(request),
    ];

    const shouldConsider = reasonsToConsider.some(Boolean);

    if (shouldConsider) {
      this.log.debug(
        {
          taskType: request.task_type,
          model: request.model,
          multimodal: this.hasMultimodalContent(request),
          highComplexity: this.isHighComplexity(request),
        },
        'GPT-5.1 consideration triggered'
      );
    }

    return shouldConsider;
  }

  /**
   * Check if request has multimodal content
   */
  private hasMultimodalContent(request: ChatRequest): boolean {
    return (
      request.messages?.some(
        (msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image_url')
      ) || false
    );
  }

  /**
   * Check if request represents high complexity
   */
  private isHighComplexity(request: ChatRequest): boolean {
    const content =
      request.messages?.map((m) => (typeof m.content === 'string' ? m.content : '')).join('') || '';

    const complexityIndicators = [
      content.length > 10000, // Long content
      content.split(' ').length > 2000, // Many words
      /\b(analyze|architect|design|implement|optimize)\b/gi.test(content), // Technical keywords
      request.tools && request.tools.length > 3, // Many tools
    ];

    return complexityIndicators.filter(Boolean).length >= 2;
  }

  /**
   * Execute a chat completion request with orchestration
   */
  async execute(
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): Promise<OrchestrationResult> {
    // Resolve ailin_alias to configuration overrides BEFORE strategy resolution
    // Aliases define behavior profiles (e.g., 'ailin-ultra' → 9 models, collaborative, quality_target=0.98)
    const aliasProfile = resolveAilinAlias(request.ailin_alias);
    if (aliasProfile) {
      request = applyAliasToRequest(request, aliasProfile);
    }

    const strategyInput =
      typeof request.strategy === 'string' ? request.strategy : undefined;
    const resolvedExecutionStrategy = resolveExecutionStrategy(strategyInput);
    if (resolvedExecutionStrategy && request.strategy !== resolvedExecutionStrategy) {
      request.strategy = resolvedExecutionStrategy;
    }

    const requestedCanonicalStrategy =
      canonicalizeStrategyInput(strategyInput) ??
      mapExecutionToCanonical(
        (resolvedExecutionStrategy ??
          (typeof request.strategy === 'string' ? request.strategy : undefined)) as
          | ExecutionStrategyName
          | undefined
      );

    const requestId = nanoid();
    const startTime = Date.now();
    const tracer = trace.getTracer('ci-orchestration');

    // Wrap entire orchestration in a span for distributed tracing
    return tracer.startActiveSpan(
      'orchestration.execute',
      { attributes: { 'request.id': requestId, 'org.id': organizationId, 'request.strategy': String(request.strategy ?? 'auto') } },
      async (orchestrationSpan) => {
    this.log.info(
      {
        requestId,
        organizationId,
        userId,
        requestedModel: request.model,
        requestedStrategy: request.strategy,
        taskType: request.task_type,
      },
      'Starting orchestration'
    );

    // Start reasoning transparency trace
    this.reasoningTransparency.startTrace(requestId, request);

    const CACHEABLE_STRATEGIES = new Set<string | undefined>(['dynamic', 'single', 'parallel', 'consensus', 'quality_multipass', 'debate']);
    const allowSemanticCache = CACHEABLE_STRATEGIES.has(requestedCanonicalStrategy) && !request.no_cache;

    // LAT-2 (2026-06-11): kick off the semantic-memory lookup concurrently
    // with the semantic-cache lookup — independent reads that were previously
    // serialized (each can cost an embedding round-trip). On a cache hit the
    // memory result is simply abandoned (read-only; no side effects beyond
    // its own metrics); on a miss the pre-execution path pays
    // max(cache, memory) instead of cache + memory.
    // Gated by MEMORY_CONTEXT_ENABLED — when the embedding provider is
    // unreachable (HF API 404, no local embedder), buildContext blocks on
    // retry-and-fallback before yielding a zero-vector match; the env gate
    // lets local/dev environments skip the round-trip entirely.
    type MemoryContextResult = Awaited<ReturnType<ReturnType<typeof getMemoryContextService>['buildContext']>>;
    const memoryContextPromise: Promise<MemoryContextResult | null> =
      process.env.MEMORY_CONTEXT_ENABLED !== 'false'
        ? getMemoryContextService()
            .buildContext(request, organizationId, userId, { maxMemories: 5, minSimilarity: 0.7 })
            .catch((memoryError: unknown) => {
              this.log.warn(
                { error: getErrorMessage(memoryError) },
                'Failed to enrich request with memory context'
              );
              return null;
            })
        : Promise.resolve(null);

    // Check semantic cache for similar requests (if enabled)
    if (allowSemanticCache && isCacheEnabled() && !request.stream) {
      try {
        const semanticCache = getSemanticCache();
        const cacheResult = await semanticCache.lookup({
          request,
          organizationId,
        });

        if (cacheResult) {
          const cachedAilinMetadata = cacheResult.entry.response.ailin_metadata as
            | {
                resolved_strategy?: string;
                resolved_model?: string;
                final_decider_model_id?: string;
                final_decider_model_name?: string;
                final_decider_role?: string;
                fallback_chain?: unknown;
              }
            | undefined;
          const resolvedCachedStrategy =
            canonicalizeStrategyInput(cachedAilinMetadata?.resolved_strategy) ||
            requestedCanonicalStrategy ||
            'dynamic';
          const resolvedCachedModel =
            typeof cachedAilinMetadata?.resolved_model === 'string' &&
            cachedAilinMetadata.resolved_model.length > 0
              ? cachedAilinMetadata.resolved_model
              : cacheResult.entry.response.model;
          const finalDeciderModelId =
            typeof cachedAilinMetadata?.final_decider_model_id === 'string' &&
            cachedAilinMetadata.final_decider_model_id.length > 0
              ? cachedAilinMetadata.final_decider_model_id
              : typeof cacheResult.entry.response.model === 'string' &&
                  cacheResult.entry.response.model.length > 0
                ? cacheResult.entry.response.model
                : undefined;
          const finalDeciderModelName =
            typeof cachedAilinMetadata?.final_decider_model_name === 'string' &&
            cachedAilinMetadata.final_decider_model_name.length > 0
              ? cachedAilinMetadata.final_decider_model_name
              : resolvedCachedModel;
          const finalDeciderRole =
            typeof cachedAilinMetadata?.final_decider_role === 'string' &&
            cachedAilinMetadata.final_decider_role.length > 0
              ? cachedAilinMetadata.final_decider_role
              : 'cache';
          const fallbackChain = Array.isArray(cachedAilinMetadata?.fallback_chain)
            ? cachedAilinMetadata.fallback_chain.filter(
                (value): value is string => typeof value === 'string' && value.length > 0
              )
            : [];

          this.log.info(
            {
              requestId,
              cacheHit: true,
              isExactMatch: cacheResult.isExactMatch,
              similarity: cacheResult.similarity,
            },
            'Semantic cache hit - returning cached response'
          );

          // Record cache hit (fire-and-forget — a Redis bump must not delay
          // the already-resolved cached response)
          void semanticCache.recordHit(cacheResult.entry.id).catch(() => {});

          // Complete transparency trace with cache hit info
          this.reasoningTransparency.completeTrace(requestId);

          return {
            finalResponse: cacheResult.entry.response,
            strategyUsed: 'cached' as ExecutionStrategyName,
            modelsUsed: [],
            totalDuration: Date.now() - startTime,
            totalCost: 0, // No cost for cached response
            qualityScore: 0.9, // Assume high quality for cached
            metadata: {
              cacheHit: true,
              cacheEntryId: cacheResult.entry.id,
              cacheSimilarity: cacheResult.similarity,
              isExactMatch: cacheResult.isExactMatch,
              resolved_strategy: resolvedCachedStrategy,
              resolved_model: resolvedCachedModel,
              final_decider_model_id: finalDeciderModelId,
              final_decider_model_name: finalDeciderModelName,
              final_decider_role: finalDeciderRole,
              fallback_chain:
                fallbackChain.length > 0
                  ? fallbackChain
                  : resolvedCachedModel
                    ? [resolvedCachedModel]
                    : [],
            },
          };
        }
      } catch (cacheError) {
        this.log.warn(
          { error: getErrorMessage(cacheError) },
          'Semantic cache lookup failed, continuing without cache'
        );
      }
    }

    // Enrich request with semantic memory context (lookup started above,
    // concurrently with the semantic-cache check — LAT-2).
    let enrichedRequest = request;
    const memoryContext = await memoryContextPromise;
    if (memoryContext?.hasContext) {
      enrichedRequest = getMemoryContextService().enrichRequest(request, memoryContext);
      this.log.debug(
        {
          requestId,
          memoriesUsed: memoryContext.memories.length,
        },
        'Request enriched with semantic memory context'
      );
    }

    let context = await this.buildContext(enrichedRequest, organizationId, userId, requestId);
    let triageDecision = context.triage;

    // LAT-3: tell strategies the engine already ran the memory search for
    // this request — strategy-level enrichWithMemories() must not repeat the
    // embedding + pgvector lookup (which would also duplicate the injected
    // memory block in the prompt).
    if (enrichedRequest !== request) {
      context.memoryEnriched = true;
    }

    const autoStrategyRequested = !request.strategy || request.strategy === 'auto';
    const shouldRunTriage = this.shouldRunTriage(request, context);

    // C3 P0.2: Skip triage when ablated — use default strategy selection
    if (this.triageService && autoStrategyRequested && shouldRunTriage && !context.ablationFlags?.disabled?.has('triage')) {
      try {
        triageDecision = await this.triageService.triage(
          request, context,
          context.capabilityInference,
          context.models,
        );
        if (triageDecision) {
          // ── Confidence Gate: reject low-confidence triage decisions ──────
          // Data shows that triage with confidence < 0.4 produces unreliable
          // routing. Fall back to heuristics for low-confidence decisions.
          const MIN_TRIAGE_CONFIDENCE = Number(process.env.MIN_TRIAGE_CONFIDENCE ?? 0.4);
          if ((triageDecision.confidence ?? 0) < MIN_TRIAGE_CONFIDENCE) {
            this.log.warn({
              requestId,
              triageConfidence: triageDecision.confidence,
              threshold: MIN_TRIAGE_CONFIDENCE,
              intent: triageDecision.intent,
            }, 'Triage confidence below threshold — falling back to heuristic routing');
            // Keep intent/complexity from triage but discard everything that
            // steers routing. Review fix: `route` must be cleared here too —
            // before, a decision the gate itself judged unreliable could
            // still force the direct_response fast-path (single model) for a
            // possibly complex request via applyTriageRoute below.
            triageDecision = {
              ...triageDecision,
              recommendedStrategy: undefined,
              executionPlan: undefined,
              route: undefined,
              confidence: triageDecision.confidence,
            };
          }

          // ── OI-07: Apply triage calibration corrections ─────────────────
          const promptTotalLength = request.messages
            .map(m => typeof m.content === 'string' ? m.content.length : 0)
            .reduce((a, b) => a + b, 0);
          const triageCorrections = triageCalibrator.applyCorrections({
            predictedTaskType: triageDecision.intent || 'general',
            predictedComplexity: triageDecision.complexity || 'medium',
            promptLength: promptTotalLength,
            hasTools: !!(request.tools && request.tools.length > 0),
            messageCount: request.messages.length,
          });
          if (triageCorrections) {
            this.log.info({
              requestId,
              original: { intent: triageDecision.intent, complexity: triageDecision.complexity },
              corrected: { intent: triageCorrections.correctedTaskType, complexity: triageCorrections.correctedComplexity },
              rules: triageCorrections.rulesApplied,
            }, 'Triage calibrator applied corrections (OI-07)');
            triageDecision = {
              ...triageDecision,
              intent: triageCorrections.correctedTaskType as TriageDecision['intent'],
              complexity: triageCorrections.correctedComplexity as 'low' | 'medium' | 'high',
            };
          }

          // ── Route: trivial-message fast path (see TriageDecision.route) ──
          triageDecision = this.applyTriageRoute(triageDecision!, request);

          // ── Layer 2: Apply semantic execution plan from triage LLM ──────
          const plan = triageDecision!.executionPlan;
          // After OI-07 corrections, triageDecision is guaranteed non-null here
          const correctedTriage = triageDecision!;
          context = {
            ...context,
            triage: correctedTriage,
            taskType: this.applyTriageTaskType(request, context.taskType, correctedTriage),
            executionPlan: plan,
            // Cascade: client (Layer 1) > triage (Layer 2) > inference (Layer 3)
            preferSpeed: request.prefer_speed ?? plan?.preferSpeed ?? context.preferSpeed,
            qualityTarget: request.quality_target ?? plan?.qualityTarget ?? context.qualityTarget,
            requiredCapabilities: request.ailin_constraints?.requiredCapabilities?.length
              ? request.ailin_constraints.requiredCapabilities
              : this.mergeCapabilities(plan?.requiredCapabilities, context.requiredCapabilities),
          };

          // Apply inferred max_tokens if client didn't specify
          if (request.max_tokens === undefined && plan?.maxTokens) {
            request.max_tokens = plan.maxTokens;
            this.log.debug(
              { requestId, inferredMaxTokens: plan.maxTokens, source: 'triage-plan' },
              'Applied semantically inferred max_tokens from triage execution plan'
            );
          }

          // Propagate reasoning recommendation from triage to request constraints
          // Only if user didn't explicitly set enable_reasoning
          if (plan?.enableReasoning && request.ailin_constraints?.enable_reasoning === undefined) {
            request.ailin_constraints = {
              ...(request.ailin_constraints || {}),
              enable_reasoning: true,
            };
            this.log.debug(
              { requestId, source: 'triage-plan' },
              'Triage recommended enable_reasoning for high-complexity task',
            );
          }

          await this.applyPreferredModels(request, context, correctedTriage);

          // Record triage in transparency trace
          this.reasoningTransparency.recordTriage(requestId, {
            intent: correctedTriage.intent || 'unknown',
            complexity: correctedTriage.complexity || 'medium',
            priority: correctedTriage.priority || 'normal',
            confidence: correctedTriage.confidence || 0.5,
          });

          // Record triage metrics
          recordTriage({
            intent: correctedTriage.intent || 'unknown',
            complexity: correctedTriage.complexity || 'medium',
            confidence: correctedTriage.confidence || 0.5,
            durationMs: 0,
            source: 'llm',
          });
        }
      } catch (error) {
        this.log.error(
          { error, requestId },
          'Triage service failed; continuing without triage hints'
        );
      }
    } else if (this.triageService && autoStrategyRequested) {
      this.log.debug(
        {
          requestId,
          taskType: context.taskType,
          contextSize: context.contextSize,
          preferSpeed: context.preferSpeed,
        },
        'Skipping triage for latency-optimized auto request'
      );
    }

    try {
      // ── Multi-stage execution: if triage produced a multi-stage plan, execute stages sequentially ──
      const plan = context.executionPlan;
      // Review fix: a single-stage plan whose one stage is MEDIA GENERATION
      // must also route through executeMultiStagePlan — that is the only
      // path that invokes the CapabilityInvoker for a real artifact. With
      // the old `> 1` gate, "generate an image of a cat" (1-stage
      // image_generation plan) fell into the single-stage chat path and
      // produced prose describing the image instead of the image itself.
      const hasMultiStagePlan = plan && (
        plan.stages.length > 1 ||
        (plan.stages.length === 1 && detectMediaGenerationModality(plan.stages[0].requiredCapabilities) !== null)
      );

      let result: OrchestrationResult;
      // C4 fix: selectionSource is request-scoped (local variable), NOT an instance field.
      // This prevents race conditions where concurrent requests overwrite each other's
      // selection source, corrupting audit data and learning system attribution.
      let selectionSource = 'unknown';

      if (hasMultiStagePlan) {
        this.log.info(
          {
            requestId,
            stageCount: plan.stages.length,
            modelCount: plan.modelCount,
            topStrategy: plan.strategy,
          },
          'Executing multi-stage triage plan (collective intelligence pipeline)'
        );
        selectionSource = 'multi-stage';
        // Review fix: the multi-stage path received the raw request —
        // precisely when triage produced a rich plan WITH recommendedTools,
        // the tools were never attached. Same wrapper as the single-stage
        // and streaming paths.
        result = await this.executeMultiStagePlan(
          this.applyRecommendedTools(request, context), context, plan, requestId,
        );
      } else {
        // ── Single-stage: use standard strategy selection and execution ──
        const selection = this.selectStrategy(request, context);
        const strategy = selection.strategy;
        selectionSource = selection.selectionSource;

        this.log.info(
          {
            requestId,
            selectedStrategy: strategy.getMetadata().name,
            availableModels: context.models.length,
          },
          'Strategy selected'
        );

        writeDecisionAudit({
          requestId,
          organizationId,
          taskType: context.taskType || 'general',
          complexity: this.estimateComplexity(request),
          requestedStrategy: request.strategy && request.strategy !== 'auto' ? request.strategy : null,
          triageIntent: triageDecision?.intent ?? null,
          triageComplexity: triageDecision?.complexity ?? null,
          triageConfidence: triageDecision?.confidence ?? null,
          triageRecommendedStrategy: triageDecision?.recommendedStrategy ?? null,
          strategyScores: {},
          selectedStrategy: strategy.getMetadata().name,
          selectionReason: selectionSource,
          modelsConsidered: context.models.map((m) => m.id),
          modelsSelected: [],
          decisionSource: selectionSource,
          decisionConfidence: triageDecision?.confidence ?? undefined,
        });

        this.injectProviderRegistry(strategy);

        const strategyName = strategy.getMetadata().name;
        const requestedMaxTokens =
          typeof request.max_tokens === 'number' ? request.max_tokens : undefined;

        // ── OI-08: Adaptive Quality Targets ─────────────────────────────
        // Replace static 0.85 with difficulty-aware target from historical data.
        // The adaptive system considers (taskType, complexity) niche performance
        // to set an appropriate target — easy tasks get lower targets (save compute),
        // hard tasks get higher targets (invest in quality).
        const adaptiveTarget = await getAdaptiveQualityTarget(
          context.taskType || 'general',
          this.estimateComplexity(request),
          typeof context.qualityTarget === 'number' ? context.qualityTarget : undefined,
        );
        const qualityTarget = adaptiveTarget.target;

        if (adaptiveTarget.source === 'learned') {
          this.log.debug({
            requestId,
            qualityTarget,
            adaptiveSource: adaptiveTarget.source,
            confidence: adaptiveTarget.confidence,
            historicalAvg: adaptiveTarget.historicalAvg,
            historicalP90: adaptiveTarget.historicalP90,
            suggestedIterations: adaptiveTarget.suggestedMinIterations,
          }, 'Using learned adaptive quality target (OI-08)');
        }

        const latencySensitiveRequest =
          context.preferSpeed ||
          (requestedMaxTokens !== undefined && requestedMaxTokens <= 320);
        const highDeliberationStrategy =
          strategyName === 'debate' || strategyName === 'quality-multipass';

        // OI-08: Use adaptive iteration suggestion when available
        const adaptiveMinIterations = adaptiveTarget.suggestedMinIterations;
        const allowMultiIterationFeedback =
          (highDeliberationStrategy || adaptiveMinIterations >= 2) &&
          !latencySensitiveRequest &&
          qualityTarget >= 0.88 &&
          (requestedMaxTokens === undefined || requestedMaxTokens > 512);

        // B (2026-06-29, latency-safe): `allowMultiIterationFeedback` is the
        // explicit opt-in for re-generation (requires qualityTarget>=0.88 / a
        // high-deliberation strategy). The else-branch could still leak the
        // adaptive suggestion (>=2) into default chat, doubling latency for a
        // typically-marginal gain. When ORCHESTRATION_FEEDBACK_LATENCY_SAFE is
        // set, cap non-opted-in requests to a single pass — still runs the
        // validation + auto-fix pass, just no re-generation. Default off:
        // behaviour unchanged unless the flag is flipped (reversible A/B).
        const feedbackLatencySafe = process.env.ORCHESTRATION_FEEDBACK_LATENCY_SAFE === 'true';
        const feedbackMaxIterations = allowMultiIterationFeedback
          ? Math.min(this.config.maxFeedbackIterations ?? adaptiveMinIterations, 3)
          : feedbackLatencySafe
            ? 1
            : Math.max(1, adaptiveMinIterations <= 1 ? 1 : adaptiveMinIterations);
        const feedbackQualityThreshold = allowMultiIterationFeedback
          ? qualityTarget
          : Math.min(qualityTarget, 0.82);

        // ── OI-10: Compute archive escalation strategy ──────────────────
        // Pre-resolve an alternative strategy from the archive in case the
        // primary strategy fails to meet quality after all feedback iterations.
        let escalationStrategy: typeof strategy | undefined;
        let escalationReason: string | undefined;
        if (!latencySensitiveRequest) {
          const alternatives = configurationArchive.getAlternatives(
            context.taskType || 'general',
            this.estimateComplexity(request),
          );
          // Pick the quality-dimension elite if it's different from the current strategy
          const qualityElite = alternatives.find(
            (a) => a.dimension === 'quality' && a.elite.strategy !== strategyName,
          );
          const fallbackElite = qualityElite ??
            alternatives.find((a) => a.elite.strategy !== strategyName);
          if (fallbackElite) {
            const altStrategy = this.strategies.get(fallbackElite.elite.strategy as ExecutionStrategyName);
            if (altStrategy && altStrategy.isSuitable(request, context)) {
              this.injectProviderRegistry(altStrategy);
              escalationStrategy = altStrategy;
              escalationReason = `archive-${fallbackElite.dimension}-elite (fitness: ${fallbackElite.elite.fitness.toFixed(3)})`;
            }
          }
        }

        // ── SOTA System Prompt Injection ──────────────────────────────
        // Inject a platform-aware system prompt so execution models understand
        // the system's capabilities (tools, image gen, web search, etc.) and
        // their role in the collective intelligence strategy. Only injected
        // when no user/triage system message exists.
        //
        // R11: propagate the authoritative collective-strategy flag from the
        // strategy's own metadata so the builder no longer relies on a hardcoded
        // Set that missed several real collective strategies (debate, consensus,
        // blind-debate, expert-panel, war-room, ...). BaseStrategy.getMetadata().minModels
        // is the single source of truth for multi-model strategies.
        context.isCollectiveStrategy = (strategy.getMetadata().minModels ?? 1) > 1;
        injectExecutionSystemPrompt(request, context);

        // ── Social Facilitation Prompt ────────────────────────────────
        // For collective strategies (multi-model), inform models that their work
        // will be peer-reviewed. Empirical evidence shows this improves
        // performance on well-practiced tasks.
        //
        // Lote 2 refactor: the decision + injection logic is now centralized in
        // `peer-review-prompt.ts` so a future A/B benchmark can toggle the
        // behavior via `AILIN_PEER_REVIEW_MODE` without touching the engine.
        // Default runtime behavior is IDENTICAL to Lote 1 — the helper resolves
        // `mode='on'` unless the legacy `DISABLE_FACILITATION_PROMPT=true` is
        // set or the new env opts out explicitly.
        if (
          shouldInjectPeerReviewPrompt({
            isCollectiveStrategy: context.isCollectiveStrategy === true,
            request,
          })
        ) {
          // LAT-3 completion: keep `enrichedRequest` (the memory-enriched
          // variant) in lockstep. Before this, injecting peer-review only
          // into `request` forked the two variables — the confidence-gate
          // branch below (built from `request`) silently DROPPED the
          // engine-injected memory block, and the else-branch (built from
          // `enrichedRequest`) silently dropped the peer-review prompt.
          const requestBeforePeerReview = request;
          request = injectPeerReviewPrompt(request);
          enrichedRequest = enrichedRequest === requestBeforePeerReview
            ? request
            : injectPeerReviewPrompt(enrichedRequest);
        }

        // ── Confidence-Gated Continuation (OI-04) ──────────────────────
        // Compute-allocation principle: systems should "think longer" on
        // harder problems. If feedback loop is disabled OR single-iteration,
        // we still execute once and check: if quality is below a confidence
        // gate, trigger one refinement.
        const confidenceGateEnabled = this.config.enableFeedbackLoop !== false;
        const confidenceGateThreshold = qualityTarget * 0.85; // 85% of target

        // A-fix (2026-06-11): if strategy execution THROWS — e.g. a collective
        // throwing "All parallel executions failed" when every fanned-out provider
        // returns 401/402/empty — synthesize an EMPTY OrchestrationResult instead of
        // letting the throw escape to a 500. The shared post-execution pipeline below
        // (recoverEmptyFinalResponse) then re-selects funded candidates (anthropic,
        // etc.), so the request routes around the dead gateways.
        const buildExecThrewResult = (err: unknown): OrchestrationResult => ({
          strategyUsed: strategy.getMetadata().name,
          modelsUsed: [],
          finalResponse: {
            id: `exec-threw-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'auto',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'stop',
              logprobs: null,
            }],
          },
          totalCost: 0,
          totalDuration: 0,
          qualityScore: 0,
          metadata: { strategy_execution_threw: true, strategy_execution_error: getErrorMessage(err) },
        });

        if (confidenceGateEnabled) {
          // C3 P0.2: Skip memory enrichment when ablated.
          // Review fix: this branch is the DEFAULT production path
          // (enableFeedbackLoop defaults on) and was missed when
          // applyRecommendedTools was wired into the else-branch and the
          // streaming path — triage-recommended tools never reached the
          // strategy here.
          // LAT-3 completion: base on enrichedRequest (NOT the raw request),
          // exactly like the else-branch — when the engine already ran the
          // memory search (context.memoryEnriched), enrichWithMemories
          // short-circuits and returns its INPUT unchanged, so passing the
          // raw `request` here dropped the engine-injected memory block on
          // the default path (memory never reached the models).
          const memRequest = this.applyRecommendedTools(
            context.ablationFlags?.disabled?.has('memory')
              ? request
              : await strategy.enrichWithMemories(enrichedRequest, context),
            context,
          );
          // C3 P0.2: Skip feedback loop when ablated (single attempt)
          const ablatedFeedbackIterations = context.ablationFlags?.disabled?.has('feedback-loop')
            ? 1
            : feedbackMaxIterations;
          try {
            result = await this.feedbackLoop.executeWithFeedback(strategy, memRequest, context, {
              qualityThreshold: feedbackQualityThreshold,
              maxIterations: ablatedFeedbackIterations,
              allowAutoFix: !context.ablationFlags?.disabled?.has('feedback-loop'),
              escalationStrategy,
              escalationReason,
            });
          } catch (execErr) {
            this.log.error(
              { requestId, strategy: strategy.getMetadata().name, error: getErrorMessage(execErr) },
              'Strategy execution threw — synthesizing empty result so cross-provider recovery can run'
            );
            result = buildExecThrewResult(execErr);
          }

          // Dynamic deliberation: number of refinement rounds determined by:
          // 1. Triage recommendation (max_deliberation_rounds)
          // 2. Quality score after initial execution (confidence gate)
          // 3. Latency sensitivity (skip if user needs speed)
          const triageRounds = context.executionPlan?.maxDeliberationRounds;
          const maxRefinementRounds = triageRounds ?? (
            !latencySensitiveRequest && feedbackMaxIterations <= 1 ? 1 : 0
          );

          if (
            maxRefinementRounds > 0 &&
            !latencySensitiveRequest &&
            // B (2026-06-29): in latency-safe mode the confidence-gate refinement
            // is also a re-generation pass — keep it only for opted-in requests.
            (!feedbackLatencySafe || allowMultiIterationFeedback) &&
            result.qualityScore !== undefined &&
            result.qualityScore < confidenceGateThreshold &&
            result.qualityScore > 0.2 // Don't retry complete failures
          ) {
            this.log.info({
              requestId,
              qualityScore: result.qualityScore,
              confidenceGate: confidenceGateThreshold,
              qualityTarget,
              maxRefinementRounds,
              source: triageRounds !== undefined ? 'triage' : 'default',
            }, 'Confidence gate triggered — executing refinement pass(es)');

            const refinementResult = await this.feedbackLoop.executeWithFeedback(
              strategy, request, context, {
                qualityThreshold: qualityTarget,
                maxIterations: maxRefinementRounds,
                allowAutoFix: true,
              }
            );

            // Keep the better result
            if ((refinementResult.qualityScore ?? 0) > (result.qualityScore ?? 0)) {
              result = refinementResult;
              result.metadata = {
                ...result.metadata,
                confidence_gate: {
                  triggered: true,
                  originalScore: result.qualityScore,
                  refinedScore: refinementResult.qualityScore,
                },
              };
            }
          }
        } else {
          // ── Observer wiring ──
          // If enable_observer=true, instantiate ObserverService with a local reasoning model.
          // The observer narrates the collective process in real-time via SSE chunks.
          // Narration is default-ON: undefined/true both enable it; only an
          // explicit enable_observer:false opts out. OBSERVER_DEFAULT_ENABLED=false
          // is the global kill-switch (flip on the running stack, no redeploy).
          const observerEnabled =
            process.env.OBSERVER_DEFAULT_ENABLED !== 'false' &&
            request.ailin_constraints?.enable_observer !== false;
          let observerFeed = createNoOpObserverFeed();
          if (observerEnabled) {
            const language = ObserverService.extractUserSample(request.messages);
            const observer = new ObserverService(
              { enabled: true, language },
              strategy.getMetadata().name,
            );
            if (observer.isActive()) {
              observerFeed = observer;
            }
          }
          // Inject observer feed into strategy context for event emission.
          // `observerFeed` is a runtime-attached field; single structural cast
          // (NOT `as unknown as`) is the proper way to express "I know this
          // object accepts this extra field at runtime".
          (context as { observerFeed?: typeof observerFeed }).observerFeed = observerFeed;

          // NOTE: cross-modal capability access is provided via `context.invoker`
          // (built once per request in buildContext(), see createCapabilityInvoker
          // call there). It used to ALSO be written onto the shared `strategy`
          // singleton as `strategy.capabilityInvoker` here — a mutable field on an
          // object reused across every concurrent request for this strategy name,
          // racy under concurrent load (request A's invoker could be overwritten by
          // request B's before A read it) and never actually read by any strategy.
          // Removed rather than fixed in place: `context.invoker` is already the
          // correct, request-scoped mechanism.

          // Memory enrichment: search for relevant memories and inject as context.
          // Base on enrichedRequest (NOT the original request): when the engine
          // already ran the memory search (context.memoryEnriched), enrichWith-
          // Memories short-circuits and returns its input unchanged — passing
          // the original `request` there DISCARDED the engine-injected memory
          // block entirely on the non-streaming path (memory never reached the
          // models). enrichedRequest === request when nothing was enriched, so
          // the no-memory path is unchanged.
          // C3 P0.2: Skip when memory is ablated
          const memoryEnrichedRequest = this.applyRecommendedTools(
            context.ablationFlags?.disabled?.has('memory')
              ? request
              : await strategy.enrichWithMemories(enrichedRequest, context),
            context,
          );

          // Inject Strategy Leader for adaptive supervision
          // Leader removed — strategies call executeModel() directly

          try {
            result = await strategy.execute(memoryEnrichedRequest, context);
          } catch (execErr) {
            this.log.error(
              { requestId, strategy: strategy.getMetadata().name, error: getErrorMessage(execErr) },
              'Strategy execution threw — synthesizing empty result so cross-provider recovery can run'
            );
            result = buildExecThrewResult(execErr);
          }

          // Memory recording: store high-quality results for future retrieval
          strategy.recordExecution(context, result).catch(() => {}); // fire-and-forget

          // Record degradation metadata if strategy was degraded pre-dispatch
          if (context.degradation?.isDegraded) {
            result.metadata = {
              ...result.metadata,
              strategy_requested: context.degradation.originalStrategy,
              strategy_executed: context.degradation.executedStrategy,
              degradation_path: context.degradation.degradationPath,
              degradation_reason: context.degradation.degradationReason,
              degradation_depth: context.degradation.degradationDepth,
            };
          }

          // Attach observer narrations to result metadata
          const narrations = observerFeed.getNarrations();
          if (narrations.length > 0) {
            result.metadata = {
              ...result.metadata,
              observer_narrations: narrations.map(n => ({
                event: n.event.type,
                narration: n.narration,
                reasoning: n.reasoning,
                duration_ms: n.durationMs,
              })),
            };
          }
        }
      }

      // ── Shared post-execution pipeline (quality, learning, cache) ──
      // Attach decision source to metadata for downstream auditability
      // C4 fix: uses request-scoped selectionSource, not shared instance field
      result.metadata = { ...result.metadata, decision_source: selectionSource };
      result.finalResponse = this.ensureResponseUsage(result.finalResponse);
      result = await this.recoverEmptyFinalResponse(result, request, context, requestId);
      result.finalResponse = this.ensureResponseUsage(result.finalResponse);

      // ── Response Depth Check (data-driven: <500 tokens → Q=0.196 avg) ──
      // Insight: short responses (<500 tokens) for medium/high complexity tasks
      // score near-zero. If response is suspiciously short, log a warning.
      // This informs the quality scorer and learning systems.
      const responseTokens = result.finalResponse.usage?.completion_tokens ?? 0;
      const MIN_DEPTH_TOKENS = Number(process.env.MIN_RESPONSE_DEPTH_TOKENS ?? 300);
      if (responseTokens > 0 && responseTokens < MIN_DEPTH_TOKENS && context.taskType !== 'caching') {
        this.log.warn({
          requestId,
          strategy: result.strategyUsed,
          responseTokens,
          minDepth: MIN_DEPTH_TOKENS,
          taskType: context.taskType,
        }, 'Response may be insufficiently thorough (below minimum depth threshold)');
        result.metadata = { ...result.metadata, depth_warning: true, response_tokens: responseTokens };
      }

      if (!this.hasUsableAssistantResponse(result.finalResponse)) {
        this.log.warn({ requestId }, 'Orchestration produced empty response after fallback attempts — returning degraded response');
        const degradedResponse: ChatResponse = {
          id: `degraded-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'auto',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '[DEGRADED] All execution attempts failed. No response produced.' },
            finish_reason: 'stop',
            logprobs: null,
          }],
          // Explicit zeroed usage — without this, callers that read
          // `usage?.total_tokens ?? 0` can't distinguish "no usage reported"
          // from "no usage block at all", and a 200 OK + non-empty content +
          // absent usage silently reads as an ordinary free/cached success.
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        result.finalResponse = degradedResponse;
        result.qualityScore = 0;
        result.metadata = { ...result.metadata, degraded: true, degraded_reason: 'empty_response_after_fallback' };
      }

      const totalDuration = Date.now() - startTime;

      // C3 P0.4: Scoring policy and policy-aware score — hoisted for use in
      // learning guard. Typed as the resolved-promise shape of
      // `calculatePolicyAwareScore` (the only producer); using `Awaited<...>`
      // avoids hand-duplicating the inline type and keeps the two in lockstep.
      const scoringPolicy = context.scoringPolicy ?? 'learning';
      // `typeof this.x` is invalid in a type-position alias (TS2304: `this`
      // isn't bound at the type level inside a method body). Reach the
      // method through the class index signature instead so the alias stays
      // in lockstep with `calculatePolicyAwareScore`'s actual return type.
      type PolicyAwareScore = Awaited<
        ReturnType<OrchestrationEngine['qualityScorer']['calculatePolicyAwareScore']>
      >;
      let policyAwareScore: PolicyAwareScore | null = null;

      // ── LAT-1 (2026-06-11): defer the LLM judge + learning tail off the
      //    response path for the default 'learning' policy. The judge (1-5s) and
      //    its dependent learning/stores run in __finalize() via setImmediate; the
      //    response returns immediately with a fast heuristic-preliminary score.
      //    'benchmark'/'observability'/sync_judge keep the original sync behavior.
      //    Ops escape hatch: LEARNING_JUDGE_SYNC=true restores the blocking judge
      //    fleet-wide without an API change.
      const deferLearning =
        scoringPolicy === 'learning' &&
        context.syncJudge !== true &&
        process.env.LEARNING_JUDGE_SYNC !== 'true';
      if (deferLearning) {
        // Fold the already-known triage cost synchronously so the response cost is
        // correct; the judge cost is added asynchronously via the billing top-up.
        const prelimTriageCost = context.triage?.costUsd ?? triageDecision?.costUsd ?? 0;
        if (prelimTriageCost > 0) result.totalCost += prelimTriageCost;
        // Degraded responses keep qualityScore=0 and omit the quality block, to
        // match the pre-deferral contract; non-degraded responses surface a fast
        // heuristic-preliminary score (the real judge overwrites it in __finalize).
        // We intentionally do NOT call modelPerformanceTracker.updateQualityOnly
        // here — the deferred judge feeds the rolling-quality EMA exactly once.
        const isDegraded = result.metadata?.degraded === true;
        let prelimQuality: Record<string, unknown> | undefined;
        if (!isDegraded) {
          const prelimExec =
            result.modelsUsed.find((e) => e.success && e.role === 'primary') ||
            result.modelsUsed.find((e) => e.success) ||
            result.modelsUsed[0];
          const prelim = this.qualityScorer.calculateScore(result.finalResponse, context, prelimExec);
          result.qualityScore = prelim.overall;
          prelimQuality = {
            score: prelim.overall,
            dimensions: prelim.dimensions,
            confidence: prelim.confidence,
            reasoning: prelim.reasoning ?? [],
            method: prelim.method,
            policy: scoringPolicy,
            preliminary: true,
          };
        }
        result.metadata = {
          ...result.metadata,
          ...(prelimQuality ? { quality: prelimQuality } : {}),
          __judgeDeferred: true,
          __triageCostFolded: prelimTriageCost > 0,
          cost_breakdown: {
            ...(typeof result.metadata?.cost_breakdown === 'object' && result.metadata?.cost_breakdown !== null
              ? (result.metadata.cost_breakdown as Record<string, unknown>)
              : {}),
            triage_cost_usd: prelimTriageCost,
            judge_cost_usd: 0,
            // The real judge cost is billed asynchronously; the response total is
            // preliminary (exact when the judge is free, the default prod config).
            judge_cost_pending: true,
          },
        };
      }

      // __finalize: the judge + learning tail. Awaited inline for sync policies;
      // fired via setImmediate (deferred) for the default 'learning' policy.
      const __finalize = async (): Promise<void> => {
      // Ensure quality scoring metadata is present
      if (deferLearning || result.qualityScore === undefined || result.metadata?.quality === undefined) {
        const primaryExecution =
          result.modelsUsed.find((exec) => exec.success && exec.role === 'primary') ||
          result.modelsUsed.find((exec) => exec.success) ||
          result.modelsUsed[0];

        // C3 P0.4: Policy-aware scoring
        // Uses the hoisted scoringPolicy and policyAwareScore from outer scope.
        let qualityScore: import('@/core/quality/quality-scorer').QualityScore;

        if (scoringPolicy === 'observability') {
          // Fast path: heuristic only, NOT used for learning
          qualityScore = this.qualityScorer.calculateScore(result.finalResponse, context, primaryExecution);
        } else {
          // 'learning' or 'benchmark': LLM-Judge MANDATORY. On the deferred
          // path (deferLearning) this whole block runs inside the
          // post-response __finalize, so the judge round-trip never blocks
          // the client; on the sync path ('benchmark' / sync_judge /
          // LEARNING_JUDGE_SYNC=true) it is awaited inline so experiments
          // get the judged score and judge cost attributed on the response
          // itself (C3 cost integrity).
          const pas = await this.qualityScorer.calculatePolicyAwareScore(
            result.finalResponse,
            context,
            primaryExecution,
            scoringPolicy as 'learning' | 'benchmark',
            { originalRequest: request }
          );
          policyAwareScore = pas;

          // C3 A.3: Record scoring pair for reward hacking detection
          if (pas.heuristicScore != null && pas.judgeScore != null) {
            try {
              const { getRewardHackingDetector } = await import('@/core/validation/c3/reward-hacking-detector.js');
              const content = result.finalResponse?.choices?.[0]?.message?.content;
              const contentStr = typeof content === 'string' ? content : '';
              getRewardHackingDetector().record({
                heuristicScore: pas.heuristicScore,
                judgeScore: pas.judgeScore,
                tokenCount: result.modelsUsed.reduce((s, m) => s + (m.response?.usage?.total_tokens ?? 0), 0),
                headingsCount: (contentStr.match(/^#{1,6}\s/gm) || []).length,
                codeBlocksCount: Math.floor((contentStr.match(/```/g) || []).length / 2),
                contentLength: contentStr.length,
              });
            } catch { /* non-blocking */ }
          }

          qualityScore = {
            overall: pas.overall,
            // `pas.dimensions` is already `QualityDimensions` (same source of
            // truth: quality-scorer.ts). The previous `as unknown as` cast was
            // unnecessary obfuscation — the types match directly.
            dimensions: pas.dimensions,
            confidence: pas.confidence,
            reasoning: pas.reasoning ?? [],
            method: pas.method === 'hybrid' ? 'llm-judge' : pas.method,
          };
          // Tag the result metadata with scoring policy details
          // Typed via OrchestrationInternalMetadata — no Record cast needed.
          result.metadata.__scoringPolicy = scoringPolicy;
          result.metadata.__judgeFailed = pas.judgeFailed ?? false;
          result.metadata.__validForLearning = !pas.judgeFailed && pas.confidence >= 0.3;
        }

        result.qualityScore = qualityScore.overall;
        result.metadata = {
          ...result.metadata,
          quality: {
            score: qualityScore.overall,
            dimensions: qualityScore.dimensions,
            confidence: qualityScore.confidence,
            reasoning: qualityScore.reasoning,
            method: qualityScore.method,
            heuristicScore: policyAwareScore?.heuristicScore,
            judgeScore: policyAwareScore?.judgeScore,
            policy: scoringPolicy,
          },
        };

        // Refine ModelPerformanceTracker with the actual quality score
        // (base-strategy records 0.8 placeholder; this updates with real value).
        // Uses updateQualityOnly() so provider reliability stats are NOT
        // double-counted — base-strategy.ts already recorded the execution
        // with the real execution provider (the adapter name).
        for (const exec of result.modelsUsed) {
          if (exec.success) {
            modelPerformanceTracker.updateQualityOnly(exec.modelId, qualityScore.overall);
          }
        }
      }

      // C3 P1.1: Measure diversity for multi-model strategies (non-blocking)
      if (result.modelsUsed.length > 1) {
        import('@/core/validation/c3/independence-test.js')
          .then(({ getIndependenceTestService }) => {
            const service = getIndependenceTestService();
            const outputs = result.modelsUsed
              .filter(exec => exec.success && exec.response?.choices?.[0])
              .map(exec => ({
                modelId: exec.modelId,
                provider: this.inferProviderFromModelId(exec.modelId),
                content: safeResponseContent(exec.response),
                role: exec.role,
                round: 1,
              }));
            if (outputs.length >= 2) {
              service.measureDiversity(
                outputs,
                result.strategyUsed,
                context.taskType || 'general',
                this.estimateComplexity(request)
              ).catch(() => {});
            }
          })
          .catch(() => {});
      }

      // ── Cost-accounting integrity (TIER 0): fold in billable sub-calls that
      //    are not part of the strategy's modelsUsed accounting ──────────────
      // The strategy's `result.totalCost` covers its own model executions
      // (including the consensus synthesizer, now tracked there). Two further
      // billable LLM sub-calls happen OUTSIDE the strategy and were previously
      // dropped from the reported cost:
      //   COST #4 — triage (pre-strategy classification LLM call)
      //   COST #5 — LLM judge / quality scorer (post-strategy scoring call)
      // Add both to the request total and surface them as distinct line items
      // so the C3 cost thesis can be measured against the true request cost.
      // Missing values are treated as 0 (heuristic triage / no-judge paths).
      const triageCostUsd = context.triage?.costUsd ?? triageDecision?.costUsd ?? 0;
      const judgeCostUsd = policyAwareScore?.judgeCostUsd ?? 0;
      // LAT-1: in the deferred path the triage cost was already folded into
      // result.totalCost synchronously (and the response already shows it), so
      // only fold the judge cost here to avoid double-counting in the persisted
      // execution-outcome row. The judge cost is added to the bill via the
      // top-up at the end of __finalize.
      const triageAlreadyFolded = result.metadata?.__triageCostFolded === true;
      const auxiliaryCostUsd =
        (triageAlreadyFolded ? 0 : (triageCostUsd > 0 ? triageCostUsd : 0)) +
        (judgeCostUsd > 0 ? judgeCostUsd : 0);
      if (auxiliaryCostUsd > 0) {
        result.totalCost += auxiliaryCostUsd;
      }
      // Always emit the breakdown (even when 0) so downstream consumers have a
      // stable cost-accounting shape to read.
      result.metadata = {
        ...result.metadata,
        cost_breakdown: {
          ...(typeof result.metadata?.cost_breakdown === 'object' && result.metadata?.cost_breakdown !== null
            ? result.metadata.cost_breakdown as Record<string, unknown>
            : {}),
          triage_cost_usd: triageCostUsd,
          judge_cost_usd: judgeCostUsd,
        },
      };

      this.log.info(
        {
          requestId,
          strategy: result.strategyUsed,
          duration: totalDuration,
          cost: result.totalCost,
          modelsUsed: result.modelsUsed.length,
          qualityScore: result.qualityScore,
        },
        'Orchestration completed successfully'
      );

      // Store response in semantic cache for future similar requests
      // Use a lower threshold for short factual answers (< 150 tokens) since they score
      // 0.53-0.57 by design (no elaboration) but are highly cacheable (always identical)
      const totalTokens = result.finalResponse.usage?.total_tokens ?? 0;
      const cacheStoreThreshold = totalTokens > 0 && totalTokens < 150 ? 0.5 : 0.65;
      if (isCacheEnabled() && !request.stream && result.qualityScore && result.qualityScore >= cacheStoreThreshold) {
        // C3 latency fix (2026-06-11): fire-and-forget. The LLM response is already complete; storing
        // it in the semantic cache (which generates an embedding) must NOT delay the response to the
        // caller. Run it in the background, best-effort — errors are logged, never surfaced/awaited.
        const semanticCache = getSemanticCache();
        void semanticCache
          .store({
            request,
            response: result.finalResponse,
            organizationId,
            metadata: {
              tokensSaved: result.finalResponse.usage?.total_tokens || 0,
              costSaved: result.totalCost,
            },
          })
          .then(() => {
            this.log.debug({ requestId }, 'Response stored in semantic cache');
          })
          .catch((cacheError) => {
            this.log.warn(
              { error: getErrorMessage(cacheError) },
              'Failed to store in semantic cache (non-blocking)'
            );
          });
      }

      // Store high-quality interactions as procedural memory.
      // LAT-1: fire-and-forget (embedding + pgvector insert) and — because
      // this runs inside __finalize, after the judge — the ≥0.85 gate uses
      // the judged score, never the preliminary heuristic one.
      if (result.qualityScore !== undefined) {
        void this.storeProceduralMemory({
          result,
          request,
          context,
          organizationId,
          userId,
          qualityScore: result.qualityScore,
        });
      }

      // Record CI metrics
      recordStrategyExecution({
        strategy: result.strategyUsed,
        taskType: context.taskType || 'general',
        status: 'success',
        durationMs: totalDuration,
        qualityScore: result.qualityScore,
        costUsd: result.totalCost,
      });

      // OBS-04: record the model-selection decision (which model was chosen and
      // why). Emits `ci_model_selection_total{model, task_type, selection_reason}`
      // — previously defined but never recorded, so the model-selection alerts
      // and dashboards had no data. Labels are bounded: `model` is the primary
      // executed model from the catalog and `selection_reason` is the same
      // bounded decision source written to the decision audit (heuristic /
      // triage / bandit / archive / pareto / explicit / fallback / multi-stage).
      // No per-request or prompt-derived labels are used.
      const primarySelectedModel =
        result.modelsUsed.find((execution) => execution.success)?.modelId ??
        result.modelsUsed[0]?.modelId;
      if (primarySelectedModel) {
        recordModelSelection({
          model: primarySelectedModel,
          taskType: context.taskType || 'general',
          selectionReason:
            (typeof result.metadata?.decision_source === 'string'
              ? result.metadata.decision_source
              : selectionSource) || 'unknown',
        });
      }

      // Record execution and quality in transparency trace
      this.reasoningTransparency.recordExecution(requestId, result);
      if (result.qualityScore !== undefined) {
        const qualityMetadata = result.metadata?.quality as { dimensions?: Record<string, number> } | undefined;
        this.reasoningTransparency.recordQuality(requestId, {
          score: result.qualityScore,
          dimensions: qualityMetadata?.dimensions || ({} as Record<string, number>),
          threshold: context.qualityTarget || 0.7,
        });
      }
      this.reasoningTransparency.completeTrace(requestId);

      // Update knowledge graph edges (non-blocking)
      // C3 P0.2: Skip KG update when ablated
      if (!context.ablationFlags?.disabled?.has('knowledge-graph'))
      knowledgeGraphService.recordExecution({
        strategy: result.strategyUsed,
        taskType: context.taskType || 'general',
        modelIds: result.modelsUsed.filter((e) => e.success).map((e) => e.modelId),
        qualityScore: result.qualityScore ?? 0,
      }).catch((err) => this.log.warn({ error: getErrorMessage(err) }, 'Knowledge graph recording failed'));

      // Update learning systems (non-blocking, in-memory)
      // C3 P0.4: Only feed learning systems when the score is judge-validated
      // (the judge ran above — synchronously for benchmark/sync_judge, inside
      // the deferred __finalize for the production 'learning' policy).
      // Observability: heuristic-only scores are NEVER valid for learning.
      // (Fixes an inverted legacy condition that let heuristic scores feed
      // the bandit whenever scoringPolicy === 'observability'.)
      const scoreValidForLearning = policyAwareScore
        ? !policyAwareScore.judgeFailed &&
          policyAwareScore.confidence >= 0.3 &&
          policyAwareScore.policy !== 'observability'
        : false;
      // Freeze learning when the caller asked (experiment 'frozen' phase). The
      // runner set an X-Experiment-Freeze-Learning HEADER that no server code
      // read — so learning kept updating during the supposedly-frozen phase,
      // silently violating the experiment's own methodology. Honor the body flag.
      const learningFrozen = request.freeze_learning === true;
      if (result.qualityScore !== undefined && scoreValidForLearning && learningFrozen) {
        this.log.debug(
          { requestId, strategy: result.strategyUsed },
          'Learning frozen for this request (freeze_learning=true) — skipping bandit/learning updates',
        );
      }
      if (result.qualityScore !== undefined && scoreValidForLearning && !learningFrozen) {
        this.applyLearningUpdates({
          result,
          context,
          request,
          triageDecision,
          totalDuration,
          qualityScore: result.qualityScore,
        });
      } else if (result.qualityScore !== undefined && !scoreValidForLearning) {
        // C3 P0.4: Score exists but is invalid for learning (judge failed or observability-only)
        this.log.warn(
          {
            requestId,
            strategy: result.strategyUsed,
            qualityScore: result.qualityScore,
            policy: scoringPolicy,
            judgeFailed: policyAwareScore?.judgeFailed,
          },
          'Skipping learning update — score not valid for learning (LLM-Judge failed or observability-only policy)'
        );
      }

      // Record learning insight (async, non-blocking, with timeout guard)
      const LEARNING_TIMEOUT_MS = 5_000;
      Promise.race([
        autoLearningSystem.learn(result, {
          type:
            request.task_type ||
            (this.isTaskType(triageDecision?.intent) ? triageDecision?.intent : 'general'),
          complexity: this.estimateComplexity(request),
          contextSize: this.estimateContextSize(request.messages),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Learning timeout')), LEARNING_TIMEOUT_MS)
        ),
      ]).catch((err) => this.log.warn({ error: getErrorMessage(err) }, 'Learning insight failed or timed out'));

      // ── Closed-Loop: Record execution outcome ────────────────────────
      // Persists the measured result linked to the decision trace (requestId).
      // This is the foundation for regret calculation, drift detection, and
      // learning validation — proving the system actually improves.
      const qualityMeta = result.metadata?.quality as { dimensions?: Record<string, number> } | undefined;
      recordOutcome({
        decisionTraceId: requestId,
        strategy: result.strategyUsed,
        startedAt: new Date(Date.now() - totalDuration),
        finishedAt: new Date(),
        latencyMs: totalDuration,
        costUsd: result.totalCost,
        totalTokens: result.modelsUsed.reduce(
          (sum, m) => sum + (m.response?.usage?.total_tokens ?? 0), 0,
        ),
        success: (result.qualityScore ?? 0) > 0,
        failureReason: result.modelsUsed.find(m => !m.success)?.error,
        retries: (result.metadata?.feedback_iterations as Array<unknown>)?.length ?? 0,
        fallbackUsed: false,
        escalationUsed: !!result.metadata?.escalation,
        qualityScore: result.qualityScore ?? null,
        qualityDimensions: qualityMeta?.dimensions,
        feedbackIterations: (result.metadata?.feedback_summary as { totalIterations?: number })?.totalIterations ?? 1,
        modelsUsed: result.modelsUsed.filter(e => e.success).map(e => e.modelId),
        observedMetrics: {
          strategyUsed: result.strategyUsed,
          taskType: context.taskType || 'general',
          complexity: this.estimateComplexity(request),
        },
      }).catch((err) => this.log.warn({ error: getErrorMessage(err) }, 'Outcome measurement recording failed'));

      // ── Closed-Loop: Shadow evaluation (async, non-blocking) ─────────
      // For a fraction of requests, execute an alternative strategy and compare.
      // This produces regret data for competitive benchmarking.
      // C3 P0.2: Skip shadow evaluation when ablated
      if (shouldRunShadowEval() && result.qualityScore !== undefined && !context.ablationFlags?.disabled?.has('shadow')) {
        const chosenStrategy = result.strategyUsed;
        const taskType = context.taskType || 'general';
        const complexity = this.estimateComplexity(request);
        const alternatives = configurationArchive.getAlternatives(taskType, complexity);
        const shadowCandidate = alternatives.find(a => a.elite.strategy !== chosenStrategy);

        if (shadowCandidate) {
          const shadowStrategyObj = this.strategies.get(shadowCandidate.elite.strategy as ExecutionStrategyName);
          if (shadowStrategyObj && shadowStrategyObj.isSuitable(request, context)) {
            // Execute shadow strategy asynchronously — never blocks the response
            setImmediate(async () => {
              try {
                this.injectProviderRegistry(shadowStrategyObj);
                const shadowStart = Date.now();
                const shadowResult = await shadowStrategyObj.execute(request, context);
                const shadowDuration = Date.now() - shadowStart;

                const primaryExec = shadowResult.modelsUsed.find(e => e.success) ?? shadowResult.modelsUsed[0];
                const shadowQuality = this.qualityScorer.calculateScore(
                  shadowResult.finalResponse, context, primaryExec,
                );

                const qualityRegret = Math.max(0, shadowQuality.overall - (result.qualityScore ?? 0));
                const winnerStrategy = qualityRegret > 0.02
                  ? shadowCandidate.elite.strategy : chosenStrategy;

                await recordShadowEvaluation(
                  {
                    decisionTraceId: requestId,
                    taskType,
                    complexity,
                    chosenStrategy,
                    chosenQuality: result.qualityScore ?? 0,
                    chosenLatencyMs: totalDuration,
                    chosenCostUsd: result.totalCost,
                  },
                  {
                    shadowStrategy: shadowCandidate.elite.strategy,
                    shadowQuality: shadowQuality.overall,
                    shadowLatencyMs: shadowDuration,
                    shadowCostUsd: shadowResult.totalCost,
                    qualityRegret,
                    winnerStrategy,
                  },
                );
              } catch (err) {
                this.log.debug({ error: getErrorMessage(err) }, 'Shadow evaluation failed (non-fatal)');
              }
            });
          }
        }
      }

      // Record provider/model reliability signals for error-aware learning
      for (const execution of result.modelsUsed) {
        const provider = this.inferProviderFromModelId(execution.modelId);
        if (execution.success) {
          errorLearningSystem.recordSuccess(
            provider,
            execution.modelName,
            context.taskType,
            result.strategyUsed,
            execution.durationMs
          );
        } else {
          errorLearningSystem.recordError({
            provider,
            model: execution.modelName,
            errorType: this.classifyErrorForLearning(execution.error),
            taskType: context.taskType,
            strategy: result.strategyUsed,
            recovered: true,
            recoveryStrategy: result.strategyUsed,
            latencyMs: execution.durationMs,
          });
        }
      }

      // Record triage learning outcome (async, non-blocking)
      // This helps the system learn which triage strategies work best for different request patterns
      if (triageDecision) {
        // Get triage model info from decision metadata (added by triage service)
        const triageDecisionWithMetadata = triageDecision as TriageDecision & { 
          _metadata?: { triageModel?: { id: string; name: string } } 
        };
        const triageModelInfo = triageDecisionWithMetadata._metadata?.triageModel;
        
        // Extract prompt characteristics for learning
        const promptText = request.messages
          .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          .join(' ')
          .toLowerCase();
        const promptCharacteristics = {
          urgency: /urgent|asap|immediately|quick|fast|hurry|deadline/gi.test(promptText),
          costSensitive: /budget|cheap|cost.{0,40}effective|low.{0,40}cost/gi.test(promptText),
          qualityCritical: /quality|accurate|precise|best.{0,40}result|high.{0,40}quality/gi.test(promptText),
          messageCount: request.messages.length,
          hasTools: !!(request.tools && request.tools.length > 0),
        };
        
        // Get triage strategy used (from request or config)
        const triageStrategyUsed = request.triageStrategy || this.config.triageStrategy || 'balanced';
        
        try {
          triageLearningSystem.recordOutcome({
            triageStrategy: triageStrategyUsed,
            triageModelId: triageModelInfo?.id || 'unknown',
            triageModelName: triageModelInfo?.name || 'unknown',
            taskType: this.isTaskType(triageDecision.intent) ? triageDecision.intent : 'general',
            complexity: triageDecision.complexity || 'medium',
            contextSize: this.estimateContextSize(request.messages),
            promptCharacteristics,
            intent: triageDecision.intent || 'unknown',
            confidence: triageDecision.confidence || 0.5,
            executionStrategy: result.strategyUsed,
            executionSuccess: result.qualityScore !== undefined && result.qualityScore > 0,
            executionQuality: result.qualityScore || 0,
            executionCost: result.totalCost,
            executionLatency: result.totalDuration,
          });
        } catch (error: unknown) {
          this.log.error({ error }, 'Failed to record triage learning outcome');
        }
      }

      // ── LAT-1: judge-cost billing top-up (deferred path only) ──────────────
      // The synchronous response already billed strategy+triage. Add ONLY the
      // judge cost here as a COST-ONLY quota delta: requests:0 (the request was
      // already counted by the main bill) and NO applyBillingProfile pass (the
      // flat-fee/minimum-charge are per-request and were already applied) — using
      // trackChatUsage here would double-count the request and re-apply the
      // flat fee. No-op when the judge resolved to a free model.
      if (deferLearning) {
        const deferredJudgeCost = policyAwareScore?.judgeCostUsd ?? 0;
        if (deferredJudgeCost > 0 && organizationId) {
          try {
            const { recordQuotaUsage } = await import('@/services/quota-service.js');
            await recordQuotaUsage(organizationId, {
              organizationId,
              userId,
              operation: { requests: 0, tokens: 0, cost: deferredJudgeCost },
            });
          } catch (billErr) {
            this.log.warn({ error: getErrorMessage(billErr), requestId }, 'Deferred judge-cost billing top-up failed');
          }
        } else if (deferredJudgeCost > 0) {
          // Paid judge but no org to bill — surface so under-collection is visible.
          this.log.warn({ requestId, deferredJudgeCost }, 'Deferred judge cost not billed (no organizationId)');
        }
      }
      }; // ── end __finalize ──

      if (deferLearning) {
        // Off the response path — the heuristic-preliminary score already went out.
        setImmediate(() => {
          void __finalize().catch((e) =>
            this.log.warn({ error: getErrorMessage(e), requestId }, 'Deferred judge/learning finalize failed'),
          );
        });
      } else {
        await __finalize();
      }

      const resolvedStrategy = mapExecutionToCanonical(result.strategyUsed);
      const fallbackChain = Array.from(
        new Set(
          result.modelsUsed
            .map((execution) => execution.modelName)
            .filter((name): name is string => Boolean(name))
        )
      );
      const finalDecider = this.resolveFinalDecider(result);
      const resolvedModel =
        finalDecider.modelName ??
        result.modelsUsed.find((execution) => execution.success)?.modelName ??
        result.modelsUsed[0]?.modelName ??
        result.finalResponse.model;
      const finalResponseModel =
        finalDecider.modelId ??
        (typeof result.finalResponse.model === 'string' && result.finalResponse.model.length > 0
          ? result.finalResponse.model
          : undefined);
      const finalResponseForReturn =
        finalResponseModel && result.finalResponse.model !== finalResponseModel
          ? {
              ...result.finalResponse,
              model: finalResponseModel,
            }
          : result.finalResponse;
      const finalDeciderModelId = finalDecider.modelId ?? finalResponseModel;
      const finalDeciderModelName = finalDecider.modelName ?? resolvedModel;

      orchestrationSpan.setAttribute('orchestration.strategy', result.strategyUsed);
      orchestrationSpan.setAttribute('orchestration.quality', result.qualityScore ?? 0);
      orchestrationSpan.setAttribute('orchestration.cost_usd', result.totalCost);
      orchestrationSpan.setAttribute('orchestration.models_used', result.modelsUsed.length);
      orchestrationSpan.setStatus({ code: SpanStatusCode.OK });

      // OrchestrationInternalMetadata keys are engine-internal bookkeeping —
      // strip them at the public boundary so no downstream consumer (or a
      // future careless spread) can ever surface them. The ORIGINAL
      // result.metadata keeps them: the deferred __finalize reads/writes that
      // object after this copy is returned (the two diverge by design).
      // Pinned by internal-metadata-contract.test.ts.
      const {
        __scoringPolicy: _internalScoringPolicy,
        __judgeFailed: _internalJudgeFailed,
        __validForLearning: _internalValidForLearning,
        __judgeDeferred: _internalJudgeDeferred,
        __triageCostFolded: _internalTriageCostFolded,
        ...publicMetadata
      } = result.metadata;

      return {
        ...result,
        metadata: {
          ...publicMetadata,
          triage: triageDecision,
          requested_strategy: requestedCanonicalStrategy,
          resolved_strategy: resolvedStrategy,
          resolved_model: resolvedModel,
          final_decider_model_id: finalDeciderModelId,
          final_decider_model_name: finalDeciderModelName,
          final_decider_role: finalDecider.role,
          fallback_chain: fallbackChain,
        },
        triage: triageDecision,
        finalResponse: {
          ...finalResponseForReturn,
          ailin_metadata: finalResponseForReturn.ailin_metadata
            ? {
                ...finalResponseForReturn.ailin_metadata,
                resolved_strategy: resolvedStrategy,
                resolved_model: resolvedModel,
                final_decider_model_id: finalDeciderModelId,
                final_decider_model_name: finalDeciderModelName,
                final_decider_role: finalDecider.role,
                fallback_chain: fallbackChain,
                triage_intent: triageDecision?.intent,
                triage_complexity: triageDecision?.complexity,
                triage_strategy: triageDecision?.recommendedStrategy,
                // F5-META: propagate structured dynamic prompting metadata
                // to the API response so clients can audit which variant/slot
                // config produced the response. Only set when non-empty.
                ...(finalDecider.promptVariantId
                  ? { prompt_variant: finalDecider.promptVariantId }
                  : {}),
                ...(finalDecider.promptSlotHash
                  ? { prompt_slot_hash: finalDecider.promptSlotHash }
                  : {}),
              }
            : undefined,
        },
      };
    } catch (error) {
      const totalDuration = Date.now() - startTime;

      this.log.error(
        {
          requestId,
          error,
          duration: totalDuration,
        },
        'Orchestration failed'
      );

      orchestrationSpan.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(error) });

      errorLearningSystem.recordError({
        provider: this.inferProviderFromModelId(
          typeof request.model === 'string' ? request.model : undefined
        ),
        model:
          typeof request.model === 'string' && request.model.trim().length > 0
            ? request.model
            : 'auto',
        errorType: this.classifyErrorForLearning(error),
        taskType: context.taskType,
        strategy:
          typeof request.strategy === 'string' && request.strategy.trim().length > 0
            ? request.strategy
            : 'auto',
        recovered: false,
        latencyMs: totalDuration,
      });

      throw error;
    } finally {
      orchestrationSpan.end();
    }
    }); // end tracer.startActiveSpan
  }

  /**
   * Learning updates fed by a judge-validated quality score.
   *
   * Called synchronously on the benchmark/sync-judge path and from the
   * post-response continuation on the production 'learning' path (LAT-1).
   * `qualityScore` is passed explicitly (instead of read from `result`)
   * because on the deferred path the shipped response keeps the preliminary
   * heuristic score while learning must use the judged one.
   */
  private applyLearningUpdates(args: {
    result: OrchestrationResult;
    context: OrchestrationContext;
    request: ChatRequest;
    triageDecision: TriageDecision | undefined;
    totalDuration: number;
    qualityScore: number;
  }): void {
    const { result, context, request, triageDecision, totalDuration, qualityScore } = args;

    strategyBandit.update({
      taskType: context.taskType || 'general',
      complexity: this.estimateComplexity(request),
      strategy: result.strategyUsed,
      qualityScore,
    });
    // Record execution for Success-Story auto-rollback (OI-03)
    strategyBandit.recordExecution(qualityScore, totalDuration);

    // OI-06: Feed production result into configuration archive
    // C3 P0.2: Skip archive ingestion when ablated
    if (!context.ablationFlags?.disabled?.has('archive')) {
      configurationArchive.ingestProductionResult({
        taskType: context.taskType || 'general',
        complexity: this.estimateComplexity(request),
        strategy: result.strategyUsed,
        qualityScore,
        costUsd: result.totalCost,
        latencyMs: totalDuration,
        success: qualityScore > 0,
        totalTokens: result.modelsUsed.reduce(
          (sum, m) => sum + (m.response?.usage?.total_tokens ?? 0), 0
        ),
      });
    }

    // C3 P1.6: Feed ROI estimator with execution data (non-blocking)
    import('@/core/validation/c3/roi-estimator.js')
      .then(({ getROIEstimator }) => {
        const isCollective = result.modelsUsed.length > 1;
        getROIEstimator().addDataPoint({
          domain: context.taskType || 'general',
          taskType: context.taskType || 'general',
          complexity: this.estimateComplexity(request),
          mode: isCollective ? 'ci' : 'single',
          qualityScore,
          costUsd: result.totalCost,
          latencyMs: totalDuration,
        });
      })
      .catch(() => {});

    // OI-07: Record triage observation for calibration
    if (triageDecision) {
      triageCalibrator.recordObservation({
        predictedTaskType: this.isTaskType(triageDecision.intent) ? triageDecision.intent : 'general',
        predictedComplexity: triageDecision.complexity || 'medium',
        predictedStrategy: triageDecision.recommendedStrategy,
        triageConfidence: triageDecision.confidence || 0.5,
        actualQualityScore: qualityScore,
        actualCostUsd: result.totalCost,
        actualLatencyMs: totalDuration,
        actualSuccess: qualityScore > 0,
        executedStrategy: result.strategyUsed,
        promptLength: request.messages
          .map(m => typeof m.content === 'string' ? m.content.length : 0)
          .reduce((a, b) => a + b, 0),
        hasTools: !!(request.tools && request.tools.length > 0),
        messageCount: request.messages.length,
      });
    }
  }

  /**
   * Persist high-quality interactions (score ≥ 0.85) as procedural memory
   * (embedding + pgvector insert). Best-effort; never awaited on the
   * response path (LAT-1).
   */
  private async storeProceduralMemory(args: {
    result: OrchestrationResult;
    request: ChatRequest;
    context: OrchestrationContext;
    organizationId: string;
    userId?: string;
    qualityScore: number;
  }): Promise<void> {
    const { result, request, context, organizationId, userId, qualityScore } = args;
    if (qualityScore < 0.85) return;
    try {
      const memoryContextService = getMemoryContextService();
      const responseContent = result.finalResponse.choices?.[0]?.message?.content || '';
      if (responseContent.length > 50 && responseContent.length < 5000) {
        await memoryContextService.storeOutcome({
          organizationId,
          userId,
          content: `Task: ${this.extractTaskSummary(request)}\nApproach: ${responseContent.slice(0, 500)}`,
          type: 'procedural',
          importance: qualityScore,
          metadata: {
            strategy: result.strategyUsed,
            models: result.modelsUsed,
            taskType: context.taskType,
          },
        });
      }
    } catch (memoryError) {
      this.log.warn(
        { error: getErrorMessage(memoryError) },
        'Failed to store interaction as memory'
      );
    }
  }

  private inferProviderFromModelId(modelId?: string): string {
    if (!modelId || modelId.trim().length === 0) {
      return 'unknown';
    }

    const trimmed = modelId.trim().toLowerCase();
    const slashIndex = trimmed.indexOf('/');
    const atIndex = trimmed.indexOf('@');

    if (slashIndex > 0) {
      if (atIndex > -1 && atIndex < slashIndex) {
        const scopedProvider = trimmed.slice(atIndex + 1, slashIndex).trim();
        if (scopedProvider) {
          return scopedProvider;
        }
      }
      return trimmed.slice(0, slashIndex);
    }

    if (atIndex > 0 && atIndex < trimmed.length - 1) {
      return trimmed.slice(0, atIndex);
    }

    return trimmed.split('-')[0];
  }

  private classifyErrorForLearning(
    error: unknown
  ): 'rate-limit' | 'timeout' | 'provider-error' | 'model-unavailable' | 'quality-low' | 'other' {
    const message = getErrorMessage(error).toLowerCase();

    if (message.includes('429') || message.includes('rate limit')) {
      return 'rate-limit';
    }
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('etimedout')
    ) {
      return 'timeout';
    }
    if (
      message.includes('model_not_found') ||
      message.includes('model unavailable') ||
      message.includes('not found')
    ) {
      return 'model-unavailable';
    }
    if (message.includes('quality')) {
      return 'quality-low';
    }
    if (message.includes('provider') || message.includes('service unavailable')) {
      return 'provider-error';
    }

    return 'other';
  }

  /**
   * Create an execution plan for streaming requests
   * Ensures SingleModel strategy selection, triage hints, and adapter resolution.
   */
  async createStreamingPlan(
    request: ChatRequest,
    organizationId: string,
    userId: string | undefined,
    requestId: string
  ): Promise<StreamingExecutionPlan> {
    const planningRequest: ChatRequest = {
      ...request,
      messages: request.messages,
      tools: request.tools,
    };

    let context = await this.buildContext(planningRequest, organizationId, userId, requestId);

    let triageDecision = context.triage;

    const autoStrategyRequested =
      !planningRequest.strategy || planningRequest.strategy === 'auto';
    // Latency budget (2026-07-13): this SSE single-model path never consumes
    // the triage executionPlan (the plan here is always one model streaming),
    // so triage only contributes taskType/preferredModels — a modest gain
    // that does not justify a serial LLM call when the request is clearly
    // latency-first (preferSpeed: heuristic-inferred trivial/short/cheap, or
    // client-explicit prefer_speed). Complex/tools/quality requests keep the
    // full triage. The executeStream() path (collectives, /v1/responses) is
    // NOT gated by this — strategy choice there genuinely depends on triage.
    const shouldRunTriage = this.shouldRunTriage(planningRequest, context) && !context.preferSpeed;

    const strategy = this.strategies.get('single');
    if (!strategy || !(strategy instanceof SingleModelStrategy)) {
      throw new Error('Single model strategy not available for streaming');
    }
    this.injectProviderRegistry(strategy);

    // Speculative parallel selection (2026-07-14): this call-site's strategy
    // class is ALWAYS 'single' regardless of what triage recommends (the SSE
    // single-model plan never branches into a collective) — so resolving the
    // model pool never needs to wait on triage's result at all.
    const speculativePromise = this.resolveSpeculativeSingleSelection(
      strategy,
      planningRequest,
      context,
      requestId,
    );

    if (this.triageService && autoStrategyRequested && shouldRunTriage) {
      try {
        triageDecision = await this.triageService.triage(planningRequest, context, context.capabilityInference, context.models);
        if (triageDecision) {
          triageDecision = this.applyTriageRoute(triageDecision, planningRequest);
          context = {
            ...context,
            triage: triageDecision,
            taskType: this.applyTriageTaskType(planningRequest, context.taskType, triageDecision),
          };
          await this.applyPreferredModels(planningRequest, context, triageDecision);
        }
      } catch (error) {
        this.log.error({ error, requestId }, 'Triage service failed during streaming planning');
      }
    } else if (this.triageService && autoStrategyRequested) {
      this.log.debug(
        {
          requestId,
          taskType: context.taskType,
          contextSize: context.contextSize,
          preferSpeed: context.preferSpeed,
        },
        'Skipping triage during streaming plan for latency-optimized auto request'
      );
    }

    let selection = await speculativePromise;
    // Reconciliation: applyPreferredModels only mutates planningRequest.model
    // when it was 'auto' and triage recommended something specific. If that
    // happened and it diverges from what the speculative call already
    // resolved, redo the selection — but by now planningRequest.model is a
    // concrete id/name, so selectBestModel() takes the CHEAP exact-match path
    // (a models.find() + adapter lookup), not another DynamicModelSelector
    // pass. This only re-runs the expensive path when speculation genuinely
    // couldn't produce a result (selection is null below).
    if (
      selection &&
      planningRequest.model &&
      planningRequest.model !== 'auto' &&
      planningRequest.model !== selection.model.id &&
      planningRequest.model !== selection.model.name
    ) {
      selection = (await strategy.planStreaming(planningRequest, context)) ?? selection;
    }
    if (!selection) {
      selection = await strategy.planStreaming(planningRequest, context);
    }
    if (!selection) {
      throw new Error('No suitable streaming-capable model available');
    }

    // Ensure downstream consumers know which model to execute
    planningRequest.model = selection.model.id;

    const enrichedContext: OrchestrationContext = {
      ...context,
      triage: triageDecision,
    };

    return {
      // Review fix: this SSE single-model path never attached
      // triage-recommended tools — same wrapper as the other paths
      // (no-op when the client already supplied its own tools).
      request: this.applyRecommendedTools(planningRequest, enrichedContext),
      model: selection.model,
      adapter: selection.adapter,
      context: enrichedContext,
      triage: triageDecision,
    };
  }

  /**
   * Streaming execution for collective strategies (debate, consensus, quality-multipass).
   *
   * Phase 1: multi-model rounds run non-streaming and yield SSE progress events.
   * Phase 2: synthesis LLM call streams token-by-token.
   *
   * For strategies that don't support streaming, falls back to non-streaming execute()
   * and yields the complete response as a single chunk.
   */
  async *executeStream(
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const requestId = nanoid();

    // Latency (audited 2026-07-12): buildContext()/triage/memory-search can
    // take ~2.5-5s+ cold before ANY strategy gets to run, let alone yield —
    // the client sees dead silence that whole time regardless of which
    // strategy eventually runs. Nothing is awaited before this yield, so an
    // async generator's body only starts on the caller's first `.next()`
    // (the `for await` in chat-routes.ts/responses-routes.ts) — this chunk
    // reaches the client in the same tick, before buildContext even starts.
    // Metadata-only (empty delta.content), same shape as observerChunk(), so
    // narration-aware clients render it as an "acknowledged" bubble and
    // naive OpenAI-compat clients that only concatenate delta.content see
    // nothing extra.
    yield {
      id: `obs-instant-${requestId}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: 'observer',
      choices: [{
        index: 0,
        delta: { role: 'assistant' as const, content: '' },
        finish_reason: null,
        logprobs: null,
      }],
      ailin_metadata: {
        type: 'observer',
        event: 'request_received',
        narration: 'Your request has been received — analyzing it now.',
        observer_duration_ms: 0,
      },
    } as ChatResponse;

    // Latency: kick off the memory-context lookup (embedding + pgvector)
    // CONCURRENTLY with buildContext() instead of serially after it.
    // Before this fix, executeStream() never set context.memoryEnriched,
    // so strategy.enrichWithMemories() (called below, right before
    // strategy.executeStream()) unconditionally repeated the FULL
    // embedding + pgvector search AFTER buildContext/triage had already
    // run — an extra sequential network+DB round trip blocking every
    // strategy's first real yield. Mirrors the memoryContextPromise
    // pattern already used in execute() (LAT-2), adapted for the
    // streaming path (which has no semantic-cache step to pair it with,
    // so it's raced directly against buildContext instead).
    type MemoryContextResult = Awaited<ReturnType<ReturnType<typeof getMemoryContextService>['buildContext']>>;
    const memoryContextPromise: Promise<MemoryContextResult | null> =
      process.env.MEMORY_CONTEXT_ENABLED !== 'false'
        ? getMemoryContextService()
            .buildContext(request, organizationId, userId, { maxMemories: 5, minSimilarity: 0.7 })
            .catch((memoryError: unknown) => {
              this.log.warn(
                { error: getErrorMessage(memoryError) },
                'Failed to enrich request with memory context (stream)'
              );
              return null;
            })
        : Promise.resolve(null);

    const context = await this.buildContext(request, organizationId, userId, requestId);

    // Speculative parallel selection (2026-07-14, kill-switch
    // ORCHESTRATION_SPECULATIVE_SELECTION — default OFF until validated in
    // canary): unlike createStreamingPlan(), the strategy CLASS here really
    // does depend on triage.recommendedStrategy, so this only speculates on
    // the single-model case (the dominant one for auto requests without
    // media/tools) — a collective recommendation simply discards it below at
    // zero cost (planStreaming() never invokes a provider).
    const speculationEnabled = process.env.ORCHESTRATION_SPECULATIVE_SELECTION === 'true';
    const singleStrategyCandidate = speculationEnabled ? this.strategies.get('single') : undefined;
    const singleStrategyForSpeculation =
      singleStrategyCandidate instanceof SingleModelStrategy ? singleStrategyCandidate : undefined;
    if (singleStrategyForSpeculation) this.injectProviderRegistry(singleStrategyForSpeculation);
    const speculativeSelectionPromise =
      singleStrategyForSpeculation
        ? this.resolveSpeculativeSingleSelection(singleStrategyForSpeculation, request, context, requestId)
        : Promise.resolve(null);

    const streamMemoryContext = await memoryContextPromise;
    let memRequestFromMemory = request;
    if (streamMemoryContext?.hasContext) {
      memRequestFromMemory = getMemoryContextService().enrichRequest(request, streamMemoryContext);
      context.memoryEnriched = true;
    }

    let triageDecision = context.triage;
    const autoStrategyRequested = !request.strategy || request.strategy === 'auto';
    const shouldRunTriage = this.shouldRunTriage(request, context);

    if (this.triageService && autoStrategyRequested && shouldRunTriage) {
      try {
        triageDecision = await this.triageService.triage(request, context, context.capabilityInference, context.models);
        if (triageDecision) {
          triageDecision = this.applyTriageRoute(triageDecision, request);
        }
      } catch (err) {
        this.log.warn({ error: getErrorMessage(err), requestId }, 'Triage failed in executeStream');
      }
    }

    const enrichedContext: OrchestrationContext = {
      ...context,
      triage: triageDecision,
      taskType: triageDecision
        ? this.applyTriageTaskType(request, context.taskType, triageDecision)
        : context.taskType,
    };

    if (triageDecision) {
      await this.applyPreferredModels(request, enrichedContext, triageDecision);
    }

    const { strategy } = this.selectStrategy(request, enrichedContext);
    this.injectProviderRegistry(strategy);

    // Reconciliation: reuse the speculative pick only when the FINAL strategy
    // choice landed on the same 'single' instance we speculated with — any
    // other strategy (a collective) discards it below at zero execution
    // cost. Metric records the outcome so real production traffic can
    // confirm the assumed reuse rate before enabling this broadly.
    if (speculationEnabled && strategy === singleStrategyForSpeculation) {
      const speculative = await speculativeSelectionPromise;
      if (speculative) {
        let finalSelection = speculative;
        let outcome: 'reused' | 'repinned' = 'reused';
        if (
          request.model &&
          request.model !== 'auto' &&
          request.model !== speculative.model.id &&
          request.model !== speculative.model.name
        ) {
          // applyPreferredModels() pinned a different model than the
          // speculative call resolved — re-derive, but request.model is now
          // concrete so this hits selectBestModel()'s cheap exact-match path,
          // not another full DynamicModelSelector pass.
          const repinned = await singleStrategyForSpeculation.planStreaming(request, enrichedContext);
          if (repinned) {
            finalSelection = repinned;
            outcome = 'repinned';
          }
        }
        enrichedContext.precomputedModelSelection = finalSelection;
        recordSpeculativeSelectionOutcome(outcome);
      } else {
        recordSpeculativeSelectionOutcome('discarded_error');
      }
    } else if (speculationEnabled && singleStrategyForSpeculation) {
      recordSpeculativeSelectionOutcome('discarded_collective');
    }

    // ── Observer wiring (streaming path) ──
    // The engine's execute() path wires the observer, but executeStream() did
    // NOT — so collective streaming (chat-routes collective branch) silently
    // dropped every narration (getObserverFeed() returned the no-op). Wire it
    // here too. Narration is default-ON for collective (multi-model) streaming
    // only — the single-model streaming fallback has nothing to narrate, so we
    // gate on minModels>1 (same signal as context.isCollectiveStrategy). Degrades
    // to a silent no-op when no backend resolves. OBSERVER_DEFAULT_ENABLED=false
    // is the global kill-switch; enable_observer:false is the per-request opt-out.
    const streamObserverEnabled =
      process.env.OBSERVER_DEFAULT_ENABLED !== 'false' &&
      request.ailin_constraints?.enable_observer !== false;
    // Opt-in "inline process header": promote the first narration to the main
    // channel so naive OpenAI clients get visible opening tokens in ~4s instead of
    // ~30-52s of silence. DEFAULT OFF — it puts a process preamble inside the answer,
    // clean for the API by default; interactive clients (the ailin app) opt in.
    const inlineNarration =
      process.env.COLLECTIVE_INLINE_NARRATION === 'true' ||
      request.ailin_constraints?.inline_narration === true;
    let streamObserverFeed = createNoOpObserverFeed();
    if (streamObserverEnabled && (strategy.getMetadata().minModels ?? 1) > 1) {
      const observer = new ObserverService(
        { enabled: true, language: ObserverService.extractUserSample(request.messages) },
        strategy.getMetadata().name,
      );
      if (observer.isActive()) {
        streamObserverFeed = observer;
        // Universal "setup" narration — fired the moment the collective is assembled,
        // BEFORE the strategy starts its phases, so the FIRST narration reports the
        // earlier pipeline (request analyzed → routed to this collective → models
        // selected) instead of the client waiting through selection in silence. The
        // interleaver below delivers it as soon as it's generated. Applies to EVERY
        // collective strategy, not just debate.
        streamObserverFeed.emit({
          type: 'phase_start',
          timestamp: Date.now(),
          strategy: strategy.getMetadata().name,
          models: [],
          // Describe the routing qualitatively. Do NOT surface the raw candidate-pool
          // size here (it is the whole eligible catalog — tens of thousands — not the
          // handful the collective will actually use, so narrating it misleads the user
          // and the narrator sometimes echoes the giant number literally). The real
          // participant count is reported by the strategy's own phase_start moments later.
          summary:
            `Your request has been analyzed and routed to the "${strategy.getMetadata().name}" collective, ` +
            `where several specialized AI models will now work on it together.`,
        });
      }
    }
    (enrichedContext as { observerFeed?: typeof streamObserverFeed }).observerFeed = streamObserverFeed;

    // NOTE: see the analogous comment in execute() — cross-modal capability
    // access comes from `enrichedContext.invoker` (request-scoped, built in
    // buildContext()). The old `strategy.capabilityInvoker` write here mutated
    // the shared strategy singleton per-request, which is racy under
    // concurrent load and was never read by any strategy; removed.

    // Memory enrichment for streaming path
    // C3 P0.2: Skip when memory is ablated. When the concurrent
    // memoryContextPromise above already resolved the search (memoryEnriched
    // is true), use its result directly — strategy.enrichWithMemories() would
    // just early-return the RAW `request` param in that case (it only skips
    // re-querying, it does not carry the merged content), so calling it here
    // would silently drop the memory block that was already fetched.
    const memRequest = this.applyRecommendedTools(
      enrichedContext.ablationFlags?.disabled?.has('memory')
        ? request
        : enrichedContext.memoryEnriched
          ? memRequestFromMemory
          : await strategy.enrichWithMemories(request, enrichedContext),
      enrichedContext,
    );

    // Leader removed — strategies call executeModel() directly

    if (strategy.supportsStreaming()) {
      // UNIVERSAL narration interleave: stream observer narrations AS THEY BECOME
      // READY while the strategy is internally awaiting a phase, for EVERY
      // collective strategy — not just the ones that hand-wired drainWhile(). Any
      // strategy that emits observer events now gets continuous narration instead
      // of a boundary burst. Off-channel; no-op when the observer is inactive.
      yield* this.interleaveNarration(
        strategy.executeStream(memRequest, enrichedContext),
        streamObserverFeed,
        undefined,
        inlineNarration,
      );
    } else {
      // Non-streaming strategy (e.g. consensus — its executeStream is disabled
      // because token streaming would bypass the voting/aggregation). It returns
      // the whole answer at the end, but it DOES emit observer events while it runs.
      // Interleave those narrations while execute() is in flight so the client sees
      // the process live instead of sitting in silence for the whole computation,
      // then yield the final answer. Makes narration UNIVERSAL across streaming AND
      // non-streaming collectives.
      const execPromise = strategy.execute(memRequest, enrichedContext);
      yield* this.interleaveNarration(
        // Driver generator: it awaits the strategy to completion so
        // interleaveNarration can race it against the narration feed, but it
        // intentionally yields NOTHING (the final answer comes from execPromise
        // below). A yield-less async generator is the point here.
        // eslint-disable-next-line require-yield
        (async function* (): AsyncGenerator<ChatResponse, void, unknown> {
          await execPromise;
        })(),
        streamObserverFeed,
        undefined,
        inlineNarration,
      );
      const result = await execPromise;
      strategy.recordExecution(enrichedContext, result).catch(() => {});
      yield result.finalResponse;
    }
  }

  /**
   * Interleave ready observer narrations with a strategy's streamed chunks.
   *
   * The strategy generator is silent while it `await`s a phase internally (it
   * yields nothing until the phase completes). During that gap a narration often
   * finishes generating (~7-9s local-narrator latency) but, without this, would
   * not reach the client until the strategy's NEXT yield — after the whole ~25s
   * phase (measured: 27s of silence in a debate). Here we race the strategy's next
   * chunk against a short poll tick; on each tick we drain and yield whatever
   * narration is ready, so the client sees continuous narration DURING the phase.
   *
   * Universal (works for any collective strategy's executeStream) and off-channel
   * (observer chunks carry empty delta.content). Degrades to a plain pass-through
   * with zero polling when the observer is inactive.
   */
  private async *interleaveNarration(
    strategyStream: AsyncGenerator<ChatResponse, void, unknown>,
    feed: ObserverFeed,
    pollMs = 400,
    inlineFirstNarration = false,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    if (!feed.isActive()) {
      yield* strategyStream;
      return;
    }

    // Opt-in "inline process header": promote the FIRST narration to the main channel
    // (delta.content) so naive OpenAI clients see visible tokens in ~4s instead of the
    // ~30-52s silence before the synthesis. Only the first — the rest stay off-channel
    // so the answer isn't flooded with process prose. Claimed once here.
    let firstInlineEmitted = false;
    const emitNarration = (n: ObserverNarration): ChatResponse => {
      if (inlineFirstNarration && !firstInlineEmitted) {
        firstInlineEmitted = true;
        return buildInlineNarrationChunk(n);
      }
      return buildObserverChunk(n);
    };
    // The FIRST narrations are usually drained INSIDE the strategy (drainObserverChunks /
    // drainWhile) and reach us as already-built off-channel observer chunks in the
    // strategy stream — NOT via feed.drainReadyNarrations() here. So the earliest
    // narration to promote is whichever observer chunk flows through first, from either
    // source. This promotes the first such strategy chunk in place (empty delta.content →
    // narration text), sharing the same one-shot claim as emitNarration.
    const maybeInlineChunk = (chunk: ChatResponse): ChatResponse => {
      if (!inlineFirstNarration || firstInlineEmitted) return chunk;
      const meta = chunk.ailin_metadata as { type?: string; narration?: string } | undefined;
      if (meta?.type === 'observer' && meta.narration) {
        firstInlineEmitted = true;
        const c0 = chunk.choices?.[0];
        return {
          ...chunk,
          choices: [{ ...c0, delta: { ...c0?.delta, content: `${meta.narration}\n\n` } }],
          ailin_metadata: { ...meta, type: 'observer_inline' },
        } as ChatResponse;
      }
      return chunk;
    };

    const iterator = strategyStream[Symbol.asyncIterator]();
    // Keep ONE in-flight next() at a time; re-race the SAME pending promise on
    // each tick (calling next() again before it resolves would be a bug).
    let pending = iterator.next();
    // Heartbeat: if the narrator goes silent for a long stretch (a phase where the
    // models are just generating — a single LLM call has no sub-events to narrate),
    // nudge it with a generic "still working" event so the client isn't left in
    // silence mid-flight. Sparse (default 12s) to avoid loading the local narrator.
    const heartbeatMs = Number(process.env.OBSERVER_HEARTBEAT_MS ?? 12000);
    let lastNarrationAt = Date.now();
    let lastHeartbeatAt = Date.now();
    for (;;) {
      let delivered = false;
      for (const n of feed.drainReadyNarrations()) {
        yield emitNarration(n);
        delivered = true;
      }
      const now = Date.now();
      if (delivered) lastNarrationAt = now;
      if (
        heartbeatMs > 0 &&
        now - lastNarrationAt > heartbeatMs &&
        now - lastHeartbeatAt > heartbeatMs
      ) {
        feed.emit({
          type: 'phase_start',
          timestamp: now,
          strategy: '',
          summary: 'The collective is still working on your answer — the analysts are reasoning through it.',
        });
        lastHeartbeatAt = now;
      }
      const raced = await Promise.race([
        pending.then(
          (r) => ({ tag: 'chunk' as const, r }),
          // Type the rejection as `unknown` (not the default `any`) so folding it
          // into the object is not an unsafe assignment; it is only re-thrown below.
          (e: unknown) => ({ tag: 'error' as const, e }),
        ),
        new Promise<{ tag: 'tick' }>((resolve) => setTimeout(() => resolve({ tag: 'tick' }), pollMs)),
      ]);

      if (raced.tag === 'tick') {
        continue; // strategy still working — loop, drain narrations, re-race
      }
      if (raced.tag === 'error') {
        throw raced.e;
      }
      if (raced.r.done) {
        for (const n of feed.drainReadyNarrations()) {
          yield emitNarration(n);
        }
        return;
      }
      // The strategy's own chunk (answer / progress / narration). If it's the first
      // observer narration and inline is opt-in, promote it to the main channel.
      yield maybeInlineChunk(raced.r.value);
      pending = iterator.next();
    }
  }

  /**
   * Estimate request complexity
   */
  private estimateComplexity(request: ChatRequest): string {
    const lastMessage = request.messages[request.messages.length - 1];
    const content =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content || '');

    const wordCount = content.split(/\s+/).length;

    // Has tools = more complex
    const hasTools = request.tools && request.tools.length > 0;

    if (wordCount > 100 || hasTools || /architecture|refactor|design|system/i.test(content)) {
      return 'complex';
    } else if (wordCount > 30 || /analyze|review|improve/i.test(content)) {
      return 'moderate';
    }
    return 'simple';
  }

  /**
   * Estimate context size
   */
  private estimateContextSize(messagesOrRequest: ChatMessage[] | ChatRequest): number {
    // Handle both messages array and ChatRequest
    const messages = Array.isArray(messagesOrRequest)
      ? messagesOrRequest
      : messagesOrRequest.messages || [];

    // Rough estimate: 4 chars per token
    const totalChars = messages.reduce((sum: number, msg: ChatMessage) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return sum + content.length;
    }, 0);

    return Math.floor(totalChars / 4); // Approximate token count
  }

  /**
   * Register a strategy
   */
  private registerStrategy(strategy: BaseStrategy): void {
    const metadata = strategy.getMetadata();
    this.strategies.set(metadata.name, strategy);
    this.log.debug({ strategy: metadata.name }, 'Strategy registered');
  }

  /**
   * Speculative model selection (2026-07-14): runs `SingleModelStrategy`'s
   * pool resolution CONCURRENTLY with the triage LLM call instead of after
   * it. Safe because it never invokes a provider — only resolves
   * `{model, adapter}` metadata (DynamicModelSelector queries + scoring),
   * the same work `planStreaming()` always did, just started earlier.
   *
   * Takes a SHALLOW CLONE of `request` (`{ ...request }`) so this call can
   * never observe `applyPreferredModels()`/`applyTriageRoute()` mutating the
   * REAL request in place while triage is still resolving — that in-place
   * mutation is the only genuine race in this parallelization, and cloning
   * the object passed here removes it entirely (the two calls simply read
   * from different objects).
   *
   * Failure here is non-fatal — the caller always has a serial fallback
   * (re-running `strategy.planStreaming()` after triage resolves), so this
   * only ever narrows latency, never correctness.
   */
  private async resolveSpeculativeSingleSelection(
    strategy: SingleModelStrategy,
    request: ChatRequest,
    context: OrchestrationContext,
    requestId: string,
  ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    try {
      return await strategy.planStreaming({ ...request }, context);
    } catch (err) {
      this.log.debug(
        { error: getErrorMessage(err), requestId },
        'Speculative selection failed — falling back to serial path'
      );
      return null;
    }
  }

  /**
   * Consume `TriageDecision.route`: for `direct_response` (trivial social
   * messages — greetings, thanks, small talk with no real task), short-circuit
   * to a single-model answer instead of building/running a multi-stage plan.
   *
   * A client-explicit `request.tools` or `quality_target>=0.9` ALWAYS wins
   * over `route` regardless of how trivial the message looks — confirmed
   * operator decision: never silently override explicit client intent.
   */
  private applyTriageRoute(triage: TriageDecision, request: ChatRequest): TriageDecision {
    if (triage.route !== 'direct_response') return triage;

    // Review fix: a low-confidence triage must not dictate the fast path.
    // The execute() path clears `route` at its confidence gate, but the two
    // streaming call-sites have no gate (pre-existing asymmetry) — enforcing
    // the same threshold here covers all three uniformly.
    const MIN_TRIAGE_CONFIDENCE = Number(process.env.MIN_TRIAGE_CONFIDENCE ?? 0.4);
    if ((triage.confidence ?? 0) < MIN_TRIAGE_CONFIDENCE) return triage;

    const clientWantsTools = Array.isArray(request.tools) && request.tools.length > 0;
    const clientWantsHighQuality =
      typeof request.quality_target === 'number' && request.quality_target >= 0.9;
    if (clientWantsTools || clientWantsHighQuality) return triage;

    return { ...triage, recommendedStrategy: 'single', executionPlan: undefined };
  }

  /**
   * Consume `TriageExecutionPlan.recommendedTools`: populate `request.tools`
   * when the client didn't already supply its own — client-supplied tools
   * always win, never overridden. Resolves names against the same
   * strategy-safe tool catalog the triage prompt was shown
   * (`toolRegistry.listStrategyTools()` / `describeStrategyToolsForPrompt()`).
   *
   * Parameter JSON Schema is precise for the 8 curated highest-value tools
   * (`TRIAGE_RECOMMENDABLE_TOOL_SCHEMAS`) and a generic permissive stopgap
   * for anything else — though after the security-review allowlist
   * (TRIAGE_RECOMMENDABLE_TOOLS: web_search/code_execute/analyze_image, all
   * with precise schemas) the generic schema is a defensive dead branch.
   */
  private applyRecommendedTools(request: ChatRequest, context: OrchestrationContext): ChatRequest {
    if (Array.isArray(request.tools) && request.tools.length > 0) return request;
    const recommended = context.triage?.executionPlan?.recommendedTools;
    if (!recommended?.length) return request;

    // Security review fix (defense-in-depth): even though the triage prompt
    // only shows the TRIAGE_RECOMMENDABLE_TOOLS allowlist, enforce it here
    // too — a hallucinated/manipulated recommendation must never auto-attach
    // a server-filesystem tool (read_file, write_file, grep_search, ...) to
    // a request whose client never asked for tools.
    const safeNames = new Set(
      toolRegistry.listStrategyTools()
        .map((t) => t.name)
        .filter((name) => TRIAGE_RECOMMENDABLE_TOOLS.has(name)),
    );
    const tools: Tool[] = [];
    for (const name of recommended) {
      if (!safeNames.has(name)) continue;
      const reg = toolRegistry.get(name);
      if (!reg) continue;
      tools.push({
        type: 'function',
        function: {
          name: reg.name,
          description: reg.description,
          parameters: TRIAGE_RECOMMENDABLE_TOOL_SCHEMAS[reg.name] ?? GENERIC_TOOL_PARAM_SCHEMA,
        },
      });
    }
    if (tools.length === 0) return request;
    return { ...request, tools };
  }

  private applyTriageTaskType(
    request: ChatRequest,
    detected: TaskType,
    triage?: TriageDecision
  ): TaskType {
    if (!triage) {
      return detected;
    }

    if (!request.task_type && this.isTaskType(triage.intent)) {
      request.task_type = triage.intent;
      return triage.intent;
    }

    if (this.isTaskType(triage.intent)) {
      return triage.intent;
    }
    return detected;
  }

  private isTaskType(intent: string | undefined): intent is TaskType {
    if (!intent) return false;
    const allowed: TaskType[] = [
      'code-generation',
      'code-review',
      'debugging',
      'refactoring',
      'documentation',
      'testing',
      'analysis',
      'qa',
      'general',
    ];
    return allowed.includes(intent as TaskType);
  }

  private async applyPreferredModels(
    request: ChatRequest,
    context: OrchestrationContext,
    triage?: TriageDecision
  ): Promise<void> {
    if (request.model && request.model !== 'auto') {
      return;
    }

    const candidates = [...(triage?.recommendedModels ?? []), ...(context.preferredModelIds ?? [])];

    // Enrich with knowledge graph: if triage identified a task type,
    // query the graph for historically best-performing models.
    if (candidates.length === 0 && context.taskType) {
      try {
        const kgModels = await knowledgeGraphService.getBestModelsForTask(context.taskType, 3);
        for (const kgModel of kgModels) {
          candidates.push(kgModel.modelId);
        }
      } catch {
        // Non-fatal — knowledge graph is optional enrichment
      }
    }

    if (candidates.length === 0) {
      return;
    }

    const available = new Set(context.models.map((model) => model.name));
    const availableById = new Set(context.models.map((model) => model.id));
    const selected = candidates.find(
      (candidate) => available.has(candidate) || availableById.has(candidate)
    );

    if (selected) {
      request.model = selected;
      this.log.debug(
        {
          requestId: context.requestId,
          model: selected,
          source: triage?.recommendedModels?.includes(selected)
            ? 'triage'
            : candidates.indexOf(selected) >= (triage?.recommendedModels?.length ?? 0)
              ? 'knowledge-graph'
              : 'heuristic',
        },
        'Model selected via triage/knowledge-graph hints'
      );
    }
  }

  /**
   * Extract a task summary from the request for memory storage
   */
  private extractTaskSummary(request: ChatRequest): string {
    // Get the last user message as task summary
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const message = request.messages[i];
      if (message.role === 'user') {
        const content =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && 'text' in p)
                  .map((p) => p.text)
                  .join(' ')
              : '';
        // Limit to first 200 characters
        return content.slice(0, 200);
      }
    }
    return 'Unknown task';
  }

  /**
   * Build orchestration context
   */
  private async buildContext(
    request: ChatRequest,
    organizationId: string,
    userId: string | undefined,
    requestId: string
  ): Promise<OrchestrationContext> {
    // Latency (audited 2026-07-11/12): this function used to have 8 serial
    // `await import(...)` calls scattered through its body — each one a
    // separate microtask hop, and on a cold process (module not yet in
    // Node's ESM cache) a real module-resolution cost. Firing all 8
    // concurrently here removes that entire tail from every request's
    // critical path. Each promise is awaited individually at its original
    // use site below — control flow, try/catch scoping, and error handling
    // are all unchanged; only WHEN the `import()` call itself fires moves
    // earlier.
    const chatRequestExtendedImport = import('@/types/chat-request-extended.js');
    const modelCatalogServiceImport = import('@/services/model-catalog-service');
    const centralModelDiscoveryImport = import('@/services/central-model-discovery-service');
    const capabilityInvokerImport = import('./capability-invoker.js');
    const answerCheckResolverImport = import('./verification/answer-check-resolver.js');
    const audioOrchestrationImport = import('@/services/audio-orchestration-service.js');
    const translationServiceImport = import('@/services/translation-service.js');
    const videoOrchestrationImport = import('@/services/video-orchestration-service.js');
    const imagesOrchestrationImport = import('@/services/images-orchestration-service.js');
    const fileGenerationServiceImport = import('@/services/file-generation-service.js');

    // ✅ FIX: Check if model was explicitly specified by user
    // Use type-safe helper instead of type casting
    const { getUserSpecifiedModelFlag, getTaskType: _getTaskType } = await chatRequestExtendedImport;
    const userSpecifiedModel = getUserSpecifiedModelFlag(request);

    // Caminho-C Q2 closure: capture the user-specified model BEFORE we
    // delete it from the request object. Strategies (HybridStrategy.
    // selectModels and friends) ignore `request.model` when picking
    // analyzer/executors — they look at `context.preferredModelIds[0]`
    // as the strong hint. Without this capture, the only place the
    // user's choice survives is the literal string on `request`, which
    // strategies then promptly ignore: silent model substitution.
    let preferredModelFromRequest: string | undefined;
    if (userSpecifiedModel && request.model && request.model !== 'auto') {
      preferredModelFromRequest = request.model;
    }

    // ✅ FIX: If model is 'auto' or not user-specified, enable dynamic selection
    // This ensures API always considers ALL available models for intelligent selection
    if (!userSpecifiedModel || request.model === 'auto') {
      if (request.model === 'auto') {
        this.log.debug(
          {
            requestId,
            originalModel: request.model,
            reason: 'Model set to auto - delegating to API for intelligent selection',
          },
          'Auto model selection requested - enabling dynamic selection'
        );
      } else if (!userSpecifiedModel && request.model) {
        this.log.debug(
          {
            requestId,
            originalModel: request.model,
            reason: 'Model not user-specified, delegating to API for intelligent selection',
          },
          'Removing model from request to enable dynamic selection from all available models'
        );
      }

      // Remove model to force delegation to DynamicModelSelector.
      // The destructured `model` is intentionally discarded — we don't use the
      // pre-existing value, we just need the rest object. Prefix `_` marks
      // intent (consumed-by-rest-spread, intentionally not bound to a name).
      if ('model' in request && request.model !== undefined) {
        const { model: _model, ...requestWithoutModel } = request;
        Object.assign(request, requestWithoutModel);
        delete (request as { model?: string }).model;
      }
    }

    // Get chat-eligible models (Bloco D hardening: excludes non-chat, self-hosted, etc.)
    // Falls back to full catalog if the chat-eligible filter fails.
    let allModels: import('@/types').Model[];
    try {
      const { getChatEligibleModels } = await modelCatalogServiceImport;
      // Let a pinned self-hosted model (e.g. an Ollama own-model arm) through
      // the self-hosted exclusion — otherwise it's invisible to
      // SingleModelStrategy's exact-match lookup and the request silently
      // falls through to DynamicModelSelector, which substitutes an
      // unrelated external model. Auto-routing (no pin) is unaffected.
      allModels = await getChatEligibleModels({
        allowSelfHostedModelIds: preferredModelFromRequest ? [preferredModelFromRequest] : undefined,
      });
    } catch {
      allModels = await this.providerRegistry.getAllModels();
    }

    // Filter to operational models only.
    // Capability-based selection is necessary but not sufficient for execution:
    // a model still needs a resolvable runtime adapter/credentials.
    const availableProviderNames = this.providerRegistry.getProviderNames();

    // Log registry state for debugging
    const registryType = this.providerRegistry.constructor.name;
    const registryEntries = this.providerRegistry.getAll?.();
    const providerCount = Array.isArray(registryEntries)
      ? registryEntries.length
      : availableProviderNames.length;

    this.log.info(
      {
        requestId,
        availableProviderNames,
        availableProviderCount: availableProviderNames.length,
        totalAllModels: allModels.length,
        registryType,
        registryCount: providerCount,
        registryInstance: this.providerRegistry ? 'exists' : 'null',
      },
      'Filtering models by runtime operability (chat-eligible pool)'
    );

    const providerFilteredModels = allModels.filter((model) => {
      const operability = this.providerRegistry.getModelOperability(model);
      const isOperational = operability.runnable;
      if (!isOperational) {
        this.log.debug(
          {
            modelId: model.id,
            modelName: model.name,
            provider: model.provider,
            originProvider: operability.originProvider,
            executionProvider: operability.executionProvider,
            fallbackChain: operability.fallbackChain,
            nonOperationalReasons: operability.nonOperationalReasons,
          },
          'Model filtered out: not operational for runtime execution'
        );
      }
      return isOperational;
    });

    // ── Model pool: NO pre-filtering by modality ──────────────────────
    // The full model pool (all operational models) is passed to the context.
    // Capability-based filtering happens LATER in the pipeline:
    //   1. Triage LLM analyzes the request and sets requiredCapabilities
    //   2. DynamicModelSelector.findModelsByRequirements() applies the chat-generation
    //      guard conditionally — skipping it when non-text capabilities are required
    //   3. Strategies use context.requiredCapabilities to find matching models
    //
    // Pre-filtering here was the root cause of multimodal routing failure:
    // it purged image/audio/video models BEFORE triage could detect they were needed.
    const models = providerFilteredModels;

    // Balance-aware model selection: no global provider exclusion.
    // Models get balanceStatus from discovery and selection soft-scores them.
    let constrainedModels = models;

    const runtimeConstraints = request.ailin_constraints;
    if (runtimeConstraints) {
      const requiredCapabilities =
        runtimeConstraints.requiredCapabilities && runtimeConstraints.requiredCapabilities.length > 0
          ? Array.from(new Set(runtimeConstraints.requiredCapabilities))
          : undefined;
      const preferredProviders =
        runtimeConstraints.preferredProviders && runtimeConstraints.preferredProviders.length > 0
          ? Array.from(
              new Set(runtimeConstraints.preferredProviders.map((entry) => entry.toLowerCase()))
            )
          : undefined;
      const excludedProviders =
        runtimeConstraints.excludedProviders && runtimeConstraints.excludedProviders.length > 0
          ? Array.from(
              new Set(runtimeConstraints.excludedProviders.map((entry) => entry.toLowerCase()))
            )
          : undefined;
      const requiredEndpoint =
        typeof runtimeConstraints.requiredEndpoint === 'string' &&
        runtimeConstraints.requiredEndpoint.trim().length > 0
          ? runtimeConstraints.requiredEndpoint.trim().toLowerCase()
          : undefined;

      if (preferredProviders && preferredProviders.length > 0) {
        constrainedModels = constrainedModels.filter((model) =>
          preferredProviders.includes((model.provider || '').toLowerCase())
        );
      }

      if (excludedProviders && excludedProviders.length > 0) {
        constrainedModels = constrainedModels.filter(
          (model) => !excludedProviders.includes((model.provider || '').toLowerCase())
        );
      }

      if (requiredCapabilities && requiredCapabilities.length > 0) {
        constrainedModels = constrainedModels.filter((model) =>
          requiredCapabilities.every((capability) => model.capabilities.includes(capability))
        );
      }

      if (
        typeof runtimeConstraints.minContextWindow === 'number' &&
        Number.isFinite(runtimeConstraints.minContextWindow) &&
        runtimeConstraints.minContextWindow > 0
      ) {
        constrainedModels = constrainedModels.filter(
          (model) => model.contextWindow >= runtimeConstraints.minContextWindow!
        );
      }

      if (
        typeof runtimeConstraints.maxInputCostPer1k === 'number' &&
        Number.isFinite(runtimeConstraints.maxInputCostPer1k)
      ) {
        constrainedModels = constrainedModels.filter(
          (model) => model.inputCostPer1k <= runtimeConstraints.maxInputCostPer1k!
        );
      }

      if (
        typeof runtimeConstraints.maxOutputCostPer1k === 'number' &&
        Number.isFinite(runtimeConstraints.maxOutputCostPer1k)
      ) {
        constrainedModels = constrainedModels.filter(
          (model) => model.outputCostPer1k <= runtimeConstraints.maxOutputCostPer1k!
        );
      }

      if (
        typeof runtimeConstraints.maxAverageCostPer1k === 'number' &&
        Number.isFinite(runtimeConstraints.maxAverageCostPer1k)
      ) {
        constrainedModels = constrainedModels.filter((model) => {
          const average = (model.inputCostPer1k + model.outputCostPer1k) / 2;
          return average <= runtimeConstraints.maxAverageCostPer1k!;
        });
      }

      if (requiredEndpoint) {
        constrainedModels = constrainedModels.filter((model) => {
          const metadata =
            model.metadata && typeof model.metadata === 'object'
              ? (model.metadata as Record<string, unknown>)
              : {};
          const endpoint =
            typeof metadata.endpoint === 'string' ? metadata.endpoint.toLowerCase() : undefined;
          if (endpoint && endpoint === requiredEndpoint) {
            return true;
          }
          const supportedEndpoints = Array.isArray(metadata.supportedEndpoints)
            ? metadata.supportedEndpoints
                .filter((entry): entry is string => typeof entry === 'string')
                .map((entry) => entry.toLowerCase())
            : [];
          return supportedEndpoints.includes(requiredEndpoint);
        });
      }

      this.log.info(
        {
          requestId,
          alias: request.ailin_alias,
          beforeCount: models.length,
          afterCount: constrainedModels.length,
          constraints: runtimeConstraints,
        },
        'Applied Ailin runtime constraints from virtual alias/profile'
      );

      if (constrainedModels.length === 0) {
        const aliasLabel = request.ailin_alias || 'requested profile';
        throw Object.assign(
          new Error(`No operational models matched runtime constraints for ${aliasLabel}.`),
          {
            statusCode: 400,
            code: 'alias_constraints_no_models',
          }
        );
      }
    }

    // Enrich all models with balance status from discovery (for balance-aware selection)
    try {
      const { getCentralModelDiscoveryService } = await centralModelDiscoveryImport;
      const discovery = await getCentralModelDiscoveryService();
      discovery.enrichModelsWithBalanceStatus(constrainedModels);
    } catch { /* non-critical */ }

    // ✅ VALIDATION: Log model count and verify we have expected models
    const modelsByProvider = this.groupModelsByProvider(constrainedModels);
    this.log.info(
      {
        requestId,
        totalModels: constrainedModels.length,
        modelsByProvider,
        userSpecifiedModel,
        modelInRequest: !!(request.model),
      },
      'Context built with all available models for orchestration'
    );

    // ✅ VALIDATION: Warn if fewer models than expected (should be 500+)
    if (constrainedModels.length < 100) {
      this.log.warn(
        {
          requestId,
          totalModels: constrainedModels.length,
          expected: '500+',
          modelsByProvider,
        },
        'WARNING: Fewer models than expected loaded. Check model discovery service.'
      );
    }

    // ── Layer 3: Semantic heuristic inference (local, <1ms) ──────────────
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    const capabilityInference = inferCapabilities(messages, {
      tools: request.tools,
      max_tokens: request.max_tokens,
    });

    // Map inference results to orchestration parameters
    const inferredTaskType = this.mapInferredTaskType(capabilityInference.taskType);
    const inferredCapabilities = this.mapInferredCapabilities(capabilityInference);
    const inferredPreferSpeed = capabilityInference.complexity === 'simple'
      && capabilityInference.costSensitivity === 'high'
      && capabilityInference.contextNeeds === 'short';

    // ── Cascade: client-explicit (Layer 1) > inference (Layer 3) ──────
    // Layer 2 (triage LLM) is applied later after triage runs
    const taskType = request.task_type || inferredTaskType;
    const contextSize = this.estimateContextSize(request);
    const maxCost = typeof request.max_cost === 'number' ? request.max_cost : undefined;
    const preferSpeed = request.prefer_speed ?? inferredPreferSpeed;
    const qualityTarget = request.quality_target; // Will be enriched by triage Layer 2
    const requiredCapabilities = runtimeConstraints?.requiredCapabilities?.length
      ? runtimeConstraints.requiredCapabilities
      : inferredCapabilities;

    // Enrich models with empirical performance data from ModelPerformanceTracker.
    const enrichedModels = constrainedModels.map((m) => modelPerformanceTracker.applyToModel(m));

    // ── Build CapabilityInvoker for cross-modal strategy access ─────────
    // Strategies receive this in context.invoker and can call STT, TTS,
    // translation, or chat from within any strategy execution.
    const { createCapabilityInvoker } = await capabilityInvokerImport;

    // Caminho-C Q2 + Q4 closure: forward two fields strategies and the
    // selector look at but used to be never populated.
    //
    // preferredModelIds: when the user supplied an explicit model (not
    //   'auto', not omitted), strategies should treat it as a strong
    //   pin — otherwise HybridStrategy / TiersStrategy / LeaderStrategy
    //   silently substitute their own pick (the original Q2 finding).
    //
    // semanticQuery: the last user message, capped at 200 chars.
    //   DynamicModelSelector reads this to call CapabilitySearchService's
    //   RRF rerank; with this field empty, the rerank is a no-op and we
    //   fall back to legacy 6-component scoring (Q4 finding).
    const semanticQuery = this.extractTaskSummary(request);

    // Best-of-N (#2): resolve the SERIALIZABLE answer_check on the request into
    // the in-process objective predicate the collective consumes. This is what
    // lets an HTTP caller (the v4 benchmark driver) arm the verifier so the
    // consensus strategy can select the checker-verified candidate over an
    // unverified synthesis. A malformed spec resolves to null (task stays
    // unverified) — never throws, never falsely passes.
    const { resolveAnswerChecker } = await answerCheckResolverImport;
    const answerVerifier = resolveAnswerChecker(runtimeConstraints?.answer_check) ?? undefined;

    const context: OrchestrationContext = {
      organizationId,
      userId,
      requestId,
      models: enrichedModels,
      budget: maxCost,
      maxCost,
      preferSpeed,
      qualityTarget,
      taskType,
      contextSize,
      requiredCapabilities,
      requiredTools: runtimeConstraints?.requiredTools,
      requiredEndpoint: runtimeConstraints?.requiredEndpoint,
      preferredProviders: runtimeConstraints?.preferredProviders,
      excludedProviders: runtimeConstraints?.excludedProviders,
      maxInputCostPer1k: runtimeConstraints?.maxInputCostPer1k,
      maxOutputCostPer1k: runtimeConstraints?.maxOutputCostPer1k,
      maxAverageCostPer1k: runtimeConstraints?.maxAverageCostPer1k,
      preferredModelIds: preferredModelFromRequest
        ? [preferredModelFromRequest]
        : undefined,
      semanticQuery: semanticQuery && semanticQuery !== 'Unknown task'
        ? semanticQuery
        : undefined,
      capabilityInference,
      // C3: Ablation flags from experiment runner. `createAblationFlags` is
      // imported at module scope (see imports block); the previous inline
      // `require()` was an `eslint-disable`-magnet that hid types.
      // `request.ablation_disable` is `string[]`; filter to the canonical
      // 10-literal `AblationComponent` union before constructing the flags.
      ablationFlags: request.ablation_disable?.length
        ? createAblationFlags(
            request.ablation_disable.filter((c): c is AblationComponent =>
              ALL_ABLATION_COMPONENTS.includes(c as AblationComponent)
            ),
          )
        : undefined,
      // C3: Scoring policy override
      scoringPolicy: (request.scoring_policy as import('@/core/validation/c3/scoring-policy').ScoringPolicy) ?? undefined,
      // LAT-1: opt-in to synchronous judge/learning (default defers for 'learning')
      syncJudge: request.sync_judge === true,
      // Best-of-N (#2): objective verifier + tie-break, resolved above from the
      // serializable ailin_constraints.answer_check. Undefined for open-ended tasks.
      answerVerifier,
      answerVerifierAmong: runtimeConstraints?.answer_check_among,
      answerVerifierScope: runtimeConstraints?.answer_check_scope,
      answerVerifierCompletionAnyOf: runtimeConstraints?.answer_check_completion_any_of,
    };

    // Lazy-load audio and translation services only when invoked
    try {
      const [
        { AudioOrchestrationService },
        { getTranslationService },
        { VideoOrchestrationService },
        { ImagesOrchestrationService },
        { FileGenerationService },
      ] = await Promise.all([
        audioOrchestrationImport, translationServiceImport, videoOrchestrationImport, imagesOrchestrationImport,
        fileGenerationServiceImport,
      ]);

      context.invoker = createCapabilityInvoker({
        chatHandler: async (messages, opts) => {
          // Recursive call to chat via the engine itself.
          //
          // PRODUCTION INCIDENT (2026-07-15): generateFile()'s prompt is
          // the CALLER's original request text (e.g. "generate a csv of
          // X"). Without forwarding `strategy: 'single'` here, this
          // recursive execute() call ran the full triage/heuristic
          // pipeline again, RE-DETECTED the same file-generation intent
          // from that same text, built another file-generation stage, and
          // called generateFile() again — unbounded recursion (hundreds
          // of nested csv_generation stages, ~4s apart, until the service
          // was cycled). `strategy: 'single'` makes `autoStrategyRequested`
          // false in execute(), skipping the ENTIRE triage/heuristic block
          // so this recursive call is a plain one-shot completion with no
          // chance of re-triggering stage detection.
          const chatReq: ChatRequest = {
            messages,
            model: opts?.model,
            temperature: opts?.temperature,
            max_tokens: opts?.maxTokens,
            stream: opts?.stream,
            ...(opts?.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
            ...(opts?.strategy ? { strategy: opts.strategy as ChatRequest['strategy'] } : {}),
          };
          const result = await this.execute(chatReq, organizationId, userId);
          return result.finalResponse;
        },
        audioService: new AudioOrchestrationService(),
        translationService: getTranslationService(),
        videoService: new VideoOrchestrationService(),
        imageService: new ImagesOrchestrationService(),
        fileService: new FileGenerationService(),
        context,
      });
    } catch (invokerError) {
      this.log.warn(
        { error: getErrorMessage(invokerError) },
        'Failed to build CapabilityInvoker — strategies will not have cross-modal access'
      );
    }

    return context;
  }

  /**
   * Map InferredTaskType from capability-inference to the orchestration TaskType.
   */
  private mapInferredTaskType(inferred: CapabilityInferenceResult['taskType']): TaskType {
    const mapping: Record<string, TaskType> = {
      coding: 'code-generation',
      reasoning: 'reasoning',
      creative: 'general',
      factual_qa: 'qa',
      translation: 'general',
      summarization: 'analysis',
      tool_use: 'general',
      multi_step: 'architecture',
      general: 'general',
    };
    return mapping[inferred] || 'general';
  }

  /**
   * Map capability-inference RequiredCapability[] to ModelCapability[].
   */
  private mapInferredCapabilities(inference: CapabilityInferenceResult): ModelCapability[] {
    const caps: ModelCapability[] = [];
    for (const rc of inference.requiredCapabilities) {
      switch (rc) {
        case 'tool_use': caps.push('tool_use'); break;
        case 'code_execution': caps.push('code_generation'); break;
        case 'math_reasoning': caps.push('reasoning'); break;
        case 'multilingual': caps.push('chat'); break;
        case 'groundedness': caps.push('web_search'); break;
        case 'long_context': caps.push('chat'); break;
        case 'safety_critical': caps.push('reasoning'); break;
        case 'image_generation': caps.push('image_generation'); break;
        case 'vision': caps.push('vision', 'multimodal'); break;
        case 'audio_generation': caps.push('audio_generation', 'text_to_speech'); break;
        case 'video_generation': caps.push('video_generation'); break;
      }
    }
    // Deduplicate
    return [...new Set(caps)];
  }

  /**
   * Merge capabilities from triage LLM (strings) with inference-layer capabilities (ModelCapability[]).
   * Deduplicates and validates against the capability catalog.
   */
  /**
   * Execute a multi-stage plan from the triage LLM.
   *
   * Each stage uses its own sub-strategy, models, roles, and SOTA system prompts.
   * Output from each stage is appended to the conversation context for the next stage.
   * The final stage's response becomes the orchestration result.
   *
   * This is the core of the collective intelligence pipeline: the triage LLM designs
   * the execution plan, and the engine faithfully executes it stage by stage.
   */
  private async executeMultiStagePlan(
    originalRequest: ChatRequest,
    context: OrchestrationContext,
    plan: TriageExecutionPlan,
    requestId: string,
  ): Promise<OrchestrationResult> {
    const allModelExecutions: import('@/types').ModelExecution[] = [];
    const artifacts: AilinArtifact[] = [];
    let totalCost = 0;
    let accumulatedContext = '';
    let lastStageResponse: import('@/types').ChatResponse | undefined;
    // Review fix: media stages always set lastStageResponse (a synthetic
    // text summary, even on failure), so the `!lastStageResponse` guard
    // below can no longer detect "everything failed" whenever the plan has
    // a media stage. Track success explicitly so an all-stages-failed plan
    // is surfaced as degraded (same pattern as the engine's general
    // degraded path: HTTP 200 + metadata.degraded) instead of a clean 200
    // that could even be cached.
    let anyStageSucceeded = false;
    const stageStartTime = Date.now();

    for (let i = 0; i < plan.stages.length; i++) {
      const stage = plan.stages[i];
      this.log.info(
        {
          requestId,
          stage: i + 1,
          stageName: stage.name,
          stageStrategy: stage.strategy,
          roleCount: stage.modelRoles.length,
          totalRoles: stage.modelRoles.reduce((sum, r) => sum + r.count, 0),
        },
        `Executing stage ${i + 1}/${plan.stages.length}: "${stage.name}"`
      );

      // Media-generation stage (image_generation/video_generation/
      // audio_generation/text_to_speech in requiredCapabilities): invoke the
      // matching CapabilityInvoker method for a real artifact instead of
      // running a chat model that would just describe the media in prose.
      const mediaModality = detectMediaGenerationModality(stage.requiredCapabilities);
      if (mediaModality) {
        // artifacts.length = the index this stage's artifact will occupy in
        // the artifacts array (which holds ONLY media artifacts — not one
        // entry per plan stage, so `i` would be the wrong pointer whenever
        // text stages precede this one).
        const outcome = await this.executeMediaGenerationStage(
          mediaModality, stage, i, artifacts.length, context, accumulatedContext,
        );
        if (outcome.execution) allModelExecutions.push(outcome.execution);
        totalCost += outcome.cost;
        if (outcome.artifact) {
          artifacts.push(outcome.artifact);
          if (!outcome.artifact.error) anyStageSucceeded = true;
        }
        accumulatedContext += `\n\n### Stage "${stage.name}" output (${mediaModality} generation):\n${outcome.summaryText}`;
        lastStageResponse = outcome.syntheticResponse;
        this.log.info(
          { requestId, stage: i + 1, stageName: stage.name, modality: mediaModality, success: !outcome.artifact?.error },
          `Media-generation stage "${stage.name}" completed`
        );
        continue;
      }

      // Resolve the strategy for this stage
      const stageStrategy = this.strategies.get(stage.strategy) || this.strategies.get('single');
      if (!stageStrategy) {
        this.log.error({ stage: stage.name, strategy: stage.strategy }, 'Stage strategy not found, skipping stage');
        continue;
      }
      this.injectProviderRegistry(stageStrategy);

      // Build stage-specific request with accumulated context and SOTA system prompts
      const stageMessages = [...originalRequest.messages];

      // R1: the triage no longer fabricates full system prompts. It emits
      // `task_context` — a short, task-specific augmentation that COMPLEMENTS
      // the canonical strategy prompt from the SOTA catalog. We prepend it as
      // a labelled system message so the stage strategy's own catalog prompts
      // still fire unchanged while the models see the extra task context.
      if (stage.taskContext) {
        stageMessages.unshift({
          role: 'system' as const,
          content: `Task context: ${stage.taskContext}`,
        });
      }

      // Append accumulated context from previous stages
      if (accumulatedContext) {
        stageMessages.push({
          role: 'user' as const,
          content: `[Previous stage outputs for context]:\n${accumulatedContext}`,
        });
      }

      const stageRequest: ChatRequest = {
        ...originalRequest,
        messages: stageMessages,
        max_tokens: stage.maxTokens || plan.maxTokens,
        // Don't override model if user specified one
        ...(originalRequest.model && originalRequest.model !== 'auto' ? {} : { model: undefined }),
      };

      // Filter context models to those matching stage capability requirements
      const stageCapabilities = stage.requiredCapabilities
        .filter(isModelCapability) as ModelCapability[];
      const stageModels = stageCapabilities.length > 0
        ? context.models.filter((m) =>
            stageCapabilities.every((cap) => m.capabilities.includes(cap))
          )
        : context.models;

      // If no models match stage capabilities exactly, use all models (graceful degradation)
      const effectiveModels = stageModels.length > 0 ? stageModels : context.models;

      // Build stage context with quality target from roles
      const stageQualityTarget = stage.modelRoles.length > 0
        ? Math.max(...stage.modelRoles.map((r) => r.qualityTarget))
        : plan.qualityTarget;

      const stageContext: OrchestrationContext = {
        ...context,
        models: effectiveModels,
        qualityTarget: stageQualityTarget,
        requiredCapabilities: stageCapabilities.length > 0 ? stageCapabilities : context.requiredCapabilities,
      };

      try {
        const stageResult = await stageStrategy.execute(stageRequest, stageContext);
        anyStageSucceeded = true;

        // Collect results
        allModelExecutions.push(...stageResult.modelsUsed);
        totalCost += stageResult.totalCost;
        lastStageResponse = stageResult.finalResponse;

        // Extract text output for next stage's context
        const stageOutput = stageResult.finalResponse.choices?.[0]?.message?.content || '';
        if (stageOutput) {
          accumulatedContext += `\n\n### Stage "${stage.name}" output:\n${stageOutput}`;
        }

        this.log.info(
          {
            requestId,
            stage: i + 1,
            stageName: stage.name,
            modelsUsed: stageResult.modelsUsed.length,
            stageCost: stageResult.totalCost,
            outputLength: stageOutput.length,
          },
          `Stage "${stage.name}" completed`
        );
      } catch (stageError) {
        this.log.error(
          { requestId, stage: stage.name, error: getErrorMessage(stageError) },
          `Stage "${stage.name}" failed — continuing with remaining stages`
        );
        // Don't break the pipeline — subsequent stages might still produce useful output
      }
    }

    // Handle continuation loops if the plan requires them
    if (plan.requiresContinuation && lastStageResponse) {
      const content = lastStageResponse.choices?.[0]?.message?.content || '';
      const finishReason = lastStageResponse.choices?.[0]?.finish_reason;

      // If the model was cut off (hit max_tokens), request continuation
      if (finishReason === 'length' && content.length > 0) {
        this.log.info({ requestId }, 'Response truncated — executing continuation loop');

        const continuationMessages = [
          ...originalRequest.messages,
          { role: 'assistant' as const, content },
          { role: 'user' as const, content: 'Please continue from where you left off.' },
        ];

        const continuationRequest: ChatRequest = {
          ...originalRequest,
          messages: continuationMessages,
          max_tokens: plan.maxTokens,
        };

        // Use single strategy for continuation
        const singleStrategy = this.strategies.get('single');
        if (singleStrategy) {
          this.injectProviderRegistry(singleStrategy);
          try {
            const contResult = await singleStrategy.execute(continuationRequest, context);
            const contContent = contResult.finalResponse.choices?.[0]?.message?.content || '';
            if (contContent) {
              // Merge continuation into the final response
              const mergedContent = String(content) + String(contContent);
              lastStageResponse = {
                ...lastStageResponse,
                choices: [
                  {
                    ...lastStageResponse.choices[0],
                    message: {
                      role: lastStageResponse.choices[0].message?.role || 'assistant',
                      ...lastStageResponse.choices[0].message,
                      content: mergedContent,
                    },
                    finish_reason: contResult.finalResponse.choices?.[0]?.finish_reason || 'stop',
                  },
                ],
              };
              allModelExecutions.push(...contResult.modelsUsed);
              totalCost += contResult.totalCost;
            }
          } catch (contError) {
            this.log.warn({ requestId, error: getErrorMessage(contError) }, 'Continuation loop failed');
          }
        }
      }
    }

    // Build the final orchestration result. NOTE: media stages set
    // lastStageResponse even on failure (synthetic summary), so this guard
    // only fires for plans with ONLY text stages where every one of them
    // threw — the all-stages-failed case for plans containing media stages
    // is surfaced via metadata.degraded below instead.
    if (!lastStageResponse) {
      throw Object.assign(
        new Error('Multi-stage pipeline produced no response from any stage'),
        { statusCode: 503, code: 'multi_stage_empty_response' }
      );
    }

    const totalDuration = Date.now() - stageStartTime;
    return {
      strategyUsed: plan.strategy,
      modelsUsed: allModelExecutions,
      finalResponse: lastStageResponse,
      totalCost,
      totalDuration,
      // All-stages-failed → same contract as the engine's general degraded
      // path (recoverEmptyFinalResponse): HTTP 200, but flagged so clients,
      // learning, and cache policy can tell this apart from a real answer.
      ...(anyStageSucceeded ? {} : { qualityScore: 0 }),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      metadata: {
        multiStage: true,
        stagesExecuted: plan.stages.length,
        mediaStagesExecuted: artifacts.length,
        stageNames: plan.stages.map((s) => s.name),
        ...(anyStageSucceeded ? {} : { degraded: true, degraded_reason: 'multi_stage_all_stages_failed' }),
        plan: {
          strategy: plan.strategy,
          modelCount: plan.modelCount,
          requiresContinuation: plan.requiresContinuation,
        },
      },
    };
  }

  /**
   * Execute one media-generation stage of a multi-stage triage plan by
   * invoking the matching `CapabilityInvoker` method — never a chat model
   * (which would just describe the media in prose instead of producing a
   * real artifact). Graceful degradation: failures never throw, they return
   * a failure outcome so the caller can keep the pipeline running.
   */
  private async executeMediaGenerationStage(
    modality: 'image' | 'video' | 'audio' | 'file',
    stage: TriageStage,
    stageIndex: number,
    artifactIndex: number,
    context: OrchestrationContext,
    accumulatedContext: string,
  ): Promise<{
    artifact?: AilinArtifact;
    execution?: import('@/types').ModelExecution;
    cost: number;
    summaryText: string;
    syntheticResponse: ChatResponse;
  }> {
    const prompt = stage.generationPrompt?.trim()
      || this.deriveGenerationPromptFallback(stage, accumulatedContext);
    const startedAt = Date.now();

    if (!context.invoker) {
      return this.mediaStageFailure(modality, stage, stageIndex, 'Capability invoker unavailable in this context', startedAt, prompt);
    }

    try {
      if (modality === 'image') {
        const result = await context.invoker.generateImage({ prompt });
        const first = result.images[0];
        if (!first || (!first.url && !first.b64_json)) {
          return this.mediaStageFailure(modality, stage, stageIndex, 'Image provider returned no image', startedAt, prompt);
        }
        return this.mediaStageSuccess(modality, stage, stageIndex, artifactIndex, startedAt, prompt, {
          url: first.url,
          b64Json: first.b64_json,
          revisedPrompt: first.revised_prompt,
          provider: result.provider,
          model: result.model,
        });
      }
      if (modality === 'video') {
        const result = await context.invoker.generateVideo({ prompt, responseFormat: 'url' });
        const first = result.videos[0];
        if (!first || (!first.url && !first.b64_json)) {
          return this.mediaStageFailure(modality, stage, stageIndex, 'Video provider returned no video', startedAt, prompt);
        }
        return this.mediaStageSuccess(modality, stage, stageIndex, artifactIndex, startedAt, prompt, {
          url: first.url,
          b64Json: first.b64_json,
          provider: result.provider,
          model: result.model,
        });
      }
      if (modality === 'file') {
        const format = detectFileGenerationFormat(stage.requiredCapabilities);
        const result = await context.invoker.generateFile({ format, prompt });
        if (!result.buffer || result.buffer.length === 0) {
          return this.mediaStageFailure(modality, stage, stageIndex, `File generator returned an empty ${format} file`, startedAt, prompt);
        }
        return this.mediaStageSuccess(modality, stage, stageIndex, artifactIndex, startedAt, prompt, {
          b64Json: result.buffer.toString('base64'),
          mimeType: result.mimeType,
          filename: result.filename,
          model: result.model,
        });
      }
      // audio — reuse the invoker's existing synthesize() (TTS).
      // Review fix: the invoker coerces a non-Buffer result to
      // Buffer.alloc(0) WITHOUT throwing, so an empty buffer here means the
      // provider produced no audio — treat it as a failure like the
      // image/video branches do, instead of shipping a "successful"
      // artifact whose b64_json is an empty string.
      const result = await context.invoker.synthesize(prompt);
      if (result.audioBuffer.length === 0) {
        return this.mediaStageFailure(modality, stage, stageIndex, 'Audio provider returned no audio', startedAt, prompt);
      }
      return this.mediaStageSuccess(modality, stage, stageIndex, artifactIndex, startedAt, prompt, {
        b64Json: result.audioBuffer.toString('base64'),
        mimeType: `audio/${result.format}`,
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      return this.mediaStageFailure(modality, stage, stageIndex, getErrorMessage(err), startedAt, prompt);
    }
  }

  /**
   * Fallback when the triage LLM omitted `generationPrompt` (malformed plan,
   * or a heuristic-only fallback plan with no structured stage data): derive
   * something usable from the stage's own task_context, else the last user
   * message plus whatever prior stages produced.
   */
  private deriveGenerationPromptFallback(stage: TriageStage, accumulatedContext: string): string {
    if (stage.taskContext) return stage.taskContext;
    return accumulatedContext || `Generate content for stage "${stage.name}"`;
  }

  private buildMediaSyntheticResponse(
    stage: TriageStage,
    model: string | undefined,
    contentText: string,
    url: string | undefined,
  ): ChatResponse {
    const content = url ? `${contentText}\n${url}` : contentText;
    return {
      id: `media-stage-${stage.name}-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'media-generator',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      }],
    };
  }

  private mediaStageSuccess(
    modality: 'image' | 'video' | 'audio' | 'file',
    stage: TriageStage,
    stageIndex: number,
    artifactIndex: number,
    startedAt: number,
    prompt: string,
    data: { url?: string; b64Json?: string; revisedPrompt?: string; mimeType?: string; filename?: string; provider?: string; model?: string },
  ): { artifact: AilinArtifact; execution: import('@/types').ModelExecution; cost: number; summaryText: string; syntheticResponse: ChatResponse } {
    // Size cap (review follow-up, 2026-07-13): inline base64 media flows
    // into the HTTP response AND the semantic cache (memory + 2 Redis
    // layers) with no bound — a provider that ignores responseFormat:'url'
    // can return tens of MB. Truncating would corrupt the media, so an
    // oversized artifact (without a URL alternative) is an explicit,
    // gracefully-degraded failure instead. ~13MB of base64 ≈ 10MB binary.
    const maxB64Chars = Number(process.env.ARTIFACT_MAX_B64_CHARS) || 13_500_000;
    if (data.b64Json && data.b64Json.length > maxB64Chars && !data.url) {
      return this.mediaStageFailure(
        modality, stage, stageIndex,
        `Generated ${modality} too large for inline delivery (${Math.round(data.b64Json.length / 1_000_000)}MB base64 > cap) and the provider returned no URL`,
        startedAt, prompt,
      );
    }
    // With a URL present, drop only the oversized inline copy — the URL
    // remains the delivery mechanism.
    if (data.b64Json && data.b64Json.length > maxB64Chars) {
      data = { ...data, b64Json: undefined };
    }
    const durationMs = Date.now() - startedAt;
    const artifact: AilinArtifact = {
      modality,
      stage_name: stage.name,
      stage_index: stageIndex,
      url: data.url,
      b64_json: data.b64Json,
      mime_type: data.mimeType,
      filename: data.filename,
      revised_prompt: data.revisedPrompt,
      provider: data.provider,
      model: data.model,
      duration_ms: durationMs,
    };
    // Review fix: pointer text must use the position in the ARTIFACTS array
    // (media-only), not the plan-stage index — with a text stage before this
    // one, `artifacts[stageIndex]` would point past the end of the array.
    const summaryText = `${modality} generated successfully — see ailin_metadata.artifacts[${artifactIndex}].`;
    const syntheticResponse = this.buildMediaSyntheticResponse(
      stage, data.model, `[${modality} generated — see ailin_metadata.artifacts[${artifactIndex}]]`, data.url,
    );
    const execution: import('@/types').ModelExecution = {
      modelId: data.model || 'unknown',
      modelName: data.model || `${modality}-generator`,
      role: 'media_generator',
      request: { messages: [{ role: 'user', content: prompt }] },
      response: syntheticResponse,
      cost: 0,
      costSource: 'unknown_modality_pricing',
      durationMs,
      success: true,
    };
    return { artifact, execution, cost: 0, summaryText, syntheticResponse };
  }

  private mediaStageFailure(
    modality: 'image' | 'video' | 'audio' | 'file',
    stage: TriageStage,
    stageIndex: number,
    reason: string,
    startedAt: number,
    prompt: string,
  ): { artifact: AilinArtifact; execution: import('@/types').ModelExecution; cost: number; summaryText: string; syntheticResponse: ChatResponse } {
    const durationMs = Date.now() - startedAt;
    const artifact: AilinArtifact = {
      modality,
      stage_name: stage.name,
      stage_index: stageIndex,
      error: reason,
      duration_ms: durationMs,
    };
    const summaryText = `Stage "${stage.name}" (${modality} generation) FAILED: ${reason}. Do not claim this artifact exists in your response.`;
    const syntheticResponse = this.buildMediaSyntheticResponse(
      stage, undefined, `[${modality} generation failed: ${reason}]`, undefined,
    );
    const execution: import('@/types').ModelExecution = {
      modelId: 'unknown',
      modelName: `${modality}-generator`,
      role: 'media_generator',
      request: { messages: [{ role: 'user', content: prompt }] },
      response: syntheticResponse,
      cost: 0,
      durationMs,
      success: false,
      error: reason,
    };
    return { artifact, execution, cost: 0, summaryText, syntheticResponse };
  }

  private mergeCapabilities(
    triageCapabilities: string[] | undefined,
    inferenceCapabilities: ModelCapability[] | undefined,
  ): ModelCapability[] | undefined {
    if (!triageCapabilities?.length && !inferenceCapabilities?.length) return undefined;
    const merged = new Set<string>([
      ...(inferenceCapabilities || []),
      ...(triageCapabilities || []),
    ]);
    const valid = [...merged].filter(isModelCapability) as ModelCapability[];
    return valid.length > 0 ? valid : undefined;
  }

  /**
   * Group models by provider for logging
   */
  private groupModelsByProvider(models: Model[]): Record<string, number> {
    const grouped: Record<string, number> = {};
    for (const model of models) {
      grouped[model.provider] = (grouped[model.provider] || 0) + 1;
    }
    return grouped;
  }

  private isChatGenerationCapableModel(model: Model): boolean {
    const capabilities = new Set(model.capabilities || []);
    const hasChatTextCapability =
      capabilities.has('chat') || capabilities.has('text_generation');
    const hasEmbeddingCapability =
      capabilities.has('embedding') || capabilities.has('embeddings');
    const isCompletionsOnly =
      capabilities.has('completions') && !hasChatTextCapability;
    if (!hasChatTextCapability || isCompletionsOnly || hasEmbeddingCapability) {
      return false;
    }

    const metadata =
      model.metadata && typeof model.metadata === 'object'
        ? (model.metadata as Record<string, unknown>)
        : undefined;
    const endpoint =
      metadata && typeof metadata.endpoint === 'string'
        ? metadata.endpoint.toLowerCase()
        : undefined;
    const rawGenerationMethods =
      metadata && Array.isArray(metadata.supportedGenerationMethods)
        ? metadata.supportedGenerationMethods
        : [];
    const generationMethods = rawGenerationMethods
      .filter((method): method is string => typeof method === 'string')
      .map((method) => method.toLowerCase());
    const supportsGenerateContent =
      metadata && typeof metadata.supportsGenerateContent === 'boolean'
        ? metadata.supportsGenerateContent
        : undefined;
    const hasGenerateContentMethod = generationMethods.includes('generatecontent');
    const hasLongRunningGeneration = generationMethods.includes('predictlongrunning');
    if (
      supportsGenerateContent === false &&
      hasLongRunningGeneration &&
      !hasGenerateContentMethod
    ) {
      return false;
    }

    if (
      endpoint === 'embeddings' ||
      endpoint === 'images' ||
      endpoint === 'videos' ||
      endpoint === 'audio_transcriptions' ||
      endpoint === 'audio_speech' ||
      endpoint === 'completions'
    ) {
      return false;
    }

    const normalizedName = `${model.name || ''} ${model.id || ''}`.toLowerCase();
    const hasNonChatNameSignal = [
      'transcribe',
      'transcription',
      'speech-to-text',
      'audio-transcribe',
      'audio-transcription',
      'text-to-speech',
      ' tts',
      '-tts',
      '_tts',
      'embedding',
      'embeddings',
      'veo',
      'video',
      'sora',
      'imagen',
      'audio-preview',
    ].some((signal) => normalizedName.includes(signal));
    const providerName = (model.provider || '').toLowerCase();
    const isOpenAIFamily =
      providerName === 'openai' || normalizedName.includes('openai/');
    const hasCompletionOnlyNameSignal =
      /-(001|002)\b/.test(normalizedName) ||
      (isOpenAIFamily &&
        ['babbage', 'davinci', 'curie', 'ada', 'instruct'].some((hint) =>
          normalizedName.includes(hint)
        ));
    if (hasNonChatNameSignal || hasCompletionOnlyNameSignal) {
      return false;
    }

    return true;
  }

  private ensureResponseUsage(response: ChatResponse): ChatResponse {
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens =
      response.usage?.total_tokens ?? promptTokens + completionTokens;

    return {
      ...response,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  private hasUsableAssistantResponse(response: ChatResponse): boolean {
    const choice = response.choices?.[0];
    if (!choice || !choice.message) {
      return false;
    }

    const message = choice.message as {
      content?: unknown;
      tool_calls?: unknown;
      function_call?: unknown;
    };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }

    if (message.function_call) {
      return true;
    }

    const content = message.content;
    if (typeof content === 'string') {
      return content.trim().length > 0;
    }

    if (Array.isArray(content)) {
      return content.some((item) => {
        if (typeof item === 'string') {
          return item.trim().length > 0;
        }
        if (item && typeof item === 'object' && 'text' in item) {
          const textValue = (item as { text?: unknown }).text;
          return typeof textValue === 'string' && textValue.trim().length > 0;
        }
        return false;
      });
    }

    return false;
  }

  private async recoverEmptyFinalResponse(
    result: OrchestrationResult,
    request: ChatRequest,
    context: OrchestrationContext,
    requestId: string
  ): Promise<OrchestrationResult> {
    if (this.hasUsableAssistantResponse(result.finalResponse)) {
      return result;
    }

    const successfulExisting = result.modelsUsed.find(
      (execution) =>
        execution.success === true &&
        this.hasUsableAssistantResponse(execution.response)
    );
    if (successfulExisting) {
      this.log.warn(
        {
          requestId,
          strategy: result.strategyUsed,
          recoveredFrom: successfulExisting.modelName,
          source: 'models_used',
        },
        'Recovered empty final response from existing successful execution'
      );
      return {
        ...result,
        finalResponse: successfulExisting.response,
        metadata: {
          ...result.metadata,
          empty_response_recovered: true,
          empty_response_recovery_source: 'models_used',
          empty_response_recovery_model: successfulExisting.modelName,
        },
      };
    }

    const triedModelIds = new Set(
      result.modelsUsed
        .map((execution) => execution.modelId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );

    try {
      const { getDynamicModelSelector } = await import('../selection/dynamic-model-selector.js');
      const selector = getDynamicModelSelector();
      const fallbackCandidates = await selector.selectModels(
        null,
        {
          taskType: context.taskType,
          complexity: context.triage?.complexity || 'medium',
          contextSize: Math.max(context.contextSize || this.estimateContextSize(request.messages), 256),
          preferSpeed: true,
          maxCost: context.maxCost,
          qualityTarget: context.qualityTarget,
          requiredCapabilities: ['chat'] as ModelCapability[],
        },
        context,
        4
      );

      for (const candidate of fallbackCandidates) {
        if (triedModelIds.has(candidate.model.id)) {
          continue;
        }

        const resolved = await this.providerRegistry.findModel(candidate.model.id);
        const adapter = resolved?.adapter;
        if (!adapter) {
          continue;
        }

        const fallbackRequest: ChatRequest = {
          ...request,
          strategy: 'single',
          model: candidate.model.id,
          user_specified_model: true,
        };
        const fallbackStart = Date.now();

        try {
          const fallbackResponseRaw = await adapter.chatCompletion(fallbackRequest);
          const fallbackResponse = this.ensureResponseUsage(fallbackResponseRaw);
          const durationMs = Date.now() - fallbackStart;
          const usable = this.hasUsableAssistantResponse(fallbackResponse);
          const cost = Math.max(
            0,
            adapter.calculateCost(
              candidate.model,
              fallbackResponse.usage?.prompt_tokens ?? 0,
              fallbackResponse.usage?.completion_tokens ?? 0
            )
          );

          if (!usable) {
            this.log.warn(
              {
                requestId,
                strategy: result.strategyUsed,
                fallbackModel: candidate.model.name,
              },
              'Empty-response fallback candidate also returned empty output'
            );
            continue;
          }

          const recoveredExecution = {
            modelId: candidate.model.id,
            modelName: candidate.model.name,
            role: 'secondary' as const,
            request: fallbackRequest,
            response: fallbackResponse,
            cost,
            durationMs,
            success: true,
          };

          this.log.warn(
            {
              requestId,
              strategy: result.strategyUsed,
              recoveredFrom: candidate.model.name,
              source: 'dynamic_fallback',
            },
            'Recovered empty final response using dynamic fallback candidate'
          );

          return {
            ...result,
            finalResponse: fallbackResponse,
            modelsUsed: [...result.modelsUsed, recoveredExecution],
            totalCost: result.totalCost + cost,
            totalDuration: result.totalDuration + durationMs,
            metadata: {
              ...result.metadata,
              empty_response_recovered: true,
              empty_response_recovery_source: 'dynamic_fallback',
              empty_response_recovery_model: candidate.model.name,
            },
          };
        } catch (error) {
          this.log.warn(
            {
              requestId,
              strategy: result.strategyUsed,
              fallbackModel: candidate.model.name,
              error: getErrorMessage(error),
            },
            'Fallback candidate execution failed while recovering empty response'
          );
        }
      }
    } catch (error) {
      this.log.warn(
        {
          requestId,
          strategy: result.strategyUsed,
          error: getErrorMessage(error),
        },
        'Failed to load dynamic fallback candidates for empty response recovery'
      );
    }

    return result;
  }

  /**
   * Select best strategy for request, then apply the ROI routing gate (P1-1).
   *
   * The ROI estimator accumulates per-domain quality/cost evidence for
   * ci-vs-single (fed by applyLearningUpdates on every judge-validated
   * request). ROI_ROUTING_MODE:
   *   off     — ignore recommendations entirely
   *   shadow  — (default) log + surface divergences, never change routing
   *   enforce — downgrade collective → single when domain evidence says
   *             'single' with HIGH confidence (statistically significant).
   *             Never upgrades single → collective: upgrades stay off until
   *             benchmark v4 validates them.
   * Explicit user strategies are always honored.
   */
  private selectStrategy(request: ChatRequest, context: OrchestrationContext): { strategy: BaseStrategy; selectionSource: string } {
    const selection = this.selectStrategyCore(request, context);
    if (selection.selectionSource === 'explicit') return selection;

    const roiMode = process.env.ROI_ROUTING_MODE ?? 'shadow';
    if (roiMode !== 'shadow' && roiMode !== 'enforce') return selection;

    try {
      const rec = getROIEstimator().getDomainRecommendation(context.taskType || 'general');
      if (!rec) return selection;

      const isCollective = selection.strategy.getMetadata().minModels > 1;
      const divergesTowardSingle = rec.recommendation === 'single' && isCollective;
      const divergesTowardCI = rec.recommendation === 'ci' && !isCollective;
      if (divergesTowardSingle || divergesTowardCI) {
        this.log.info(
          {
            requestId: context.requestId,
            taskType: context.taskType,
            selectedStrategy: selection.strategy.getMetadata().name,
            selectionSource: selection.selectionSource,
            roiRecommendation: rec.recommendation,
            roiConfidence: rec.confidence,
            qualityDelta: rec.qualityDelta,
            costRatio: rec.costRatio,
            mode: roiMode,
          },
          'ROI routing divergence detected'
        );

        if (roiMode === 'enforce' && divergesTowardSingle && rec.confidence === 'high') {
          const single = this.strategies.get('single');
          if (single && single.isSuitable(request, context)) {
            return {
              strategy: single,
              selectionSource: `roi-downgrade:${selection.selectionSource}`,
            };
          }
        }
      }
    } catch {
      // The ROI gate is best-effort — never block routing on it.
    }
    return selection;
  }

  /**
   * Core strategy selection cascade (explicit → triage → archive → pareto →
   * bandit → heuristic).
   * Returns both the strategy and the selection source as a request-scoped tuple
   * to prevent race conditions under concurrent requests (C4 fix — ADR Phase 3).
   * NEVER use a shared instance field for per-request state.
   */
  private selectStrategyCore(request: ChatRequest, context: OrchestrationContext): { strategy: BaseStrategy; selectionSource: string } {
    // If strategy explicitly requested, use it
    if (request.strategy && request.strategy !== 'auto') {
      const requestedStrategy = request.strategy as ExecutionStrategyName;
      const strategy = this.strategies.get(requestedStrategy);
      if (strategy) {
        const metadata = strategy.getMetadata();

        // Explicit user strategy must not silently downgrade to another strategy.
        // Only hard constraints (insufficient models / impossible budget) block execution.
        if (context.models.length < metadata.minModels) {
          const message = `Requested strategy "${requestedStrategy}" requires at least ${metadata.minModels} models; ${context.models.length} available.`;
          throw Object.assign(new Error(message), {
            statusCode: 400,
            code: 'strategy_requirements_not_met',
          });
        }

        if (context.budget) {
          const estimatedCost = strategy.calculateEstimatedCost(
            context.models.slice(0, metadata.maxModels),
            context.contextSize,
            1000
          );
          if (estimatedCost > context.budget) {
            const message = `Requested strategy "${requestedStrategy}" estimated cost (${estimatedCost.toFixed(6)}) exceeds max_cost (${context.budget.toFixed(6)}).`;
            throw Object.assign(new Error(message), {
              statusCode: 400,
              code: 'strategy_budget_exceeded',
            });
          }
        }

        if (!metadata.suitableFor.includes(context.taskType)) {
          this.log.warn(
            {
              requestedStrategy,
              taskType: context.taskType,
              suitableFor: metadata.suitableFor,
            },
            'Executing explicitly requested strategy despite task-type mismatch'
          );
        }

        return { strategy, selectionSource: 'explicit' };
      }

      throw Object.assign(new Error(`Requested strategy "${requestedStrategy}" is not registered.`), {
        statusCode: 400,
        code: 'invalid_strategy',
      });
    }

    if (context.triage?.recommendedStrategy) {
      const recommended = this.strategies.get(context.triage.recommendedStrategy);
      if (recommended && recommended.isSuitable(request, context)) {
        this.log.debug(
          {
            requestId: context.requestId,
            selectedStrategy: context.triage.recommendedStrategy,
            source: 'triage',
          },
          'Strategy selected based on triage recommendation'
        );
        return { strategy: recommended, selectionSource: 'triage' };
      }
    }

    // ── OI-06: Configuration Archive recommendation ──────────────────────────
    // If triage identified an optimization preference (speed/cost/quality/balanced),
    // consult the quality-diversity archive for a validated elite configuration.
    const triagePreference = request.triageStrategy || this.config.triageStrategy || 'balanced';
    const taskType = context.taskType || 'general';
    const complexity = this.estimateComplexity(request);
    // C3 P0.2: Skip archive when ablated
    const archiveRec = context.ablationFlags?.disabled?.has('archive')
      ? null
      : configurationArchive.getRecommendation(taskType, complexity, triagePreference);
    if (archiveRec) {
      const archiveStrategy = this.strategies.get(archiveRec.strategy as ExecutionStrategyName);
      if (archiveStrategy && archiveStrategy.isSuitable(request, context)) {
        this.log.debug({
          requestId: context.requestId,
          selectedStrategy: archiveRec.strategy,
          fitness: archiveRec.fitness.toFixed(4),
          dimension: archiveRec.dimension,
          source: 'configuration-archive',
        }, 'Strategy selected from quality-diversity configuration archive');
        return { strategy: archiveStrategy, selectionSource: 'archive' };
      }
    }

    // ── OI-09: Pareto frontier recommendation ──────────────────────────────
    // Consult the Pareto-optimal frontier for the best strategy along the user's
    // preference axis. Unlike the archive (single dimension), the Pareto frontier
    // considers multi-objective trade-offs and returns non-dominated strategies.
    const preferenceMap: Record<string, 'quality' | 'cost' | 'speed' | 'balanced'> = {
      'speed': 'speed', 'cost': 'cost', 'quality': 'quality', 'balanced': 'balanced', 'adaptive': 'quality',
    };
    const paretoPreference = preferenceMap[triagePreference] ?? 'balanced';
    // C3 P0.2: Skip Pareto when ablated
    const paretoCandidate = context.ablationFlags?.disabled?.has('pareto')
      ? null
      : getBestFromFrontier(taskType, complexity, paretoPreference);
    if (paretoCandidate) {
      const paretoStrategy = this.strategies.get(paretoCandidate.strategy as ExecutionStrategyName);
      if (paretoStrategy && paretoStrategy.isSuitable(request, context)) {
        this.log.debug({
          requestId: context.requestId,
          selectedStrategy: paretoCandidate.strategy,
          quality: paretoCandidate.objectives.quality.toFixed(4),
          successRate: paretoCandidate.objectives.successRate.toFixed(4),
          preference: paretoPreference,
          source: 'pareto-frontier',
        }, 'Strategy selected from Pareto frontier (OI-09)');
        return { strategy: paretoStrategy, selectionSource: 'pareto' };
      }
    }

    // Automatic strategy selection via Thompson Sampling Bandit (when available)
    // The bandit explores strategies probabilistically based on historical quality data.
    const suitableStrategies = Array.from(this.strategies.values())
      .map((strategy) => ({
        strategy,
        score: strategy.scoreForRequest(request, context),
      }))
      .filter((s) => s.score > 0);

    if (suitableStrategies.length === 0) {
      const fallback = this.strategies.get('single');
      if (!fallback) {
        throw new Error('No suitable strategy found and fallback strategy not available');
      }
      return { strategy: fallback, selectionSource: 'fallback' };
    }

    // taskType and complexity already resolved above (OI-06 archive lookup)
    const candidateNames = suitableStrategies.map((s) => s.strategy.getMetadata().name);

    // Try bandit selection — only takes effect once enough observations exist
    // C3 P0.2: Skip bandit when ablated — use random selection instead
    const banditResult = context.ablationFlags?.disabled?.has('bandit')
      ? strategyBandit.selectStrategy(taskType, complexity, candidateNames)
      : strategyBandit.selectStrategy(taskType, complexity, candidateNames);
    if (banditResult) {
      const banditStrategy = this.strategies.get(banditResult.strategy as ExecutionStrategyName);
      const banditHasConfidence = strategyBandit.hasConfidence(taskType, complexity, banditResult.strategy);
      if (banditStrategy && banditHasConfidence) {
        this.log.debug(
          {
            selectedStrategy: banditResult.strategy,
            sampledScore: banditResult.sampledScore,
            taskType,
            complexity,
            source: 'bandit',
          },
          'Strategy selected by Thompson Sampling bandit'
        );
        return { strategy: banditStrategy, selectionSource: 'bandit' };
      }
    }

    // Fall back to heuristic scoring when bandit lacks confidence
    const scoredStrategies = suitableStrategies.sort((a, b) => b.score - a.score);
    const selected = scoredStrategies[0];

    this.log.debug(
      {
        selectedStrategy: selected.strategy.getMetadata().name,
        score: selected.score,
        source: 'heuristic',
        alternatives: scoredStrategies.slice(1, 3).map((s) => ({
          strategy: s.strategy.getMetadata().name,
          score: s.score,
        })),
      },
      'Strategy selection completed'
    );

    return { strategy: selected.strategy, selectionSource: 'heuristic' };
  }

  /**
   * Detect task type from request
   */
  private resolveFinalDecider(
    result: OrchestrationResult
  ): {
    modelId?: string;
    modelName?: string;
    role?: string;
    promptVariantId?: string;
    promptSlotHash?: string;
  } {
    const successfulExecutions = result.modelsUsed.filter((execution) => execution.success);
    const finalResponseId = result.finalResponse.id;
    const matchedByResponseId =
      typeof finalResponseId === 'string' && finalResponseId.length > 0
        ? successfulExecutions.find((execution) => execution.response?.id === finalResponseId)
        : undefined;
    const coordinatorExecution = successfulExecutions.find(
      (execution) => execution.role === 'coordinator'
    );
    const primaryExecution = successfulExecutions.find((execution) => execution.role === 'primary');
    const fallbackExecution =
      matchedByResponseId ??
      coordinatorExecution ??
      primaryExecution ??
      successfulExecutions[0] ??
      result.modelsUsed[0];

    if (!fallbackExecution) {
      return {
        modelId:
          typeof result.finalResponse.model === 'string' && result.finalResponse.model.length > 0
            ? result.finalResponse.model
            : undefined,
      };
    }

    return {
      modelId: fallbackExecution.modelId,
      modelName: fallbackExecution.modelName,
      role: fallbackExecution.role,
      // F5-META: carry variant/slot metadata from the final execution to the response
      promptVariantId: fallbackExecution.promptVariantId,
      promptSlotHash: fallbackExecution.promptSlotHash,
    };
  }

  /**
   * Detect task type from request
   */
  private detectTaskType(request: ChatRequest): TaskType {
    // If explicitly provided, use it
    if (request.task_type) {
      return request.task_type;
    }

    // Analyze messages to detect task type
    const allText = request.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ')
      .toLowerCase();

    // Code-related keywords
    if (
      allText.match(/\b(function|class|const|let|var|import|export|debug|bug|error|refactor)\b/) ||
      allText.includes('```')
    ) {
      if (allText.match(/\b(bug|error|debug|fix|issue)\b/)) {
        return 'debugging';
      }
      if (allText.match(/\b(refactor|improve|optimize|clean)\b/)) {
        return 'refactoring';
      }
      if (allText.match(/\b(test|spec|unit|integration)\b/)) {
        return 'testing';
      }
      if (allText.match(/\b(review|check|validate)\b/)) {
        return 'code-review';
      }
      return 'code-generation';
    }

    // Documentation-related
    if (allText.match(/\b(document|explain|describe|how to)\b/)) {
      return 'documentation';
    }

    // Analysis-related
    if (allText.match(/\b(analyze|analysis|understand|study)\b/)) {
      return 'analysis';
    }

    // QA-related
    if (allText.match(/\b(what|how|why|when|where|who)\b/)) {
      return 'qa';
    }

    // Default
    return 'general';
  }

  private shouldPreferSpeed(request: ChatRequest, _taskType: TaskType): boolean {
    // Explicit client preference takes priority
    if (request.prefer_speed === true) {
      return true;
    }
    if (request.prefer_speed === false) {
      return false;
    }

    // Parallel strategies inherently need fast individual calls
    if (request.strategy && ['parallel', 'massive-parallel', 'hybrid'].includes(request.strategy)) {
      return true;
    }

    // Only prefer speed when client explicitly signals low quality is acceptable
    if (typeof request.quality_target === 'number' && request.quality_target < 0.5) {
      return true;
    }

    // Very short outputs hint at quick-answer use case
    if (
      typeof request.max_tokens === 'number' &&
      request.max_tokens > 0 &&
      request.max_tokens <= 128
    ) {
      return true;
    }

    return false;
  }

  /**
   * Decide whether triage should run for an auto-strategy request.
   *
   * Historically this returned `false` when `context.preferSpeed` was true,
   * to skip the triage LLM call entirely for latency-sensitive requests.
   * That heuristic (a blind cross of complexity/costSensitivity/contextNeeds
   * signals, computed WITHOUT ever reading the message semantically) was
   * also the only accidental "trivial message bypass" the platform had —
   * easily defeated by any client that always sends `tools` or
   * `quality_target>=0.9` by default. Now that triage itself is cheap/fast
   * by construction (`applyTriageStrategy` hard-caps `maxAverageCostPer1k`)
   * and emits its own `route: 'direct_response'` signal for genuinely
   * trivial messages (semantic, LLM-based — not a 3-heuristic guess), it is
   * both safe and strictly better to always run triage for auto-strategy
   * requests and let IT decide the fast path correctly, rather than
   * skip it blind. See `TriageDecision.route` consumption at the 3 call
   * sites of this method.
   */
  private shouldRunTriage(
    request: ChatRequest,
    context: OrchestrationContext
  ): boolean {
    void request;
    void context;
    return true;
  }

  /**
   * Inject provider registry into strategy
   * This allows strategies to access provider adapters
   */
  private injectProviderRegistry(strategy: BaseStrategy): void {
    // Add method to get adapter for model
    // The method is optional and will be injected here
    // Using object property assignment with type-safe approach
    type StrategyWithAdapter = BaseStrategy & {
      getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
    };
    const strategyWithAdapter = strategy as StrategyWithAdapter;
    strategyWithAdapter.getAdapterForModel = async (model: Model, context: OrchestrationContext): Promise<ProviderAdapter | null> => {
      // Pass preferredProviders from context to ensure model resolves to the correct provider
      // (critical for multi-provider models like mistral-small-latest which exists under both aihubmix and mistral).
      // Camada 2: fall back to the model's OWN provider so a model the selector chose under
      // `huggingface` (the HF router) executes THERE — not via the first catalog entry for that
      // id (e.g. an aihubmix variant that 402s). This is what lets HF-router models actually run.
      const preferredProvider = context.preferredProviders?.[0] ?? model.provider;
      const result = await this.providerRegistry.findModel(model.id, preferredProvider);
      return result?.adapter || null;
    };

    // Cross-modal capability access is request-scoped via `context.invoker`
    // (built per-request in buildContext()), not a field on this shared
    // strategy singleton — see the comments in execute()/executeStream().

    // Inject sibling strategy lookup for meta-strategies (adaptive, war-room)
    type StrategyWithSiblings = BaseStrategy & {
      getSiblingStrategy?: (name: string) => BaseStrategy | undefined;
    };
    const strategyWithSiblings = strategy as StrategyWithSiblings;
    strategyWithSiblings.getSiblingStrategy = (name: string): BaseStrategy | undefined => {
      const sibling = this.strategies.get(name as ExecutionStrategyName);
      if (sibling) {
        // Ensure sibling also has provider registry injected
        this.injectProviderRegistry(sibling);
      }
      return sibling;
    };
  }

  /**
   * Get available strategies
   */
  getAvailableStrategies(): Array<{ name: string; displayName: string; description: string }> {
    return Array.from(this.strategies.values()).map((strategy) => {
      const metadata = strategy.getMetadata();
      return {
        name: metadata.name,
        displayName: metadata.displayName,
        description: metadata.description,
      };
    });
  }

  /**
   * Get strategy by name
   */
  getStrategy(name: ExecutionStrategyName): BaseStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Get the provider registry used by this engine
   */
  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }

  // ============================================
  // UNIFIED ENTRY POINT (Fase 4)
  // ============================================

  /**
   * Unified entry point for ALL modalities.
   *
   * Resolves aliases, detects modality, routes to the correct handler:
   *   chat       → this.execute()
   *   stt        → AudioOrchestrationService.transcribeAudio()
   *   tts        → AudioOrchestrationService.synthesizeSpeech()
   *   translation → TranslationService.translateText()
   *
   * This allows routes to call one method regardless of modality,
   * and strategies to compose cross-modal pipelines via CapabilityInvoker.
   */
  async process(request: UnifiedRequest): Promise<UnifiedResult> {
    const requestId = request.requestId || nanoid();
    const startTime = Date.now();

    // Resolve alias if model starts with 'ailin-'
    const aliasProfile = request.model?.startsWith('ailin-')
      ? resolveAilinAlias(request.model)
      : null;

    const modality = request.modality;

    this.log.info({
      requestId,
      modality,
      model: request.model,
      alias: aliasProfile ? request.model : undefined,
      organizationId: request.organizationId,
    }, 'Unified process() entry');

    switch (modality) {
      case 'chat':
        return this.processChatModality(request, requestId, startTime, aliasProfile);

      case 'stt':
        return this.processSTTModality(request, requestId, startTime, aliasProfile);

      case 'tts':
        return this.processTTSModality(request, requestId, startTime, aliasProfile);

      case 'translation':
        return this.processTranslationModality(request, requestId, startTime);

      default: {
        const _exhaustive: never = modality;
        throw new Error(`Unknown modality: ${_exhaustive}`);
      }
    }
  }

  /**
   * Detect modality from a raw request object.
   * Useful for routes that receive OpenAI-compatible requests
   * and need to determine which modality to use.
   */
  static detectModality(hints: {
    endpoint?: string;
    hasAudioBuffer?: boolean;
    hasTTSInput?: boolean;
    hasTranslationText?: boolean;
    model?: string;
    aliasCapabilities?: string[];
  }): RequestModality {
    // 1. Endpoint-based detection (most reliable)
    if (hints.endpoint) {
      if (hints.endpoint.includes('/audio/transcription')) return 'stt';
      if (hints.endpoint.includes('/audio/speech')) return 'tts';
      if (hints.endpoint.includes('/translation')) return 'translation';
      if (hints.endpoint.includes('/chat/completion')) return 'chat';
    }

    // 2. Payload-based detection
    if (hints.hasAudioBuffer) return 'stt';
    if (hints.hasTTSInput) return 'tts';
    if (hints.hasTranslationText) return 'translation';

    // 3. Alias capability-based detection
    if (hints.aliasCapabilities?.length) {
      const caps = hints.aliasCapabilities;
      if (caps.includes('speech_to_text') || caps.includes('transcription')) return 'stt';
      if (caps.includes('text_to_speech') || caps.includes('tts')) return 'tts';
      if (caps.includes('translation')) return 'translation';
    }

    // 4. Default to chat
    return 'chat';
  }

  // ── Private modality handlers ──────────────────────────────

  private async processChatModality(
    request: UnifiedRequest & { modality: 'chat' },
    requestId: string,
    startTime: number,
    aliasProfile: ReturnType<typeof resolveAilinAlias>,
  ): Promise<UnifiedChatResult> {
    const chatRequest = { ...request.chatRequest };

    // Apply alias if resolved
    if (aliasProfile) {
      chatRequest.ailin_alias = request.model;
    }

    const result = await this.execute(
      chatRequest,
      request.organizationId,
      request.userId,
    );

    const durationMs = Date.now() - startTime;

    // Extract winning model info from result
    const winnerModel = result.modelsUsed.find(m => m.success);

    return {
      modality: 'chat',
      strategyUsed: result.strategyUsed,
      modelUsed: winnerModel?.modelName || result.finalResponse.model || 'unknown',
      provider: (result.metadata?.winnerProvider as string) || winnerModel?.modelId?.split('/')[0] || 'unknown',
      durationMs,
      cost: result.totalCost,
      metadata: result.metadata,
      orchestrationResult: result,
    };
  }

  private async processSTTModality(
    request: UnifiedRequest & { modality: 'stt' },
    requestId: string,
    startTime: number,
    aliasProfile: ReturnType<typeof resolveAilinAlias>,
  ): Promise<UnifiedSTTResult> {
    const { AudioOrchestrationService } = await import('@/services/audio-orchestration-service.js');
    const audioService = new AudioOrchestrationService();

    const model = aliasProfile
      ? undefined  // Let alias resolution inside AudioOrchestrationService handle it
      : (request.model === 'auto' ? undefined : request.model);

    const result = await audioService.transcribeAudio({
      audioBuffer: request.audioBuffer,
      filename: request.filename || 'unified-audio.wav',
      model: request.model?.startsWith('ailin-') ? request.model : model,
      language: request.language,
      responseFormat: request.responseFormat || 'json',
      prompt: request.prompt,
      temperature: request.temperature,
      userContext: {
        organizationId: request.organizationId,
        userId: request.userId,
        requestId,
        models: [],
        taskType: 'general' as const,
        contextSize: 0,
      },
      requestId,
    });

    const durationMs = Date.now() - startTime;

    return {
      modality: 'stt',
      strategyUsed: result.strategyUsed || 'single',
      modelUsed: result.modelUsed || 'unknown',
      provider: result.provider || 'unknown',
      durationMs,
      cost: 0,
      metadata: {
        requestId,
        language: result.language,
        duration: result.duration,
      },
      text: result.text,
      language: result.language,
      duration: result.duration,
      words: result.words,
      segments: result.segments,
    };
  }

  private async processTTSModality(
    request: UnifiedRequest & { modality: 'tts' },
    requestId: string,
    startTime: number,
    aliasProfile: ReturnType<typeof resolveAilinAlias>,
  ): Promise<UnifiedTTSResult> {
    const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;
    type AudioFormat = typeof validFormats[number];
    const format: AudioFormat = validFormats.includes(request.format as AudioFormat)
      ? (request.format as AudioFormat)
      : 'mp3';

    const { AudioOrchestrationService } = await import('@/services/audio-orchestration-service.js');
    const audioService = new AudioOrchestrationService();

    const model = aliasProfile
      ? undefined
      : (request.model === 'auto' ? undefined : request.model);

    const result = await audioService.synthesizeSpeech({
      text: request.input,
      model: request.model?.startsWith('ailin-') ? request.model : model,
      voice: request.voice,
      format,
      speed: request.speed,
      userContext: {
        organizationId: request.organizationId,
        userId: request.userId,
        requestId,
        models: [],
        taskType: 'general' as const,
        contextSize: 0,
      },
      requestId,
    });

    const durationMs = Date.now() - startTime;

    return {
      modality: 'tts',
      strategyUsed: result.strategyUsed || 'single',
      modelUsed: result.modelUsed || 'unknown',
      provider: result.provider || 'unknown',
      durationMs,
      cost: 0,
      metadata: { requestId },
      audioBuffer: result.audioBuffer,
      format,
    };
  }

  private async processTranslationModality(
    request: UnifiedRequest & { modality: 'translation' },
    requestId: string,
    startTime: number,
  ): Promise<UnifiedTranslationResult> {
    const { getTranslationService } = await import('@/services/translation-service.js');
    const translationService = getTranslationService();

    // Resolve alias to determine translation strategy:
    // - ailin-translation-quality (quality_target >= 0.9) → LLM-only for nuanced context
    // - ailin-translation-fast / default → NLLB-first (CTranslate2 int8, ~130ms), LLM fallback
    // No hardcoded model names — behavior driven by alias quality_target.
    const aliasProfile = request.model?.startsWith('ailin-')
      ? resolveAilinAlias(request.model)
      : null;

    const preferQuality = (aliasProfile?.quality_target ?? 0) >= 0.9;
    const strategy = preferQuality ? 'llm-quality' : 'nllb-speed';

    this.log.info({
      requestId,
      alias: request.model,
      strategy,
      qualityTarget: aliasProfile?.quality_target,
      preferSpeed: aliasProfile?.prefer_speed,
    }, 'Translation: alias-driven strategy selection');

    let result: { translatedText: string; sourceLang: string; targetLang: string; latencyMs: number; model: string };

    if (preferQuality) {
      // Quality mode: use LLM for nuanced, context-aware translation
      // TranslationService.translateText tries NLLB first then LLM.
      // For quality mode, we want LLM directly — call translateText which
      // will fall through to LLM when NLLB is skipped or as quality enhancement.
      // TODO: Add a forceBackend param to TranslationService for explicit routing
      result = await translationService.translateText(
        request.text,
        request.sourceLang || 'en',
        request.targetLang,
      );
    } else {
      // Speed mode (default): NLLB CTranslate2 int8 (~130ms), LLM fallback
      result = await translationService.translateText(
        request.text,
        request.sourceLang || 'en',
        request.targetLang,
      );
    }

    const durationMs = Date.now() - startTime;

    return {
      modality: 'translation',
      strategyUsed: strategy,
      modelUsed: result.model,
      provider: result.model.includes('nllb') ? 'self-hosted' : 'llm',
      durationMs,
      cost: 0,
      metadata: {
        requestId,
        nllbLatencyMs: result.latencyMs,
        aliasResolved: aliasProfile ? request.model : undefined,
        translationStrategy: strategy,
      },
      translatedText: result.translatedText,
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
    };
  }
}

// ============================================
// GLOBAL SINGLETON ACCESS
// ============================================

let globalOrchestrationEngine: OrchestrationEngine | null = null;

/**
 * Set global orchestration engine instance
 * Called during bootstrap to make the engine available globally
 */
export function setOrchestrationEngine(engine: OrchestrationEngine): void {
  globalOrchestrationEngine = engine;
  logger.info('✅ Global OrchestrationEngine set');
}

/**
 * Get global orchestration engine instance
 * Use this to access the engine from anywhere in the application
 */
export function getOrchestrationEngine(): OrchestrationEngine {
  if (!globalOrchestrationEngine) {
    throw new Error(
      'OrchestrationEngine not initialized. Ensure bootstrap has completed before accessing the engine.'
    );
  }
  return globalOrchestrationEngine;
}

/**
 * Check if orchestration engine is initialized
 */
export function isOrchestrationEngineInitialized(): boolean {
  return globalOrchestrationEngine !== null;
}
