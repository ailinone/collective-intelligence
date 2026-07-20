// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SAP Generative AI Hub Adapter — OAuth2 client_credentials + deployment IDs.
 *
 * SAP's Gen-AI Hub sits inside SAP AI Core (part of BTP). Its quirks vs. a
 * plain OAI surface:
 *
 *   1. **OAuth2 client_credentials** against the customer's XSUAA tenant.
 *      The client_id + client_secret come from a BTP service key binding.
 *   2. **`AI-Resource-Group` header** on every request — resource-group
 *      scoping (defaults to 'default'). Omitting returns 403.
 *   3. **deployment_id routing**: the path is
 *      `/v2/inference/deployments/{deployment_id}/chat/completions`, NOT
 *      `/chat/completions`. `deployment_id` is the provisioned SAP instance
 *      of a model, not the model name itself. We resolve via a
 *      `SAP_AI_CORE_DEPLOYMENTS` JSON map: `{ "gpt-4o": "d-abc-123", ... }`.
 *   4. Response bodies are OpenAI-compatible *once* you've routed correctly,
 *      so body parsing reuses the OAI shape.
 *
 * Docs: https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide
 *       https://help.sap.com/docs/ai-launchpad/sap-ai-launchpad/use-generative-ai-hub
 *
 * ### Why a dedicated adapter and not hub-extending
 *
 *   - The hub's `buildRequestHeaders` assumes a static apiKey; SAP needs a
 *     refreshable OAuth2 token and a mandatory resource-group header.
 *   - The path depends on the model-specific deployment id, so
 *     `chatCompletionsPath` in metadata is not expressive enough.
 *   - Discovery (`/v2/admin/deployments`) returns SAP-shaped rows, not
 *     OpenAI `/models` rows — needs translation.
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import {
  createOAuth2ClientCredentialsProvider,
  type OAuth2ClientCredentialsOptions,
} from '../_shared/oauth2-client-credentials';
import type { TokenProvider } from '../_shared/token-provider';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import { narrowAs } from '@/utils/type-guards';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';

export interface SapAiCoreAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** OAuth2 token endpoint. Usually ends with `/oauth/token` on the XSUAA tenant. */
  authUrl?: string;
  /** OAuth2 client id (from the BTP service key binding). */
  clientId?: string;
  /** OAuth2 client secret (from the BTP service key binding). */
  clientSecret?: string;
  /** Resource group. Defaults to 'default'. */
  resourceGroup?: string;
  /**
   * `model → deployment_id` map. Populated from
   * `SAP_AI_CORE_DEPLOYMENTS` env var as JSON if not provided.
   */
  deployments?: Record<string, string>;
  /** Override the OAuth2 provider factory (tests inject a mock). */
  tokenProviderFactory?: (opts: OAuth2ClientCredentialsOptions) => TokenProvider;
}

function parseDeploymentMap(source: string | undefined): Record<string, string> {
  if (!source) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    // Fall through — caller gets an empty map; assertions will complain.
  }
  return {};
}

export class SapAiCoreAdapter extends ProviderAdapter {
  private readonly baseUrl: string;
  private readonly resourceGroup: string;
  private readonly deployments: Record<string, string>;
  private readonly tokenProvider: TokenProvider | null;
  private readonly configError: string | null;
  private readonly log = logger.child({ provider: 'sap' });

  constructor(config: SapAiCoreAdapterConfig) {
    super('sap', 'SAP Generative AI Hub', config);

    this.baseUrl = (
      config.baseUrl ||
      process.env.SAP_AI_CORE_BASE_URL ||
      'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com'
    ).replace(/\/$/, '');
    this.resourceGroup =
      config.resourceGroup || process.env.SAP_AI_CORE_RESOURCE_GROUP || 'default';

    this.deployments =
      config.deployments && Object.keys(config.deployments).length > 0
        ? config.deployments
        : parseDeploymentMap(process.env.SAP_AI_CORE_DEPLOYMENTS);

    const clientId = config.clientId || config.apiKey || process.env.SAP_AI_CORE_CLIENT_ID || '';
    const clientSecret = config.clientSecret || process.env.SAP_AI_CORE_CLIENT_SECRET || '';
    const authUrl = config.authUrl || process.env.SAP_AI_CORE_AUTH_URL || '';

    let tokenProvider: TokenProvider | null = null;
    let configError: string | null = null;
    if (!clientId) configError = 'SAP_AI_CORE_CLIENT_ID missing';
    else if (!clientSecret) configError = 'SAP_AI_CORE_CLIENT_SECRET missing';
    else if (!authUrl) configError = 'SAP_AI_CORE_AUTH_URL missing';

    if (!configError) {
      try {
        const factory =
          config.tokenProviderFactory ?? createOAuth2ClientCredentialsProvider;
        tokenProvider = factory({
          authUrl,
          clientId,
          clientSecret,
          // XSUAA accepts both styles; `basic` keeps the secret out of the
          // body (preferred for audit logs).
          authStyle: 'basic',
        });
      } catch (err) {
        configError = err instanceof Error ? err.message : String(err);
      }
    }
    this.tokenProvider = tokenProvider;
    this.configError = configError;
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'sap',
      name: 'sap',
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  /**
   * Returns the set of models implied by the configured deployment map. The
   * map keys ARE the model names customers can request. Discovering deployments
   * via `/v2/admin/deployments` is possible but requires the token AND would
   * need to be filtered by status=RUNNING — keep that out of the critical path.
   */
  async getModels(): Promise<Model[]> {
    const ids = Object.keys(this.deployments);
    return ids.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'sap',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: narrowAs<Model['capabilities']>(['chat', 'embeddings']),
        })),
    );
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    this.assertReady();
    const model = (request.model || '').trim();
    if (!model) throw new Error('sap: chat model is required');

    const deploymentId = this.deployments[model];
    if (!deploymentId) {
      throw new Error(
        `sap: no deployment_id mapped for model "${model}" — set SAP_AI_CORE_DEPLOYMENTS={"${model}":"<deployment_id>"}`,
      );
    }

    const payload = {
      messages: request.messages,
      ...(request.max_tokens != null ? { max_tokens: request.max_tokens } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.top_p != null ? { top_p: request.top_p } : {}),
      stream: false,
    };

    const path = `/v2/inference/deployments/${deploymentId}/chat/completions?api-version=2023-05-15`;
    const raw = await this.fetchJson<{
      id?: string;
      choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>(path, { method: 'POST', body: payload });

    const first = raw.choices?.[0];
    return {
      id: raw.id || `sap-${Date.now()}`,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: first?.message?.content ?? '',
          },
          finish_reason: first?.finish_reason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens ?? 0,
        completion_tokens: raw.usage?.completion_tokens ?? 0,
        total_tokens: raw.usage?.total_tokens ?? 0,
      },
    } as ChatResponse;
  }

  async *chatCompletionStream(_request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('sap: streaming not yet implemented — use chatCompletion');
    yield undefined as never;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.assertReady();
    const model = (request.model || '').trim();
    if (!model) throw new Error('sap: embedding model is required');

    const deploymentId = this.deployments[model];
    if (!deploymentId) {
      throw new Error(`sap: no deployment_id mapped for model "${model}"`);
    }

    const inputs = Array.isArray(request.input) ? request.input : [String(request.input ?? '')];
    const payload = { input: inputs };
    const path = `/v2/inference/deployments/${deploymentId}/embeddings?api-version=2023-05-15`;
    const raw = await this.fetchJson<{
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    }>(path, { method: 'POST', body: payload });

    return {
      object: 'list',
      data: (raw.data ?? []).map((d, i) => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index ?? i,
      })),
      model,
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens ?? 0,
        total_tokens: raw.usage?.total_tokens ?? 0,
      },
    } as EmbeddingResponse;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (this.configError) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: `sap: ${this.configError}`,
      };
    }
    if (!this.tokenProvider) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: 'sap: token provider unavailable',
      };
    }
    try {
      await this.tokenProvider.getToken();
      return { healthy: true, checkedAt: new Date(), latency: Date.now() - start };
    } catch (error) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return (modelName || '').trim();
  }

  // ─── Unsupported surfaces ────────────────────────────────────────────────
  async imageGenerate(_m: Model, _r: ImageGenRequest): Promise<ImageGenResponse> {
    throw new Error('sap: imageGenerate not supported by Gen-AI Hub');
  }

  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('sap: imageEdit not supported by Gen-AI Hub');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('sap: imageVariation not supported by Gen-AI Hub');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('sap: moderation not supported by Gen-AI Hub');
  }

  // ─── Internals ───────────────────────────────────────────────────────────
  private assertReady(): void {
    if (this.configError) throw new Error(`sap: ${this.configError}`);
    if (!this.tokenProvider) throw new Error('sap: token provider unavailable');
  }

  private async buildHeaders(includeJsonContentType: boolean): Promise<Record<string, string>> {
    if (!this.tokenProvider) throw new Error('sap: token provider unavailable');
    const auth = await this.tokenProvider.buildAuthHeader();
    const headers: Record<string, string> = {
      ...auth,
      Accept: 'application/json',
      'AI-Resource-Group': this.resourceGroup,
    };
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async fetchJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 60_000);
    const headers = await this.buildHeaders(init.body !== undefined);
    // Single choke-point for all SAP AI Core API calls — route through the
    // resilience stack (bulkhead → breaker → timeout) so an outage fast-fails
    // and is isolated per-provider.
    return this.executeThroughBulkhead(async () => {
      const res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`SAP HTTP ${res.status} at ${path}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    }, `${init.method} ${path}`);
  }
}
