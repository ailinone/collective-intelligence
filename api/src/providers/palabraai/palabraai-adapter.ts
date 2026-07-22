// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Palabra.ai Provider Adapter
 *
 * Real-time speech-to-speech translation via LiveKit WebRTC.
 * 70+ languages, bidirectional, with captions/subtitles.
 *
 * Flow:
 * 1. ci-api creates session → gets webrtc_url + publisher token
 * 2. Client connects directly to LiveKit room (low latency)
 * 3. Client sends set_task via DataChannel to configure languages
 * 4. Audio flows: mic → room → Palabra pipeline → translated audio back
 *
 * Auth: ClientId + ClientSecret headers
 * API: https://api.palabra.ai
 */

import { ProviderAdapter, type ProviderConfig, type HealthCheckResult } from '@/providers/base/provider-adapter';
import type { Provider, Model, ChatResponse, EmbeddingResponse } from '@/types';
import type { ModerationResponse, ImageEditResponse, ImageVariationResponse } from '@/types/model-client';
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'palabraai' });

const PALABRA_API = 'https://api.palabra.ai';

export interface PalabraSessionRequest {
  sourceLanguage: string;
  targetLanguages: string[];
  voiceId?: string;
  sentenceSplitterEnabled?: boolean;
  translatePartialTranscriptions?: boolean;
}

export interface PalabraSessionResponse {
  sessionId: string;
  webrtcUrl: string;
  publisherToken: string;
  roomName: string;
  /** set_task config to send via DataChannel after connecting */
  translationConfig: Record<string, unknown>;
  languages: {
    source: string;
    targets: string[];
  };
}

export class PalabraAIAdapter extends ProviderAdapter {
  private clientId: string;
  private clientSecret: string;

  constructor(config: ProviderConfig & { clientId?: string; clientSecret?: string }) {
    super('palabraai', 'Palabra.ai', config);
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || config.apiKey || '';
  }

  private authHeaders(): Record<string, string> {
    return {
      'ClientId': this.clientId,
      'ClientSecret': this.clientSecret,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create a real-time translation session.
   * Returns LiveKit room credentials + translation config for the client.
   */
  async createTranslationSession(req: PalabraSessionRequest): Promise<PalabraSessionResponse> {
    const start = Date.now();

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Palabra.ai credentials not configured');
    }

    try {
      // Step 1: Create session (gets LiveKit room credentials). Route
      // connection establishment through the resilience stack (bulkhead →
      // breaker → timeout) so a Palabra outage fast-fails and is isolated
      // per-provider; the JSON body is read outside the bulkhead slot.
      const response = await this.executeThroughBulkhead(async () => {
        const res = await fetch(`${PALABRA_API}/session-storage/session`, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({
            data: {
              subscriber_count: 0,
              intent: 'api',
            },
          }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Palabra session failed: ${res.status} ${errorText}`);
        }
        return res;
      }, 'create translation session');

      const data = await response.json() as {
        data: {
          id: string;
          webrtc_url: string;
          publisher: string;
          webrtc_room_name?: string;
        };
      };

      const sessionData = data.data;

      // Step 2: Build set_task config for the client to send via DataChannel
      const translationConfig = {
        message_type: 'set_task',
        data: {
          input_stream: { content_type: 'audio', source: { type: 'webrtc' } },
          output_stream: { content_type: 'audio', target: { type: 'webrtc' } },
          pipeline: {
            transcription: {
              source_language: req.sourceLanguage,
              detectable_languages: [],
              sentence_splitter: { enabled: req.sentenceSplitterEnabled ?? true },
            },
            translations: req.targetLanguages.map(lang => ({
              target_language: lang,
              translate_partial_transcriptions: req.translatePartialTranscriptions ?? false,
              speech_generation: {
                voice_cloning: false,
                voice_id: req.voiceId || 'default_low',
                voice_timbre_detection: {
                  enabled: true,
                  high_timbre_voices: ['default_high'],
                  low_timbre_voices: ['default_low'],
                },
              },
            })),
          },
        },
      };

      const session: PalabraSessionResponse = {
        sessionId: sessionData.id,
        webrtcUrl: sessionData.webrtc_url,
        publisherToken: sessionData.publisher,
        roomName: sessionData.webrtc_room_name || sessionData.id,
        translationConfig,
        languages: { source: req.sourceLanguage, targets: req.targetLanguages },
      };

      log.info({
        latency: Date.now() - start,
        sessionId: session.sessionId,
        source: req.sourceLanguage,
        targets: req.targetLanguages,
      }, 'Palabra translation session created');

      return session;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Palabra session creation failed');
      throw error;
    }
  }

  /**
   * Delete a translation session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Guard against SSRF/path-injection: sessionId comes from the public
    // DELETE /v1/translation/session/:id route param and is otherwise
    // unvalidated. Restrict it to the opaque-id charset Palabra actually
    // issues before it is interpolated into the request URL.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      log.warn({ sessionId }, 'Rejected Palabra session deletion: invalid session id format');
      throw new Error('Invalid session id');
    }

    try {
      await fetch(`${PALABRA_API}/session-storage/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
      });
      log.info({ sessionId }, 'Palabra session deleted');
    } catch (error) {
      log.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Session deletion failed');
    }
  }

  // ── Provider Metadata ──────────────────

  async getProvider(): Promise<Provider> {
    return {
      id: 'palabraai', name: 'palabraai', displayName: 'Palabra.ai',
      status: 'active',
      health: { status: 'healthy', lastCheck: new Date() },
      models: [],
    };
  }

  async getModels(): Promise<Model[]> {
    const perf: import('@/types').ModelPerformance = { latencyMs: 200, throughput: 0, quality: 0.9, reliability: 0.95 };
    return [{
      id: 'palabraai/realtime-translation',
      providerId: 'palabraai', provider: 'palabraai',
      name: 'realtime-translation',
      displayName: 'Palabra.ai Real-time Translation (70+ languages)',
      contextWindow: 0, maxOutputTokens: 0,
      inputCostPer1k: 0, outputCostPer1k: 0,
      status: 'active', performance: perf,
      capabilities: ['speech_to_text', 'text_to_speech', 'streaming'],
    }];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Check if we can list sessions (validates credentials)
      const response = await fetch(`${PALABRA_API}/session-storage/sessions?page_size=1`, {
        headers: this.authHeaders(),
      });
      return { healthy: response.ok, latency: Date.now() - start, checkedAt: new Date() };
    } catch {
      return { healthy: false, latency: Date.now() - start, checkedAt: new Date() };
    }
  }

  // ── Not Supported ──────────────────
  async chatCompletion(): Promise<ChatResponse> { throw new Error('Palabra.ai: translation-only'); }
  // eslint-disable-next-line require-yield -- translation-only provider; this generator never yields.
  async *chatCompletionStream(): AsyncGenerator<ChatResponse> { throw new Error('Palabra.ai: translation-only'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('Not supported'); }
  calculateCost(): number { return 0; }
  normalizeModelName(name: string): string { return name; }
  async moderate(): Promise<ModerationResponse> { throw new Error('Not supported'); }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('Not supported'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('Not supported'); }
}
