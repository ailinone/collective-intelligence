// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Realtime Translation Adapter
 *
 * Dedicated streaming pipeline: Deepgram STT → NLLB CTranslate2 → Cartesia TTS
 * Each phrase is processed independently (200ms endpointing).
 *
 * Implements the same RealtimeClient interface as OpenAI/Google/Ailin clients.
 * No shared state with chat pipeline. Self-contained error boundaries.
 *
 * Flow:
 *   sendAudio(pcm) → Deepgram WS → is_final(phrase) → NLLB(~130ms) → TTS → audio events
 */

import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';
import { getProviderRegistry } from '@/providers/provider-registry';
import { getTranslationService } from '@/services/translation-service';
import WebSocket from 'ws';

const log = logger.child({ component: 'RealtimeTranslationAdapter' });

const DEEPGRAM_ENDPOINTING_MS = 200;
const DEEPGRAM_SAMPLE_RATE = 24000;
const TTS_CHUNK_BYTES = 4096;

export interface TranslationSessionConfig {
  sourceLanguage: string;
  targetLanguage: string;
  modalities?: ('text' | 'audio')[];
  voice?: string;
}

export class RealtimeTranslationAdapter extends EventEmitter {
  private deepgramWs: WebSocket | null = null;
  private ttsQueue: Promise<void> = Promise.resolve();
  private phraseCounter = 0;
  private connected = false;
  private config: TranslationSessionConfig | null = null;

  private organizationId: string;
  private userId: string;
  private requestId: string;

  constructor(opts: { organizationId: string; userId: string; requestId: string }) {
    super();
    this.organizationId = opts.organizationId;
    this.userId = opts.userId;
    this.requestId = opts.requestId;
  }

  // ── RealtimeClient interface ────────────────────────────

  async connect(config: TranslationSessionConfig): Promise<void> {
    this.config = config;
    this.connected = true;
    this.phraseCounter = 0;

    await this.openDeepgramStream(config.sourceLanguage);

    const deepgramOk = this.deepgramWs?.readyState === WebSocket.OPEN;
    log.info({
      requestId: this.requestId,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      deepgramActive: deepgramOk,
    }, 'Translation adapter connected — deepgramWs=' + (deepgramOk ? 'OPEN' : 'NULL'));

    // Emit diagnostic event so the client knows the STT status
    this.emit('translation.adapter.status', {
      type: 'translation.adapter.status',
      deepgramConnected: deepgramOk,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
    });
  }

  sendText(_text: string): void {
    // Translation adapter only handles audio→text→translate→audio
  }

  sendAudio(buffer: Buffer): void {
    if (!this.connected) return;

    if (this.deepgramWs?.readyState === WebSocket.OPEN) {
      this.deepgramWs.send(buffer);
    } else {
      // Log the issue — helps diagnose if Deepgram WS failed to connect
      log.warn({
        requestId: this.requestId,
        wsState: this.deepgramWs?.readyState ?? 'null',
        bufferLen: buffer.length,
      }, 'Audio dropped — Deepgram WS not OPEN');
    }
  }

  requestResponse(): void {
    // Streaming adapter auto-processes on is_final — no manual trigger needed
  }

  cancelResponse(): void {
    // Nothing to cancel mid-stream
  }

  disconnect(): void {
    this.connected = false;
    this.closeDeepgramStream();
    this.config = null;
    this.emit('close', {});
    log.info({ requestId: this.requestId }, 'Translation adapter disconnected');
  }

  // ── Deepgram Streaming STT ──────────────────────────────

  private async openDeepgramStream(sourceLanguage: string): Promise<void> {
    const registry = getProviderRegistry();
    const deepgramAdapter = registry.get('deepgram');
    const apiKey = deepgramAdapter?.getApiKey();

    if (!apiKey) {
      log.error({ requestId: this.requestId }, 'No Deepgram API key — translation adapter cannot start STT');
      this.emit('error', {
        type: 'error',
        error: { type: 'config_error', message: 'Deepgram API key not configured' },
      });
      return;
    }

    // Normalize language code: pt_BR → pt-BR, pt → pt, auto → omit
    const dgLang = sourceLanguage === 'auto'
      ? undefined
      : sourceLanguage.replace('_', '-');

    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: DEEPGRAM_SAMPLE_RATE.toString(),
      channels: '1',
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: DEEPGRAM_ENDPOINTING_MS.toString(),
      endpointing: DEEPGRAM_ENDPOINTING_MS.toString(),
      vad_events: 'true',
      ...(dgLang ? { language: dgLang } : {}),
    });

    const wsUrl = `wss://api.deepgram.com/v1/listen?${params}`;

    return new Promise<void>((resolve) => {
      try {
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Token ${apiKey}` },
        });

        const connectTimeout = setTimeout(() => {
          log.warn({ requestId: this.requestId }, 'Deepgram WS connect timeout (5s)');
          try { ws.close(); } catch { /* ignore */ }
          resolve(); // Resolve without setting deepgramWs — sendAudio will silently drop
        }, 5000);

        ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.deepgramWs = ws;
          log.info({
            requestId: this.requestId,
            endpointingMs: DEEPGRAM_ENDPOINTING_MS,
            language: dgLang || 'auto',
          }, 'Deepgram streaming STT connected');
          resolve();
        });

        ws.on('message', (data: Buffer) => {
          this.handleDeepgramMessage(data);
        });

        ws.on('close', () => {
          this.deepgramWs = null;
          log.info({ requestId: this.requestId }, 'Deepgram WS closed');
        });

        ws.on('error', (err) => {
          clearTimeout(connectTimeout);
          log.error({ requestId: this.requestId, error: err.message }, 'Deepgram WS error');
          this.deepgramWs = null;
          resolve(); // Don't reject — adapter still works, just without STT
        });
      } catch (err) {
        log.error({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Failed to create Deepgram WS');
        resolve();
      }
    });
  }

  private closeDeepgramStream(): void {
    if (this.deepgramWs) {
      try {
        if (this.deepgramWs.readyState === WebSocket.OPEN) {
          this.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.deepgramWs.close();
      } catch { /* ignore */ }
      this.deepgramWs = null;
    }
  }

  private handleDeepgramMessage(raw: Buffer): void {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        is_final?: boolean;
        channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
      };

      // Deepgram VAD events (separate message type)
      if (msg.type === 'SpeechStarted') {
        this.emit('input_audio_buffer.speech_started', {
          type: 'input_audio_buffer.speech_started',
        });
        return;
      }

      if (msg.type !== 'Results') return;

      const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
      const confidence = msg.channel?.alternatives?.[0]?.confidence || 0;

      if (msg.is_final && transcript.trim()) {
        // Phrase finalized — translate + TTS
        this.phraseCounter++;
        const phraseId = this.phraseCounter;

        log.info({
          requestId: this.requestId,
          phraseId,
          text: transcript.substring(0, 60),
          confidence: confidence.toFixed(2),
        }, 'Phrase finalized');

        this.emit('conversation.item.input_audio_transcription.completed', {
          type: 'conversation.item.input_audio_transcription.completed',
          transcript,
        });

        this.processPhrase(transcript, phraseId);
      } else if (!msg.is_final && transcript.trim()) {
        // Interim — UI feedback
        this.emit('stt.transcription', {
          type: 'stt.transcription',
          text: transcript,
          is_final: false,
        });
      }
    } catch {
      // Non-JSON or malformed — ignore
    }
  }

  // ── Phrase Processing: Translate → TTS ──────────────────

  private processPhrase(text: string, phraseId: number): void {
    if (!this.connected || !this.config) return;
    const { sourceLanguage, targetLanguage } = this.config;
    const wantAudio = this.config.modalities?.includes('audio') ?? true;
    const phraseStart = Date.now();

    // Queue ensures TTS audio doesn't overlap between phrases
    this.ttsQueue = this.ttsQueue
      .then(async () => {
        if (!this.connected) return;

        // Emit original text
        this.emit('translation.text.original', {
          type: 'translation.text.original',
          text,
          language: sourceLanguage,
          phraseId,
        });

        // Translate via NLLB CT2 (~130ms)
        const translationService = getTranslationService();
        const result = await translationService.translateText(text, sourceLanguage, targetLanguage);

        if (!this.connected) return;

        log.info({
          requestId: this.requestId,
          phraseId,
          translateMs: result.latencyMs,
          src: text.substring(0, 40),
          tgt: result.translatedText.substring(0, 40),
        }, 'Phrase translated');

        // Emit translated text
        this.emit('translation.text.translated', {
          type: 'translation.text.translated',
          text: result.translatedText,
          language: targetLanguage,
          phraseId,
        });
        this.emit('response.text.delta', {
          type: 'response.text.delta',
          delta: result.translatedText + ' ',
        });

        // TTS for the translated phrase
        if (wantAudio && result.translatedText.trim()) {
          await this.synthesizePhrase(result.translatedText);
        }

        const totalMs = Date.now() - phraseStart;
        log.info({ requestId: this.requestId, phraseId, totalMs }, 'Phrase complete');
      })
      .catch(err => {
        // Catch ALL errors — never let them escape as unhandled rejections
        log.error({
          requestId: this.requestId,
          phraseId,
          error: err instanceof Error ? err.message : String(err),
        }, 'Phrase processing failed');
      });
  }

  private async synthesizePhrase(text: string): Promise<void> {
    const ttsStart = Date.now();

    try {
      // Strategy 1: Cartesia streaming (lowest TTFB ~40ms)
      const registry = getProviderRegistry();
      const cartesiaAdapter = registry.get('cartesia');
      const cartesiaKey = cartesiaAdapter?.getApiKey();

      if (cartesiaKey) {
        const streamed = await this.streamCartesiaTTS(cartesiaKey, text, ttsStart);
        if (streamed) return;
      }

      // Strategy 2: Self-hosted sidecar (Kokoro)
      const sidecarUrl = process.env.SELF_HOSTED_TTS_URL;
      if (sidecarUrl) {
        const streamed = await this.streamSidecarTTS(sidecarUrl, text, ttsStart);
        if (streamed) return;
      }

      // Strategy 3: Batch TTS via AudioOrchestrationService
      const { AudioOrchestrationService } = await import('@/services/audio-orchestration-service.js');
      const audioService = new AudioOrchestrationService();
      const result = await audioService.synthesizeSpeech({
        text,
        format: 'pcm',
        userContext: {
          organizationId: this.organizationId,
          userId: this.userId,
          requestId: this.requestId,
          models: [],
          taskType: 'general' as const,
          contextSize: 0,
        },
        requestId: this.requestId,
      });

      // Emit audio in chunks
      for (let i = 0; i < result.audioBuffer.length; i += TTS_CHUNK_BYTES) {
        if (!this.connected) break;
        this.emit('response.audio.delta', {
          type: 'response.audio.delta',
          delta: result.audioBuffer.subarray(i, Math.min(i + TTS_CHUNK_BYTES, result.audioBuffer.length)).toString('base64'),
        });
      }
      this.emit('response.audio.done', { type: 'response.audio.done' });
      log.info({ requestId: this.requestId, ttsMs: Date.now() - ttsStart, method: 'batch' }, 'TTS done');
    } catch (err) {
      log.warn({
        requestId: this.requestId,
        error: err instanceof Error ? err.message : String(err),
      }, 'TTS failed (text still delivered)');
    }
  }

  private async streamCartesiaTTS(apiKey: string, text: string, startTime: number): Promise<boolean> {
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'Cartesia-Version': '2025-04-16',
        },
        body: JSON.stringify({
          model_id: 'sonic',
          transcript: text,
          voice: { mode: 'id', id: 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
        }),
      });

      if (!response.ok || !response.body) return false;

      const reader = response.body.getReader();
      let totalBytes = 0;
      let firstChunk = true;

      while (this.connected) {
        const result = await reader.read();
        if (result.done) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        const chunk = Buffer.from(value);
        totalBytes += chunk.length;

        if (firstChunk) {
          log.info({ requestId: this.requestId, ttfb: Date.now() - startTime }, 'TTS first byte (Cartesia)');
          firstChunk = false;
        }

        for (let i = 0; i < chunk.length; i += TTS_CHUNK_BYTES) {
          this.emit('response.audio.delta', {
            type: 'response.audio.delta',
            delta: chunk.subarray(i, Math.min(i + TTS_CHUNK_BYTES, chunk.length)).toString('base64'),
          });
        }
      }

      this.emit('response.audio.done', { type: 'response.audio.done' });
      log.info({ requestId: this.requestId, ttsMs: Date.now() - startTime, totalBytes, method: 'cartesia-stream' }, 'TTS done');
      return totalBytes > 0;
    } catch (err) {
      log.warn({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Cartesia TTS failed');
      return false;
    }
  }

  private async streamSidecarTTS(baseUrl: string, text: string, startTime: number): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          input: text,
          voice: this.config?.voice || 'default',
          response_format: 'pcm',
        }),
      });

      if (!response.ok || !response.body) return false;

      const reader = response.body.getReader();
      let totalBytes = 0;

      while (this.connected) {
        const result = await reader.read();
        if (result.done) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        const chunk = Buffer.from(value);
        totalBytes += chunk.length;

        for (let i = 0; i < chunk.length; i += TTS_CHUNK_BYTES) {
          this.emit('response.audio.delta', {
            type: 'response.audio.delta',
            delta: chunk.subarray(i, Math.min(i + TTS_CHUNK_BYTES, chunk.length)).toString('base64'),
          });
        }
      }

      this.emit('response.audio.done', { type: 'response.audio.done' });
      log.info({ requestId: this.requestId, ttsMs: Date.now() - startTime, totalBytes, method: 'sidecar-stream' }, 'TTS done');
      return totalBytes > 0;
    } catch {
      return false;
    }
  }
}
