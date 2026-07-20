// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Azure OpenAI Adapter — Microsoft-hosted OpenAI with deployment-scoped URLs.
 *
 * Azure OpenAI is the most-deployed enterprise LLM gateway on the planet, but
 * it is NOT a drop-in OpenAI endpoint — its URL shape is fundamentally
 * different:
 *
 *   POST https://{resource}.openai.azure.com/openai/deployments/{deployment}
 *        /chat/completions?api-version=2024-10-21
 *
 * Three variables have to be resolved at construction time:
 *
 *   1. **resourceName**  — the Azure resource subdomain (e.g. `my-aoai-prod`).
 *   2. **deployment**    — the per-model deployment alias that the Azure
 *                          admin chose when deploying (e.g. `gpt-4o-prod`,
 *                          `embeddings-v3`). Azure treats this as the model
 *                          identifier; the wire `model` field is ignored when
 *                          the deployment is in the URL.
 *   3. **apiVersion**    — a date-stamped API contract version
 *                          (`2024-10-21`, `2024-12-01-preview`, etc.). Azure
 *                          refuses every request without it, so we MUST carry
 *                          it as a query string on every path.
 *
 * ### Why one adapter = one deployment
 *
 * The hub base exposes `chatCompletionsPath` as a STATIC per-adapter config,
 * not a per-request hook. Azure's deployment varies per-model, which would
 * force either:
 *   (a) a stateful path-rewrite hack that races under concurrency, or
 *   (b) a per-deployment adapter instance.
 *
 * We chose (b). Operators with N deployments register N adapter instances
 * (`AZURE_OPENAI_DEPLOYMENTS` env var, JSON array). This respects the "one
 * adapter = one immutable baseUrl" contract that every other hub subclass
 * also honors, and it maps 1:1 to how LiteLLM models Azure routing under the
 * hood. The factory-time expansion is handled in `default-adapter-factories.ts`.
 *
 * ### Auth — `api-key` header, NOT Bearer
 *
 * Azure subscription keys use the header name `api-key: <key>`, with no
 * scheme prefix. Microsoft Entra ID (formerly Azure AD) supports Bearer
 * tokens, but the catalog default targets the subscription-key path (the
 * ninety-percent case). Operators wanting Entra can set `apiKey` to a fresh
 * access token and override `authHeaderName` to `Authorization` with scheme
 * `Bearer` via catalog metadata.
 *
 * ### Model normalization
 *
 * The adapter instance IS the deployment. Any `model` field in the request
 * is silently rewritten to the configured deployment name — Azure ignores
 * the body's model anyway when the URL specifies it, but keeping the body
 * consistent prevents operator confusion when they grep logs.
 *
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type { ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse } from '@/types';

/**
 * Default Azure OpenAI API version. Chosen to be a GA stamp, not a preview —
 * operators who need preview features (e.g. `2024-12-01-preview` for
 * structured outputs v2, assistant v2) override per-instance.
 */
export const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21';

export interface AzureOpenAIAdapterConfig extends OpenAICompatibleHubAdapterConfig {
  /** Azure resource subdomain (before `.openai.azure.com`). Required. */
  resourceName?: string;
  /** Deployment alias (the Azure admin-chosen name). Required. */
  deployment?: string;
  /** Date-stamped API version. Defaults to a known-GA version. */
  apiVersion?: string;
  /**
   * Explicit endpoint override (e.g. sovereign clouds: `.openai.azure.us`,
   * `.openai.azure.cn`, or a private-link FQDN). When set, takes precedence
   * over resourceName-based URL composition.
   */
  endpoint?: string;
  /**
   * Override the internal providerName (default `'azure-openai'`) so that
   * multi-deployment factory expansion (Batch 8.2) can register N distinct
   * adapter instances under N distinct `ProviderRegistry` keys. When unset
   * the default fires — preserving single-deployment backward compat.
   */
  providerNameOverride?: string;
}

/**
 * Compose the fully-qualified Azure OpenAI deployment base URL.
 *
 * The output already includes the deployment path segment — chat/embedding
 * paths are appended AS IS (they only need the trailing verb + api-version).
 *
 * @example
 *   buildAzureOpenAIBaseUrl({ resourceName: 'my-aoai', deployment: 'gpt-4o' })
 *   // → 'https://my-aoai.openai.azure.com/openai/deployments/gpt-4o'
 */
export function buildAzureOpenAIBaseUrl(options: {
  resourceName?: string;
  deployment?: string;
  endpoint?: string;
}): string {
  const deployment = options.deployment?.trim();
  if (!deployment) {
    throw new Error('AzureOpenAI: deployment is required');
  }

  // Explicit endpoint takes priority — sovereign cloud + private-link paths.
  if (options.endpoint && options.endpoint.trim().length > 0) {
    const normalized = options.endpoint.trim().replace(/\/+$/, '');
    // If the operator already encoded `/openai` in the endpoint, don't double-add.
    const openaiSuffix = normalized.endsWith('/openai') ? '' : '/openai';
    return `${normalized}${openaiSuffix}/deployments/${deployment}`;
  }

  const resource = options.resourceName?.trim();
  if (!resource) {
    throw new Error('AzureOpenAI: resourceName (or explicit endpoint) is required');
  }

  return `https://${resource}.openai.azure.com/openai/deployments/${deployment}`;
}

export class AzureOpenAIAdapter extends OpenAICompatibleHubAdapter {
  private readonly deployment: string;
  private readonly apiVersion: string;

  constructor(config: AzureOpenAIAdapterConfig) {
    // Pull env fallbacks BEFORE URL composition so error messages are accurate.
    const resourceName =
      config.resourceName?.trim() ||
      process.env.AZURE_OPENAI_RESOURCE_NAME?.trim() ||
      process.env.AZURE_OPENAI_RESOURCE?.trim() ||
      '';
    const deployment =
      config.deployment?.trim() || process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || '';
    const apiVersion =
      config.apiVersion?.trim() ||
      process.env.AZURE_OPENAI_API_VERSION?.trim() ||
      AZURE_OPENAI_DEFAULT_API_VERSION;
    const endpoint =
      config.endpoint?.trim() || process.env.AZURE_OPENAI_ENDPOINT?.trim() || '';

    // Composing the URL fails fast when either deployment or resource is
    // missing UNLESS the operator already passed an explicit baseUrl (the
    // hub's escape hatch — e.g. a proxy/gateway in front of Azure).
    let resolvedBaseUrl = config.baseUrl?.trim();
    if (!resolvedBaseUrl) {
      // Use a sentinel URL (same pattern as Cloudflare) when required pieces
      // are missing. This preserves boot — Azure may be an OPTIONAL provider.
      // Operators see a very loud 404/403 at first request instead of a
      // hard startup crash that blocks unrelated providers.
      if (!deployment || (!resourceName && !endpoint)) {
        resolvedBaseUrl =
          'https://MISSING_AZURE_OPENAI_CONFIG.openai.azure.com/openai/deployments/MISSING_DEPLOYMENT';
      } else {
        resolvedBaseUrl = buildAzureOpenAIBaseUrl({
          resourceName,
          deployment,
          endpoint,
        });
      }
    }

    // Azure always needs ?api-version=... on the path. The hub treats the
    // path as `${baseUrl}${path}` — we encode the query here so it survives
    // chat, embeddings, images, and audio paths uniformly.
    const withVersion = (path: string): string =>
      `${path}${path.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion)}`;

    // Resolve providerName — allow the multi-deployment factory to register
    // this instance under a unique name (e.g. `azure-openai-<alias>`).
    // Default preserves the single-deployment name exactly.
    const resolvedProviderName =
      config.providerNameOverride?.trim() || 'azure-openai';

    super({
      ...config,
      providerName: resolvedProviderName,
      displayName:
        config.displayName ||
        (resolvedProviderName === 'azure-openai'
          ? `Azure OpenAI (${deployment || 'unconfigured'})`
          : `Azure OpenAI — ${deployment || 'unconfigured'}`),
      baseUrl: resolvedBaseUrl,
      metadata: {
        // Azure subscription keys use the `api-key` header with no scheme.
        // Hub's empty-scheme path yields `api-key: <value>`, which is what
        // Azure expects.
        authHeaderName: 'api-key',
        authScheme: '',
        chatCompletionsPath: withVersion('/chat/completions'),
        embeddingsPath: withVersion('/embeddings'),
        imagesPath: withVersion('/images/generations'),
        audioSpeechPath: withVersion('/audio/speech'),
        audioTranscriptionsPath: withVersion('/audio/transcriptions'),
        // Azure's /models list is NOT per-deployment — it sits at
        // `/openai/models?api-version=...` (resource-scoped). Our hub lists
        // from baseUrl which is already deployment-scoped, so we NULL this
        // to fall back to the catalog-driven model list.
        modelListPath: undefined,
        ...config.metadata,
      },
    });

    this.deployment = deployment || 'unconfigured';
    this.apiVersion = apiVersion;
  }

  /**
   * Azure ignores the `model` field in the request body (the URL wins),
   * but we overwrite it anyway to keep log-grep honest — every request
   * leaves a breadcrumb of the deployment it targeted.
   */
  override async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return super.chatCompletion({ ...request, model: this.deployment });
  }

  override async *chatCompletionStream(
    request: ChatRequest,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    yield* super.chatCompletionStream({ ...request, model: this.deployment });
  }

  override async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return super.generateEmbeddings({ ...request, model: this.deployment });
  }

  /** Exposed for tests + admin introspection; not part of the generic contract. */
  getDeployment(): string {
    return this.deployment;
  }

  /** Exposed for tests + admin introspection. */
  getApiVersion(): string {
    return this.apiVersion;
  }
}
