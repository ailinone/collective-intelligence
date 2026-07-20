// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Self-Hosted Inference Adapter
 *
 * Connects to local sidecar containers running STT/TTS models:
 * - faster-whisper (STT) — POST /transcribe
 * - kokoro-tts (TTS) — POST /synthesize
 * - silero-vad (VAD) — POST /detect
 *
 * Zero network latency (localhost HTTP). Models run on GPU/CPU sidecars.
 * Enabled when SELF_HOSTED_STT_URL or SELF_HOSTED_TTS_URL env vars are set.
 */

import { ProviderAdapter, type ProviderConfig, type HealthCheckResult } from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type { AudioTTSRequest, AudioTTSResponse, AudioSTTRequest, AudioSTTResponse, ModerationResponse, ImageEditResponse, ImageVariationResponse } from '@/types/model-client';
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'self-hosted' });

export class SelfHostedAdapter extends ProviderAdapter {
  // Per-model sidecar URLs — each model has its own endpoint
  // Convention: SELF_HOSTED_{MODEL}_URL (e.g., SELF_HOSTED_MELOTTS_URL)
  // Falls back to generic SELF_HOSTED_STT_URL / SELF_HOSTED_TTS_URL
  private modelUrls: Map<string, string>;
  private sttUrl: string | null;
  private ttsUrl: string | null;
  private vadUrl: string | null;
  private stsUrl: string | null;

  constructor(config: ProviderConfig) {
    super('self-hosted', 'Self-Hosted Inference', config);
    this.sttUrl = process.env.SELF_HOSTED_STT_URL || null;
    this.ttsUrl = process.env.SELF_HOSTED_TTS_URL || null;
    this.vadUrl = process.env.SELF_HOSTED_VAD_URL || null;
    this.stsUrl = process.env.SELF_HOSTED_STS_URL || null;

    // Per-model URL overrides
    this.modelUrls = new Map();
    this.modelUrls.set('faster-whisper', process.env.SELF_HOSTED_STT_URL || '');
    this.modelUrls.set('melotts', process.env.SELF_HOSTED_MELOTTS_URL || '');
    this.modelUrls.set('kokoro-tts', process.env.SELF_HOSTED_TTS_URL || '');
    this.modelUrls.set('fish-speech', process.env.SELF_HOSTED_FISH_SPEECH_URL || '');
    this.modelUrls.set('neutts-air', process.env.SELF_HOSTED_NEUTTS_URL || '');
    this.modelUrls.set('dia2-2b', process.env.SELF_HOSTED_DIA2_URL || '');
    this.modelUrls.set('silero-vad', process.env.SELF_HOSTED_VAD_URL || '');
  }

  private getModelUrl(modelName: string): string | null {
    return this.modelUrls.get(modelName) || null;
  }

  /** Map ci-api model name to the name the sidecar expects in its API */
  private getSidecarModelName(modelName: string): string {
    const map: Record<string, string> = {
      'kokoro-tts': 'kokoro',
      'melotts': 'melotts',
      'fish-speech': 'fish-speech',
      'neutts-air': 'neutts-air',
      'dia2-2b': 'dia2-2b',
      'faster-whisper': 'base',  // whisper model size
    };
    return map[modelName] || modelName;
  }

  // ── STT: faster-whisper sidecar ──────────────────

  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const modelName = model.name || model.id?.replace('self-hosted/', '') || '';
    const url = this.getModelUrl(modelName) || this.sttUrl;
    if (!url) throw new Error('Self-hosted STT not configured for model: ' + modelName);

    const start = Date.now();
    try {
      const form = new FormData();
      const mimeType = (request.options?.mimeType as string) || 'audio/wav';
      const filename = (request.options?.filename as string) || 'audio.wav';
      form.set('file', new File([new Blob([request.audio], { type: mimeType })], filename, { type: mimeType }));
      if (request.language) form.set('language', request.language);

      // OpenAI-compatible /v1/audio/transcriptions endpoint. Route connection
      // establishment through the resilience stack (bulkhead → breaker →
      // timeout); the JSON body is read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form });
        if (!res.ok) {
          throw new Error(`Self-hosted STT failed: ${res.status} ${await res.text()}`);
        }
        return res;
      }, 'speech-to-text');

      const data = await response.json() as { text: string; segments?: Array<{ text: string; start: number; end: number }>; language?: string };
      const latency = Date.now() - start;
      log.info({ latency, textLen: data.text.length }, 'Self-hosted STT completed');

      return { text: data.text, raw: { ...data, latency, method: 'self-hosted' } };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Self-hosted STT failed');
      throw error;
    }
  }

  // ── TTS: kokoro-tts sidecar ──────────────────

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const modelName = model.name || model.id?.replace('self-hosted/', '') || '';
    const url = this.getModelUrl(modelName) || this.ttsUrl;
    if (!url) throw new Error('Self-hosted TTS not configured for model: ' + modelName);

    const start = Date.now();
    try {
      // OpenAI-compatible /v1/audio/speech endpoint. Only connection
      // establishment runs through the resilience stack (bulkhead → breaker →
      // timeout); the streaming read loop below stays outside the bulkhead slot
      // so the slot is not held for the audio stream's lifetime.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${url}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.getSidecarModelName(modelName),
            input: request.text,
            voice: request.voice || 'default',
            response_format: request.format || 'mp3',
            speed: request.options?.speed || 1.0,
          }),
        });

        if (!res.ok) {
          throw new Error(`Self-hosted TTS failed: ${res.status} ${await res.text()}`);
        }
        return res;
      }, 'text-to-speech');

      // STREAMING: Read response as stream — emit chunks as they arrive
      // This reduces first-byte latency from 3-8s to ~200ms
      if (request.options?.onAudioChunk && response.body) {
        const reader = response.body.getReader();
        const onChunk = request.options.onAudioChunk as (chunk: Buffer) => void;
        let totalBytes = 0;
        let firstChunk = true;

        // Stream-pump loop: terminates on `reader.read()` returning done=true.
        // eslint-disable-next-line no-constant-condition -- intentional infinite loop, exit via `break` on stream EOF.
        while (true) {
          const { done, value } = (await reader.read()) as {
            done: boolean;
            value: Uint8Array | undefined;
          };
          if (done || !value) break;
          const chunk = Buffer.from(value);
          totalBytes += chunk.length;
          if (firstChunk) {
            log.info({ latency: Date.now() - start, chunkBytes: chunk.length }, 'Self-hosted TTS first chunk (streaming)');
            firstChunk = false;
          }
          onChunk(chunk);
        }

        log.info({ latency: Date.now() - start, totalBytes }, 'Self-hosted TTS streaming completed');
        return { audio: Buffer.alloc(0), format: request.format || 'wav', raw: { latency: Date.now() - start, method: 'self-hosted-stream', totalBytes } };
      }

      // BATCH fallback: Read entire response at once
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const latency = Date.now() - start;
      log.info({ latency, audioBytes: audioBuffer.length }, 'Self-hosted TTS completed');

      return { audio: audioBuffer, format: request.format || 'wav', raw: { latency, method: 'self-hosted' } };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Self-hosted TTS failed');
      throw error;
    }
  }

  // ── Provider Metadata ──────────────────

  async getProvider(): Promise<Provider> {
    return {
      id: 'self-hosted', name: 'self-hosted', displayName: 'Self-Hosted Inference',
      status: 'active',
      health: { status: 'healthy', lastCheck: new Date() },
      models: [],
    };
  }

  async getModels(): Promise<Model[]> {
    const perf: import('@/types').ModelPerformance = { latencyMs: 200, throughput: 0, quality: 0.85, reliability: 0.95 };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'self-hosted', provider: 'self-hosted',
      contextWindow: 0, maxOutputTokens: 0,
      inputCostPer1k: 0, outputCostPer1k: 0,
      status: 'active', performance: perf,
    };

    // Dynamically discover models from each running sidecar via /v1/models
    const models: Model[] = [];

    const discoverFromSidecar = async (url: string, type: 'stt' | 'tts' | 'vad' | 'sts'): Promise<void> => {
      try {
        const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const data = await response.json() as { data?: Array<{ id?: string; object?: string }> };
        const caps: import('@/types').ModelCapability[] = type === 'stt' ? ['speech_to_text', 'streaming']
          : type === 'tts' ? ['text_to_speech', 'streaming']
          : type === 'sts' ? ['text_to_speech', 'speech_to_text', 'streaming']
          : ['streaming'];

        if (Array.isArray(data.data)) {
          for (const m of data.data) {
            const name = m.id || 'unknown';
            models.push({ ...base, id: `self-hosted/${name}`, name, displayName: `${name} (self-hosted)`, capabilities: caps });
          }
        }
      } catch {
        // Sidecar not responding — skip
      }
    };

    // Discover from each configured sidecar
    const discoveries: Promise<void>[] = [];
    if (this.sttUrl) discoveries.push(discoverFromSidecar(this.sttUrl, 'stt'));
    if (this.vadUrl) discoveries.push(discoverFromSidecar(this.vadUrl, 'vad'));

    // Discover from each per-model TTS sidecar
    for (const [name, url] of this.modelUrls.entries()) {
      if (url && name !== 'faster-whisper' && name !== 'silero-vad') {
        discoveries.push(discoverFromSidecar(url, 'tts'));
      }
    }

    if (this.stsUrl) discoveries.push(discoverFromSidecar(this.stsUrl, 'sts'));

    await Promise.allSettled(discoveries);

    if (models.length > 0) {
      log.info({ count: models.length }, 'Self-hosted models discovered dynamically');
    }

    return models;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const checks = await Promise.all([
        this.sttUrl ? fetch(`${this.sttUrl}/health`).then(r => r.ok) : Promise.resolve(true),
        this.ttsUrl ? fetch(`${this.ttsUrl}/health`).then(r => r.ok) : Promise.resolve(true),
      ]);
      return { healthy: checks.every(Boolean), latency: Date.now() - start, checkedAt: new Date() };
    } catch {
      return { healthy: false, latency: Date.now() - start, checkedAt: new Date() };
    }
  }

  // ── Not Supported ──────────────────
  async chatCompletion(): Promise<ChatResponse> { throw new Error('Self-hosted: audio-only'); }
  // eslint-disable-next-line require-yield -- audio-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> { throw new Error('Self-hosted: audio-only'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('Not supported'); }
  calculateCost(): number { return 0; }
  normalizeModelName(name: string): string { return name; }
  async moderate(): Promise<ModerationResponse> { throw new Error('Not supported'); }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('Not supported'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('Not supported'); }
}
