// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import path from 'path';
import type { Logger } from 'pino';
import type { ChatRequest, ChatResponse, ChatMessage, ToolCall, TaskType, AilinMetadata, CanonicalStrategyName, OrchestrationContext, RagConfig, RetrievalMetadata } from '@/types';
import type { ToolResult } from '@/types/tool';
import {
  VectorStoreIngestService,
  type SearchChunkHit,
} from '@/services/vector-store-ingest-service';
import type { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ChatRequestWithMetadata } from '@/types/chat-request-extended';
import { isChatRequestWithMetadata, getTaskType } from '@/types/chat-request-extended';
import { narrowAs } from '@/utils/type-guards';
import { getRequestLogger } from '@/services/request-logger';
import { getCacheService } from '@/cache/cache-service';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { applyBranding } from '@/utils/branding';
import { VideoOrchestrationService } from '@/services/video-orchestration-service';
import { createCapabilityInvoker } from '@/core/orchestration/capability-invoker';
import { emitBroadcastTrace } from '@/services/broadcast-emit-hook';
import {
  canonicalizeStrategyInput,
  mapExecutionToCanonical,
} from '@/core/orchestration/strategy-contract';
import {
  executeSearchReplaceTool,
  executeGrepSearchTool,
  executeListDirectoryTool,
  executeCodebaseSearchTool,
  executeApplyMultiFileChangesTool,
  executeBatchSearchReplaceTool,
  executeGitStatusTool,
  executeGitCommitTool,
  executeGitDiffTool,
  executeGitPushTool,
  executeGitPullTool,
  executeGitCreateBranchTool,
  executeGitMergeTool,
  executeGitRebaseTool,
  executeCreateTodoTool,
  executeUpdateTodoTool,
  executeCheckTodoTool,
  executeListTodosTool,
  executeWebSearchTool,
  executeFindSymbolReferencesTool,
  executeAnalyzeCodebaseTool,
  executeGetDependencyGraphTool,
  executeSemanticSearchTool,
  type ToolExecutionContext,
} from '@/services/tool-execution-service';
import {
  executeExtractFunctionTool,
  executeRenameSymbolTool,
  executeExtractVariableTool,
  executeHealFileTool,
  executeGenerateTestsTool,
  executeTodoWriteTool,
  executeRefactorCodeTool,
  executeAnalyzeImageTool,
  executeCompareImagesTool,
  executeExtractCodeFromScreenshotTool,
  executeInlineFunctionTool,
  executeFileSearchTool,
  executeDetectErrorsTool,
  executeValidateCodeTool,
  executeGitResolveConflictTool,
  executeDeleteFileTool,
  executeExecuteWorkflowTool,
  executeListWorkflowsTool,
  executeRegisterWorkflowTool,
  executeExploreCodebaseTool,
} from '@/services/advanced-tool-execution-service';

export interface ProcessChatRequestParams {
  chatRequest: ChatRequest | ChatRequestWithMetadata;
  orchestrationEngine: OrchestrationEngine;
  organizationId: string;
  userId?: string;
  requestId: string;
  log: Logger;
  /**
   * Set when the caller forced `chatRequest.stream = false` on a request the
   * CLIENT actually sent with `stream: true` (the streaming file-generation
   * artifact redirect in chat-routes.ts). `detectVideoGenerationIntent`'s
   * early path below is gated on `!enhancedRequest.stream`, under the
   * assumption that reaching this function with `stream: false` means the
   * client genuinely wants a buffered response — a redirect breaks that
   * assumption. Confirmed by execution (2026-07-17 adversarial review):
   * without this flag, a message like "Render a clip of the intro, and also
   * generate a downloadable pdf report" is classified as file-only by the
   * streaming gate's OWN (narrower) detector, forces stream:false, and then
   * this function's SEPARATE, more permissive detectVideoGenerationIntent
   * fires on the same text — triggering a real VideoOrchestrationService
   * call instead of producing the requested PDF. Narrowing the streaming
   * gate to file-modality does not prevent this, because the video
   * early-path is independent of what the gate detected.
   */
  disableVideoEarlyPath?: boolean;
}

export interface ProcessChatResult {
  response: ChatResponse;
  fromCache: boolean;
  cacheLayer?: string;
  cacheLatency?: number;
}

function resolveCanonicalStrategyValue(
  strategy: string | null | undefined,
  fallback: CanonicalStrategyName = 'dynamic'
): CanonicalStrategyName {
  const canonical = canonicalizeStrategyInput(strategy);
  if (canonical) {
    return canonical;
  }
  if (typeof strategy === 'string' && strategy.trim().length > 0) {
    return mapExecutionToCanonical(strategy);
  }
  return fallback;
}

function ensureResponseUsage(response: ChatResponse): ChatResponse {
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? promptTokens + completionTokens;

  return {
    ...response,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  };
}

/**
 * Analyze user request to determine if tools should be used automatically
 */
function shouldUseToolsAutomatically(chatRequest: ChatRequest): boolean {
  if (!chatRequest.messages?.length) return false;

  const lastMessage = chatRequest.messages[chatRequest.messages.length - 1];
  if (lastMessage.role !== 'user' || typeof lastMessage.content !== 'string') return false;

  const content = lastMessage.content.toLowerCase();

  // High-confidence patterns that clearly indicate file creation/modification
  const highConfidencePatterns = [
    // Direct file creation
    /\bcreate\b.*\b(html|js|ts|css|json|md|py|java|cpp|csharp|php|rb|go|rs)\b/i,
    /\bmake\b.*\bfile\b/i,
    /\bwrite\b.*\bfile\b/i,
    /\bbuild\b.*\bcomponent\b/i,
    /\bgenerate\b.*\bcode\b/i,

    // Specific file names
    /\bindex\.html\b/i,
    /\bpackage\.json\b/i,
    /\bserver\.js\b/i,
    /\bapp\.js\b/i,
    /\bmain\.js\b/i,

    // File extension patterns
    /\.(js|ts|html|css|json|md|py|java|cpp|csharp|php|rb|go|rs)\b/i,
  ];

  // Check high-confidence patterns
  const hasHighConfidence = highConfidencePatterns.some(pattern => pattern.test(content));

  // Medium-confidence patterns
  const mediumConfidencePatterns = [
    /\bcreate\b/i,
    /\bmake\b/i,
    /\bbuild\b/i,
    /\bgenerate\b/i,
    /\bwrite\b/i,
    /\bfile\b/i,
    /\bcomponent\b/i,
    /\bapi\b/i,
  ];

  // Check medium-confidence patterns (need additional context)
  const hasMediumConfidence = mediumConfidencePatterns.some(pattern => pattern.test(content));

  // Additional context checks for medium confidence
  const hasContext = /\b(html|js|ts|css|json|code|function|class)\b/i.test(content) ||
                    /\bfile\b.*\b(html|js|ts|css|json)\b/i.test(content);

  return hasHighConfidence || (hasMediumConfidence && hasContext);
}

/**
 * Enhance request with automatic tool usage when appropriate
 */
function enhanceRequestWithTools(chatRequest: ChatRequest): ChatRequest {
  if (shouldUseToolsAutomatically(chatRequest)) {
    // Force tool usage by modifying tool_choice
    return {
      ...chatRequest,
      tool_choice: 'auto', // Force the model to use tools
      tools: chatRequest.tools || [], // Ensure tools are available
    };
  }

  return chatRequest;
}

interface VideoIntentDetection {
  prompt: string;
  image?: string;
  startImage?: string;
  endImage?: string;
  audio?: string;
  video?: string;
  duration?: number;
  aspectRatio?: string;
  size?: string;
  n?: number;
  responseFormat?: 'url' | 'b64_json';
}

function getRequestString(request: ChatRequest, key: string): string | undefined {
  const value = narrowAs<Record<string, unknown>>(request)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getRequestNumber(request: ChatRequest, key: string): number | undefined {
  const value = narrowAs<Record<string, unknown>>(request)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractLastUserContent(chatRequest: ChatRequest): { text: string; image?: string } | null {
  const lastUser = [...chatRequest.messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return null;

  if (typeof lastUser.content === 'string') {
    return { text: lastUser.content };
  }

  if (Array.isArray(lastUser.content)) {
    const textParts: string[] = [];
    let image: string | undefined;
    for (const item of lastUser.content) {
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        textParts.push(item.text);
      }
      if (
        !image &&
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'image_url' &&
        'image_url' in item &&
        item.image_url &&
        typeof item.image_url === 'object' &&
        'url' in item.image_url &&
        typeof item.image_url.url === 'string'
      ) {
        image = item.image_url.url;
      }
    }
    return { text: textParts.join(' ').trim(), image };
  }

  return null;
}

// ─── Native RAG (P5) ─────────────────────────────────────────────────────────

/** Default per-store kNN depth when `rag_config.top_k` is omitted. */
const RAG_DEFAULT_TOP_K = 5;
/** Default cap on total injected chunks when `rag_config.max_chunks` is omitted. */
const RAG_DEFAULT_MAX_CHUNKS = 8;
/** Hard ceiling on both top_k and max_chunks (bounds retrieval cost/latency). */
const RAG_MAX_LIMIT = 50;
/** Characters of each chunk surfaced in `ailin_metadata.retrieval[].content_preview`. */
const RAG_PREVIEW_CHARS = 280;

function clampRagLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), RAG_MAX_LIMIT);
}

/**
 * Read a well-formed `rag_config` off the chat request. Returns null when the
 * field is absent/malformed (→ unchanged, no-retrieval behaviour). Sanitises
 * `vector_store_ids` to a deduped list of non-empty strings.
 */
function extractRagConfig(chatRequest: ChatRequest): RagConfig | null {
  const raw = narrowAs<Record<string, unknown>>(chatRequest).rag_config;
  if (!raw || typeof raw !== 'object') return null;

  const cfg = raw as Record<string, unknown>;
  const idsRaw = cfg.vector_store_ids;
  if (!Array.isArray(idsRaw)) return null;

  const storeIds = Array.from(
    new Set(
      idsRaw
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );
  if (storeIds.length === 0) return null;

  const config: RagConfig = { vector_store_ids: storeIds };
  if (typeof cfg.top_k === 'number' && Number.isFinite(cfg.top_k)) config.top_k = cfg.top_k;
  if (typeof cfg.max_chunks === 'number' && Number.isFinite(cfg.max_chunks)) config.max_chunks = cfg.max_chunks;
  if (typeof cfg.score_threshold === 'number' && Number.isFinite(cfg.score_threshold)) {
    config.score_threshold = cfg.score_threshold;
  }
  return config;
}

/**
 * Build the grounding context message body from ranked chunks. Each chunk is
 * labelled with a 1-based index so the model can cite "source N".
 */
function buildRagContextBlock(
  hits: Array<SearchChunkHit & { vectorStoreId: string }>,
): string {
  const lines = hits.map((hit, i) => {
    const header = `[source ${i + 1} | store=${hit.vectorStoreId} | file=${hit.fileId} | score=${hit.score.toFixed(3)}]`;
    return `${header}\n${hit.content.trim()}`;
  });
  return (
    'You are given the following retrieved context to ground your answer. ' +
    'Use it when relevant and prefer it over prior assumptions. ' +
    'If the context does not contain the answer, say so rather than inventing facts.\n\n' +
    lines.join('\n\n')
  );
}

export interface RagRetrievalOutcome {
  /** Request with the grounding context message injected (original messages preserved). */
  request: ChatRequest;
  /** Provenance for `ailin_metadata.retrieval`, or null when nothing was injected. */
  retrieval: RetrievalMetadata | null;
}

/**
 * Native RAG pipeline (P5). When the request carries a valid `rag_config`:
 *   1. take the last user message text as the query,
 *   2. vector-search each named store (P4 service), scoped to `organizationId`,
 *   3. aggregate hits, apply `score_threshold`, rank by score, cap at `max_chunks`,
 *   4. inject the aggregated context as a `system` message BEFORE the conversation,
 *   5. return the modified request + retrieval provenance.
 *
 * Fail-soft: any retrieval error leaves the request unchanged and returns
 * `retrieval: null` — a vector-store outage must never break a chat completion.
 * Tenant isolation: only `organizationId` is ever passed to the search service,
 * which additionally filters by org in SQL (defence in depth).
 */
export async function retrieveRagContext(params: {
  chatRequest: ChatRequest;
  organizationId: string;
  log: Logger;
  ingestService?: VectorStoreIngestService;
}): Promise<RagRetrievalOutcome> {
  const { chatRequest, organizationId, log } = params;
  const config = extractRagConfig(chatRequest);
  if (!config) {
    return { request: chatRequest, retrieval: null };
  }

  const queryContent = extractLastUserContent(chatRequest);
  const query = queryContent?.text?.trim() ?? '';
  if (query.length === 0) {
    log.debug('rag_config present but no user query text to retrieve against — skipping');
    return { request: chatRequest, retrieval: null };
  }

  const topK = clampRagLimit(config.top_k, RAG_DEFAULT_TOP_K);
  const maxChunks = clampRagLimit(config.max_chunks, RAG_DEFAULT_MAX_CHUNKS);
  const threshold =
    typeof config.score_threshold === 'number' ? config.score_threshold : undefined;

  const service = params.ingestService ?? new VectorStoreIngestService();

  // Search every store in parallel, scoped to the request's org. A single failing
  // store does not poison the others (Promise.allSettled).
  const perStore = await Promise.allSettled(
    config.vector_store_ids.map(async (vectorStoreId) => {
      const hits = await service.search({ vectorStoreId, organizationId, query, topK });
      return hits.map((hit) => ({ ...hit, vectorStoreId }));
    }),
  );

  let aggregated: Array<SearchChunkHit & { vectorStoreId: string }> = [];
  for (let i = 0; i < perStore.length; i += 1) {
    const outcome = perStore[i];
    if (outcome.status === 'fulfilled') {
      aggregated = aggregated.concat(outcome.value);
    } else {
      log.warn(
        { vectorStoreId: config.vector_store_ids[i], error: String(outcome.reason) },
        'RAG vector-store search failed (skipping this store)',
      );
    }
  }

  if (aggregated.length === 0) {
    log.info({ stores: config.vector_store_ids.length }, 'RAG retrieval returned no chunks');
    return {
      request: chatRequest,
      retrieval: { chunks: [], store_ids: config.vector_store_ids, chunk_count: 0 },
    };
  }

  // Apply threshold → rank by descending similarity → cap.
  const ranked = aggregated
    .filter((hit) => (threshold === undefined ? true : hit.score >= threshold))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);

  if (ranked.length === 0) {
    log.info(
      { stores: config.vector_store_ids.length, threshold },
      'RAG retrieval: all chunks below score_threshold',
    );
    return {
      request: chatRequest,
      retrieval: { chunks: [], store_ids: config.vector_store_ids, chunk_count: 0 },
    };
  }

  const contextBlock = buildRagContextBlock(ranked);
  const contextMessage: ChatMessage = { role: 'system', content: contextBlock };

  // Inject BEFORE the first user message so the grounding precedes the question
  // but stays after any caller-provided leading system prompt. Original messages
  // are never mutated or dropped.
  const messages = [...chatRequest.messages];
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  const insertAt = firstUserIdx === -1 ? messages.length : firstUserIdx;
  messages.splice(insertAt, 0, contextMessage);

  const retrieval: RetrievalMetadata = {
    chunks: ranked.map((hit) => ({
      vector_store_id: hit.vectorStoreId,
      file_id: hit.fileId,
      score: hit.score,
      content_preview: hit.content.trim().slice(0, RAG_PREVIEW_CHARS),
    })),
    store_ids: config.vector_store_ids,
    chunk_count: ranked.length,
  };

  log.info(
    {
      stores: config.vector_store_ids.length,
      chunksRetrieved: aggregated.length,
      chunksInjected: ranked.length,
      topK,
      maxChunks,
      threshold,
    },
    'Native RAG context injected',
  );

  return { request: { ...chatRequest, messages }, retrieval };
}

/** One subcall entry in ailin_metadata — a single model execution inside the
 *  strategy pipeline. `content`/`reasoning` are only present when the caller
 *  opted in via `include_subcall_content` (experiment full-flow capture). */
export interface SubcallEntry {
  model_id: string;
  model_name: string;
  role: string;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error: string | null;
  tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  /** The subcall's full output text. Present only under include_subcall_content. */
  content?: string | null;
  /** Extracted chain-of-thought (when enable_reasoning captured it). Present
   *  only under include_subcall_content. */
  reasoning?: string | null;
  /** Prompt-catalog provenance (which prompt slot/variant drove this call) —
   *  present only under include_subcall_content, so the full flow is
   *  reconstructable: task prompt → per-role prompt variant → output. */
  prompt_key?: string | null;
  prompt_variant_id?: string | null;
  /** Set when SUBCALL_CONTENT_MAX_CHARS clipped the persisted content. The
   *  default (0 = unlimited) never clips — an experiment must persist the
   *  WHOLE transcript; the cap exists only as an operator escape hatch. */
  content_truncated?: boolean;
}

/**
 * Map the strategy pipeline's per-model executions to serializable subcall
 * entries. Content capture is OPT-IN (`includeContent`): the intra-collective
 * transcript can run to hundreds of KB per response, so normal traffic keeps
 * the lean metrics-only shape while the experiment (which must persist every
 * voter/coordinator output for full-flow auditability) sets the flag.
 * Exported for unit testing.
 */
/** Normalize a ChatMessage content (string OR multimodal parts array) to plain
 *  text. Multimodal parts keep their text segments; non-text parts (images,
 *  audio refs) are represented by their type tag so the transcript stays
 *  faithful about what the model actually emitted. */
function contentToText(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (part && typeof part === 'object') {
          const p = part as { type?: string; text?: string };
          if (typeof p.text === 'string') return p.text;
          return `[${p.type ?? 'non-text'}]`;
        }
        return String(part);
      })
      .join('');
  }
  return String(raw);
}

export function mapSubcallEntries(
  modelsUsed: Array<{
    modelId: string;
    modelName: string;
    role: unknown;
    cost: number;
    durationMs: number;
    success: boolean;
    error?: string;
    reasoning?: string;
    promptKey?: string;
    promptVariantId?: string;
    response?: { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
  }>,
  includeContent: boolean,
): SubcallEntry[] {
  const maxChars = Number(process.env.SUBCALL_CONTENT_MAX_CHARS ?? 0);
  return modelsUsed.map((m) => {
    const entry: SubcallEntry = {
      model_id: m.modelId,
      model_name: m.modelName,
      role: String(m.role),
      cost_usd: m.cost,
      latency_ms: m.durationMs,
      success: m.success,
      error: m.error ?? null,
      tokens: m.response?.usage
        ? { prompt_tokens: m.response.usage.prompt_tokens, completion_tokens: m.response.usage.completion_tokens, total_tokens: m.response.usage.total_tokens }
        : null,
    };
    if (includeContent) {
      const raw = contentToText(m.response?.choices?.[0]?.message?.content);
      if (raw != null && maxChars > 0 && raw.length > maxChars) {
        entry.content = raw.slice(0, maxChars);
        entry.content_truncated = true;
      } else {
        entry.content = raw;
      }
      entry.reasoning = m.reasoning ?? null;
      entry.prompt_key = m.promptKey ?? null;
      entry.prompt_variant_id = m.promptVariantId ?? null;
    }
    return entry;
  });
}

export function detectVideoGenerationIntent(chatRequest: ChatRequest): VideoIntentDetection | null {
  const lastUserContent = extractLastUserContent(chatRequest);
  if (!lastUserContent) return null;

  const prompt = lastUserContent.text.trim();
  if (!prompt) return null;

  // Scoring/judge requests opt out of media-generation interception: a judge
  // rubric that happens to contain "clip"/"render"/"create" (e.g. the canvas
  // regime's rubric) must be evaluated as TEXT, never rerouted to costly, wrong
  // video generation — and never charged real generation cost per judge
  // attempt. (experiment judge-integrity fix — review TS-01)
  if (chatRequest.disable_media_generation === true) return null;

  const lower = prompt.toLowerCase();
  const hasVideoKeyword = /\b(video|clipe|clip|anima(?:cao|ção)|sora|veo)\b/i.test(lower);
  const hasGenerationVerb =
    /\b(generate|create|make|render|produce|gerar|criar|produza|fa[çc]a)\b/i.test(lower);
  const hasDevContext =
    /\b(endpoint|api|route|rota|swagger|openapi|c[oó]digo|code|implementa(?:r|ção))\b/i.test(
      lower
    );

  const image = getRequestString(chatRequest, 'image') ?? lastUserContent.image;
  const startImage = getRequestString(chatRequest, 'start_image');
  const endImage = getRequestString(chatRequest, 'end_image');
  const audio = getRequestString(chatRequest, 'audio');
  const video = getRequestString(chatRequest, 'video');
  const hasConditioningMedia = !!(image || startImage || endImage || audio || video);

  const shouldGenerate = hasConditioningMedia || (hasVideoKeyword && hasGenerationVerb && !hasDevContext);
  if (!shouldGenerate) return null;

  const responseFormatRaw = getRequestString(chatRequest, 'response_format');
  const responseFormat = responseFormatRaw === 'b64_json' ? 'b64_json' : 'url';

  return {
    prompt,
    image,
    startImage,
    endImage,
    audio,
    video,
    duration: getRequestNumber(chatRequest, 'duration'),
    aspectRatio: getRequestString(chatRequest, 'aspect_ratio'),
    size: getRequestString(chatRequest, 'size'),
    n: getRequestNumber(chatRequest, 'n'),
    responseFormat,
  };
}

/**
 * Execute tool calls automatically if present in the response
 */
async function executeToolCallsAutomatically(
  response: ChatResponse,
  chatRequest: ChatRequest | ChatRequestWithMetadata,
  log: Logger,
  organizationId?: string,
  userId?: string
): Promise<ChatResponse> {
  if (!response.choices?.[0]?.message?.tool_calls?.length) {
    return response;
  }

  const toolCalls = response.choices[0].message.tool_calls;
  log.info({ toolCallCount: toolCalls.length }, 'Executing tool calls automatically');

  const toolResults: ToolResult[] = [];

  for (const toolCall of toolCalls) {
    try {
      const result = await executeRealTool(toolCall, chatRequest, log, organizationId, userId);
      toolResults.push(result);
    } catch (error) {
      log.error({ toolCall: toolCall.function.name, error }, 'Tool execution failed');
      toolResults.push({
        tool_call_id: toolCall.id,
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const succeeded = toolResults.filter((result) => result.success);
  const failed = toolResults.filter((result) => !result.success);
  const summaryLines = toolResults.map((result) => {
    const status = result.success ? 'success' : 'error';
    const detail = result.success
      ? typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output ?? null)
      : result.error || 'unknown tool execution error';
    return `${result.tool_call_id}: ${status} - ${String(detail).slice(0, 400)}`;
  });

  // Create a response with real tool execution results and output snippets.
  const enhancedResponse: ChatResponse = {
    ...response,
    choices: [{
      ...response.choices[0],
      message: {
        ...response.choices[0].message,
        content:
          `Executed ${toolResults.length} tool call(s): ${succeeded.length} succeeded, ${failed.length} failed.\n` +
          summaryLines.join('\n'),
        tool_results: toolResults,
      },
    }],
  };

  return enhancedResponse;
}

function normalizeWorkingDirectory(dir?: string): string {
  if (!dir || typeof dir !== 'string' || dir.trim().length === 0) {
    return path.resolve(process.cwd());
  }
  return path.resolve(dir);
}

/**
 * Safely get a string property from an object
 */
function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveWorkingDirectory(chatRequest: ChatRequest | ChatRequestWithMetadata): string {
  const candidates: Array<string | undefined> = [];

  // Check if it's ChatRequestWithMetadata with direct properties
  if (isChatRequestWithMetadata(chatRequest)) {
    candidates.push(
      chatRequest.working_directory,
      chatRequest.workingDirectory,
      chatRequest.workspace_path,
      chatRequest.metadata?.working_directory,
      chatRequest.metadata?.workingDirectory,
      chatRequest.metadata?.workspace_path
    );
  } else {
    // For ChatRequest, try to access properties safely
    candidates.push(
      getStringProperty(chatRequest, 'working_directory'),
      getStringProperty(chatRequest, 'workingDirectory'),
      getStringProperty(chatRequest, 'workspace_path'),
      getStringProperty(chatRequest, 'project_path')
    );
  }

  candidates.push(process.env.AILIN_WORKSPACE_ROOT);

  const picked = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return normalizeWorkingDirectory(picked);
}

function resolveProjectId(chatRequest: ChatRequest | ChatRequestWithMetadata): string | undefined {
  const candidates: Array<string | undefined> = [];

  // Check if it's ChatRequestWithMetadata with direct properties
  if (isChatRequestWithMetadata(chatRequest)) {
    candidates.push(
      chatRequest.project_id,
      chatRequest.projectId,
      chatRequest.metadata?.project_id,
      chatRequest.metadata?.projectId
    );
  } else {
    // For ChatRequest, try to access properties safely
    candidates.push(
      getStringProperty(chatRequest, 'project_id'),
      getStringProperty(chatRequest, 'projectId')
    );
  }

  candidates.push(process.env.AILIN_PROJECT_ID);

  const picked = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return picked;
}

function createToolContext(
  chatRequest: ChatRequest | ChatRequestWithMetadata,
  log: Logger,
  organizationId?: string,
  userId?: string
): ToolExecutionContext & { projectId?: string } {
  const workingDirectory = resolveWorkingDirectory(chatRequest);
  const projectId = resolveProjectId(chatRequest);

  // Option B (2026-06-11): give tool handlers a cross-modal CapabilityInvoker so
  // a `generate_video` tool_call can drive video generation. The post-orchestration
  // tool loop has no live OrchestrationContext, so we build a minimal one — the
  // video service only reads qualityTarget/maxCost from it and runs its own model
  // selection. Best-effort: a build failure leaves invoker undefined (tool errors
  // cleanly with "capability not available").
  let invoker: ToolExecutionContext['invoker'];
  try {
    const orchestrationContext = {
      organizationId: organizationId ?? '',
      userId,
      requestId: `tool-${organizationId ?? 'anon'}`,
      models: [],
      taskType: (getTaskType(chatRequest) ?? 'general') as TaskType,
      contextSize: 0,
      qualityTarget: narrowAs<{ quality_target?: number }>(chatRequest).quality_target,
      maxCost: narrowAs<{ max_cost?: number }>(chatRequest).max_cost,
    } as OrchestrationContext;
    invoker = createCapabilityInvoker({
      videoService: new VideoOrchestrationService(),
      context: orchestrationContext,
    });
  } catch (err) {
    log.debug({ err: String(err) }, 'tool-context invoker build failed (non-fatal)');
  }

  return {
    workingDirectory,
    log,
    organizationId,
    userId,
    projectId,
    invoker,
  };
}

function resolvePathWithinWorkspace(workingDirectory: string, targetPath: string): string {
  const normalizedWorkspace = normalizeWorkingDirectory(workingDirectory);
  const normalizedTarget = path.resolve(normalizedWorkspace, targetPath);
  const relative = path.relative(normalizedWorkspace, normalizedTarget);
  const isOutside =
    relative.startsWith('..') ||
    relative.startsWith(`..${path.sep}`) ||
    (relative !== '' && path.isAbsolute(relative));

  if (isOutside) {
    throw new Error('Access denied: file is outside working directory');
  }

  return normalizedTarget;
}

/**
 * Execute tool calls with actual tool implementations
 */
async function executeRealTool(
  toolCall: ToolCall,
  chatRequest: ChatRequest | ChatRequestWithMetadata,
  log: Logger,
  organizationId?: string,
  userId?: string
): Promise<ToolResult> {
  const { name, arguments: args } = toolCall.function;

  log.info({ toolName: name, args }, 'Executing real tool');

  try {
    const parsedArgs: unknown = JSON.parse(args);
    const context = createToolContext(chatRequest, log, organizationId, userId);

    // Delegate to Tool Registry if available (enables shared execution with strategies)
    const { toolRegistry } = await import('@/core/tools/tool-registry');
    if (toolRegistry.isInitialized() && toolRegistry.has(name)) {
      return await toolRegistry.execute(name, narrowAs<Record<string, unknown>>(parsedArgs), toolCall.id, context);
    }

    // Fallback: direct switch (used before registry is initialized at boot)
    switch (name) {
      case 'write_file':
        return await executeWriteFileTool(parsedArgs as Parameters<typeof executeWriteFileTool>[0], toolCall.id, context);

      case 'run_command':
        return await executeRunCommandTool(parsedArgs as Parameters<typeof executeRunCommandTool>[0], toolCall.id, context);

      case 'read_file':
        return await executeReadFileTool(parsedArgs as Parameters<typeof executeReadFileTool>[0], toolCall.id, context);

      case 'list_directory':
        return await executeListDirectoryTool(parsedArgs as Parameters<typeof executeListDirectoryTool>[0], toolCall.id, context);

      case 'grep_tool':
      case 'grep':
      case 'grep_search':
        return await executeGrepSearchTool(parsedArgs as Parameters<typeof executeGrepSearchTool>[0], toolCall.id, context);

      case 'search_replace':
        return await executeSearchReplaceTool(parsedArgs as Parameters<typeof executeSearchReplaceTool>[0], toolCall.id, context);

      case 'codebase_search':
        return await executeCodebaseSearchTool(parsedArgs as Parameters<typeof executeCodebaseSearchTool>[0], toolCall.id, context);

      case 'apply_multi_file_changes':
        return await executeApplyMultiFileChangesTool(parsedArgs as Parameters<typeof executeApplyMultiFileChangesTool>[0], toolCall.id, context);

      case 'batch_search_replace':
        return await executeBatchSearchReplaceTool(parsedArgs as Parameters<typeof executeBatchSearchReplaceTool>[0], toolCall.id, context);

      case 'git_status':
        return await executeGitStatusTool(toolCall.id, context);

      case 'git_commit':
        return await executeGitCommitTool(parsedArgs as Parameters<typeof executeGitCommitTool>[0], toolCall.id, context);

      case 'git_diff':
        return await executeGitDiffTool(parsedArgs as Parameters<typeof executeGitDiffTool>[0], toolCall.id, context);

      case 'git_push':
        return await executeGitPushTool(parsedArgs as Parameters<typeof executeGitPushTool>[0], toolCall.id, context);

      case 'git_pull':
        return await executeGitPullTool(parsedArgs as Parameters<typeof executeGitPullTool>[0], toolCall.id, context);

      case 'git_create_branch':
        return await executeGitCreateBranchTool(parsedArgs as Parameters<typeof executeGitCreateBranchTool>[0], toolCall.id, context);

      case 'git_merge':
        return await executeGitMergeTool(parsedArgs as Parameters<typeof executeGitMergeTool>[0], toolCall.id, context);

      case 'git_rebase':
        return await executeGitRebaseTool(parsedArgs as Parameters<typeof executeGitRebaseTool>[0], toolCall.id, context);

      case 'git_resolve_conflict':
        return await executeGitResolveConflictTool(parsedArgs as Parameters<typeof executeGitResolveConflictTool>[0], toolCall.id, context);

      // Advanced refactoring tools
      case 'extract_function':
        return await executeExtractFunctionTool(parsedArgs as Parameters<typeof executeExtractFunctionTool>[0], toolCall.id, context);

      case 'rename_symbol':
        return await executeRenameSymbolTool(parsedArgs as Parameters<typeof executeRenameSymbolTool>[0], toolCall.id, context);

      case 'extract_variable':
        return await executeExtractVariableTool(parsedArgs as Parameters<typeof executeExtractVariableTool>[0], toolCall.id, context);

      case 'inline_function':
        return await executeInlineFunctionTool(parsedArgs as Parameters<typeof executeInlineFunctionTool>[0], toolCall.id, context);

      // Auto-healing tools
      case 'heal_file':
        return await executeHealFileTool(parsedArgs as Parameters<typeof executeHealFileTool>[0], toolCall.id, context);

      // Test generation tools
      case 'generate_tests':
        return await executeGenerateTestsTool(parsedArgs as Parameters<typeof executeGenerateTestsTool>[0], toolCall.id, context);

      case 'detect_errors':
        return await executeDetectErrorsTool(parsedArgs as Parameters<typeof executeDetectErrorsTool>[0], toolCall.id, context);

      case 'validate_code':
        return await executeValidateCodeTool(parsedArgs as Parameters<typeof executeValidateCodeTool>[0], toolCall.id, context);

      // Task management tools
      case 'todo_write':
        return await executeTodoWriteTool(parsedArgs as Parameters<typeof executeTodoWriteTool>[0], toolCall.id, context);

      case 'create_todo':
        return await executeCreateTodoTool(parsedArgs as Parameters<typeof executeCreateTodoTool>[0], toolCall.id, context);

      case 'update_todo':
        return await executeUpdateTodoTool(parsedArgs as Parameters<typeof executeUpdateTodoTool>[0], toolCall.id, context);

      case 'check_todo':
        return await executeCheckTodoTool(parsedArgs as Parameters<typeof executeCheckTodoTool>[0], toolCall.id, context);

      case 'list_todos':
        return await executeListTodosTool(parsedArgs as Parameters<typeof executeListTodosTool>[0], toolCall.id, context);

      // Code refactoring tools
      case 'refactor_code':
        return await executeRefactorCodeTool(parsedArgs as Parameters<typeof executeRefactorCodeTool>[0], toolCall.id, context);

      // Web search
      case 'web_search':
      case 'explore_web':
        return await executeWebSearchTool(parsedArgs as Parameters<typeof executeWebSearchTool>[0], toolCall.id, context);

      // Multimodal image analysis - requires OrchestrationEngine
      case 'analyze_image':
        return await executeAnalyzeImageTool(parsedArgs as Parameters<typeof executeAnalyzeImageTool>[0], toolCall.id, context);

      case 'compare_images':
        return await executeCompareImagesTool(parsedArgs as Parameters<typeof executeCompareImagesTool>[0], toolCall.id, context);

      case 'extract_code_from_screenshot':
        return await executeExtractCodeFromScreenshotTool(parsedArgs as Parameters<typeof executeExtractCodeFromScreenshotTool>[0], toolCall.id, context);

      // File search
      case 'file_search':
        return await executeFileSearchTool(parsedArgs as Parameters<typeof executeFileSearchTool>[0], toolCall.id, context);

      case 'delete_file':
        return await executeDeleteFileTool(parsedArgs as Parameters<typeof executeDeleteFileTool>[0], toolCall.id, context);

      // Semantic code analysis tools
      case 'find_symbol_references':
      case 'find_references':
        return await executeFindSymbolReferencesTool(parsedArgs as Parameters<typeof executeFindSymbolReferencesTool>[0], toolCall.id, context);

      case 'analyze_codebase':
        return await executeAnalyzeCodebaseTool(parsedArgs as Parameters<typeof executeAnalyzeCodebaseTool>[0], toolCall.id, context);

      case 'get_dependency_graph':
      case 'dependency_graph':
        return await executeGetDependencyGraphTool(parsedArgs as Parameters<typeof executeGetDependencyGraphTool>[0], toolCall.id, context);

      case 'semantic_search':
        return await executeSemanticSearchTool(parsedArgs as Parameters<typeof executeSemanticSearchTool>[0], toolCall.id, context);

      // Workflow tools
      case 'execute_workflow':
        return await executeExecuteWorkflowTool(parsedArgs as Parameters<typeof executeExecuteWorkflowTool>[0], toolCall.id, context);

      case 'list_workflows':
        return await executeListWorkflowsTool(parsedArgs as Parameters<typeof executeListWorkflowsTool>[0], toolCall.id, context);

      case 'register_workflow':
        return await executeRegisterWorkflowTool(parsedArgs as Parameters<typeof executeRegisterWorkflowTool>[0], toolCall.id, context);

      // Codebase exploration
      case 'explore_codebase':
        return await executeExploreCodebaseTool(parsedArgs as Parameters<typeof executeExploreCodebaseTool>[0], toolCall.id, context);

      default:
        log.error({ toolName: name }, 'Tool not implemented');
        return {
          tool_call_id: toolCall.id,
          success: false,
          error: `Tool "${name}" is not implemented. Available tools: write_file, read_file, run_command, list_directory, grep_tool, search_replace, codebase_search, apply_multi_file_changes, git_status, git_commit, git_diff, git_push, git_pull, git_create_branch, git_merge, git_rebase, extract_function, rename_symbol, extract_variable, heal_file, generate_tests, todo_write, refactor_code, web_search, analyze_image, compare_images, file_search, find_symbol_references, analyze_codebase, get_dependency_graph, semantic_search, detect_errors, validate_code, git_resolve_conflict, delete_file, execute_workflow, list_workflows, register_workflow, explore_codebase`,
        };
    }
  } catch (error) {
    log.error({ toolName: name, error }, 'Tool execution error');
    return {
      tool_call_id: toolCall.id,
      success: false,
      error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Execute write_file tool
 */
async function executeWriteFileTool(
  args: { file_path: string; content: string },
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { file_path, content } = args;
  const { workingDirectory, log } = context;

  try {
    const fs = await import('fs/promises');
    const normalizedWorkspace = normalizeWorkingDirectory(workingDirectory);
    const fullPath = resolvePathWithinWorkspace(normalizedWorkspace, file_path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    const relativePath = path.relative(normalizedWorkspace, fullPath) || fullPath;

    log.info({ file_path: relativePath, contentLength: content.length }, 'File written successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `File ${relativePath} created successfully with ${content.length} characters`,
      metadata: {
        file_path: relativePath,
        bytes: Buffer.byteLength(content, 'utf-8'),
      },
    };
  } catch (error) {
    log.error({ file_path, error }, 'File write failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Failed to write file ${file_path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Execute run_command tool
 */
async function executeRunCommandTool(
  args: { command: string },
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { command } = args;
  const { workingDirectory, log } = context;

  try {
    const { execSync } = await import('child_process');

    const result = execSync(command, {
      cwd: normalizeWorkingDirectory(workingDirectory),
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    log.info({ command, resultLength: result.length }, 'Command executed successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: result.trim(),
    };
  } catch (error) {
    log.error({ command, error }, 'Command execution failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Execute read_file tool
 */
async function executeReadFileTool(
  args: { file_path: string },
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { file_path } = args;
  const { workingDirectory, log } = context;

  try {
    const fs = await import('fs/promises');
    const normalizedWorkspace = normalizeWorkingDirectory(workingDirectory);
    const fullPath = resolvePathWithinWorkspace(normalizedWorkspace, file_path);
    const content = await fs.readFile(fullPath, 'utf-8');
    const relativePath = path.relative(normalizedWorkspace, fullPath) || fullPath;

    log.info({ file_path: relativePath, contentLength: content.length }, 'File read successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: content,
      metadata: {
        file_path: relativePath,
        bytes: Buffer.byteLength(content, 'utf-8'),
      },
    };
  } catch (error) {
    log.error({ file_path, error }, 'File read failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Failed to read file ${file_path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Legacy tool implementations removed in favor of dedicated services

/**
 * Public entry point. Thin wrapper around {@link processChatRequestImpl} that
 * stages a broadcast trace envelope (F1 / ADR-017) into the outbox once the
 * completion is assembled — covering ALL terminal paths (video, cache hit,
 * orchestration) with a single hook instead of one emit per `return`.
 *
 * The emit is strictly fire-and-forget: `emitBroadcastTrace` never throws and
 * is not awaited on the user's critical path, so it cannot affect latency,
 * success, or the response body. It is also a no-op unless
 * `BROADCAST_FEATURE_ENABLED` is set, so the default build pays nothing.
 */
export async function processChatRequest(
  params: ProcessChatRequestParams,
): Promise<ProcessChatResult> {
  const startedAt = new Date();
  const result = await processChatRequestImpl(params);
  // Fire-and-forget. Synchronous in the sense that `emitBroadcastTrace`
  // returns immediately (it does its own async staging internally and
  // swallows every error). Do NOT await — the response must not wait on it.
  emitBroadcastTrace({
    chatRequest: params.chatRequest,
    chatResponse: result.response,
    requestId: params.requestId,
    organizationId: params.organizationId,
    userId: params.userId,
    startedAt,
    endedAt: new Date(),
  });
  return result;
}

async function processChatRequestImpl({
  chatRequest,
  orchestrationEngine,
  organizationId,
  userId,
  requestId,
  log,
  disableVideoEarlyPath,
}: ProcessChatRequestParams): Promise<ProcessChatResult> {
  const requestLogger = getRequestLogger();
  const cacheService = getCacheService();

  // Enhance request with automatic tool usage if appropriate
  let enhancedRequest = enhanceRequestWithTools(chatRequest);

  // Native RAG (P5): if the request carries `rag_config`, retrieve relevant
  // chunks from the named vector stores (scoped to this org) and inject a
  // grounding context message BEFORE the conversation. The injected request
  // then flows through cache + orchestration unchanged. Fail-soft: a retrieval
  // failure leaves the request untouched and `ragRetrieval` null.
  const { request: ragRequest, retrieval: ragRetrieval } = await retrieveRagContext({
    chatRequest: enhancedRequest,
    organizationId,
    log,
  });
  enhancedRequest = ragRequest;

  // Route direct video generation intents through the video capability path.
  const videoIntent = disableVideoEarlyPath ? null : detectVideoGenerationIntent(enhancedRequest);
  if (videoIntent && !enhancedRequest.stream) {
    log.info({ requestId }, 'Video generation intent detected in chat request');

    const strategyRequested = resolveCanonicalStrategyValue(
      enhancedRequest.strategy ?? null,
      'dynamic'
    );
    const allowFallbackRaw = narrowAs<Record<string, unknown>>(enhancedRequest).allow_fallback;
    const allowFallback =
      typeof allowFallbackRaw === 'boolean'
        ? allowFallbackRaw
        : typeof allowFallbackRaw === 'string'
          ? allowFallbackRaw.toLowerCase() !== 'false'
          : true;
    const videoService = new VideoOrchestrationService();
    const videoResult = await videoService.generateVideo({
      ...videoIntent,
      strategy: strategyRequested,
      allowFallback,
      userContext: {
        organizationId,
        userId,
        requestId,
        models: [],
        taskType: getTaskType(enhancedRequest) || 'general',
        contextSize: 0,
        maxCost: enhancedRequest.max_cost,
        qualityTarget: enhancedRequest.quality_target,
      },
      requestId,
    });
    const attemptedModels =
      videoResult.attempts && videoResult.attempts.length > 0
        ? Array.from(new Set(videoResult.attempts.map((attempt) => attempt.model)))
        : [videoResult.modelUsed];
    // Attribution fix (2026-07-04, c3-v4 defect A): report the REQUESTED
    // strategy, not videoResult.strategyUsed — the modality layer's
    // normalizeStrategy() collapses every non-modality strategy name
    // ('hybrid', 'war-room', 'consensus', …) to 'dynamic', which relabeled 28
    // distinct benchmark arms as a single fake 'dynamic' strategy in the
    // persisted data. The modality-internal strategy remains visible in the
    // video path's own logs; the caller-facing metadata must keep the arm.
    const resolvedStrategy = strategyRequested;

    const payload = {
      object: 'video.list',
      created: Math.floor(Date.now() / 1000),
      data: videoResult.videos,
      provider: videoResult.provider,
      model: videoResult.modelUsed,
    };

    let response: ChatResponse = {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: videoResult.modelUsed,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(payload),
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      ailin_metadata: {
        strategy_used: resolvedStrategy,
        models_used: attemptedModels,
        model_count: attemptedModels.length,
        execution_time_ms: videoResult.durationMs,
        cost_usd: 0,
        resolved_strategy: resolvedStrategy,
        resolved_model: videoResult.modelUsed,
        final_decider_model_id: videoResult.modelUsed,
        final_decider_model_name: videoResult.modelUsed,
        final_decider_role: 'video_generation',
        fallback_chain: attemptedModels,
        provider: videoResult.provider,
        cache_hit: false,
      },
    };

    response = applyBranding(response);
    response = ensureResponseUsage(response);

    // Fire-and-forget: telemetry, not billing — nothing reads the result.
    trackChatUsage({
      organizationId,
      userId,
      requestId,
      request: enhancedRequest,
      cacheHit: false,
      totalCostOverride: 0,
      totalTokensOverride: 0,
    }).catch((error: unknown) => {
      log.error({ error }, 'Failed to track chat usage');
    });

    return {
      response,
      fromCache: false,
    };
  }

  // Check cache first (non-streaming only)
  const cacheResult = await cacheService.get(enhancedRequest, { organizationId });

  if (cacheResult.hit && cacheResult.data) {
    log.info(
      {
        cacheHit: true,
        cacheLayer: cacheResult.layer,
        latency: cacheResult.latency,
      },
      'Cache HIT - returning cached response'
    );

    // Add cache metadata
    const rawMetadata = cacheResult.data.ailin_metadata;
    // Cached responses only carry the rich `AilinMetadata` shape (chunk-type
    // variants are SSE-only and never cached). Narrow via type discriminator:
    // chunk variants have `.type`, AilinMetadata does not.
    const existingMetadata =
      rawMetadata && !('type' in rawMetadata) ? rawMetadata : undefined;
    const requestedCanonicalStrategy = resolveCanonicalStrategyValue(
      typeof enhancedRequest.strategy === 'string' ? enhancedRequest.strategy : undefined
    );
    const fallbackResolvedModel =
      typeof cacheResult.data.model === 'string' && cacheResult.data.model.length > 0
        ? cacheResult.data.model
        : undefined;

    let cachedResponse: ChatResponse = {
      ...cacheResult.data,
      ailin_metadata: existingMetadata
        ? {
            ...existingMetadata,
            resolved_strategy: resolveCanonicalStrategyValue(
              typeof existingMetadata.resolved_strategy === 'string'
                ? existingMetadata.resolved_strategy
                : requestedCanonicalStrategy,
              requestedCanonicalStrategy
            ),
            resolved_model:
              typeof existingMetadata.resolved_model === 'string' &&
              existingMetadata.resolved_model.length > 0
                ? existingMetadata.resolved_model
                : fallbackResolvedModel,
            final_decider_model_id:
              typeof existingMetadata.final_decider_model_id === 'string' &&
              existingMetadata.final_decider_model_id.length > 0
                ? existingMetadata.final_decider_model_id
                : fallbackResolvedModel,
            final_decider_model_name:
              typeof existingMetadata.final_decider_model_name === 'string' &&
              existingMetadata.final_decider_model_name.length > 0
                ? existingMetadata.final_decider_model_name
                : fallbackResolvedModel,
            final_decider_role:
              typeof existingMetadata.final_decider_role === 'string' &&
              existingMetadata.final_decider_role.length > 0
                ? existingMetadata.final_decider_role
                : 'cache',
            fallback_chain:
              Array.isArray(existingMetadata.fallback_chain) &&
              existingMetadata.fallback_chain.length > 0
                ? existingMetadata.fallback_chain
                : fallbackResolvedModel
                  ? [fallbackResolvedModel]
                  : [],
            cache_hit: true,
            // Native RAG (P5): re-attach the freshly-retrieved provenance. The
            // injected context is part of the cache key, so a hit used the same
            // retrieved chunks — surface them for consistency with the miss path.
            ...(ragRetrieval ? { retrieval: ragRetrieval } : {}),
            // Store cache-specific fields in _internal to maintain type safety
            _internal: {
              ...(existingMetadata._internal || {}),
              cache_layer: cacheResult.layer,
              cache_latency: cacheResult.latency,
            },
          } satisfies AilinMetadata
        : {
            // If no existing metadata, create minimal required fields
            strategy_used: 'cache',
            models_used: [],
            model_count: 0,
            execution_time_ms: 0,
            cost_usd: 0,
            resolved_strategy: requestedCanonicalStrategy,
            resolved_model: fallbackResolvedModel,
            final_decider_model_id: fallbackResolvedModel,
            final_decider_model_name: fallbackResolvedModel,
            final_decider_role: 'cache',
            fallback_chain: fallbackResolvedModel ? [fallbackResolvedModel] : [],
            cache_hit: true,
            ...(ragRetrieval ? { retrieval: ragRetrieval } : {}),
            _internal: {
              cache_layer: cacheResult.layer,
              cache_latency: cacheResult.latency,
            },
          },
    };

    // Apply branding (if configured)
    cachedResponse = applyBranding(cachedResponse);
    cachedResponse = ensureResponseUsage(cachedResponse);

    // Fire-and-forget: telemetry, not billing — nothing reads the result.
    trackChatUsage({
      organizationId,
      userId,
      requestId,
      request: enhancedRequest,
      cacheHit: true,
      totalCostOverride: 0,
      totalTokensOverride: 0,
    }).catch((error: unknown) => {
      log.error({ error }, 'Failed to track chat usage');
    });

    return {
      response: cachedResponse,
      fromCache: true,
      cacheLayer: cacheResult.layer,
      cacheLatency: cacheResult.latency,
    };
  }

  // Cache MISS - execute orchestration
  log.debug('Cache MISS - executing orchestration');

  const result = await orchestrationEngine.execute(enhancedRequest, organizationId, userId);
  const requestedCanonicalStrategy = resolveCanonicalStrategyValue(
    typeof enhancedRequest.strategy === 'string' ? enhancedRequest.strategy : undefined
  );
  const resolvedModelFromResult =
    typeof result.metadata?.resolved_model === 'string'
      ? result.metadata.resolved_model
      : typeof result.finalResponse.model === 'string'
        ? result.finalResponse.model
        : undefined;
  const finalDeciderModelId =
    typeof result.metadata?.final_decider_model_id === 'string'
      ? result.metadata.final_decider_model_id
      : resolvedModelFromResult;
  const finalDeciderModelName =
    typeof result.metadata?.final_decider_model_name === 'string'
      ? result.metadata.final_decider_model_name
      : resolvedModelFromResult;
  const finalDeciderRole =
    typeof result.metadata?.final_decider_role === 'string'
      ? result.metadata.final_decider_role
      : undefined;

  // Add Ailin metadata to response
  let response: ChatResponse = {
    ...result.finalResponse,
    ailin_metadata: {
      strategy_used: result.strategyUsed,
      models_used: result.modelsUsed.map((m) => m.modelName),
      model_count: result.modelsUsed.length,
      execution_time_ms: result.totalDuration,
      cost_usd: result.totalCost,
      resolved_strategy: resolveCanonicalStrategyValue(
        typeof result.metadata?.resolved_strategy === 'string'
          ? result.metadata.resolved_strategy
          : undefined,
        requestedCanonicalStrategy
      ),
      resolved_model: resolvedModelFromResult,
      final_decider_model_id: finalDeciderModelId,
      final_decider_model_name: finalDeciderModelName,
      final_decider_role: finalDeciderRole,
      fallback_chain: Array.isArray(result.metadata?.fallback_chain)
        ? (result.metadata.fallback_chain.filter(
            (entry): entry is string => typeof entry === 'string'
          ) as string[])
        : resolvedModelFromResult
          ? [resolvedModelFromResult]
          : undefined,
      quality_score: result.qualityScore,
      cache_hit: result.metadata?.cacheHit === true,
      degraded: result.metadata?.degraded === true,
      degraded_reason: typeof result.metadata?.degraded_reason === 'string' ? result.metadata.degraded_reason : undefined,
      // ── Per-subcall decomposition for benchmark auditability ──────
      // Each entry = one model execution within the strategy pipeline.
      // Enables: cost decomposition, latency decomposition, role tracking,
      // routing auditability, and composition analysis. With
      // include_subcall_content, also the full intra-collective transcript
      // (each voter/coordinator's actual output + extracted reasoning).
      subcalls: mapSubcallEntries(result.modelsUsed, enhancedRequest.include_subcall_content === true),
      decision_source: typeof result.metadata?.decision_source === 'string' ? result.metadata.decision_source : null,
      // ── Best-of-N observability (#2, H-A adjudication) ──────
      // Surface HOW the collective picked its final answer (synthesis /
      // best_individual_fallback / verified_individual / agreement_individual)
      // and the checker telemetry, so benchmark rows are analyzable post-hoc
      // without the intra-collective transcript. Absent for single-model runs.
      aggregation_method:
        typeof result.metadata?.aggregationMethod === 'string'
          ? result.metadata.aggregationMethod
          : undefined,
      verification: (() => {
        const artifacts = result.metadata?.consensusArtifacts as
          | { verification?: { decision: string; method: string; confidence: number; verifiedCount: number; totalCount: number; verifiedModelId?: string } }
          | undefined;
        const v = artifacts?.verification;
        return v
          ? {
              decision: v.decision,
              method: v.method,
              confidence: v.confidence,
              verified_count: v.verifiedCount,
              total_count: v.totalCount,
              verified_model_id: v.verifiedModelId ?? null,
            }
          : undefined;
      })(),
      // ── Cost decomposition for auditability (cost-integrity fix) ──────
      // `cost_usd` above is the request total (strategy model executions —
      // including the consensus synthesizer — plus triage + judge). Surface
      // the engine's `cost_breakdown` line items (triage_cost_usd /
      // judge_cost_usd) so external consumers can verify the total is fully
      // accounted and reproduce the C3 quality-vs-cost comparison. Internal
      // accounting (result.totalCost) is what the experiment-runner reads;
      // this just makes the same numbers falsifiable from the HTTP response.
      ...(typeof result.metadata?.cost_breakdown === 'object' && result.metadata?.cost_breakdown !== null
        ? { cost_breakdown: result.metadata.cost_breakdown }
        : {}),
      ...(Array.isArray(result.metadata?.reasoning_traces) && result.metadata.reasoning_traces.length > 0
        ? { reasoning_traces: result.metadata.reasoning_traces }
        : {}),
      // ── Native RAG (P5) retrieval provenance ──────────────────────
      // Real data: the chunks injected as grounding context, their source
      // store/file + similarity score, and the queried store IDs.
      ...(ragRetrieval ? { retrieval: ragRetrieval } : {}),
      // ── Multi-stage media artifacts (multimodal triage composition) ──
      // Non-textual outputs (image/video/audio) from media-generation
      // stages of a multi-stage plan. Additive — choices[].message.content
      // is unaffected either way.
      ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
    },
  };

  // Apply branding (if configured)
  response = applyBranding(response);
  response = ensureResponseUsage(response);

  // 🚨 NEW: Execute tool calls automatically if present
  response = await executeToolCallsAutomatically(
    response,
    enhancedRequest,
    log,
    organizationId,
    userId
  );
  response = ensureResponseUsage(response);

  // 🚨 CRITICAL: Auto-feedback integration for continuous learning across ALL  models
  try {
    const { getModelPerformanceTracker } = await import('./model-performance-tracker.js');
    const performanceTracker = getModelPerformanceTracker();

    // Track performance for each model used (could be multiple in parallel strategy).
    // LAT-7 (2026-06-11): analytics writes, not billing — previously awaited
    // SERIALLY (one DB round-trip per model) on the response path. Run them
    // concurrently and never block the response on them.
    void Promise.allSettled(
      result.modelsUsed.map((modelExecution) => {
        const taskType = getTaskType(enhancedRequest);

        const performanceUpdate: {
          modelId: string;
          taskType?: TaskType;
          responseTime: number;
          cost: number;
          qualityScore: number;
          success: boolean;
        } = {
          modelId: modelExecution.modelName,
          responseTime: modelExecution.durationMs || result.totalDuration / result.modelsUsed.length,
          cost: modelExecution.cost,
          qualityScore: result.qualityScore || 0.7,
          success: modelExecution.success !== false, // Default to success unless explicitly failed
        };
        if (taskType) {
          performanceUpdate.taskType = taskType;
        }

        log.debug(
          {
            modelId: modelExecution.modelName,
            taskType,
            responseTime: modelExecution.durationMs,
            cost: modelExecution.cost,
            qualityScore: result.qualityScore,
            success: modelExecution.success,
          },
          '✅ Auto-feedback recorded - continuous learning for ALL  models'
        );

        return performanceTracker.trackRequest(performanceUpdate);
      })
    ).then((settled) => {
      const failed = settled.filter((s) => s.status === 'rejected').length;
      if (failed > 0) {
        log.warn({ failed, total: settled.length }, 'Some performance-tracker writes failed (non-blocking)');
      }
    });

    log.info(
      {
        modelsTracked: result.modelsUsed.length,
        taskType: getTaskType(chatRequest) || 'chat',
        totalCost: result.totalCost,
        qualityScore: result.qualityScore,
        continuousLearning: true, // ✅ System is learning from every request
      },
      '✅ Continuous learning updated for ALL models used in orchestration'
    );
  } catch (feedbackError) {
    // Don't fail the request if feedback fails - learning is best effort
    log.warn(
      {
        error: feedbackError,
        requestId,
      },
      'Auto-feedback recording failed, but request succeeded - learning continues'
    );
  }

  log.info(
    {
      strategy: result.strategyUsed,
      modelsUsed: result.modelsUsed.length,
      cost: result.totalCost,
      duration: result.totalDuration,
      continuousLearningEnabled: true, // ✅ Indicates system is learning
    },
    'Chat completion successful with continuous learning'
  );

  // Cache response asynchronously (non-blocking).
  cacheService.set(enhancedRequest, response, { organizationId }).catch((error: unknown) => {
    log.error({ error }, 'Failed to cache response');
  });

  // Log to database asynchronously (non-blocking)
  requestLogger
    .logOrchestration(result, organizationId, userId, '/v1/chat/completions', 'POST', chatRequest)
    .catch((error: unknown) => {
      log.error({ error }, 'Failed to log request to database');
    });

    // Telemetry/quota counting, not billing (see debitTierRequest for the
    // financial ledger, which stays synchronous). Same fire-and-forget pattern
    // as cacheService.set/requestLogger.logOrchestration right above — nothing
    // reads this Promise's result, so it shouldn't block the response.
    trackChatUsage({
      organizationId,
      userId,
      requestId,
      request: enhancedRequest,
      result,
      cacheHit: false,
    }).catch((error: unknown) => {
      log.error({ error }, 'Failed to track chat usage');
    });

  return {
    response,
    fromCache: false,
  };
}

/**
 * Register all tool implementations into the Tool Registry.
 * Call this once at startup AFTER the module is loaded.
 * This enables strategies to access the same tools as the chat processor.
 */
export function registerToolsInRegistry(): void {
  // Dynamic import to avoid circular dependency at module load time
  import('@/core/tools/tool-registry').then(({ toolRegistry }) => {
    if (toolRegistry.isInitialized()) return; // Already registered

    // Cast handlers to the generic ToolHandler signature (args as Record<string, unknown>).
    // The original functions have typed args, but the registry uses generic args since
    // the model provides JSON that needs runtime validation, not compile-time.
    type GenericHandler = import('@/core/tools/tool-registry').ToolHandler;

    const reg = (
      name: string,
      description: string,
      category: 'file' | 'git' | 'search' | 'code' | 'refactoring' | 'testing' | 'task' | 'analysis' | 'workflow' | 'web' | 'image' | 'video' | 'audio' | 'general',
      safeForStrategies: boolean,
      // `(...a: never[]) => Promise<unknown>` accepts EVERY concrete executor
      // signature via parameter contravariance — no `any` laundering needed.
      // The registry-facing shape is restored with the sanctioned narrowAs
      // (each executor's real args are parsed/validated by the tool layer).
      handler: (...a: never[]) => Promise<unknown>,
      aliases?: string[],
    ) => {
      toolRegistry.register({ name, description, category, safeForStrategies, handler: narrowAs<GenericHandler>(handler), aliases });
    };

    // ── File Operations ────────────────────────────
    reg('write_file', 'Create or overwrite a file', 'file', true, executeWriteFileTool);
    reg('read_file', 'Read file contents', 'file', true, executeReadFileTool);
    reg('list_directory', 'List directory contents', 'file', true, executeListDirectoryTool);
    reg('delete_file', 'Delete a file', 'file', false, executeDeleteFileTool);
    reg('file_search', 'Search for files by name', 'file', true, executeFileSearchTool);

    // ── Search ─────────────────────────────────────
    reg('grep_search', 'Search file contents with regex', 'search', true, executeGrepSearchTool, ['grep_tool', 'grep']);
    reg('codebase_search', 'Semantic codebase search', 'search', true, executeCodebaseSearchTool);
    reg('semantic_search', 'Semantic similarity search', 'search', true, executeSemanticSearchTool);
    reg('web_search', 'Search the web', 'web', true, executeWebSearchTool, ['explore_web']);

    // ── Modality generation (option B, tool→modality bridge) ──────
    // safeForStrategies=false: video generation is billable + slow; do NOT let
    // every collective voter fire a generation. Routes through the
    // ToolExecutionContext.invoker (CapabilityInvoker → VideoOrchestrationService).
    reg('generate_video', 'Generate a video from a text prompt', 'video', false, async (
      args: Record<string, unknown>,
      toolCallId: string,
      ctx: ToolExecutionContext,
    ): Promise<ToolResult> => {
      if (!ctx.invoker) {
        return { tool_call_id: toolCallId, success: false, error: 'Video generation capability not available in this context' };
      }
      const result = await ctx.invoker.generateVideo({
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        model: typeof args.model === 'string' ? args.model : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        aspectRatio: typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined,
        size: typeof args.size === 'string' ? args.size : undefined,
        responseFormat: 'url',
      });
      return {
        tool_call_id: toolCallId,
        success: true,
        output: JSON.stringify({ videos: result.videos, model: result.model, provider: result.provider }),
      };
    });

    // ── Code ───────────────────────────────────────
    reg('search_replace', 'Search and replace in file', 'code', true, executeSearchReplaceTool);
    reg('apply_multi_file_changes', 'Apply multi-file changes', 'code', false, executeApplyMultiFileChangesTool);
    reg('batch_search_replace', 'Batch search-replace', 'code', false, executeBatchSearchReplaceTool);
    reg('run_command', 'Execute shell command', 'general', false, executeRunCommandTool);

    // ── Git ────────────────────────────────────────
    reg('git_status', 'Show git status', 'git', true, executeGitStatusTool);
    reg('git_diff', 'Show git diff', 'git', true, executeGitDiffTool);
    reg('git_commit', 'Create commit', 'git', false, executeGitCommitTool);
    reg('git_push', 'Push to remote', 'git', false, executeGitPushTool);
    reg('git_pull', 'Pull from remote', 'git', false, executeGitPullTool);
    reg('git_create_branch', 'Create branch', 'git', false, executeGitCreateBranchTool);
    reg('git_merge', 'Merge branches', 'git', false, executeGitMergeTool);
    reg('git_rebase', 'Rebase branch', 'git', false, executeGitRebaseTool);
    reg('git_resolve_conflict', 'Resolve conflict', 'git', false, executeGitResolveConflictTool);

    // ── Refactoring ────────────────────────────────
    reg('extract_function', 'Extract code into function', 'refactoring', true, executeExtractFunctionTool);
    reg('rename_symbol', 'Rename symbol', 'refactoring', true, executeRenameSymbolTool);
    reg('extract_variable', 'Extract into variable', 'refactoring', true, executeExtractVariableTool);
    reg('inline_function', 'Inline function', 'refactoring', true, executeInlineFunctionTool);
    reg('refactor_code', 'General refactoring', 'refactoring', true, executeRefactorCodeTool);

    // ── Code Execution (Sandbox) ─────────────────
    reg('code_execute', 'Execute code in sandbox', 'code', true, async (args: Record<string, unknown>, toolCallId: string, ctx: ToolExecutionContext & { projectId?: string }) => {
      const code = typeof args.code === 'string' ? args.code : '';
      const language = typeof args.language === 'string' ? args.language : 'javascript';
      try {
        const { CodeExecutionService } = await import('@/services/code-execution-service');
        const service = new CodeExecutionService();
        const result = await service.executeCode({
          code,
          language: language as import('@/runtime/code-sandbox').SupportedLanguage,
          timeoutMs: 30000,
          userContext: { requestId: toolCallId, organizationId: ctx.organizationId || '', models: [], taskType: 'code-generation', contextSize: 0 },
          requestId: toolCallId,
        });
        return { tool_call_id: toolCallId, success: result.success, output: result.stdout || JSON.stringify(result.result ?? ''), error: result.error || result.stderr, metadata: { sandbox: result.sandboxBackend } };
      } catch (err) {
        return { tool_call_id: toolCallId, success: false, error: `Code execution failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }, ['execute_code']);

    // ── Code Quality ───────────────────────────────
    reg('heal_file', 'Auto-fix file errors', 'code', true, executeHealFileTool);
    reg('generate_tests', 'Generate tests', 'testing', true, executeGenerateTestsTool);
    reg('detect_errors', 'Detect code errors', 'testing', true, executeDetectErrorsTool);
    reg('validate_code', 'Validate code', 'testing', true, executeValidateCodeTool);

    // ── Tasks ──────────────────────────────────────
    reg('todo_write', 'Write todos', 'task', false, executeTodoWriteTool);
    reg('create_todo', 'Create todo', 'task', false, executeCreateTodoTool);
    reg('update_todo', 'Update todo', 'task', false, executeUpdateTodoTool);
    reg('check_todo', 'Check todo status', 'task', true, executeCheckTodoTool);
    reg('list_todos', 'List todos', 'task', true, executeListTodosTool);

    // ── Analysis ───────────────────────────────────
    reg('find_symbol_references', 'Find references', 'analysis', true, executeFindSymbolReferencesTool, ['find_references']);
    reg('analyze_codebase', 'Analyze codebase', 'analysis', true, executeAnalyzeCodebaseTool);
    reg('get_dependency_graph', 'Dependency graph', 'analysis', true, executeGetDependencyGraphTool, ['dependency_graph']);
    reg('explore_codebase', 'Explore codebase', 'analysis', true, executeExploreCodebaseTool);

    // ── Image ──────────────────────────────────────
    reg('analyze_image', 'Analyze image', 'image', true, executeAnalyzeImageTool);
    reg('compare_images', 'Compare images', 'image', true, executeCompareImagesTool);
    reg('extract_code_from_screenshot', 'Extract code from screenshot', 'image', true, executeExtractCodeFromScreenshotTool);

    // ── Workflow ────────────────────────────────────
    reg('execute_workflow', 'Execute workflow', 'workflow', false, executeExecuteWorkflowTool);
    reg('list_workflows', 'List workflows', 'workflow', true, executeListWorkflowsTool);
    reg('register_workflow', 'Register workflow', 'workflow', false, executeRegisterWorkflowTool);

    toolRegistry.markInitialized();
  }).catch((err) => {
    // Non-fatal: tools work via fallback switch in executeRealTool
    console.warn('Failed to register tools in registry:', err);
  });
}
