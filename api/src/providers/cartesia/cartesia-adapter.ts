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
 * NO HARDCODED MODELS — model/voice selection by capabilities.
 */

import { ProviderAdapter, type ProviderConfig, type HealthCheckResult } from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type { AudioTTSRequest, AudioTTSResponse, ModerationResponse, ImageEditResponse, ImageVariationResponse } from '@/types/model-client';
import { logger } from '@/utils/logger';
import WebSocket from 'ws';

const log = logger.child({ provider: 'cartesia' });

// Cartesia API version
const CARTESIA_VERSION = '2025-04-16';

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
    const modelId = model.name || model.id || 'sonic';

    try {
      // Resolve voice: if UUID use directly, if name map to UUID, fallback to default
      const rawVoice = request.voice || request.options?.voice as string || '';
      const voiceId = this.resolveVoiceId(rawVoice);

      // Map format
      let outputFormat: Record<string, unknown>;
      const format = request.format || 'mp3';
      if (format === 'pcm' || format === 'wav') {
        outputFormat = { container: format === 'wav' ? 'wav' : 'raw', encoding: 'pcm_s16le', sample_rate: 24000 };
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
      alloy: 'a0e99841-438c-4a64-b679-ae501e7d6091',  // Barbershop Man
      echo: 'c2ac25f9-ecc4-4f56-9095-651354df60c0',  // Classy British Man
      fable: '87748186-23bb-4571-b42b-1acb74960a72',  // Wise Lady
      onyx: 'daf747c6-6bc2-4083-bd59-aa94dce23233',  // Wise Man
      nova: 'b7d50908-b17c-442d-ad8d-810c63997ed9',  // Friendly Sidekick
      shimmer: '2ee87190-8f84-4925-97da-e52547f9462c',  // Gentle Lady
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
    const modelId = model.name || model.id || 'sonic';
    const voiceId = voice || 'a0e99841-438c-4a64-b679-ae501e7d6091';

    return new Promise((resolve, reject) => {
      const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${this.config.apiKey}&cartesia_version=${CARTESIA_VERSION}`;
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Cartesia WS TTS timeout 10s')); }, 10000);
      const contextId = `ctx_${Date.now()}`;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          model_id: modelId,
          transcript: text,
          voice: { mode: 'id', id: voiceId },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          context_id: contextId,
        }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as { type?: string; data?: string; done?: boolean };
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

      ws.on('close', () => { clearTimeout(timeout); resolve(); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
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

  async getModels(): Promise<Model[]> {
    // Dynamically discover models from Cartesia API — zero hardcoded models
    const perf: import('@/types').ModelPerformance = { latencyMs: 90, throughput: 0, quality: 0.95, reliability: 0.9 };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'cartesia', provider: 'cartesia',
      contextWindow: 0, maxOutputTokens: 0,
      inputCostPer1k: 0, outputCostPer1k: 0,
      status: 'active', performance: perf,
    };

    try {
      // Fetch available models from Cartesia API
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'Cartesia models API failed, returning empty');
        return [];
      }

      const data = await response.json() as Array<{ id: string; name?: string; description?: string; languages?: string[] }>;

      if (!Array.isArray(data) || data.length === 0) {
        log.warn('Cartesia returned no models');
        return [];
      }

      return data.map(m => ({
        ...base,
        id: `cartesia/${m.id}`,
        name: m.id,
        displayName: `Cartesia ${m.name || m.id} (TTS)`,
        capabilities: ['text_to_speech', 'streaming'] as import('@/types').ModelCapability[],
        metadata: { languages: m.languages, description: m.description },
      }));
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Cartesia model discovery failed');
      return [];
    }
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
      return { healthy: false, latency: 0, error: error instanceof Error ? error.message : 'Unknown', checkedAt: new Date() };
    }
  }

  // ── Not Supported (TTS-only provider) ──────────────────

  async chatCompletion(): Promise<ChatResponse> { throw new Error('Cartesia: TTS-only provider'); }
  // eslint-disable-next-line require-yield -- TTS-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> { throw new Error('Cartesia: TTS-only provider'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('Not supported'); }
  calculateCost(): number { return 0; }
  normalizeModelName(name: string): string { return name; }
  async moderate(): Promise<ModerationResponse> { throw new Error('Not supported'); }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('Not supported'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('Not supported'); }
}
