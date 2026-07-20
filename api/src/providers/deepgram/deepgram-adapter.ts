// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Deepgram Provider Adapter
 *
 * Audio-first provider: STT (Nova-3) + TTS (Aura-2)
 * Auth: `Token ${apiKey}` (NOT Bearer)
 * STT: POST /listen or WSS /listen (streaming)
 * TTS: POST /speak?model={model}
 *
 * NO HARDCODED MODELS — model selection by capabilities via AudioOrchestrationService.
 */

import { ProviderAdapter, type ProviderConfig, type HealthCheckResult, type BalanceCheckResult } from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type { AudioTTSRequest, AudioTTSResponse, AudioSTTRequest, AudioSTTResponse, ModerationResponse, ImageEditResponse, ImageVariationResponse } from '@/types/model-client';
import { logger } from '@/utils/logger';
import WebSocket from 'ws';

const log = logger.child({ provider: 'deepgram' });

export class DeepgramAdapter extends ProviderAdapter {
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    super('deepgram', 'Deepgram', config);
    this.baseUrl = (config.baseUrl || 'https://api.deepgram.com/v1').replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Token ${this.config.apiKey}`,
    };
  }

  // ── Audio: STT (Speech-to-Text) ──────────────────

  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const start = Date.now();
    const modelName = model.name || model.id || 'nova-3';

    try {
      const params = new URLSearchParams({ model: modelName });
      if (request.language) params.set('language', request.language);
      params.set('smart_format', 'true');
      params.set('punctuate', 'true');

      const mimeType: string = (request.options?.mimeType as string) || 'audio/wav';

      // Route connection establishment through the resilience stack (bulkhead →
      // breaker → timeout) so a Deepgram outage fast-fails and is isolated
      // per-provider; the JSON body is read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${this.baseUrl}/listen?${params}`, {
          method: 'POST',
          headers: {
            ...this.authHeaders(),
            'Content-Type': mimeType,
          } as Record<string, string>,
          body: Buffer.from(request.audio),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Deepgram STT failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'speech-to-text');

      const data = await response.json() as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{
              transcript?: string;
              confidence?: number;
              words?: Array<{ word: string; start: number; end: number; confidence: number }>;
            }>;
          }>;
        };
        metadata?: { duration?: number; request_id?: string };
      };

      const alt = data.results?.channels?.[0]?.alternatives?.[0];
      const latency = Date.now() - start;

      log.info({ model: modelName, latency, textLen: alt?.transcript?.length || 0 }, 'STT completed');

      return {
        text: alt?.transcript || '',
        raw: {
          ...data,
          latency,
          words: alt?.words,
          confidence: alt?.confidence,
          duration: data.metadata?.duration,
        },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ model: modelName, latency, error: msg }, 'STT failed');
      throw error;
    }
  }

  // ── Audio: STT WebSocket Streaming (L10) ──────────────────
  // For long audio (>5s), WebSocket streaming is faster than REST batch.
  // Sends audio chunks incrementally, receives interim transcripts.

  async speechToTextStreaming(
    model: Model,
    audioBuffer: Buffer,
    onInterim?: (text: string) => void
  ): Promise<AudioSTTResponse> {
    const start = Date.now();
    const modelName = model.name || model.id || 'nova-3';

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: modelName,
        smart_format: 'true',
        punctuate: 'true',
        interim_results: onInterim ? 'true' : 'false',
        utterance_end_ms: '1000',
        vad_events: 'true',
      });

      const wsUrl = `wss://api.deepgram.com/v1/listen?${params}`;
      const ws = new WebSocket(wsUrl, { headers: this.authHeaders() });
      let finalTranscript = '';
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Deepgram WS STT timeout 15s')); }, 15000);

      ws.on('open', () => {
        // Send audio in 8KB chunks for smooth streaming
        const CHUNK = 8192;
        for (let i = 0; i < audioBuffer.length; i += CHUNK) {
          ws.send(audioBuffer.subarray(i, Math.min(i + CHUNK, audioBuffer.length)));
        }
        // Signal end of audio
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string }> };
          };

          if (msg.type === 'Results') {
            const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
            if (msg.is_final && transcript) {
              finalTranscript += (finalTranscript ? ' ' : '') + transcript;
            }
            if (!msg.is_final && transcript && onInterim) {
              onInterim(transcript);
            }
          }
        } catch { /* skip */ }
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        const latency = Date.now() - start;
        log.info({ model: modelName, latency, textLen: finalTranscript.length, method: 'websocket' }, 'STT streaming completed');
        resolve({ text: finalTranscript, raw: { latency, method: 'websocket' } });
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        log.error({ model: modelName, error: err.message }, 'STT WebSocket error');
        reject(err);
      });
    });
  }

  // ── Audio: TTS (Text-to-Speech) ──────────────────

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const start = Date.now();
    const modelName = model.name || model.id || 'aura-2-thalia-en';

    try {
      const params = new URLSearchParams({ model: modelName });

      // Map format to Deepgram encoding
      const format = request.format || 'mp3';
      if (format === 'pcm' || format === 'wav') {
        params.set('encoding', 'linear16');
        params.set('container', format === 'wav' ? 'wav' : 'none');
        params.set('sample_rate', '24000');
      }
      // mp3 is default — no params needed

      // Route connection establishment through the resilience stack (bulkhead →
      // breaker → timeout) so a Deepgram outage fast-fails and is isolated
      // per-provider; the audio bytes are read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${this.baseUrl}/speak?${params}`, {
          method: 'POST',
          headers: {
            ...this.authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: request.text }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Deepgram TTS failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'text-to-speech');

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const latency = Date.now() - start;

      log.info({ model: modelName, latency, bytes: audioBuffer.length }, 'TTS completed');

      return {
        audio: audioBuffer,
        format,
        raw: { size: audioBuffer.length, latency },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ model: modelName, latency, error: msg }, 'TTS failed');
      throw error;
    }
  }

  // ── Provider Metadata ──────────────────

  async getProvider(): Promise<Provider> {
    return {
      id: 'deepgram',
      name: 'deepgram',
      displayName: 'Deepgram',
      status: 'active',
      health: { status: 'healthy', lastCheck: new Date() },
      models: [],
    };
  }

  async getModels(): Promise<Model[]> {
    // Dynamically discover models from Deepgram API
    const perf: import('@/types').ModelPerformance = { latencyMs: 300, throughput: 0, quality: 0.9, reliability: 0.95 };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'deepgram', provider: 'deepgram',
      contextWindow: 0, maxOutputTokens: 0,
      inputCostPer1k: 0, outputCostPer1k: 0,
      status: 'active', performance: perf,
    };

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'Deepgram models API failed');
        return [];
      }

      const data = await response.json() as { stt?: Array<{ name: string; canonical_name?: string; languages?: string[] }>; tts?: Array<{ name: string; canonical_name?: string }> };

      const models: Model[] = [];

      // STT models
      if (Array.isArray(data.stt)) {
        for (const m of data.stt) {
          models.push({ ...base, id: `deepgram/${m.name}`, name: m.name, displayName: `Deepgram ${m.canonical_name || m.name} (STT)`, capabilities: ['speech_to_text', 'streaming'] });
        }
      }

      // TTS models
      if (Array.isArray(data.tts)) {
        for (const m of data.tts) {
          models.push({ ...base, id: `deepgram/${m.name}`, name: m.name, displayName: `Deepgram ${m.canonical_name || m.name} (TTS)`, capabilities: ['text_to_speech', 'streaming'] });
        }
      }

      if (models.length > 0) {
        log.info({ count: models.length }, 'Deepgram models discovered');
        return models;
      }

      // Fallback: if /models endpoint returns different format, try raw parsing
      const rawData = data as Record<string, unknown>;
      const allModels = Object.entries(rawData).flatMap(([category, items]) => {
        if (!Array.isArray(items)) return [];
        return (items as Array<{ name?: string; model?: string }>).map(item => {
          const name = item.name || item.model || '';
          const isTTS = category.includes('tts') || name.includes('aura');
          return { ...base, id: `deepgram/${name}`, name, displayName: `Deepgram ${name}`, capabilities: [isTTS ? 'text_to_speech' : 'speech_to_text', 'streaming'] as import('@/types').ModelCapability[] };
        }).filter(m => m.name);
      });

      return allModels;
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Deepgram model discovery failed');
      return [];
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.baseUrl}/status`, {
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
        error: error instanceof Error ? error.message : 'Unknown', checkedAt: new Date(),
      };
    }
  }

  /**
   * Check Deepgram balance via projects API.
   * Requires DEEPGRAM_PROJECT_ID env var; returns null if unavailable.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const projectId = process.env.DEEPGRAM_PROJECT_ID;
      if (!projectId) return null;

      const res = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/balances`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as { balances?: Array<{ balance_id?: string; amount?: number; units?: string }> };
      const first = data.balances?.[0];
      const balance = typeof first?.amount === 'number' ? first.amount : undefined;
      return {
        hasCredits: balance !== undefined ? balance > 0 : true,
        balance,
        currency: first?.units || 'USD',
      };
    } catch {
      return null;
    }
  }

  // ── Not Supported (audio-only provider) ──────────────────

  async chatCompletion(): Promise<ChatResponse> {
    throw new Error('Deepgram does not support chat completions — audio-only provider');
  }

  // eslint-disable-next-line require-yield -- audio-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
    throw new Error('Deepgram does not support chat completions — audio-only provider');
  }

  async generateEmbeddings(): Promise<EmbeddingResponse> {
    throw new Error('Deepgram does not support embeddings — audio-only provider');
  }

  calculateCost(): number { return 0; }
  normalizeModelName(name: string): string { return name; }

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
