// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * NVIDIA Triton Inference Server Adapter — KServe v2 HTTP protocol.
 *
 * Triton does NOT speak OpenAI. Its native HTTP surface is the KServe v2
 * protocol: `POST /v2/models/{model}/infer` with a JSON body carrying
 * `inputs[]` (tensors with `name`, `shape`, `datatype`, `data`) and receiving
 * `outputs[]` in the same shape. This adapter bridges the embeddings surface:
 *
 *   OAI `{ input: string | string[], model }`
 *                    ↓
 *   Triton `{ inputs: [{ name, shape: [batch, 1], datatype: "BYTES", data: [...] }] }`
 *                    ↓
 *   Triton `{ outputs: [{ data: [d0_0, d0_1, ..., d1_0, d1_1, ...], shape: [batch, dim] }] }`
 *                    ↓
 *   OAI `{ data: [{ embedding: [d0_0, ...], index: 0 }, { embedding: [d1_0, ...], index: 1 }] }`
 *
 * Chat completion is NOT implemented — Triton typically fronts classification
 * and embedding models, not LLMs. When an operator loads an LLM via TensorRT-LLM
 * with the generate_stream extension, a future subclass will handle it; until
 * then `chatCompletion` throws an explicit "not supported" error that ops can
 * act on.
 *
 * ### Input tensor conventions
 *
 * The tensor `name` varies by model. The de-facto convention for BGE / E5 /
 * Jina embedders deployed via Triton is:
 *   - Input tensor name: `"TEXT"` (or `"text"` — case-preserved from model config)
 *   - Output tensor name: `"EMBEDDING"` (or model-specific — we read whichever
 *     the server emits, not assume a name)
 *
 * We let operators override the input-name via `metadata.inputTensorName`; the
 * output is discovered at response time (read `outputs[0]`). This keeps the
 * adapter compatible with any embedding model loaded into Triton without a
 * separate config file per model.
 *
 * Docs:
 *   https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/protocol/extension_generate.html
 *   https://kserve.github.io/website/latest/modelserving/data_plane/v2_protocol/
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
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
  AudioSTTRequest,
  AudioSTTResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';

export interface TritonAdapterConfig extends BaseProviderConfig {
  /** Input tensor name. Defaults to `"TEXT"`. */
  inputTensorName?: string;
}

interface TritonInferResponse {
  model_name?: string;
  model_version?: string;
  outputs?: Array<{
    name: string;
    shape: number[];
    datatype: string;
    data: number[];
  }>;
}

interface TritonModelMetadata {
  name: string;
  versions?: string[];
  platform?: string;
  inputs?: Array<{ name: string; datatype: string; shape: number[] }>;
  outputs?: Array<{ name: string; datatype: string; shape: number[] }>;
}

interface TritonServerMetadata {
  name?: string;
  version?: string;
  extensions?: string[];
}

export class TritonAdapter extends ProviderAdapter {
  private readonly baseUrl: string;
  private readonly inputTensorName: string;
  private readonly log = logger.child({ provider: 'triton' });

  constructor(config: TritonAdapterConfig) {
    super('triton', 'NVIDIA Triton', config);
    // Triton's KServe v2 endpoints are rooted at the host (no /v1 prefix).
    this.baseUrl = (config.baseUrl || process.env.TRITON_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
    this.inputTensorName = config.inputTensorName || 'TEXT';
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'triton',
      name: 'triton',
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
   * Triton exposes model repository metadata at `GET /v2/models/repository/index`
   * (v2.28+) or the older `GET /v2/models/{name}`. We use the repository index
   * which returns every loaded model in one call — cheap even with many models.
   */
  async getModels(): Promise<Model[]> {
    try {
      const url = `${this.baseUrl}/v2/repository/index`;
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(false),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 10_000)),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, 'triton: repository/index failed; returning empty catalog');
        return [];
      }
      const body = (await res.json()) as Array<{ name?: string; state?: string }>;
      return body
        .filter((m) => typeof m.name === 'string' && (m.state === 'READY' || !m.state))
        .map(
          (m) =>
            narrowAs<Model>(({
              id: m.name!,
              name: m.name!,
              displayName: m.name!,
              provider: 'triton',
              contextWindow: 0,
              maxOutputTokens: 0,
              capabilities: ['embeddings'],
            })),
        );
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'triton: getModels failed, returning empty catalog',
      );
      return [];
    }
  }

  async chatCompletion(_request: ChatRequest): Promise<ChatResponse> {
    // Triton hosts LLMs through TensorRT-LLM with a generate_stream extension.
    // That surface is model-specific and hasn't settled into a single contract
    // we can reasonably abstract. Rather than ship a half-working path, the
    // adapter rejects explicitly — operators deploying an LLM on Triton should
    // front it with vLLM or use the OAI-compatible TensorRT-LLM frontend.
    throw new Error(
      'triton: chat completion not supported — Triton adapter currently exposes embeddings only. ' +
        'For LLM inference, front Triton with vLLM or use TensorRT-LLM OAI-compat mode.',
    );
  }

  async *chatCompletionStream(_request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('triton: streaming chat not supported');
    yield undefined as never;
  }

  /**
   * POST /v2/models/{model}/infer with a single BYTES tensor carrying N strings.
   *
   * Tensor shape encoding:
   *   - `shape: [batch, 1]` where batch = number of input strings
   *   - `datatype: "BYTES"` — Triton's string tensor type
   *   - `data: string[]` — flat array of strings (Triton serializes them)
   *
   * Response is a flat `number[]` of length `batch × dim`. We reshape back
   * into `number[][]` by reading the output tensor's declared shape.
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = (request.model || '').trim();
    if (!model) throw new Error('triton: embedding model is required');

    const inputs = Array.isArray(request.input) ? request.input : [String(request.input ?? '')];
    if (inputs.length === 0) {
      // Fail-fast: an empty batch is a caller bug, not an upstream problem.
      throw new Error('triton: embedding input must be a non-empty string or string array');
    }

    const body = {
      inputs: [
        {
          name: this.inputTensorName,
          shape: [inputs.length, 1],
          datatype: 'BYTES',
          data: inputs,
        },
      ],
    };

    const url = `${this.baseUrl}/v2/models/${encodeURIComponent(model)}/infer`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 30_000);
    // Route the provider inference call through the resilience stack (bulkhead
    // → breaker → timeout) so a Triton outage fast-fails and is isolated
    // per-provider. Response reshaping below is pure and stays outside the slot.
    const parsed = await this.executeThroughBulkhead(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Triton HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      return (await res.json()) as TritonInferResponse;
    }, 'embeddings');
    const output = parsed.outputs?.[0];
    if (!output || !Array.isArray(output.data) || !Array.isArray(output.shape)) {
      throw new Error('triton: response missing outputs[0].data or outputs[0].shape');
    }

    // Reshape flat data → number[][] using the declared [batch, dim] shape.
    // We trust `shape[0]` to equal inputs.length (Triton guarantees this) but
    // derive `dim` from shape[1] to stay honest about the wire data.
    const [batchFromResp, dim] = output.shape;
    if (batchFromResp !== inputs.length) {
      throw new Error(
        `triton: output batch (${batchFromResp}) mismatches input batch (${inputs.length})`,
      );
    }
    if (output.data.length !== batchFromResp * dim) {
      throw new Error(
        `triton: output data length (${output.data.length}) !== batch×dim (${batchFromResp * dim})`,
      );
    }

    const rows: number[][] = [];
    for (let i = 0; i < batchFromResp; i++) {
      rows.push(output.data.slice(i * dim, (i + 1) * dim));
    }

    return {
      object: 'list',
      data: rows.map((embedding, index) => ({
        object: 'embedding',
        embedding,
        index,
      })),
      model,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    } as EmbeddingResponse;
  }

  /**
   * Triton exposes `GET /v2/health/ready` — 200 when ready, 503 when warming up.
   * Cheap: no payload, no auth required even in most deployments.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v2/health/ready`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(Math.max(500, this.config.timeout ?? 5_000)),
      });
      return {
        healthy: res.ok,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Server-level metadata, handy for operator diagnostics. */
  async getServerMetadata(): Promise<TritonServerMetadata> {
    const res = await fetch(`${this.baseUrl}/v2`, {
      method: 'GET',
      headers: this.buildHeaders(false),
      signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 10_000)),
    });
    if (!res.ok) throw new Error(`Triton server metadata failed: HTTP ${res.status}`);
    return (await res.json()) as TritonServerMetadata;
  }

  /** Per-model metadata — used to introspect the expected tensor shapes. */
  async getModelMetadata(model: string): Promise<TritonModelMetadata> {
    const res = await fetch(`${this.baseUrl}/v2/models/${encodeURIComponent(model)}`, {
      method: 'GET',
      headers: this.buildHeaders(false),
      signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 10_000)),
    });
    if (!res.ok) throw new Error(`Triton model metadata failed: HTTP ${res.status}`);
    return (await res.json()) as TritonModelMetadata;
  }

  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    // Self-hosted — no per-token cost. Infrastructure cost lives outside this
    // module (GPU node-hours billed via cloud provider).
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return (modelName || '').trim();
  }

  // ─── Unsupported surfaces ────────────────────────────────────────────────
  async imageGenerate(_m: Model, _r: ImageGenRequest): Promise<ImageGenResponse> {
    throw new Error('triton: imageGenerate not supported');
  }

  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('triton: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('triton: imageVariation not supported');
  }

  async textToSpeech(_m: Model, _r: AudioTTSRequest): Promise<AudioTTSResponse> {
    throw new Error('triton: textToSpeech not supported');
  }

  async speechToText(_m: Model, _r: AudioSTTRequest): Promise<AudioSTTResponse> {
    throw new Error('triton: speechToText not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('triton: moderation not supported');
  }

  // ─── Internals ───────────────────────────────────────────────────────────
  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Triton is typically unauthenticated, but operators putting it behind a
    // reverse proxy can set TRITON_API_KEY to have us emit a bearer header.
    const apiKey = (this.config.apiKey || '').trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }
}
