// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Snowflake Cortex Adapter — Key-pair JWT auth + account-scoped REST API.
 *
 * Snowflake's Cortex REST API is a **first-party** surface (not OpenAI
 * compatible). It lives at `https://<account>.snowflakecomputing.com` and
 * accepts short-lived RS256 JWTs minted locally from a registered RSA key
 * pair — no separate OAuth exchange. This adapter owns the full contract:
 *
 *   - Account-scoped baseUrl resolution (from `SNOWFLAKE_ACCOUNT` or explicit
 *     `SNOWFLAKE_BASE_URL`)
 *   - JWT signing via `SnowflakeJwtSigner` (kid = SHA256 fingerprint of the
 *     registered public key)
 *   - Two endpoints: `/api/v2/cortex/inference:complete` for chat,
 *     `/api/v2/cortex/inference:embed` for embeddings
 *   - Static model catalog — Cortex lists models via SQL (`CORTEX.LIST_MODELS()`),
 *     not REST, so discovery returns the curated list
 *
 * Docs:
 *   https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api
 *   https://docs.snowflake.com/en/user-guide/key-pair-auth
 *
 * ### Why a dedicated adapter and not hub-extending
 *
 *   1. baseUrl must be derived from `SNOWFLAKE_ACCOUNT` — the catalog's
 *      placeholder URL is a sentinel, not a working endpoint.
 *   2. Headers include `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT` —
 *      the hub's `buildRequestHeaders` emits `Authorization` only.
 *   3. Path shape `/api/v2/cortex/inference:complete` (the `:verb` suffix is
 *      gRPC-style) isn't the hub's `/chat/completions` default.
 *   4. Embeddings body uses `text: string[]` not OpenAI's `input`.
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import {
  SnowflakeJwtSigner,
  type SnowflakeJwtSignerOptions,
} from '../_shared/snowflake-jwt-signer';
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

export interface SnowflakeCortexAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** Snowflake account, e.g. `orgname-accountname`. */
  account?: string;
  /** Snowflake user. */
  user?: string;
  /** RSA private key PEM (PKCS8). */
  privateKeyPem?: string;
  /** Optional passphrase if the key is encrypted. */
  privateKeyPassphrase?: string;
  /** Override the token signer (tests inject a mock). */
  signerFactory?: (opts: SnowflakeJwtSignerOptions) => SnowflakeJwtSigner;
}

/**
 * Curated Cortex model catalog. Snowflake publishes availability per region
 * and account; this list reflects the cross-region generally-available set
 * as of 2026-04. Additions are safe; removals require a version bump because
 * external callers may hardcode these ids.
 */
const STATIC_CORTEX_MODELS: readonly string[] = [
  'mistral-large2',
  'mistral-7b',
  'mixtral-8x7b',
  'llama3.1-405b',
  'llama3.1-70b',
  'llama3.1-8b',
  'llama3-70b',
  'llama3-8b',
  'reka-core',
  'reka-flash',
  'snowflake-arctic',
  'claude-3-5-sonnet',
  'e5-base-v2',
  'nv-embed-qa-4',
  'snowflake-arctic-embed-m',
] as const;

const EMBEDDING_MODEL_IDS: readonly string[] = [
  'e5-base-v2',
  'nv-embed-qa-4',
  'snowflake-arctic-embed-m',
] as const;

function isEmbeddingModel(id: string): boolean {
  return EMBEDDING_MODEL_IDS.includes(id);
}

export class SnowflakeCortexAdapter extends ProviderAdapter {
  private readonly baseUrl: string;
  private readonly account: string;
  private readonly user: string;
  private readonly signer: SnowflakeJwtSigner | null;
  private readonly log = logger.child({ provider: 'snowflake' });
  private readonly configError: string | null = null;

  constructor(config: SnowflakeCortexAdapterConfig) {
    super('snowflake', 'Snowflake Cortex', config);
    this.account = (config.account || process.env.SNOWFLAKE_ACCOUNT || '').trim();
    this.user = (config.user || process.env.SNOWFLAKE_USER || '').trim();

    // Resolve baseUrl: explicit config > SNOWFLAKE_BASE_URL env > computed
    // from account. The computed form is the canonical Snowflake endpoint.
    const explicitBase = config.baseUrl || process.env.SNOWFLAKE_BASE_URL || '';
    if (explicitBase) {
      this.baseUrl = explicitBase.replace(/\/$/, '');
    } else if (this.account) {
      // Snowflake account identifiers are dot-separated (orgname.accountname)
      // for the URL; the config form uses a dash. Convert.
      const accountHost = this.account.replace('.', '-').toLowerCase();
      this.baseUrl = `https://${accountHost}.snowflakecomputing.com`;
    } else {
      this.baseUrl = 'https://snowflake.example.snowflakecomputing.com';
    }

    const privateKeyPem = config.privateKeyPem || process.env.SNOWFLAKE_PRIVATE_KEY_PEM || '';
    const passphrase = config.privateKeyPassphrase || process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;

    // The signer is only constructed when we have enough to produce a valid
    // token. Otherwise we stash the error and surface it in healthCheck().
    let signer: SnowflakeJwtSigner | null = null;
    let configError: string | null = null;
    if (!this.account || !this.user || !privateKeyPem) {
      configError =
        !this.account
          ? 'SNOWFLAKE_ACCOUNT missing'
          : !this.user
            ? 'SNOWFLAKE_USER missing'
            : 'SNOWFLAKE_PRIVATE_KEY_PEM missing';
    } else {
      try {
        const factory = config.signerFactory ?? ((o) => new SnowflakeJwtSigner(o));
        signer = factory({
          account: this.account,
          user: this.user,
          privateKeyPem,
          privateKeyPassphrase: passphrase,
        });
      } catch (err) {
        configError = err instanceof Error ? err.message : String(err);
      }
    }
    this.signer = signer;
    this.configError = configError;
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'snowflake',
      name: 'snowflake',
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

  async getModels(): Promise<Model[]> {
    return STATIC_CORTEX_MODELS.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'snowflake',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: isEmbeddingModel(id) ? ['embeddings'] : ['chat'],
        })),
    );
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    this.assertReady();
    const model = (request.model || '').trim();
    if (!model) throw new Error('snowflake: chat model is required');
    if (isEmbeddingModel(model)) {
      throw new Error(`snowflake: model "${model}" is embeddings-only`);
    }

    const payload = {
      model,
      messages: request.messages,
      stream: false,
      ...(request.max_tokens != null ? { max_tokens: request.max_tokens } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.top_p != null ? { top_p: request.top_p } : {}),
    };

    const raw = await this.fetchJson<{
      id?: string;
      choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>('/api/v2/cortex/inference:complete', { method: 'POST', body: payload });

    const first = raw.choices?.[0];
    return {
      id: raw.id || `snowflake-${Date.now()}`,
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
    throw new Error('snowflake: streaming not yet implemented — use chatCompletion');
    yield undefined as never;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.assertReady();
    const model = (request.model || '').trim();
    if (!model) throw new Error('snowflake: embedding model is required');
    if (!isEmbeddingModel(model)) {
      throw new Error(`snowflake: model "${model}" is not an embedding model`);
    }

    const inputs = Array.isArray(request.input) ? request.input : [String(request.input ?? '')];
    const payload = { model, text: inputs };

    const raw = await this.fetchJson<{
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { total_tokens?: number };
    }>('/api/v2/cortex/inference:embed', { method: 'POST', body: payload });

    return {
      object: 'list',
      data: (raw.data ?? []).map((d, i) => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index ?? i,
      })),
      model,
      usage: {
        prompt_tokens: raw.usage?.total_tokens ?? 0,
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
        error: `snowflake: ${this.configError}`,
      };
    }
    if (!this.signer) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: 'snowflake: signer unavailable',
      };
    }
    // Minting a JWT locally is the cheapest probe — it validates the key
    // parses and the fingerprint computes. We don't hit the wire here
    // because Snowflake doesn't have a lightweight GET /health endpoint.
    try {
      await this.signer.getToken();
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
    // Snowflake bills in credits, not dollars — credit-per-token varies by
    // model and warehouse. Returning 0 here defers cost reporting to the
    // Snowflake-native billing view rather than guessing a USD conversion.
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return (modelName || '').trim();
  }

  // ─── Unsupported surfaces ────────────────────────────────────────────────
  async imageGenerate(_m: Model, _r: ImageGenRequest): Promise<ImageGenResponse> {
    throw new Error('snowflake: imageGenerate not supported by Cortex');
  }

  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('snowflake: imageEdit not supported by Cortex');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('snowflake: imageVariation not supported by Cortex');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('snowflake: moderation not supported by Cortex');
  }

  // ─── Internals ───────────────────────────────────────────────────────────
  private assertReady(): void {
    if (this.configError) throw new Error(`snowflake: ${this.configError}`);
    if (!this.signer) throw new Error('snowflake: signer unavailable');
  }

  private async buildHeaders(includeJsonContentType: boolean): Promise<Record<string, string>> {
    if (!this.signer) throw new Error('snowflake: signer unavailable');
    const auth = await this.signer.buildAuthHeader();
    const headers: Record<string, string> = { ...auth, Accept: 'application/json' };
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
    // Single choke-point for all Snowflake Cortex API calls — route through the
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
        // 401 from Snowflake usually means the public key registered on the
        // user doesn't match the private key we signed with, or the account
        // id is wrong. The error body from Cortex includes a message.code.
        throw new Error(`Snowflake HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    }, `${init.method} ${path}`);
  }
}
