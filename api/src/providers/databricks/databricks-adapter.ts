// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Databricks Model Serving Adapter — workspace-scoped OAI-compat inference.
 *
 * Databricks exposes its Model Serving (formerly "Foundation Model APIs")
 * as an OpenAI-compatible surface rooted at:
 *
 *   https://{workspace}.cloud.databricks.com/serving-endpoints/
 *
 * Each workspace (a Databricks tenant) has its own subdomain, and inside
 * the workspace the admin has provisioned *serving endpoints* that wrap
 * Databricks-hosted foundation models (DBRX, Llama-3, Mixtral, etc.) or
 * fine-tunes uploaded from Unity Catalog.
 *
 * ### Three URL shapes in the wild
 *
 *   1. **Pay-per-token (hosted foundation)** — Databricks runs the weights;
 *      endpoints are named `databricks-llama-3-70b-instruct`,
 *      `databricks-meta-llama-3-3-70b-instruct`, etc.
 *      URL: `/serving-endpoints/{endpoint}/invocations` (native) OR
 *           `/serving-endpoints/{endpoint}` (OAI-compat variant).
 *   2. **Provisioned throughput** — dedicated capacity reserved by the
 *      workspace; URL pattern is identical, endpoint name is a free-form
 *      alias chosen by the admin.
 *   3. **External model** — a proxy endpoint that forwards to an upstream
 *      OpenAI/Anthropic/Cohere. Looks like an OAI-compat endpoint from
 *      our side; Databricks injects their auth token upstream.
 *
 * All three variants accept the `/chat/completions` and `/embeddings`
 * paths when rooted at `/serving-endpoints/{endpoint}/` — which is the
 * shape we use here. Operators pass the endpoint name AS THE MODEL field,
 * and the adapter routes it to `{baseUrl}/{endpoint}/chat/completions`.
 *
 * Wait — that's path-varying-per-request, same issue Azure has. Solved
 * identically: **one adapter instance per serving endpoint**, with the
 * endpoint name baked into baseUrl at construction.
 *
 * ### Auth
 *
 * Databricks Personal Access Token via `Authorization: Bearer`. Service
 * principal OAuth tokens also work (same header). Tokens are per-workspace;
 * rotating requires a new token from the workspace admin UI.
 *
 * ### Model naming
 *
 * The adapter's `endpoint` is the only model it exposes — all requests hit
 * the same serving endpoint. The request's `model` field is overwritten to
 * the endpoint name so logs stay honest (same pattern as Azure).
 *
 * Docs: https://docs.databricks.com/en/machine-learning/model-serving/
 *       https://docs.databricks.com/en/machine-learning/foundation-models/
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  MessageContent,
} from '@/types';
import { narrowAs } from '@/utils/type-guards';

/**
 * Detects a Databricks pay-per-token serving endpoint that fronts an
 * Anthropic Claude model. Databricks' own Foundation Model API supported-
 * models listing names these endpoints `databricks-claude-<family>` (e.g.
 * `databricks-claude-sonnet-4-5`, `databricks-claude-opus-4-1` — confirmed
 * live against `docs.databricks.com/.../foundation-model-apis/supported-models`,
 * 2026-09-09). A custom-named serving endpoint that also wraps a Claude
 * model (workspace admins choose arbitrary endpoint names) is not detected
 * by this heuristic — same class of limitation as Bedrock's
 * `isBedrockClaudeModel()`, which this mirrors.
 */
export function isDatabricksClaudeEndpoint(endpoint: string): boolean {
  return /claude/i.test(endpoint);
}

/**
 * Prompt caching (ADR-025 follow-up, 2026-09): Databricks documents
 * `cache_control: { type: 'ephemeral' }` on a message content block —
 * Anthropic's own mechanism, verified live 2026-09-09 (Databricks community
 * + REST API reference; supported for Databricks-hosted Claude models,
 * covering "text content messages ... in the messages.content array").
 *
 * Scoped deliberately narrow, mirroring the same "single checkpoint" choice
 * ADR-025 made for Bedrock: only the system message (the caller's stable,
 * repeated instructions — the highest-value target for caching) is marked,
 * and only when its content is a plain string. Tool definitions and
 * structured/array system content are explicitly OUT of scope here — the
 * exact shape Databricks expects for `cache_control` on those is unverified
 * for this OpenAI-compatible-shaped endpoint, and sending a malformed extra
 * field is a worse failure mode than caching nothing. No minimum-size gate
 * (same as `anthropic-adapter.ts`'s own system-prompt breakpoint) — Claude
 * silently skips caching below its minimum rather than erroring.
 *
 * A no-op (returns the input array unchanged) when there is no system
 * message or its content is not a plain string.
 */
export function applyDatabricksClaudeCacheControl(messages: ChatMessage[]): ChatMessage[] {
  const systemIndex = messages.findIndex((m) => m.role === 'system');
  if (systemIndex === -1) return messages;
  const systemMessage = messages[systemIndex];
  if (typeof systemMessage.content !== 'string' || systemMessage.content.length === 0) {
    return messages;
  }

  const cacheableContent = narrowAs<MessageContent[]>([
    { type: 'text', text: systemMessage.content, cache_control: { type: 'ephemeral' } },
  ]);

  const updated = [...messages];
  updated[systemIndex] = { ...systemMessage, content: cacheableContent };
  return updated;
}

export interface DatabricksAdapterConfig extends OpenAICompatibleHubAdapterConfig {
  /**
   * Databricks workspace hostname WITHOUT protocol or path, e.g.
   * `my-company.cloud.databricks.com` or `dbc-abc123de-f456.cloud.databricks.com`.
   * Can also be set via `DATABRICKS_HOST` env var.
   */
  workspaceHost?: string;
  /**
   * Serving endpoint name, e.g. `databricks-llama-3-70b-instruct`.
   * Can be set via `DATABRICKS_SERVING_ENDPOINT` env var.
   */
  endpoint?: string;
  /**
   * Override the internal providerName (default `'databricks'`) so that
   * multi-deployment factory expansion (Batch 8.2) can register N distinct
   * adapter instances under N distinct `ProviderRegistry` keys. When unset
   * the default fires — preserving single-endpoint backward compat.
   */
  providerNameOverride?: string;
}

/**
 * Build the fully-qualified Databricks Model Serving base URL.
 *
 * @example
 *   buildDatabricksBaseUrl({
 *     workspaceHost: 'abc.cloud.databricks.com',
 *     endpoint: 'databricks-llama-3-70b-instruct',
 *   })
 *   // → 'https://abc.cloud.databricks.com/serving-endpoints/databricks-llama-3-70b-instruct'
 */
export function buildDatabricksBaseUrl(options: {
  workspaceHost?: string;
  endpoint?: string;
}): string {
  const host = options.workspaceHost?.trim();
  const endpoint = options.endpoint?.trim();

  if (!host) {
    throw new Error('Databricks: workspaceHost is required');
  }
  if (!endpoint) {
    throw new Error('Databricks: endpoint (serving endpoint name) is required');
  }

  // Normalize: strip protocol if operator included it by mistake, drop
  // trailing slashes, and trim whitespace.
  const normalizedHost = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .trim();

  return `https://${normalizedHost}/serving-endpoints/${endpoint}`;
}

export class DatabricksAdapter extends OpenAICompatibleHubAdapter {
  private readonly endpoint: string;

  constructor(config: DatabricksAdapterConfig) {
    const workspaceHost = config.workspaceHost?.trim() || process.env.DATABRICKS_HOST?.trim() || '';
    const endpoint =
      config.endpoint?.trim() || process.env.DATABRICKS_SERVING_ENDPOINT?.trim() || '';

    // Same sentinel pattern as Cloudflare + Azure: fail-soft when config is
    // missing so boot doesn't crash for operators who never use Databricks.
    let resolvedBaseUrl = config.baseUrl?.trim();
    if (!resolvedBaseUrl) {
      if (workspaceHost && endpoint) {
        resolvedBaseUrl = buildDatabricksBaseUrl({ workspaceHost, endpoint });
      } else {
        resolvedBaseUrl =
          'https://MISSING_DATABRICKS_HOST.cloud.databricks.com/serving-endpoints/MISSING_ENDPOINT';
      }
    }

    // Resolve providerName — same multi-deployment override as Azure.
    const resolvedProviderName = config.providerNameOverride?.trim() || 'databricks';

    super({
      ...config,
      providerName: resolvedProviderName,
      displayName:
        config.displayName ||
        (resolvedProviderName === 'databricks'
          ? `Databricks (${endpoint || 'unconfigured'})`
          : `Databricks — ${endpoint || 'unconfigured'}`),
      baseUrl: resolvedBaseUrl,
      metadata: {
        authHeaderName: 'Authorization',
        authScheme: 'Bearer',
        // Databricks doesn't expose /v1/models on serving endpoints (the
        // endpoint IS the model). Suppress auto-discovery at this path;
        // model list comes from the catalog instead.
        modelListPath: undefined,
        ...config.metadata,
      },
    });

    this.endpoint = endpoint || 'unconfigured';
  }

  /**
   * Databricks accepts the `model` field and will 400 if it doesn't match
   * the serving endpoint's bound model. We overwrite to the endpoint name —
   * this is what Databricks expects AND keeps log-grep honest.
   *
   * When the endpoint fronts a Claude model (ADR-025 follow-up, 2026-09),
   * also mark the system message for `cache_control` — see
   * {@link applyDatabricksClaudeCacheControl}.
   */
  override async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const messages = isDatabricksClaudeEndpoint(this.endpoint)
      ? applyDatabricksClaudeCacheControl(request.messages)
      : request.messages;
    return super.chatCompletion({ ...request, model: this.endpoint, messages });
  }

  override async *chatCompletionStream(
    request: ChatRequest
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const messages = isDatabricksClaudeEndpoint(this.endpoint)
      ? applyDatabricksClaudeCacheControl(request.messages)
      : request.messages;
    yield* super.chatCompletionStream({ ...request, model: this.endpoint, messages });
  }

  override async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return super.generateEmbeddings({ ...request, model: this.endpoint });
  }

  /** Exposed for tests + admin introspection. */
  getEndpoint(): string {
    return this.endpoint;
  }
}
