// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cartesia Provider Adapter
 *
 * TTS-first provider: Ultra-low latency speech synthesis (Sonic)
 * Auth: `X-API-Key: ${apiKey}`
 * TTS REST: POST /tts/bytes
 * TTS WebSocket: wss://api.cartesia.ai/tts/websocket (streaming)
 *
 * ### Model discovery — no `/models` endpoint exists (verified 2026-09-12)
 *
 * `getModels()` used to call `GET {baseUrl}/models`, which Cartesia has
 * never exposed (confirmed live in production as an HTTP 404 — see the
 * 2026-09-10 discovery-audit comment this replaced). Cartesia's REST API
 * reference (https://docs.cartesia.ai/api-reference/tts/bytes, fetched
 * 2026-09-12) documents no model-listing route at all — the only listing
 * resource is `GET /voices` (confirmed live 200, and mirrored by the
 * `cartesia-js` SDK's `resources/voices.ts` `list()` method), and a VOICE
 * (a persona with a UUID and a display name like "Skylar - Friendly
 * Guide") is a different resource type from a TTS MODEL (`sonic-3`,
 * `sonic-3.5`, ...) — `/voices` cannot substitute as model discovery.
 * The `cartesia-js` SDK's current `main` branch (checked 2026-09-12 via
 * the GitHub API file tree) has no `models` resource file either — only
 * `access-token`, `agents`, `datasets`, `fine-tunes`,
 * `pronunciation-dicts`, `stt`, `tts`, `voice-changer`, `voices`. Model
 * ids are a plain request parameter on `POST /tts/bytes`
 * (`TTSModel = 'sonic-3.5' | 'sonic-3' | ... | (string & {})` in the SDK's
 * `resources/tts.ts`), not a queryable resource.
 *
 * `getModels()` therefore returns the operator-curated `CARTESIA_MODELS`
 * list below — no network call — mirroring the `pinnedFallback.models`
 * entry for `cartesia` in `providers.catalog.ts` (same
 * `reason: 'no-list-endpoint'` pattern as `topaz`/`v0`). See that catalog
 * entry's comment for the model-lifecycle sourcing
 * (https://docs.cartesia.ai/build-with-cartesia/tts-models/api-changes,
 * fetched 2026-09-12): `sonic-3`, `sonic-3.5`, and `sonic-3.6` are the
 * current stable families; bare `sonic` was already sunsetted (June 1,
 * 2026) and `sonic-2`/`sonic-turbo` sunset October 20, 2026, so none of
 * the three are used here as the id, still less as a silent fallback.
 *
 * NO HARDCODED MODELS beyond this curated, source-cited fallback — no
 * network-discovered model list exists to prefer over it.
 */

import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '@/providers/base/provider-adapter';
import type {
  Provider,
  Model,
  ModelCapability,
  ChatResponse,
  EmbeddingResponse,
} from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  ModerationResponse,
  ImageEditResponse,
  ImageVariationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import WebSocket from 'ws';

const log = logger.child({ provider: 'cartesia' });

// Cartesia API version
const CARTESIA_VERSION = '2025-04-16';

/**
 * Operator-curated TTS model inventory — mirrors `pinnedFallback.models`
 * for `cartesia` in `providers.catalog.ts` (same three ids, same
 * source/date). See that entry's comment for the full sourcing citation.
 * Kept as a same-file constant (like `V0_MODELS` in v0-adapter.ts and
 * `ENHANCE_MODELS` in topaz-adapter.ts) so `getModels()` never has to
 * reach across modules — and never has to hit the wire.
 */
const CARTESIA_MODELS: ReadonlyArray<{ id: string; capabilities: ModelCapability[] }> = [
  { id: 'sonic-3', capabilities: ['text_to_speech', 'streaming'] },
  { id: 'sonic-3.5', capabilities: ['text_to_speech', 'streaming'] },
  { id: 'sonic-3.6', capabilities: ['text_to_speech', 'streaming'] },
] as const;

/**
 * Fallback `model_id` used only when a caller passes neither `model.name`
 * nor `model.id`. Was `'sonic'` (the bare, unversioned id) — per
 * Cartesia's own model-lifecycle docs
 * (https://docs.cartesia.ai/build-with-cartesia/tts-models/api-changes,
 * fetched 2026-09-12) that id was SUNSETTED June 1, 2026 and now returns a
 * `model_sunsetted` error on every call, so it was a guaranteed-broken
 * silent default. `sonic-3` is the oldest family still documented as
 * "Stable" (not deprecating) as of the same fetch.
 */
const DEFAULT_MODEL_ID = 'sonic-3';

export class CartesiaAdapter extends ProviderAdapter {
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    super('cartesia', 'Cartesia', config);
    this.baseUrl = (config.baseUrl || 'https://api.cartesia.ai').replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return {
      'X-API-Key': this.config.apiKey,
      'Cartesia-Version': CARTESIA_VERSION,
    };
  }

  // ── Audio: TTS (Text-to-Speech) — Primary capability ──────────────────

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const start = Date.now();
    const modelId = model.name || model.id || DEFAULT_MODEL_ID;

    try {
      // Resolve voice: if UUID use directly, if name map to UUID, fallback to default
      const rawVoice = request.voice || (request.options?.voice as string) || '';
      const voiceId = this.resolveVoiceId(rawVoice);

      // Map format
      let outputFormat: Record<string, unknown>;
      const format = request.format || 'mp3';
      if (format === 'pcm' || format === 'wav') {
        outputFormat = {
          container: format === 'wav' ? 'wav' : 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 24000,
        };
      } else {
        outputFormat = { container: 'mp3', encoding: 'mp3', sample_rate: 44100 };
      }

      const payload = {
        model_id: modelId,
        transcript: request.text,
        voice: {
          mode: 'id',
          id: voiceId,
        },
        output_format: outputFormat,
        language: 'en', // Default; can be overridden
      };

      // Route connection establishment through the resilience stack (bulkhead →
      // breaker → timeout) so a Cartesia outage fast-fails and is isolated
      // per-provider; the audio bytes are read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${this.baseUrl}/tts/bytes`, {
          method: 'POST',
          headers: {
            ...this.authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Cartesia TTS failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'text-to-speech');

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const latency = Date.now() - start;

      log.info({ model: modelId, latency, bytes: audioBuffer.length }, 'TTS completed');

      return {
        audio: audioBuffer,
        format,
        raw: { size: audioBuffer.length, latency },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ model: modelId, latency, error: msg }, 'TTS failed');
      throw error;
    }
  }

  /** Resolve voice name to Cartesia UUID. Accepts UUID directly or common names. */
  private resolveVoiceId(voice: string): string {
    // If it looks like a UUID, use directly
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voice)) return voice;

    // Map common OpenAI-compatible names to Cartesia voice UUIDs
    const voiceMap: Record<string, string> = {
      alloy: 'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop Man
      echo: 'c2ac25f9-ecc4-4f56-9095-651354df60c0', // Classy British Man
      fable: '87748186-23bb-4571-b42b-1acb74960a72', // Wise Lady
      onyx: 'daf747c6-6bc2-4083-bd59-aa94dce23233', // Wise Man
      nova: 'b7d50908-b17c-442d-ad8d-810c63997ed9', // Friendly Sidekick
      shimmer: '2ee87190-8f84-4925-97da-e52547f9462c', // Gentle Lady
      default: 'a0e99841-438c-4a64-b679-ae501e7d6091',
      auto: 'a0e99841-438c-4a64-b679-ae501e7d6091',
    };

    return voiceMap[voice.toLowerCase()] || voiceMap.default;
  }

  // ── TTS WebSocket Streaming (L11) ──────────────────
  // Sends text incrementally, receives audio chunks with ~40ms TTFB.
  // Use for pipeline: LLM token → Cartesia WS → audio chunk → client.

  async textToSpeechStreaming(
    model: Model,
    text: string,
    onAudioChunk: (chunk: Buffer) => void,
    voice?: string
  ): Promise<void> {
    const modelId = model.name || model.id || DEFAULT_MODEL_ID;
    const voiceId = voice || 'a0e99841-438c-4a64-b679-ae501e7d6091';

    return new Promise((resolve, reject) => {
      const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${this.config.apiKey}&cartesia_version=${CARTESIA_VERSION}`;
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Cartesia WS TTS timeout 10s'));
      }, 10000);
      const contextId = `ctx_${Date.now()}`;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            model_id: modelId,
            transcript: text,
            voice: { mode: 'id', id: voiceId },
            output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
            context_id: contextId,
          })
        );
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type?: string;
            data?: string;
            done?: boolean;
          };
          if (msg.type === 'chunk' && msg.data) {
            const audioBuf = Buffer.from(msg.data, 'base64');
            onAudioChunk(audioBuf);
          }
          if (msg.done) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        } catch {
          // Binary audio frame — emit directly
          if (Buffer.isBuffer(data) && data.length > 100) {
            onAudioChunk(data);
          }
        }
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ── Provider Metadata ──────────────────

  async getProvider(): Promise<Provider> {
    return {
      id: 'cartesia',
      name: 'cartesia',
      displayName: 'Cartesia',
      status: 'active',
      health: { status: 'healthy', lastCheck: new Date() },
      models: [],
    };
  }

  /**
   * Cartesia has no bulk `/models` route (see the class doc comment) —
   * returns the pinned `CARTESIA_MODELS` list, mirroring
   * `pinnedFallback.models` for `cartesia` in `providers.catalog.ts`. No
   * network call, so this never fails and never returns empty.
   */
  async getModels(): Promise<Model[]> {
    const perf: import('@/types').ModelPerformance = {
      latencyMs: 90,
      throughput: 0,
      quality: 0.95,
      reliability: 0.9,
    };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'cartesia',
      provider: 'cartesia',
      contextWindow: 0,
      maxOutputTokens: 0,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      status: 'active',
      performance: perf,
    };

    return CARTESIA_MODELS.map((m) => ({
      ...base,
      id: `cartesia/${m.id}`,
      name: m.id,
      displayName: `Cartesia ${m.id} (TTS)`,
      capabilities: m.capabilities,
    }));
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const start = Date.now();
      // Cartesia doesn't have a dedicated health endpoint; use voices list
      const response = await fetch(`${this.baseUrl}/voices`, {
        headers: this.authHeaders(),
      });
      return {
        healthy: response.ok,
        latency: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        healthy: false,
        latency: 0,
        error: error instanceof Error ? error.message : 'Unknown',
        checkedAt: new Date(),
      };
    }
  }

  // ── Not Supported (TTS-only provider) ──────────────────

  async chatCompletion(): Promise<ChatResponse> {
    throw new Error('Cartesia: TTS-only provider');
  }

  // eslint-disable-next-line require-yield -- TTS-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
    throw new Error('Cartesia: TTS-only provider');
  }

  async generateEmbeddings(): Promise<EmbeddingResponse> {
    throw new Error('Not supported');
  }

  calculateCost(): number {
    return 0;
  }

  normalizeModelName(name: string): string {
    return name;
  }

  async moderate(): Promise<ModerationResponse> {
    throw new Error('Not supported');
  }

  async imageEdit(): Promise<ImageEditResponse> {
    throw new Error('Not supported');
  }

  async imageVariation(): Promise<ImageVariationResponse> {
    throw new Error('Not supported');
  }
}
