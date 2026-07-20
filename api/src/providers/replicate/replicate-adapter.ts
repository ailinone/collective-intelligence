// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Replicate Provider Adapter
 *
 * Replicate runs open-source models via a predictions API.
 * Unlike OpenAI-compatible providers, Replicate uses:
 * - Model versions (not model names) for execution
 * - Async predictions with polling
 * - Sync predictions with `Prefer: wait` header
 *
 * Base URL: https://api.replicate.com/v1
 * Auth: Authorization: Bearer {token} OR Authorization: Token {token}
 */

import { ProviderAdapter, type HealthCheckResult } from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
  ProviderConfig,
} from '@/types';
import type {
  ImageGenRequest,
  ImageGenResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  ModerationRequest,
  ModerationResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
} from '@/types/model-client';
import { getModelsByProvider } from '@/services/model-catalog-service';
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'replicate-adapter' });

// ── Types ────────────────────────────────────────────────────────────────────

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  input: Record<string, unknown>;
  output: unknown;
  error?: string;
  urls: { get: string; cancel?: string; stream?: string };
  created_at: string;
  completed_at?: string;
  model?: string;
  version?: string;
  metrics?: { predict_time?: number };
}

interface ReplicateModel {
  url: string;
  owner: string;
  name: string;
  description: string;
  visibility: string;
  latest_version?: { id: string };
}

interface ReplicateModelVersion {
  id: string;
  created_at: string;
  cog_version: string;
  openapi_schema?: Record<string, unknown>;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class ReplicateAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super('replicate', 'Replicate', config);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.replicate.com/v1';
  }

  // ── ProviderAdapter abstract methods ─────────────────────────────────────

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('replicate');

    if (!models.length) {
      log.warn('No models registered in catalog for Replicate');
    }

    return models.map((model) => ({
      ...model,
      id: model.name,
    }));
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();

    return {
      id: 'replicate',
      name: 'replicate',
      displayName: 'Replicate',
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
   * Chat completion via Replicate predictions API.
   * Creates a sync prediction (Prefer: wait) for an LLM model.
   * Expects the model ID to be in "owner/name" or "owner/name:version" format.
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const modelId = request.model || '';

    // Build prompt from messages (Replicate LLM models typically take a "prompt" input)
    const prompt = this.messagesToPrompt(request);

    const input: Record<string, unknown> = {
      prompt,
      max_tokens: request.max_tokens ?? 2048,
    };
    if (request.temperature !== undefined) {
      input.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      input.top_p = request.top_p;
    }

    let prediction: ReplicatePrediction;

    // Use model-based prediction if it looks like "owner/name" (no version hash)
    if (modelId.includes('/') && !modelId.includes(':')) {
      const [owner, name] = modelId.split('/');
      prediction = await this.createModelPrediction(owner, name, input, { sync: true });
    } else if (modelId.includes(':')) {
      // "owner/name:version" format
      const version = modelId.split(':')[1];
      prediction = await this.createPrediction(version, input, { sync: true });
    } else {
      // Fallback: treat entire string as version
      prediction = await this.createPrediction(modelId, input, { sync: true });
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate prediction failed: ${prediction.error || 'unknown error'}`);
    }

    // Convert output to string
    const outputText = this.extractTextOutput(prediction.output);

    return {
      id: prediction.id,
      object: 'chat.completion',
      created: Math.floor(new Date(prediction.created_at).getTime() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: outputText,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  /**
   * Streaming chat completion via Replicate's streaming predictions.
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const modelId = request.model || '';
    const prompt = this.messagesToPrompt(request);

    const input: Record<string, unknown> = {
      prompt,
      max_tokens: request.max_tokens ?? 2048,
    };
    if (request.temperature !== undefined) {
      input.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      input.top_p = request.top_p;
    }

    // Create the prediction (async mode, then poll or stream)
    let prediction: ReplicatePrediction;

    if (modelId.includes('/') && !modelId.includes(':')) {
      const [owner, name] = modelId.split('/');
      prediction = await this.createModelPrediction(owner, name, input, { sync: false });
    } else {
      const version = modelId.includes(':') ? modelId.split(':')[1] : modelId;
      prediction = await this.createPrediction(version, input, { sync: false });
    }

    // If the prediction has a stream URL, use SSE streaming
    if (prediction.urls?.stream) {
      yield* this.streamFromSSE(prediction.urls.stream, modelId, prediction.id);
      return;
    }

    // Fallback: poll for completion
    const completed = await this.pollPrediction(prediction.id);
    const outputText = this.extractTextOutput(completed.output);

    yield {
      id: completed.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: outputText,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    };
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('Replicate: generateEmbeddings not supported. Use a dedicated embedding provider.');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/account`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      const latency = Date.now() - startTime;

      return {
        healthy: response.ok,
        latency,
        checkedAt: new Date(),
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        healthy: false,
        latency: Date.now() - startTime,
        checkedAt: new Date(),
        error: errorMessage,
      };
    }
  }

  async checkBalance(): Promise<null> {
    // Replicate does not expose a balance API
    return null;
  }

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost =
      (inputTokens / 1000) * Math.max(0, inputRate) +
      (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  /**
   * Image generation via Replicate prediction.
   * Supports SDXL, Flux, Stable Diffusion, etc.
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const modelId = model.name || model.id;
    const input: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.size) {
      const [w, h] = request.size.split('x').map(Number);
      if (w && h) {
        input.width = w;
        input.height = h;
      }
    }

    if (request.options) {
      Object.assign(input, request.options);
    }

    let prediction: ReplicatePrediction;

    if (modelId.includes('/') && !modelId.includes(':')) {
      const [owner, name] = modelId.split('/');
      prediction = await this.createModelPrediction(owner, name, input, { sync: true });
    } else {
      const version = modelId.includes(':') ? modelId.split(':')[1] : modelId;
      prediction = await this.createPrediction(version, input, { sync: true });
    }

    // If sync returned non-completed, poll
    if (prediction.status !== 'succeeded') {
      prediction = await this.pollPrediction(prediction.id);
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate image generation failed: ${prediction.error || 'unknown error'}`);
    }

    // Output is typically a URL or array of URLs
    const imageUrl = this.extractFirstUrl(prediction.output);
    if (!imageUrl) {
      throw new Error('Replicate image generation returned no output URL');
    }

    // Download the image
    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image from Replicate: HTTP ${imageResponse.status}`);
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const contentType = imageResponse.headers.get('content-type') || 'image/png';
    const format = contentType.includes('jpeg') || contentType.includes('jpg')
      ? 'jpg'
      : contentType.includes('webp')
        ? 'webp'
        : 'png';

    return {
      image: buffer,
      format,
      raw: prediction,
    };
  }

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const modelId = model.name || model.id;
    const input: Record<string, unknown> = {
      text: request.text,
    };
    if (request.voice) input.voice = request.voice;
    if (request.options) Object.assign(input, request.options);

    let prediction: ReplicatePrediction;
    if (modelId.includes('/') && !modelId.includes(':')) {
      const [owner, name] = modelId.split('/');
      prediction = await this.createModelPrediction(owner, name, input, { sync: true });
    } else {
      const version = modelId.includes(':') ? modelId.split(':')[1] : modelId;
      prediction = await this.createPrediction(version, input, { sync: true });
    }

    if (prediction.status !== 'succeeded') {
      prediction = await this.pollPrediction(prediction.id);
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate TTS failed: ${prediction.error || 'unknown error'}`);
    }

    const audioUrl = this.extractFirstUrl(prediction.output);
    if (!audioUrl) {
      throw new Error('Replicate TTS returned no output URL');
    }

    const audioResponse = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio from Replicate: HTTP ${audioResponse.status}`);
    }

    const buffer = Buffer.from(await audioResponse.arrayBuffer());
    const contentType = audioResponse.headers.get('content-type') || 'audio/wav';
    const format = contentType.includes('mp3') ? 'mp3' : contentType.includes('ogg') ? 'ogg' : 'wav';

    return {
      audio: buffer,
      format,
      raw: prediction,
    };
  }

  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const modelId = model.name || model.id;
    // Whisper-style models on Replicate expect an audio URL or base64
    const audioBase64 = request.audio.toString('base64');
    const input: Record<string, unknown> = {
      audio: `data:audio/wav;base64,${audioBase64}`,
    };
    if (request.language) input.language = request.language;
    if (request.options) Object.assign(input, request.options);

    let prediction: ReplicatePrediction;
    if (modelId.includes('/') && !modelId.includes(':')) {
      const [owner, name] = modelId.split('/');
      prediction = await this.createModelPrediction(owner, name, input, { sync: true });
    } else {
      const version = modelId.includes(':') ? modelId.split(':')[1] : modelId;
      prediction = await this.createPrediction(version, input, { sync: true });
    }

    if (prediction.status !== 'succeeded') {
      prediction = await this.pollPrediction(prediction.id);
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate STT failed: ${prediction.error || 'unknown error'}`);
    }

    const text = this.extractTextOutput(prediction.output);

    return {
      text,
      raw: prediction,
    };
  }

  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('Replicate: imageEdit not implemented. Use a prediction directly for image editing models.');
  }

  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('Replicate: imageVariation not implemented. Use a prediction directly for image variation models.');
  }

  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('Replicate: moderate not implemented. Replicate does not have a dedicated moderation API.');
  }

  // ── Core Prediction Methods ──────────────────────────────────────────────

  /**
   * Create a prediction (async by default, sync with Prefer: wait)
   */
  async createPrediction(
    modelVersion: string,
    input: Record<string, unknown>,
    options?: { sync?: boolean; webhook?: string },
  ): Promise<ReplicatePrediction> {
    const headers = this.buildHeaders();
    if (options?.sync) {
      headers['Prefer'] = 'wait';
    }

    const body: Record<string, unknown> = {
      version: modelVersion,
      input,
    };
    if (options?.webhook) {
      body.webhook = options.webhook;
    }

    const submit = async (): Promise<ReplicatePrediction> => {
      const response = await fetch(`${this.baseUrl}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options?.sync ? 300_000 : 30_000), // 5 min for sync, 30s for async
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(`Replicate prediction failed (${response.status}): ${JSON.stringify(error)}`);
      }

      return (await response.json()) as ReplicatePrediction;
    };

    // Async predictions (fast submit, then poll separately) run through the
    // resilience stack (bulkhead → breaker → timeout) so an outage fast-fails
    // and is isolated per-provider. Sync predictions use `Prefer: wait` and
    // legitimately block up to 5 minutes, which exceeds the 60s llm-provider
    // breaker timeout — leaving them unwrapped preserves the happy path.
    return options?.sync ? submit() : this.executeThroughBulkhead(submit, 'prediction');
  }

  /**
   * Get prediction status
   */
  async getPrediction(predictionId: string): Promise<ReplicatePrediction> {
    const response = await fetch(`${this.baseUrl}/predictions/${predictionId}`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(`Replicate get prediction failed (${response.status}): ${JSON.stringify(error)}`);
    }

    return (await response.json()) as ReplicatePrediction;
  }

  /**
   * List predictions
   */
  async listPredictions(cursor?: string): Promise<{ results: ReplicatePrediction[]; next?: string }> {
    const url = cursor
      ? `${this.baseUrl}/predictions?cursor=${encodeURIComponent(cursor)}`
      : `${this.baseUrl}/predictions`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list predictions failed: HTTP ${response.status}`);
    }

    return (await response.json()) as { results: ReplicatePrediction[]; next?: string };
  }

  /**
   * Cancel prediction
   */
  async cancelPrediction(predictionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/predictions/${predictionId}/cancel`, {
      method: 'POST',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate cancel prediction failed: HTTP ${response.status}`);
    }
  }

  /**
   * Create prediction for official models (different endpoint: /models/{owner}/{name}/predictions)
   */
  async createModelPrediction(
    owner: string,
    name: string,
    input: Record<string, unknown>,
    options?: { sync?: boolean },
  ): Promise<ReplicatePrediction> {
    const headers = this.buildHeaders();
    if (options?.sync) {
      headers['Prefer'] = 'wait';
    }

    const submit = async (): Promise<ReplicatePrediction> => {
      const response = await fetch(`${this.baseUrl}/models/${owner}/${name}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(options?.sync ? 300_000 : 30_000),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(
          `Replicate model prediction for ${owner}/${name} failed (${response.status}): ${JSON.stringify(error)}`,
        );
      }

      return (await response.json()) as ReplicatePrediction;
    };

    // Async predictions run through the resilience stack; sync predictions
    // (`Prefer: wait`, up to 5 min) stay unwrapped to preserve the happy path
    // (see createPrediction).
    return options?.sync ? submit() : this.executeThroughBulkhead(submit, 'model prediction');
  }

  // ── Model Methods ────────────────────────────────────────────────────────

  /**
   * List public models (search)
   */
  async listPublicModels(query?: string): Promise<ReplicateModel[]> {
    const url = query
      ? `${this.baseUrl}/models?query=${encodeURIComponent(query)}`
      : `${this.baseUrl}/models`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list models failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { results?: ReplicateModel[] };
    return data.results || [];
  }

  /**
   * Get model details
   */
  async getModelDetails(owner: string, name: string): Promise<ReplicateModel> {
    const response = await fetch(`${this.baseUrl}/models/${owner}/${name}`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate get model ${owner}/${name} failed: HTTP ${response.status}`);
    }

    return (await response.json()) as ReplicateModel;
  }

  /**
   * List model versions
   */
  async listModelVersions(owner: string, name: string): Promise<ReplicateModelVersion[]> {
    const response = await fetch(`${this.baseUrl}/models/${owner}/${name}/versions`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list model versions failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { results?: ReplicateModelVersion[] };
    return data.results || [];
  }

  /**
   * List collections
   */
  async listCollections(): Promise<unknown[]> {
    const response = await fetch(`${this.baseUrl}/collections`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list collections failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { results?: unknown[] };
    return data.results || [];
  }

  /**
   * Get collection
   */
  async getCollection(slug: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/collections/${slug}`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate get collection ${slug} failed: HTTP ${response.status}`);
    }

    return (await response.json()) as unknown;
  }

  // ── Account & System ─────────────────────────────────────────────────────

  /**
   * Get account info
   */
  async getAccount(): Promise<{ username: string; type: string }> {
    const response = await fetch(`${this.baseUrl}/account`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate get account failed: HTTP ${response.status}`);
    }

    return (await response.json()) as { username: string; type: string };
  }

  /**
   * List hardware options
   */
  async listHardware(): Promise<Array<{ name: string; sku: string }>> {
    const response = await fetch(`${this.baseUrl}/hardware`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list hardware failed: HTTP ${response.status}`);
    }

    return (await response.json()) as Array<{ name: string; sku: string }>;
  }

  // ── Training Methods ─────────────────────────────────────────────────────

  async createTraining(
    owner: string,
    name: string,
    versionId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(
      `${this.baseUrl}/models/${owner}/${name}/versions/${versionId}/trainings`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(`Replicate create training failed (${response.status}): ${JSON.stringify(error)}`);
    }

    return (await response.json()) as unknown;
  }

  async getTraining(trainingId: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/trainings/${trainingId}`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate get training failed: HTTP ${response.status}`);
    }

    return (await response.json()) as unknown;
  }

  async listTrainings(): Promise<unknown[]> {
    const response = await fetch(`${this.baseUrl}/trainings`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list trainings failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { results?: unknown[] };
    return data.results || [];
  }

  async cancelTraining(trainingId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/trainings/${trainingId}/cancel`, {
      method: 'POST',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate cancel training failed: HTTP ${response.status}`);
    }
  }

  // ── Deployment Methods ───────────────────────────────────────────────────

  async createDeployment(config: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/deployments`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(`Replicate create deployment failed (${response.status}): ${JSON.stringify(error)}`);
    }

    return (await response.json()) as unknown;
  }

  async listDeployments(): Promise<unknown[]> {
    const response = await fetch(`${this.baseUrl}/deployments`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate list deployments failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { results?: unknown[] };
    return data.results || [];
  }

  async getDeployment(owner: string, name: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/deployments/${owner}/${name}`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Replicate get deployment ${owner}/${name} failed: HTTP ${response.status}`);
    }

    return (await response.json()) as unknown;
  }

  async createDeploymentPrediction(
    owner: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ReplicatePrediction> {
    const response = await fetch(`${this.baseUrl}/deployments/${owner}/${name}/predictions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(
        `Replicate deployment prediction for ${owner}/${name} failed (${response.status}): ${JSON.stringify(error)}`,
      );
    }

    return (await response.json()) as ReplicatePrediction;
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Convert ChatRequest messages into a single prompt string for Replicate LLM models.
   */
  private messagesToPrompt(request: ChatRequest): string {
    const parts: string[] = [];

    for (const msg of request.messages) {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((part) => {
                  if (typeof part === 'string') return part;
                  if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
                    return part.text;
                  }
                  return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

      if (msg.role === 'system') {
        parts.push(`[INST] <<SYS>>\n${content}\n<</SYS>> [/INST]`);
      } else if (msg.role === 'user') {
        parts.push(`[INST] ${content} [/INST]`);
      } else if (msg.role === 'assistant') {
        parts.push(content);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract text from Replicate prediction output.
   * Output can be: string, string[], or complex object.
   */
  private extractTextOutput(output: unknown): string {
    if (typeof output === 'string') {
      return output;
    }
    if (Array.isArray(output)) {
      // Many LLM models return an array of string tokens
      return output
        .map((item) => (typeof item === 'string' ? item : ''))
        .join('');
    }
    if (output && typeof output === 'object') {
      // Check for common output keys
      const obj = output as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.output === 'string') return obj.output;
      if (typeof obj.transcription === 'string') return obj.transcription;
    }
    return String(output ?? '');
  }

  /**
   * Extract first URL from prediction output (for image/audio models).
   */
  private extractFirstUrl(output: unknown): string | null {
    if (typeof output === 'string' && output.startsWith('http')) {
      return output;
    }
    if (Array.isArray(output)) {
      for (const item of output) {
        if (typeof item === 'string' && item.startsWith('http')) {
          return item;
        }
      }
    }
    if (output && typeof output === 'object') {
      const obj = output as Record<string, unknown>;
      if (typeof obj.url === 'string') return obj.url;
      if (typeof obj.output === 'string' && (obj.output as string).startsWith('http')) {
        return obj.output as string;
      }
    }
    return null;
  }

  /**
   * Poll a prediction until it completes or fails.
   */
  private async pollPrediction(
    predictionId: string,
    maxAttempts: number = 120,
    intervalMs: number = 2000,
  ): Promise<ReplicatePrediction> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const prediction = await this.getPrediction(predictionId);

      if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') {
        return prediction;
      }

      await this.sleep(intervalMs);
    }

    throw new Error(`Replicate prediction ${predictionId} timed out after ${maxAttempts} polling attempts`);
  }

  /**
   * Stream from an SSE endpoint (Replicate streaming predictions).
   */
  private async *streamFromSSE(
    streamUrl: string,
    modelId: string,
    predictionId: string,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const response = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'text/event-stream',
      },
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Replicate SSE stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = (await reader.read()) as {
          done: boolean;
          value: Uint8Array | undefined;
        };
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed === 'event: done') {
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            yield {
              id: predictionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: data,
                  },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
