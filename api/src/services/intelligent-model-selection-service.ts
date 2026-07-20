// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Intelligent Model Selection Service
 *
 * Implements dynamic, capability-based model selection with:
 * - Input enrichment triage using fast reasoning models
 * - Capability-based filtering across ALL available models
 * - Provider-specific tool schema adaptation
 * - Unlimited fallback attempts based on capability matching
 * - Detailed provider-specific error logging
 *
 * This is the "ailin¹ brain" - the first line of reasoning that understands,
 * enriches user input, and selects the best models for execution.
 */

import { logger } from '@/utils/logger';
import { type ChatRequest, type ChatResponse, type Model, type ModelCapability, ensureModelCapabilityArray } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry } from '@/providers/provider-registry.js';
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service.js';
import { providerAvailabilityService, type ProviderStatus } from '@/services/provider-availability-service';
import { nanoid } from 'nanoid';
import { LRUCache } from 'lru-cache';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface CapabilityRequirements {
  required: ModelCapability[];
  preferred: ModelCapability[];
  taskType: string;
  complexity: 'simple' | 'moderate' | 'complex' | 'expert';
  contextSize: number;
  needsTools: boolean;
  toolCount: number;
}

export interface EnrichedInput {
  originalInput: string;
  enrichedInput: string;
  detectedIntent: string;
  suggestedCapabilities: ModelCapability[];
  suggestedTaskType: string;
  complexity: 'simple' | 'moderate' | 'complex' | 'expert';
  confidence: number;
  triageModelsUsed: string[];
  crossValidated: boolean;
}

export interface ModelCandidate {
  model: Model;
  adapter: ProviderAdapter;
  score: number;
  matchedCapabilities: ModelCapability[];
  missingCapabilities: ModelCapability[];
  reason: string;
}

/**
 * Per-provider scored result cached by the model-scoring hot-path memoization.
 * `candidates` is the score>0 subset for this provider; `evaluated` is the raw
 * count of models scanned (score>0 or not). Availability is NOT applied here —
 * it is filtered live per request (see `collectModelCandidates`).
 */
interface ProviderScoredEntry {
  candidates: ModelCandidate[];
  evaluated: number;
}

/** Provider -> scored entry, in adapter-registry insertion order. */
type ScoredProviderMap = Map<string, ProviderScoredEntry>;

/**
 * Minimal availability surface consumed by the scoring hot path. Injected so
 * the scoring/filter logic can be unit-tested without the full provider
 * registry / env-driven availability singleton. Defaults to the real
 * `providerAvailabilityService` singleton in production.
 */
interface ProviderAvailabilityChecker {
  isProviderUsable(provider: string): boolean;
  getStatus(provider: string): ProviderStatus | undefined;
}

export interface SelectionResult {
  candidates: ModelCandidate[];
  primaryCandidate: ModelCandidate | null;
  triageResult?: EnrichedInput;
  totalModelsEvaluated: number;
  totalModelsMatched: number;
  selectionTime: number;
}

export interface ExecutionAttempt {
  provider: string;
  model: string;
  modelId: string;
  success: boolean;
  error?: string;
  errorCode?: string;
  errorType?: string;
  latencyMs: number;
  attemptNumber: number;
  capabilities: ModelCapability[];
}

export interface IntelligentExecutionResult {
  success: boolean;
  response?: ChatResponse;
  attempts: ExecutionAttempt[];
  finalProvider?: string;
  finalModel?: string;
  totalLatencyMs: number;
  modelsAttempted: number;
  triageResult?: EnrichedInput;
  /** Canonical-engine cost accounting (triage + judge + synth folded into the
   *  request total). Populated when execution delegates to the orchestration
   *  engine (2026-06-11 demotion). Surfaced in the route's `_execution` block. */
  costUsd?: number;
  /** Names of every model the canonical engine executed (primary + fallbacks). */
  modelsUsed?: string[];
}

// ============================================================================
// Tool Schema Adapters by Provider
// ============================================================================

import type { Tool } from '@/types';

interface ToolSchemaAdapter {
  adaptTools(tools: Tool[]): Array<Record<string, unknown>>;
  validateSchema(tool: Tool): { valid: boolean; errors: string[] };
}

// Helper functions for schema adaptation
function adaptSchemaForAnthropic(params: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!params || Object.keys(params).length === 0) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }
  return params;
}

function adaptSchemaForGoogle(params: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!params || !params.properties || Object.keys(params.properties).length === 0) {
    return {
      type: 'object',
      properties: {
        _unused: { type: 'string', description: 'Unused parameter' },
      },
    };
  }
  return params;
}

interface JSONSchemaProperty {
  type?: string;
  description?: string;
}

interface JSONSchemaParams {
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

function convertToCohereParams(params: JSONSchemaParams | null | undefined): Record<string, { type: string; description: string; required: boolean }> {
  if (!params?.properties) return {};
  const result: Record<string, { type: string; description: string; required: boolean }> = {};
  for (const [key, value] of Object.entries(params.properties)) {
    const prop: JSONSchemaProperty = value;
    result[key] = {
      type: prop.type || 'string',
      description: prop.description || '',
      required: params.required?.includes(key) || false,
    };
  }
  return result;
}

function adaptToolsForOpenAI(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map(tool => {
    const params = tool.function?.parameters || {};
    if (params.type === 'object' && (!params.properties || Object.keys(params.properties).length === 0)) {
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: {
            type: 'object',
            properties: {
              _placeholder: {
                type: 'boolean',
                description: 'No parameters required',
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
      } as Record<string, unknown>;
    }
    // Convert Tool to Record<string, unknown> by creating a new object
    const toolRecord: Record<string, unknown> = {
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    };
    return toolRecord;
  });
}

function validateOpenAISchema(tool: Tool): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const params = tool.function?.parameters;
  if (params && params.type === 'object') {
    if (!params.properties || Object.keys(params.properties).length === 0) {
      errors.push(`Tool ${tool.function?.name}: OpenAI requires non-empty properties object`);
    }
  }
  return { valid: errors.length === 0, errors };
}

const toolSchemaAdapters: Record<string, ToolSchemaAdapter> = {
  openai: {
    adaptTools: adaptToolsForOpenAI,
    validateSchema: validateOpenAISchema,
  },

  anthropic: {
    adaptTools(tools: Tool[]) {
      return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: adaptSchemaForAnthropic(tool.function.parameters),
      }));
    },
    validateSchema() {
      return { valid: true, errors: [] };
    },
  },

  google: {
    adaptTools(tools: Tool[]) {
      return tools.map(tool => ({
        function_declarations: [{
          name: tool.function.name,
          description: tool.function.description,
          parameters: adaptSchemaForGoogle(tool.function.parameters),
        }],
      }));
    },
    validateSchema() {
      return { valid: true, errors: [] };
    },
  },

  mistral: {
    adaptTools: adaptToolsForOpenAI,
    validateSchema: validateOpenAISchema,
  },

  deepseek: {
    adaptTools: adaptToolsForOpenAI,
    validateSchema: validateOpenAISchema,
  },

  xai: {
    adaptTools: adaptToolsForOpenAI,
    validateSchema: validateOpenAISchema,
  },

  cohere: {
    adaptTools(tools: Tool[]) {
      return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameter_definitions: convertToCohereParams(tool.function.parameters),
      }));
    },
    validateSchema() {
      return { valid: true, errors: [] };
    },
  },

  default: {
    adaptTools(tools: Tool[]): Array<Record<string, unknown>> {
      return tools.map(tool => {
        // Convert Tool to Record<string, unknown> by creating a new object
        return {
          type: tool.type,
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          },
        };
      });
    },
    validateSchema() {
      return { valid: true, errors: [] };
    },
  },
};

function getToolAdapter(providerName: string): ToolSchemaAdapter {
  const normalizedName = providerName.toLowerCase().replace(/[_-]/g, '');
  return toolSchemaAdapters[normalizedName] || toolSchemaAdapters.default;
}

// ============================================================================
// Main Service
// ============================================================================

export class IntelligentModelSelectionService {
  private log = logger.child({ service: 'intelligent-model-selection' });
  private triageCache = new Map<string, EnrichedInput>();

  /**
   * Memoizes the O(N) model-catalog scoring (all providers x all models) OFF
   * the request hot path. `evaluateModel` is a PURE function of static model
   * attributes and (requiredCapabilities, preferredCapabilities,
   * requirements.contextSize), so the scored per-provider map is fully keyed by
   * those inputs. Availability is NOT part of the key — it is applied live per
   * request so a provider going down/up is reflected without a rebuild. The
   * catalog changes on the order of minutes, so a short TTL plus explicit
   * invalidation on discovery refresh keeps scores fresh.
   */
  private readonly scoredCandidateCache = new LRUCache<string, ScoredProviderMap>({
    max: 500,
    ttl: Number(process.env.MODEL_SCORING_CACHE_TTL_MS) || 60_000,
  });

  /** Live provider-availability checker (injectable for tests). */
  private readonly availability: ProviderAvailabilityChecker;

  // Fast models for triage (will be discovered dynamically)
  private readonly FAST_MODEL_KEYWORDS = ['mini', 'flash', 'haiku', 'instant', 'turbo', 'fast'];
  private readonly MAX_TRIAGE_MODELS = 3;

  constructor(availability: ProviderAvailabilityChecker = providerAvailabilityService) {
    this.availability = availability;
  }

  /**
   * Analyze input and determine capability requirements
   */
  async analyzeRequirements(request: ChatRequest): Promise<CapabilityRequirements> {
    const content = this.extractContent(request);
    const contextSize = this.estimateContextSize(request);
    const toolCount = request.tools?.length || 0;

    // Detect complexity
    const complexity = this.detectComplexity(content, contextSize, toolCount);

    // Detect required capabilities - baseline chat/text generation support
    const required: ModelCapability[] = ['chat', 'text_generation'];
    const preferred: ModelCapability[] = [];

    // Always need basic capabilities
    if (request.stream) required.push('streaming');
    if (toolCount > 0) required.push('function_calling', 'tool_use');

    // Detect from content
    if (this.containsCodePatterns(content)) {
      required.push('code_generation');
      preferred.push('code_completion', 'debugging');
    }

    if (this.containsAnalysisPatterns(content)) {
      preferred.push('analysis', 'reasoning');
    }

    if (this.containsVisionPatterns(request)) {
      required.push('vision', 'multimodal');
    }

    // Detect task type
    const taskType = this.detectTaskType(content, request.task_type);

    return {
      required,
      preferred,
      taskType,
      complexity,
      contextSize,
      needsTools: toolCount > 0,
      toolCount,
    };
  }

  /**
   * Perform input enrichment triage using fast models
   * Uses up to 3 fast reasoning models with cross-validation
   */
  async performInputTriage(
    request: ChatRequest,
    requirements: CapabilityRequirements
  ): Promise<EnrichedInput | null> {
    // Skip triage for simple requests
    if (requirements.complexity === 'simple') {
      this.log.debug('Skipping triage for simple request');
      return null;
    }

    const content = this.extractContent(request);
    const cacheKey = this.generateCacheKey(content);

    // Check cache
    if (this.triageCache.has(cacheKey)) {
      this.log.debug('Using cached triage result');
      return this.triageCache.get(cacheKey)!;
    }

    this.log.info({ complexity: requirements.complexity }, 'Starting input triage with fast models');

    try {
      // Find fast models for triage
      const fastModels = await this.findFastModels();

      if (fastModels.length === 0) {
        this.log.warn('No fast models available for triage, skipping');
        return null;
      }

      // Select up to 3 models for cross-validation
      const triageModels = fastModels.slice(0, this.MAX_TRIAGE_MODELS);
      const triageResults: Array<{
        model: string;
        capabilities: ModelCapability[];
        taskType: string;
        complexity: string;
        confidence: number;
      }> = [];

      // Query each triage model in parallel
      const triagePromises = triageModels.map(async ({ model, adapter }) => {
        try {
          const triagePrompt = this.buildTriagePrompt(content, requirements);
          const response = await adapter.chatCompletion({
            model: model.id,
            messages: [{ role: 'user', content: triagePrompt }],
            temperature: 0.1,
            max_tokens: 500,
          });

          const analysis = this.parseTriageResponse(response);
          return {
            model: model.id,
            ...analysis,
          };
        } catch (error) {
          this.log.warn({ model: model.id, error }, 'Triage model failed');
          return null;
        }
      });

      const results = await Promise.all(triagePromises);
      triageResults.push(...results.filter((r): r is NonNullable<typeof r> => r !== null));

      if (triageResults.length === 0) {
        this.log.warn('All triage models failed');
        return null;
      }

      // Cross-validate and merge results
      const enrichedInput = this.crossValidateTriageResults(content, triageResults);
      enrichedInput.triageModelsUsed = triageResults.map(r => r.model);
      enrichedInput.crossValidated = triageResults.length >= 2;

      // Cache result
      this.triageCache.set(cacheKey, enrichedInput);

      this.log.info({
        modelsUsed: enrichedInput.triageModelsUsed,
        suggestedCapabilities: enrichedInput.suggestedCapabilities,
        taskType: enrichedInput.suggestedTaskType,
        confidence: enrichedInput.confidence,
      }, 'Input triage completed');

      return enrichedInput;
    } catch (error) {
      this.log.error({ error }, 'Input triage failed');
      return null;
    }
  }

  /**
   * Select ALL capable models based on requirements
   * No artificial limits - filters based on capability matching
   */
  async selectCapableModels(
    requirements: CapabilityRequirements,
    triageResult?: EnrichedInput | null
  ): Promise<SelectionResult> {
    const startTime = Date.now();
    const requestId = nanoid(8);

    this.log.info({
      requestId,
      requiredCapabilities: requirements.required,
      preferredCapabilities: requirements.preferred,
      taskType: requirements.taskType,
      complexity: requirements.complexity,
    }, 'Starting capability-based model selection');

    try {
      const registry = getProviderRegistry();
      const allAdapters = registry.getAll();

      // Merge triage suggestions with requirements
      const effectiveRequired = [...requirements.required];
      const effectivePreferred = [...requirements.preferred];

      if (triageResult) {
        for (const cap of triageResult.suggestedCapabilities) {
          if (!effectiveRequired.includes(cap) && !effectivePreferred.includes(cap)) {
            effectivePreferred.push(cap);
          }
        }
      }

      let { candidates, evaluated } = await this.collectModelCandidates(
        allAdapters,
        effectiveRequired,
        effectivePreferred,
        requirements
      );
      let totalModelsEvaluated = evaluated;

      if (candidates.length === 0) {
        this.log.warn(
          {
            requestId,
            requiredCapabilities: effectiveRequired,
          },
          'No catalog candidates found. Forcing real-time model discovery.'
        );

        await this.forceProviderRefresh(effectiveRequired);

        const refreshed = await this.collectModelCandidates(
          allAdapters,
          effectiveRequired,
          effectivePreferred,
          requirements
        );

        totalModelsEvaluated += refreshed.evaluated;
        candidates = refreshed.candidates;
      }

      // Sort by score (descending)
      candidates.sort((a, b) => b.score - a.score);

      const selectionTime = Date.now() - startTime;

      this.log.info({
        requestId,
        totalModelsEvaluated,
        totalModelsMatched: candidates.length,
        topCandidates: candidates.slice(0, 5).map(c => ({
          model: c.model.id,
          provider: c.model.provider,
          score: c.score,
          reason: c.reason,
        })),
        selectionTime,
      }, 'Model selection completed');

      return {
        candidates,
        primaryCandidate: candidates[0] || null,
        triageResult: triageResult || undefined,
        totalModelsEvaluated,
        totalModelsMatched: candidates.length,
        selectionTime,
      };
    } catch (error) {
      this.log.error({ error }, 'Model selection failed');
      return {
        candidates: [],
        primaryCandidate: null,
        totalModelsEvaluated: 0,
        totalModelsMatched: 0,
        selectionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute request with intelligent fallback across ALL capable models
   */
  async executeWithIntelligentFallback(
    request: ChatRequest,
    selection: SelectionResult,
    organizationId: string,
    userId?: string,
    requiredCapabilities?: ModelCapability[]
  ): Promise<IntelligentExecutionResult> {
    const startTime = Date.now();
    const requestId = nanoid(8);

    const primary = selection.primaryCandidate;
    if (!primary || selection.candidates.length === 0) {
      this.log.error({ requestId }, 'No capable models found for request');
      return {
        success: false,
        attempts: [],
        totalLatencyMs: Date.now() - startTime,
        modelsAttempted: 0,
        triageResult: selection.triageResult,
      };
    }

    // DEMOTED (2026-06-11, DUP #1): execution now delegates to the canonical
    // orchestration engine instead of a private adapter-fallback loop. The
    // capability-matching layer still chooses the model (primaryCandidate, set
    // as request.model below); the engine supplies the unified cost accounting
    // (triage + judge + synth folded into totalCost + cost_breakdown) and the
    // cross-provider resilience (empty-response recovery, health-aware routing)
    // the private loop lacked. This removes the shadow execution engine that
    // previously served /v1/chat/completions/intelligent without those
    // guarantees. Dynamic import avoids a load-time cycle with the engine.
    const { getOrchestrationEngine } = await import(
      '@/core/orchestration/orchestration-engine.js'
    );
    const engine = getOrchestrationEngine();
    const engineRequest: ChatRequest = {
      ...request,
      // Capability-matching FILTERS, it does NOT PIN (DUP #1 canary fix,
      // 2026-06-11): pinning the single top capability-match +
      // user_specified_model broke under provider scarcity — the top match is
      // often a dead gateway that nominally supports every capability, and
      // pinning disables the engine's fallback chain. Pass the required
      // capabilities so the engine's HEALTH-AWARE selector picks a healthy
      // capable model and retains its full cross-provider fallback.
      model: request.model && request.model.trim() && request.model !== 'auto'
        ? request.model
        : 'auto',
      ...(requiredCapabilities && requiredCapabilities.length
        ? { requiredCapabilities }
        : {}),
    };

    this.log.info(
      {
        requestId,
        totalCandidates: selection.candidates.length,
        capabilityPrimary: primary.model.id,
        requiredCapabilities: requiredCapabilities ?? [],
      },
      'Delegating intelligent execution to canonical orchestration engine (health-aware selection)'
    );

    try {
      const result = await engine.execute(engineRequest, organizationId, userId);
      const attempts: ExecutionAttempt[] = result.modelsUsed.map((m, i) => ({
        provider: this.providerOfModelId(m.modelId, primary.model.provider),
        model: m.modelName,
        modelId: m.modelId,
        success: m.success,
        error: m.error,
        latencyMs: m.durationMs,
        attemptNumber: i + 1,
        capabilities: primary.matchedCapabilities,
      }));

      const primaryExec =
        result.modelsUsed.find((m) => m.success && m.role === 'primary') ??
        result.modelsUsed.find((m) => m.success) ??
        result.modelsUsed[0];
      const succeeded =
        !!primaryExec?.success && this.hasUsableResponseContent(result.finalResponse);

      if (!succeeded) {
        this.log.warn(
          { requestId, modelsAttempted: result.modelsUsed.length },
          'Canonical engine produced no usable response for intelligent request'
        );
        return {
          success: false,
          attempts,
          totalLatencyMs: Date.now() - startTime,
          modelsAttempted: result.modelsUsed.length,
          triageResult: selection.triageResult,
        };
      }

      this.log.info(
        {
          requestId,
          finalModel: primaryExec?.modelId,
          modelsAttempted: result.modelsUsed.length,
          costUsd: result.totalCost,
        },
        'Intelligent execution succeeded via canonical engine'
      );

      return {
        success: true,
        response: result.finalResponse,
        attempts,
        finalProvider: this.providerOfModelId(primaryExec?.modelId, primary.model.provider),
        finalModel: primaryExec?.modelId ?? primary.model.id,
        totalLatencyMs: Date.now() - startTime,
        modelsAttempted: result.modelsUsed.length,
        triageResult: selection.triageResult,
        costUsd: result.totalCost,
        modelsUsed: result.modelsUsed.map((m) => m.modelName),
      };
    } catch (error) {
      const errorInfo = this.parseProviderError(error, primary.model.provider);
      this.log.error(
        { requestId, error: errorInfo.message },
        'Canonical engine execution failed for intelligent request'
      );
      return {
        success: false,
        attempts: [
          {
            provider: primary.model.provider,
            model: primary.model.name,
            modelId: primary.model.id,
            success: false,
            error: errorInfo.message,
            errorCode: errorInfo.code,
            errorType: errorInfo.type,
            latencyMs: Date.now() - startTime,
            attemptNumber: 1,
            capabilities: primary.matchedCapabilities,
          },
        ],
        totalLatencyMs: Date.now() - startTime,
        modelsAttempted: 0,
        triageResult: selection.triageResult,
      };
    }
  }

  /**
   * Execute streaming request with intelligent fallback
   */
  // NOT demoted (2026-06-11, DUP #1): streaming stays on the direct
  // adapter.chatCompletionStream fallback loop. The canonical engine's
  // executeStream is NOT a clean streaming path for every adapter — a canary
  // showed it routing through the OpenRouter adapter's NON-streaming
  // chatCompletion, which then fails to JSON-parse the SSE body
  // ("Unexpected token 'd', \"data: {...\"). Until that engine/adapter
  // streaming bug is fixed, true token streaming for /v1/chat/completions/
  // intelligent is more reliable here. Only the non-streaming path
  // (executeWithIntelligentFallback) was demoted to the engine.
  async *executeStreamingWithFallback(
    request: ChatRequest,
    selection: SelectionResult
  ): AsyncGenerator<ChatResponse, IntelligentExecutionResult, undefined> {
    const startTime = Date.now();
    const attempts: ExecutionAttempt[] = [];
    const requestId = nanoid(8);

    if (selection.candidates.length === 0) {
      this.log.error({ requestId }, 'No capable models found for streaming request');
      return {
        success: false,
        attempts: [],
        totalLatencyMs: Date.now() - startTime,
        modelsAttempted: 0,
        triageResult: selection.triageResult,
      };
    }

    for (let i = 0; i < selection.candidates.length; i++) {
      const candidate = selection.candidates[i];
      const attemptStart = Date.now();
      const attemptNumber = i + 1;
      const providerName = candidate.model.provider;

      const providerStatus = providerAvailabilityService.getStatus(providerName);
      if (!providerAvailabilityService.isProviderUsable(providerName)) {
        attempts.push({
          provider: providerName,
          model: candidate.model.name,
          modelId: candidate.model.id,
          success: false,
          error: providerStatus?.reason || 'Provider unavailable',
          errorCode: providerStatus?.status,
          errorType: 'ProviderUnavailable',
          latencyMs: 0,
          attemptNumber,
          capabilities: candidate.matchedCapabilities,
        });
        this.log.warn(
          {
            requestId,
            attemptNumber,
            provider: providerName,
            status: providerStatus?.status,
            reason: providerStatus?.reason,
          },
          'Skipping streaming candidate because provider is unavailable'
        );
        continue;
      }

      this.log.info({
        requestId,
        attemptNumber,
        provider: providerName,
        model: candidate.model.id,
      }, 'Starting streaming attempt');

      try {
        const adaptedRequest = this.adaptRequestForProvider(request, candidate);
        adaptedRequest.stream = true;

        const stream = candidate.adapter.chatCompletionStream(adaptedRequest);
        let chunkCount = 0;
        let firstChunkReceived = false;

        for await (const chunk of stream) {
          chunkCount++;
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            this.log.debug({
              requestId,
              attemptNumber,
              provider: providerName,
            }, 'First chunk received');
          }
          yield chunk;
        }

        const latencyMs = Date.now() - attemptStart;

        attempts.push({
          provider: providerName,
          model: candidate.model.name,
          modelId: candidate.model.id,
          success: true,
          latencyMs,
          attemptNumber,
          capabilities: candidate.matchedCapabilities,
        });

        providerAvailabilityService.markAvailable(providerName);

        this.log.info({
          requestId,
          attemptNumber,
          provider: providerName,
          model: candidate.model.id,
          chunkCount,
          latencyMs,
        }, 'Streaming completed successfully');

        return {
          success: true,
          attempts,
          finalProvider: providerName,
          finalModel: candidate.model.id,
          totalLatencyMs: Date.now() - startTime,
          modelsAttempted: attemptNumber,
          triageResult: selection.triageResult,
        };
      } catch (error) {
        const latencyMs = Date.now() - attemptStart;
        const errorInfo = this.parseProviderError(error, providerName);

        attempts.push({
          provider: providerName,
          model: candidate.model.name,
          modelId: candidate.model.id,
          success: false,
          error: errorInfo.message,
          errorCode: errorInfo.code,
          errorType: errorInfo.type,
          latencyMs,
          attemptNumber,
          capabilities: candidate.matchedCapabilities,
        });

        if (this.isCredentialError(errorInfo)) {
          providerAvailabilityService.markInvalidCredentials(providerName, errorInfo.message);
        } else if (this.isProviderAvailabilityError(errorInfo)) {
          providerAvailabilityService.markDegraded(providerName, errorInfo.message);
        } else if (this.isModelAvailabilityError(errorInfo)) {
          this.log.info(
            {
              requestId,
              provider: providerName,
              model: candidate.model.id,
              error: errorInfo.message,
            },
            'Model-specific availability error detected; keeping provider available for next candidates'
          );
        }

        this.log.warn({
          requestId,
          attemptNumber,
          provider: providerName,
          error: errorInfo.message,
          errorCode: errorInfo.code,
        }, 'Streaming attempt failed');
      }
    }

    return {
      success: false,
      attempts,
      totalLatencyMs: Date.now() - startTime,
      modelsAttempted: attempts.length,
      triageResult: selection.triageResult,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /** Derive a provider name from a namespaced model id ("openai/gpt-5.4-mini"
   *  → "openai"). `ModelExecution` carries no explicit provider field, so the
   *  canonical-engine delegation maps it back from the id, falling back to the
   *  capability-matched candidate's provider. */
  private providerOfModelId(modelId?: string, fallback?: string): string {
    if (modelId && modelId.includes('/')) {
      const head = modelId.split('/')[0];
      if (head) return head;
    }
    return fallback ?? 'unknown';
  }

  /** True when the engine's final response carries real assistant content —
   *  guards against the graceful "[DEGRADED]" placeholder (which is a 200 with
   *  no successful execution) being reported as a success. */
  private hasUsableResponseContent(response?: ChatResponse): boolean {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed.length > 0 && !trimmed.startsWith('[DEGRADED]');
    }
    return Array.isArray(content) ? content.length > 0 : false;
  }

  private extractContent(request: ChatRequest): string {
    return request.messages
      ?.map(m => typeof m.content === 'string' ? m.content : '')
      .join('\n') || '';
  }

  private estimateContextSize(request: ChatRequest): number {
    const content = this.extractContent(request);
    // Rough estimate: 4 chars per token
    return Math.ceil(content.length / 4);
  }

  private detectComplexity(
    content: string,
    contextSize: number,
    toolCount: number
  ): 'simple' | 'moderate' | 'complex' | 'expert' {
    if (contextSize < 500 && toolCount === 0 && content.length < 200) {
      return 'simple';
    }
    if (contextSize < 2000 && toolCount <= 3) {
      return 'moderate';
    }
    if (contextSize < 10000 && toolCount <= 10) {
      return 'complex';
    }
    return 'expert';
  }

  private containsCodePatterns(content: string): boolean {
    const codePatterns = [
      /```[\s\S]*?```/,
      /\b(function|class|const|let|var|def|import|export)\b/,
      /\.(ts|js|py|java|go|rs|cpp|c|rb|php)\b/,
      /\b(code|implement|debug|refactor|fix|bug)\b/i,
    ];
    return codePatterns.some(p => p.test(content));
  }

  private containsAnalysisPatterns(content: string): boolean {
    const analysisPatterns = [
      /\b(analyze|analysis|explain|understand|review|evaluate)\b/i,
      /\b(why|how|what.*reason|compare|contrast)\b/i,
      /\b(analisa|analisar|análise|analise|avaliar|avaliação|avaliacao|comparar|comparativo|diagnosticar|investigar|risco|riscos)\b/i,
    ];
    return analysisPatterns.some(p => p.test(content));
  }

  private containsVisionPatterns(request: ChatRequest): boolean {
    return request.messages?.some(m => {
      if (Array.isArray(m.content)) {
        return m.content.some(c => c.type === 'image_url');
      }
      return false;
    }) || false;
  }

  private detectTaskType(content: string, explicitType?: string): string {
    if (explicitType) return explicitType;

    // Order matters - more specific patterns first
    const taskPatterns: Record<string, RegExp[]> = {
      // Testing patterns - check before code-generation since "generate tests" is testing
      'testing': [
        /\b(unit|integration|e2e|end-to-end)\s*test/i,
        /\bgenerate\s+(tests?|specs?)\b/i,
        /\bwrite\s+tests?\s+for\b/i,
        /\btest\s+(coverage|suite|case)/i,
      ],
      // Code generation patterns
      'code-generation': [
        /\b(create|write|implement|generate|build)\s+(a|an|the)?\s*(code|function|class|api|app|script|module)/i,
        /\bcreate\s+(a|an)?\s*\w+\s*(in|using|with)\s*(node|python|typescript|javascript|go|rust)/i,
      ],
      // Debugging patterns
      'debugging': [
        /\b(debug|fix|error|bug|issue|problem)\b/i,
        /\bwhy\s+(is|does|isn't|doesn't)\b.*\b(work|return|fail)/i,
      ],
      // Refactoring patterns
      'refactoring': [
        /\b(refactor|improve|optimize|clean\s*up)\b/i,
        /\bmake\s+(this|the|it)\s+(more|better|cleaner)/i,
      ],
      // Code review patterns
      'code-review': [
        /\breview\s+(this|the|my)?\s*(code|pull\s*request|pr|implementation)/i,
        /\bcheck\s+(this|the|my)?\s*(code|implementation)\s+for/i,
        /\baudit\s+(this|the|my)?\s*(code|codebase)/i,
      ],
      // Documentation patterns  
      'documentation': [
        /\b(write|create|generate)\s+(documentation|docs|readme)/i,
        /\bdocument\s+(this|the|my)/i,
        /\badd\s+comments?\s+to/i,
      ],
      // Analysis patterns - must reference code/architecture/system/performance
      'analysis': [
        /\banalyze\s+(this|the|my)\s*(code|architecture|system|implementation|codebase|function|class|performance)/i,
        /\bexplain\s+(how|why)\s+(this|the|my)\s*(code|function|system|works)/i,
        /\bunderstand\s+(this|the)\s*(code|implementation|architecture|flow)/i,
        /\bwhat\s+(is|are|does)\s+(this|the)\s*(code|function|method|class)\b/i,
      ],
    };

    for (const [taskType, patterns] of Object.entries(taskPatterns)) {
      if (patterns.some(p => p.test(content))) {
        return taskType;
      }
    }

    return 'general';
  }

  private async findFastModels(): Promise<Array<{ model: Model; adapter: ProviderAdapter }>> {
    const registry = getProviderRegistry();
    const allAdapters = registry.getAll();
    const fastModels: Array<{ model: Model; adapter: ProviderAdapter }> = [];

    for (const adapter of allAdapters) {
      try {
        const models = await adapter.getModels();

        for (const model of models) {
          const nameLower = model.name.toLowerCase();
          const isFast = this.FAST_MODEL_KEYWORDS.some(k => nameLower.includes(k));

          if (isFast && model.capabilities?.includes('chat')) {
            fastModels.push({ model, adapter });
          }
        }
      } catch {
        // Skip failed providers
      }
    }

    // Sort by estimated speed (smaller context = faster)
    fastModels.sort((a, b) => (a.model.contextWindow || 0) - (b.model.contextWindow || 0));

    return fastModels;
  }

  private buildTriagePrompt(content: string, requirements: CapabilityRequirements): string {
    const requiredCaps = requirements.required.length > 0 ? requirements.required.join(', ') : 'none';
    const preferredCaps = requirements.preferred.length > 0 ? requirements.preferred.join(', ') : 'none';
    const toolHint = requirements.needsTools
      ? `Tools required (~${requirements.toolCount}): yes`
      : 'Tools required: no';

    return `Analyze this user request and determine the best approach.

Execution context:
- Task type hint: ${requirements.taskType}
- Complexity hint: ${requirements.complexity}
- Required capabilities: ${requiredCaps}
- Preferred capabilities: ${preferredCaps}
- Context size: ${requirements.contextSize} tokens
- ${toolHint}

USER REQUEST:
${content.slice(0, 2000)}

Based on this request, provide a brief JSON response with:
{
  "detected_intent": "brief description of what user wants",
  "suggested_capabilities": ["list", "of", "needed", "capabilities"],
  "task_type": "one of: code-generation, debugging, refactoring, analysis, documentation, testing, general",
  "complexity": "one of: simple, moderate, complex, expert",
  "confidence": 0.0 to 1.0
}

Capabilities to consider: code_generation, debugging, refactoring, analysis, reasoning, vision, multimodal, function_calling, streaming, code_completion, documentation, testing

Respond ONLY with the JSON, no other text.`;
  }

  private parseTriageResponse(response: ChatResponse): {
    capabilities: ModelCapability[];
    taskType: string;
    complexity: string;
    confidence: number;
  } {
    try {
      const rawContent = response.choices?.[0]?.message?.content || '';
      const content = typeof rawContent === 'string' ? rawContent : '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { capabilities: [], taskType: 'general', complexity: 'moderate', confidence: 0.5 };
      }

      // JSON.parse returns `unknown` — narrow each accessed field structurally.
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      const obj: { suggested_capabilities?: unknown; task_type?: unknown; complexity?: unknown; confidence?: unknown } =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { suggested_capabilities?: unknown; task_type?: unknown; complexity?: unknown; confidence?: unknown })
          : {};
      return {
        capabilities: ensureModelCapabilityArray(obj.suggested_capabilities),
        taskType: typeof obj.task_type === 'string' && obj.task_type.length > 0 ? obj.task_type : 'general',
        complexity: typeof obj.complexity === 'string' && obj.complexity.length > 0 ? obj.complexity : 'moderate',
        confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
      };
    } catch {
      return { capabilities: [], taskType: 'general', complexity: 'moderate', confidence: 0.5 };
    }
  }

  private crossValidateTriageResults(
    originalContent: string,
    results: Array<{
      model: string;
      capabilities: ModelCapability[];
      taskType: string;
      complexity: string;
      confidence: number;
    }>
  ): EnrichedInput {
    // Count capability votes
    const capabilityVotes = new Map<ModelCapability, number>();
    const taskTypeVotes = new Map<string, number>();
    const complexityVotes = new Map<string, number>();
    let totalConfidence = 0;

    for (const result of results) {
      for (const cap of result.capabilities) {
        capabilityVotes.set(cap, (capabilityVotes.get(cap) || 0) + 1);
      }
      taskTypeVotes.set(result.taskType, (taskTypeVotes.get(result.taskType) || 0) + 1);
      complexityVotes.set(result.complexity, (complexityVotes.get(result.complexity) || 0) + 1);
      totalConfidence += result.confidence;
    }

    // Select capabilities with majority vote (at least 50%)
    const threshold = results.length / 2;
    const suggestedCapabilities: ModelCapability[] = [];
    for (const [cap, votes] of capabilityVotes.entries()) {
      if (votes >= threshold) {
        suggestedCapabilities.push(cap);
      }
    }

    // Select most voted task type and complexity
    const suggestedTaskType = [...taskTypeVotes.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';
    const suggestedComplexity = [...complexityVotes.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'moderate';

    // Map complexity levels to expected type
    const complexityMap: Record<string, 'expert' | 'simple' | 'complex' | 'moderate'> = {
      low: 'simple',
      medium: 'moderate',
      high: 'complex',
      expert: 'expert',
      simple: 'simple',
      complex: 'complex',
      moderate: 'moderate',
    };
    const mappedComplexity = complexityMap[suggestedComplexity] || 'moderate';

    return {
      originalInput: originalContent,
      enrichedInput: originalContent, // Could be enhanced in future
      detectedIntent: `Task type: ${suggestedTaskType}`,
      suggestedCapabilities,
      suggestedTaskType,
      complexity: mappedComplexity,
      confidence: totalConfidence / results.length,
      triageModelsUsed: [],
      crossValidated: false,
    };
  }

  private evaluateModel(
    model: Model,
    adapter: ProviderAdapter,
    requiredCapabilities: ModelCapability[],
    preferredCapabilities: ModelCapability[],
    requirements: CapabilityRequirements
  ): ModelCandidate {
    const modelCapabilities = ensureModelCapabilityArray(model.capabilities);
    const matchedRequired: ModelCapability[] = [];
    const missingRequired: ModelCapability[] = [];
    const matchedPreferred: ModelCapability[] = [];

    // Check required capabilities
    for (const cap of requiredCapabilities) {
      if (modelCapabilities.includes(cap)) {
        matchedRequired.push(cap);
      } else {
        missingRequired.push(cap);
      }
    }

    // If missing required capabilities, score is 0
    if (missingRequired.length > 0) {
      return {
        model,
        adapter,
        score: 0,
        matchedCapabilities: matchedRequired,
        missingCapabilities: missingRequired,
        reason: `Missing required: ${missingRequired.join(', ')}`,
      };
    }

    // Calculate score based on matched preferred capabilities
    let score = 50; // Base score for meeting requirements

    for (const cap of preferredCapabilities) {
      if (modelCapabilities.includes(cap)) {
        matchedPreferred.push(cap);
        score += 10;
      }
    }

    // Bonus for context window size
    if (model.contextWindow >= requirements.contextSize * 2) {
      score += 5;
    }

    // Bonus for quality metrics
    if (model.performance?.quality >= 0.8) {
      score += 10;
    }

    // Penalty for high cost (prefer cost-efficient)
    const avgCost = ((model.inputCostPer1k || 0) + (model.outputCostPer1k || 0)) / 2;
    if (avgCost > 10) {
      score -= 5;
    }

    return {
      model,
      adapter,
      score,
      matchedCapabilities: [...matchedRequired, ...matchedPreferred],
      missingCapabilities: [],
      reason: `Score ${score}: matched ${matchedRequired.length} required, ${matchedPreferred.length} preferred`,
    };
  }

  /**
   * Stable cache key for the memoized per-provider scoring. Depends ONLY on the
   * inputs `evaluateModel` actually reads: required capabilities, preferred
   * capabilities, and `requirements.contextSize` (the sole `requirements` field
   * scoring consumes today). Capability arrays are sorted so key equality is
   * order-independent.
   */
  private buildScoringCacheKey(
    requiredCapabilities: ModelCapability[],
    preferredCapabilities: ModelCapability[],
    requirements: CapabilityRequirements
  ): string {
    const required = [...requiredCapabilities].sort().join(',');
    const preferred = [...preferredCapabilities].sort().join(',');
    return `${required}|${preferred}|${requirements.contextSize}`;
  }

  /**
   * Score EVERY provider's catalog with NO availability skip. For each adapter
   * we fetch its models and run the pure `evaluateModel` on each, collecting the
   * score>0 candidates plus the raw evaluated count per provider. This is the
   * heavy O(providers x models) scan; its result is memoized by
   * `collectModelCandidates`. Decoupling scoring from availability means an
   * availability change never needs a cache rebuild.
   */
  private async scoreAllProviders(
    adapters: ProviderAdapter[],
    requiredCapabilities: ModelCapability[],
    preferredCapabilities: ModelCapability[],
    requirements: CapabilityRequirements
  ): Promise<ScoredProviderMap> {
    const scored: ScoredProviderMap = new Map();

    for (const adapter of adapters) {
      const providerName = adapter.getName();
      const entry: ProviderScoredEntry = { candidates: [], evaluated: 0 };

      try {
        const models = await adapter.getModels();

        for (const model of models) {
          entry.evaluated++;

          const evaluation = this.evaluateModel(
            model,
            adapter,
            requiredCapabilities,
            preferredCapabilities,
            requirements
          );

          if (evaluation.score > 0) {
            entry.candidates.push(evaluation);
          }
        }
      } catch (error) {
        this.log.warn({ provider: providerName, error }, 'Failed to evaluate provider models');
      }

      scored.set(providerName, entry);
    }

    return scored;
  }

  private async collectModelCandidates(
    adapters: ProviderAdapter[],
    requiredCapabilities: ModelCapability[],
    preferredCapabilities: ModelCapability[],
    requirements: CapabilityRequirements
  ): Promise<{ candidates: ModelCandidate[]; evaluated: number }> {
    // (a) Look up / build-and-cache the per-provider scored map. This is the
    // only place the 76k-model scan runs; a warm key reuses the cached scoring.
    const cacheKey = this.buildScoringCacheKey(requiredCapabilities, preferredCapabilities, requirements);
    let scored = this.scoredCandidateCache.get(cacheKey);
    if (!scored) {
      scored = await this.scoreAllProviders(
        adapters,
        requiredCapabilities,
        preferredCapabilities,
        requirements
      );
      this.scoredCandidateCache.set(cacheKey, scored);
    }

    // (b) Filter LIVE by provider availability (never cached). (c) Return the
    // flattened score>0 candidates from usable providers plus the summed
    // evaluated count over usable providers — identical shape/semantics to the
    // pre-memoization behavior.
    const candidates: ModelCandidate[] = [];
    let totalModelsEvaluated = 0;

    for (const [providerName, entry] of scored) {
      if (!this.availability.isProviderUsable(providerName)) {
        const status = this.availability.getStatus(providerName);
        this.log.debug(
          {
            provider: providerName,
            status: status?.status,
            reason: status?.reason,
          },
          'Skipping provider due to availability status'
        );
        continue;
      }

      candidates.push(...entry.candidates);
      totalModelsEvaluated += entry.evaluated;
    }

    return { candidates, evaluated: totalModelsEvaluated };
  }

  /**
   * Drops all memoized scoring so the next `collectModelCandidates` rebuilds
   * from the live catalog. Call after a catalog/discovery refresh; the TTL is
   * the backstop. Availability is never cached, so this does NOT need to run on
   * an availability change.
   */
  invalidateScoredCandidateCache(): void {
    this.scoredCandidateCache.clear();
  }

  private async forceProviderRefresh(requiredCapabilities: ModelCapability[]): Promise<void> {
    try {
      const discoveryService = await getCentralModelDiscoveryService();
      await discoveryService.discoverAllModels();
      // Catalog just changed — drop stale memoized scores so the retry rescan
      // (and subsequent requests) reflect the refreshed model set.
      this.invalidateScoredCandidateCache();
      this.log.info(
        { requiredCapabilities },
        'Forced provider discovery completed after empty candidate set'
      );
    } catch (error) {
      this.log.error({ error, requiredCapabilities }, 'Forced provider discovery failed');
    }
  }

  // Used by the streaming path (executeStreamingWithFallback), which stays on
  // the direct adapter loop — see the note on that method. Adapts/validates
  // tool schemas per provider before the streaming call.
  private adaptRequestForProvider(request: ChatRequest, candidate: ModelCandidate): ChatRequest {
    const providerName = candidate.model.provider;
    const adapter = getToolAdapter(providerName);

    const adaptedRequest = { ...request };

    if (request.tools && request.tools.length > 0) {
      // Validate and adapt tools for this provider
      const validationErrors: string[] = [];
      for (const tool of request.tools) {
        const validation = adapter.validateSchema(tool);
        if (!validation.valid) {
          validationErrors.push(...validation.errors);
        }
      }

      if (validationErrors.length > 0) {
        this.log.warn({
          provider: providerName,
          errors: validationErrors,
        }, 'Tool schema validation warnings');
      }

      // Note: We don't replace request.tools here because the adapter
      // will handle the conversion when making the API call
      // This is just for validation logging
    }

    // Set the model ID
    adaptedRequest.model = candidate.model.id;

    return adaptedRequest;
  }

  private parseProviderError(
    error: unknown,
    provider: string
  ): { message: string; code?: string; type?: string } {
    const errorObj = error && typeof error === 'object' && error !== null ? error : {};
    const withProvider = (message: string) =>
      provider ? `[${provider}] ${message}` : message;

    // Type guard for error with response property - safely extract without assertions.
    // `Object.getOwnPropertyDescriptor(...).value` is typed `any` (intentionally,
    // since descriptors are heterogeneous); annotate `unknown` and narrow.
    if ('response' in errorObj && errorObj.response && typeof errorObj.response === 'object' && 'data' in errorObj.response) {
      const responseDataDescriptor = Object.getOwnPropertyDescriptor(errorObj.response, 'data');
      const responseData: unknown = responseDataDescriptor?.value;
      
      if (responseData && typeof responseData === 'object' && responseData !== null) {
        // Safely extract error message
        let errorMessage: string = String(error);
        const errorDescriptor = Object.getOwnPropertyDescriptor(responseData, 'error');
        if (errorDescriptor && errorDescriptor.value && typeof errorDescriptor.value === 'object') {
          const errorMsgDescriptor = Object.getOwnPropertyDescriptor(errorDescriptor.value, 'message');
          if (errorMsgDescriptor) {
            errorMessage = String(errorMsgDescriptor.value || error);
          }
        } else {
          const messageDescriptor = Object.getOwnPropertyDescriptor(responseData, 'message');
          if (messageDescriptor) {
            errorMessage = String(messageDescriptor.value || error);
          }
        }
        
        // Safely extract error code
        let errorCode: string | undefined;
        const errorObjDescriptor = errorDescriptor?.value && typeof errorDescriptor.value === 'object' ? Object.getOwnPropertyDescriptor(errorDescriptor.value, 'code') : null;
        if (errorObjDescriptor) {
          errorCode = String(errorObjDescriptor.value);
        } else {
          const codeDescriptor = Object.getOwnPropertyDescriptor(responseData, 'code');
          if (codeDescriptor) {
            errorCode = String(codeDescriptor.value);
          }
        }
        
        // Safely extract error type
        let errorType: string | undefined;
        const errorTypeDescriptor = errorDescriptor?.value && typeof errorDescriptor.value === 'object' ? Object.getOwnPropertyDescriptor(errorDescriptor.value, 'type') : null;
        if (errorTypeDescriptor) {
          errorType = String(errorTypeDescriptor.value);
        } else {
          const typeDescriptor = Object.getOwnPropertyDescriptor(responseData, 'type');
          if (typeDescriptor) {
            errorType = String(typeDescriptor.value);
          }
        }
        
        return {
          message: withProvider(errorMessage),
          code: errorCode,
          type: errorType,
        };
      }
    }

    // Type guard for error with error property - safely extract without assertions
    if ('error' in errorObj && errorObj.error && typeof errorObj.error === 'object' && errorObj.error !== null) {
      const errorProp = errorObj.error;
      
      // Safely extract message
      let errorMessage: string = String(error);
      const messageDescriptor = Object.getOwnPropertyDescriptor(errorProp, 'message');
      if (messageDescriptor) {
        errorMessage = String(messageDescriptor.value || error);
      }
      
      // Safely extract code
      let errorCode: string | undefined;
      const codeDescriptor = Object.getOwnPropertyDescriptor(errorProp, 'code');
      if (codeDescriptor) {
        errorCode = String(codeDescriptor.value);
      }
      
      // Safely extract type
      let errorType: string | undefined;
      const typeDescriptor = Object.getOwnPropertyDescriptor(errorProp, 'type');
      if (typeDescriptor) {
        errorType = String(typeDescriptor.value);
      }
      
      return {
        message: withProvider(errorMessage),
        code: errorCode,
        type: errorType,
      };
    }

    // Type guard for error with message property - safely extract without assertions
    if ('message' in errorObj && errorObj.message) {
      // Safely extract message
      let messageValue: unknown;
      const messageDescriptor = Object.getOwnPropertyDescriptor(errorObj, 'message');
      if (messageDescriptor) {
        messageValue = messageDescriptor.value;
      }
      
      // Safely extract code
      let errorCode: string | undefined;
      const codeDescriptor = Object.getOwnPropertyDescriptor(errorObj, 'code');
      if (codeDescriptor) {
        errorCode = String(codeDescriptor.value);
      }
      
      // Safely extract name as type
      let errorType: string | undefined;
      const nameDescriptor = Object.getOwnPropertyDescriptor(errorObj, 'name');
      if (nameDescriptor && typeof nameDescriptor.value === 'string') {
        errorType = nameDescriptor.value;
      }
      
      return {
        message: withProvider(String(messageValue || error)),
        code: errorCode,
        type: errorType,
      };
    }

    return {
      message: withProvider(String(error)),
      code: 'UNKNOWN',
      type: 'UnknownError',
    };
  }

  private generateCacheKey(content: string): string {
    // Simple hash for caching
    let hash = 0;
    for (let i = 0; i < Math.min(content.length, 1000); i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `triage-${hash}`;
  }

  private isCredentialError(errorInfo: { message?: string; code?: string; type?: string }): boolean {
    const content = `${errorInfo.message || ''} ${errorInfo.code || ''} ${errorInfo.type || ''}`.toLowerCase();
    if (!content) return false;

    if (content.includes('api key') && (content.includes('invalid') || content.includes('not valid') || content.includes('missing') || content.includes('revoked'))) {
      return true;
    }

    if (content.includes('unauthorized') || content.includes('authentication') || content.includes('401')) {
      return true;
    }

    return false;
  }

  private isModelAvailabilityError(errorInfo: { message?: string; code?: string; type?: string }): boolean {
    const content = `${errorInfo.message || ''} ${errorInfo.code || ''} ${errorInfo.type || ''}`.toLowerCase();
    if (!content) return false;

    return (
      content.includes('model not exist') ||
      content.includes('model not found') ||
      content.includes('not found for api version') ||
      content.includes('invalid model id') ||
      content.includes('unsupported model') ||
      content.includes('not supported for generatecontent') ||
      content.includes('unknown model') ||
      (content.includes('404') && content.includes('model'))
    );
  }

  private isProviderAvailabilityError(errorInfo: {
    message?: string;
    code?: string;
    type?: string;
  }): boolean {
    const content = `${errorInfo.message || ''} ${errorInfo.code || ''} ${errorInfo.type || ''}`.toLowerCase();
    if (!content) return false;

    return (
      content.includes('rate limit') ||
      content.includes('429') ||
      content.includes('service unavailable') ||
      content.includes('503') ||
      content.includes('gateway timeout') ||
      content.includes('504') ||
      content.includes('connection refused') ||
      content.includes('connection reset') ||
      content.includes('econnreset') ||
      content.includes('econnrefused') ||
      content.includes('timeout')
    );
  }
}

// Singleton instance
let intelligentSelectionService: IntelligentModelSelectionService | null = null;

export function getIntelligentModelSelectionService(): IntelligentModelSelectionService {
  if (!intelligentSelectionService) {
    intelligentSelectionService = new IntelligentModelSelectionService();
  }
  return intelligentSelectionService;
}
