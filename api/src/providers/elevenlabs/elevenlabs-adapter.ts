// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ElevenLabs Provider Adapter
 *
 * TTS provider: High-quality voice synthesis + Conversational AI
 * Auth: `xi-api-key: ${apiKey}`
 * TTS: POST /text-to-speech/{voice_id}
 * TTS Streaming: POST /text-to-speech/{voice_id}/stream
 *
 * NO HARDCODED MODELS — model/voice selection by capabilities.
 */

import { ProviderAdapter, type ProviderConfig, type HealthCheckResult, type BalanceCheckResult } from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type { AudioTTSRequest, AudioTTSResponse, ModerationResponse, ImageEditResponse, ImageVariationResponse } from '@/types/model-client';
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'elevenlabs' });

// Default voice ID — Rachel (clear female voice, good for general use)
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export class ElevenLabsAdapter extends ProviderAdapter {
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    super('elevenlabs', 'ElevenLabs', config);
    this.baseUrl = (config.baseUrl || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return {
      'xi-api-key': this.config.apiKey,
    };
  }

  // ── Audio: TTS (Text-to-Speech) ──────────────────

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const start = Date.now();
    const modelId = model.name || model.id || 'eleven_multilingual_v2';

    try {
      // Voice ID: use request.voice as voice_id, or map common names
      const voiceId = this.resolveVoiceId(request.voice || request.options?.voice as string);

      // Map format to ElevenLabs output_format
      const format = request.format || 'mp3';
      let outputFormat = 'mp3_44100_128';
      if (format === 'pcm' || format === 'wav') {
        outputFormat = 'pcm_24000';
      } else if (format === 'opus') {
        outputFormat = 'opus_48000_64';
      }

      const payload = {
        text: request.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      };

      // Route connection establishment through the resilience stack (bulkhead →
      // breaker → timeout) so an ElevenLabs outage fast-fails and is isolated
      // per-provider; the audio bytes are read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(
          `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`,
          {
            method: 'POST',
            headers: {
              ...this.authHeaders(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          }
        );

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`ElevenLabs TTS failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'text-to-speech');

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const latency = Date.now() - start;

      log.info({ model: modelId, voice: voiceId, latency, bytes: audioBuffer.length }, 'TTS completed');

      return {
        audio: audioBuffer,
        format,
        raw: { size: audioBuffer.length, latency, voiceId },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ model: modelId, latency, error: msg }, 'TTS failed');
      throw error;
    }
  }

  /**
   * Map common voice names to ElevenLabs voice IDs.
   * If the input looks like a voice ID (long alphanumeric), use as-is.
   */
  private resolveVoiceId(voice?: string): string {
    if (!voice) return DEFAULT_VOICE_ID;

    // Common OpenAI-compatible voice name mappings
    const voiceMap: Record<string, string> = {
      alloy: '21m00Tcm4TlvDq8ikWAM',    // Rachel
      echo: 'MF3mGyEYCl7XYWbV9V6O',      // Elli
      fable: 'TxGEqnHWrfWFTfGW9XjX',     // Josh
      onyx: 'VR6AewLTigWG4xSOukaG',       // Arnold
      nova: 'EXAVITQu4vr4xnSDxMaL',       // Bella
      shimmer: 'XB0fDUnXU5powFXDhCwa',    // Charlotte
    };

    if (voiceMap[voice.toLowerCase()]) {
      return voiceMap[voice.toLowerCase()];
    }

    // If it looks like a UUID/ID, use directly
    if (voice.length > 15) return voice;

    return DEFAULT_VOICE_ID;
  }

  // ── Provider Metadata ──────────────────

  async getProvider(): Promise<Provider> {
    return {
      id: 'elevenlabs',
      name: 'elevenlabs',
      displayName: 'ElevenLabs',
      status: 'active',
      health: { status: 'healthy', lastCheck: new Date() },
      models: [],
    };
  }

  async getModels(): Promise<Model[]> {
    // Dynamically discover models from ElevenLabs API
    const perf: import('@/types').ModelPerformance = { latencyMs: 200, throughput: 0, quality: 0.95, reliability: 0.9 };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'elevenlabs', provider: 'elevenlabs',
      contextWindow: 0, maxOutputTokens: 0,
      inputCostPer1k: 0, outputCostPer1k: 0,
      status: 'active', performance: perf,
    };

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'ElevenLabs models API failed');
        return [];
      }

      const data = await response.json() as Array<{ model_id: string; name?: string; description?: string; can_do_text_to_speech?: boolean; can_do_voice_conversion?: boolean; languages?: Array<{ language_id: string; name: string }> }>;

      if (!Array.isArray(data) || data.length === 0) return [];

      return data
        .filter(m => m.can_do_text_to_speech !== false)
        .map(m => ({
          ...base,
          id: `elevenlabs/${m.model_id}`,
          name: m.model_id,
          displayName: `ElevenLabs ${m.name || m.model_id}`,
          capabilities: ['text_to_speech', 'streaming'] as import('@/types').ModelCapability[],
          metadata: { languages: m.languages?.map(l => l.language_id), description: m.description },
        }));
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'ElevenLabs model discovery failed');
      return [];
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.baseUrl}/user`, {
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

  /**
   * Check ElevenLabs remaining character quota via subscription endpoint.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/user/subscription`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as {
        character_count?: number;
        character_limit?: number;
      };
      const used = typeof data.character_count === 'number' ? data.character_count : 0;
      const limit = typeof data.character_limit === 'number' ? data.character_limit : 0;
      const remaining = limit - used;
      return {
        hasCredits: remaining > 0,
        balance: remaining,
        currency: 'characters',
      };
    } catch {
      return null;
    }
  }

  // ── Not Supported (TTS-only provider) ──────────────────

  async chatCompletion(): Promise<ChatResponse> { throw new Error('ElevenLabs: TTS-only provider'); }
  // eslint-disable-next-line require-yield -- TTS-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> { throw new Error('ElevenLabs: TTS-only provider'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('Not supported'); }
  calculateCost(): number { return 0; }
  normalizeModelName(name: string): string { return name; }
  async moderate(): Promise<ModerationResponse> { throw new Error('Not supported'); }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('Not supported'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('Not supported'); }
}
