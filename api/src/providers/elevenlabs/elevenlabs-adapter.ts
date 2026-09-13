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

import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
  type BalanceCheckResult,
} from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  MusicGenRequest,
  MusicGenResponse,
  ModerationResponse,
  ImageEditResponse,
  ImageVariationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'elevenlabs' });

// Default voice ID — Rachel (clear female voice, good for general use)
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

// ElevenLabs' documented Music model ids are `music_v1`/`music_v2` (default
// v2, per docs.elevenlabs.io as confirmed live 2026-09-06). Matched by
// prefix — not a fixed id list — so a future `music_v3` etc. is picked up
// without a code change IF the vendor ever adds it to `/v1/models`.
const MUSIC_MODEL_ID_PATTERN = /^music/i;
const DEFAULT_MUSIC_MODEL_ID = 'music_v2';

/**
 * Pinned fallback for ElevenLabs Music (LOTE AX, 2026-09-06).
 *
 * Live-verified 2026-09-06 against `GET /v1/models` with a real
 * `<prefix>-elevenlabs-key`: the response lists only TTS/STS models
 * (eleven_v3, eleven_multilingual_v2, eleven_turbo_v2_5, ...) — `music_v1`
 * and `music_v2` are ABSENT from that listing even though `POST /v1/music`
 * accepts both ids and is separately documented at docs.elevenlabs.io. This
 * mirrors the `pinnedFallback` pattern the catalog uses elsewhere for a
 * vendor whose discovery surface doesn't cover a whole capability (reason
 * `no-list-endpoint` in `provider-catalog.types.ts`) — ElevenLabs itself is
 * a bespoke non-catalog adapter, so the equivalent fallback lives here
 * instead. These two ids are the vendor's OWN documented model_ids, not a
 * list this adapter invented; MUSIC_MODEL_ID_PATTERN is still what tags a
 * model `music_generation` if the vendor ever starts listing them.
 */
const PINNED_MUSIC_MODEL_IDS: readonly string[] = ['music_v1', 'music_v2'];

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
      const voiceId = this.resolveVoiceId(request.voice || (request.options?.voice as string));

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

      log.info(
        { model: modelId, voice: voiceId, latency, bytes: audioBuffer.length },
        'TTS completed'
      );

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

  // ── Music Generation ──────────────────
  //
  // ElevenLabs Music: `POST /v1/music` — synchronous (not job/polling-based;
  // the completed audio file comes back in the response body), same
  // `xi-api-key` auth as TTS. Body: `prompt` XOR `composition_plan`, plus
  // `model_id`, `music_length_ms` (3000-600000), `force_instrumental`,
  // `seed`; format via the `output_format` query param — confirmed live
  // against docs.elevenlabs.io 2026-09-06. Gated to paid subscribers upstream
  // (a 402/403 surfaces as an ordinary thrown error here, same as any other
  // credential/plan-tier gate in this catalog).
  async generateMusic(model: Model, request: MusicGenRequest): Promise<MusicGenResponse> {
    const start = Date.now();
    const modelId = model.name || model.id || DEFAULT_MUSIC_MODEL_ID;

    try {
      if (!request.prompt && !request.compositionPlan) {
        throw new Error(
          'ElevenLabs Music: either prompt or compositionPlan is required'
        );
      }

      const outputFormat = (request.options?.outputFormat as string) || 'mp3_44100_128';

      const payload: Record<string, unknown> = { model_id: modelId };
      if (request.compositionPlan) {
        payload.composition_plan = request.compositionPlan;
      } else {
        payload.prompt = request.prompt;
      }
      if (request.musicLengthMs !== undefined) payload.music_length_ms = request.musicLengthMs;
      if (request.forceInstrumental !== undefined) {
        payload.force_instrumental = request.forceInstrumental;
      }
      if (request.seed !== undefined) payload.seed = request.seed;

      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${this.baseUrl}/music?output_format=${outputFormat}`, {
          method: 'POST',
          headers: {
            ...this.authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`ElevenLabs Music generation failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'music-generation');

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const latency = Date.now() - start;

      log.info(
        { model: modelId, latency, bytes: audioBuffer.length },
        'Music generation completed'
      );

      return {
        audio: audioBuffer,
        format: 'mp3',
        raw: { size: audioBuffer.length, latency },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ model: modelId, latency, error: msg }, 'Music generation failed');
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
      alloy: '21m00Tcm4TlvDq8ikWAM', // Rachel
      echo: 'MF3mGyEYCl7XYWbV9V6O', // Elli
      fable: 'TxGEqnHWrfWFTfGW9XjX', // Josh
      onyx: 'VR6AewLTigWG4xSOukaG', // Arnold
      nova: 'EXAVITQu4vr4xnSDxMaL', // Bella
      shimmer: 'XB0fDUnXU5powFXDhCwa', // Charlotte
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
    const perf: import('@/types').ModelPerformance = {
      latencyMs: 200,
      throughput: 0,
      quality: 0.95,
      reliability: 0.9,
    };
    const base: Omit<Model, 'id' | 'name' | 'displayName' | 'capabilities'> = {
      providerId: 'elevenlabs',
      provider: 'elevenlabs',
      contextWindow: 0,
      maxOutputTokens: 0,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      status: 'active',
      performance: perf,
    };

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'ElevenLabs models API failed');
        return [];
      }

      const data = (await response.json()) as Array<{
        model_id: string;
        name?: string;
        description?: string;
        can_do_text_to_speech?: boolean;
        can_do_voice_conversion?: boolean;
        languages?: Array<{ language_id: string; name: string }>;
      }>;

      if (!Array.isArray(data) || data.length === 0) return [];

      // Music models (`music_v1`/`music_v2`) are a SEPARATE capability from
      // TTS — no spoken-text input, minutes-long output — so they are kept
      // even when the vendor reports `can_do_text_to_speech: false` for them,
      // and tagged `music_generation` instead of `text_to_speech`.
      const discovered = data
        .filter(
          (m) => m.can_do_text_to_speech !== false || MUSIC_MODEL_ID_PATTERN.test(m.model_id)
        )
        .map((m) => {
          const isMusic = MUSIC_MODEL_ID_PATTERN.test(m.model_id);
          return {
            ...base,
            id: `elevenlabs/${m.model_id}`,
            name: m.model_id,
            displayName: `ElevenLabs ${m.name || m.model_id}${isMusic ? ' (Music)' : ''}`,
            capabilities: (isMusic
              ? ['music_generation']
              : ['text_to_speech', 'streaming']) as import('@/types').ModelCapability[],
            metadata: {
              languages: m.languages?.map((l) => l.language_id),
              description: m.description,
            },
          };
        });

      // Append the pinned Music models `/v1/models` doesn't list — see
      // PINNED_MUSIC_MODEL_IDS. Skips any id the live response already
      // surfaced (defensive against the vendor closing this listing gap).
      const discoveredIds = new Set(discovered.map((m) => m.name));
      const pinnedMusic = PINNED_MUSIC_MODEL_IDS.filter((id) => !discoveredIds.has(id)).map(
        (id) => ({
          ...base,
          id: `elevenlabs/${id}`,
          name: id,
          displayName: `ElevenLabs ${id} (Music)`,
          capabilities: ['music_generation'] as import('@/types').ModelCapability[],
          metadata: {
            pinnedFallback: true,
            pinnedFallbackReason: 'no-list-endpoint',
            description: 'Music generation model — not listed by GET /v1/models (verified 2026-09-06).',
          },
        })
      );

      return [...discovered, ...pinnedMusic];
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'ElevenLabs model discovery failed'
      );
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
      return {
        healthy: false,
        latency: 0,
        error: error instanceof Error ? error.message : 'Unknown',
        checkedAt: new Date(),
      };
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

  async chatCompletion(): Promise<ChatResponse> {
    throw new Error('ElevenLabs: TTS-only provider');
  }

  // eslint-disable-next-line require-yield -- TTS-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
    throw new Error('ElevenLabs: TTS-only provider');
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
