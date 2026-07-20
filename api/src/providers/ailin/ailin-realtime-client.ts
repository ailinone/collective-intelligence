// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin Realtime Client — Optimized Streaming Pipeline
 *
 * Native realtime orchestrator for the Ailin API.
 * All model selection by capabilities — zero hardcoded models or providers.
 *
 * Pipeline optimizations:
 * 1. Direct OrchestrationEngine call (no HTTP loopback — saves ~200-500ms)
 * 2. Sentence-level TTS flush (TTS starts during LLM generation)
 * 3. Adaptive flush: accumulates tokens until sentence boundary OR time threshold
 * 4. Concurrent TTS: next sentence queued while previous synthesizes
 * 5. Audio chunking: 4KB segments for smooth client-side playback
 * 6. Graceful degradation: TTS failure = text-only response
 */

import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';
import { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import { getProviderRegistry } from '@/providers/provider-registry';
import { getTranslationService } from '@/services/translation-service';
import type { ChatMessage, OrchestrationContext } from '@/types';
import { isObject } from '@/utils/type-guards';
import WebSocket from 'ws';

const log = logger.child({ component: 'AilinRealtimeClient' });

// Pipeline tuning constants
const SENTENCE_DELIMITERS = /[.!?;\n]/;
const MIN_TTS_CHARS = 15;           // Minimum chars before flushing to TTS
const MAX_TTS_WAIT_MS = 3000;       // Force flush after this much silence from LLM
const TTS_CHUNK_BYTES = 4096;       // Audio chunk size for client streaming

// Server-side VAD constants (legacy batch mode — non-translation)
const VAD_SILENCE_MS = 800;          // Silence threshold before auto-flush
const VAD_MAX_BUFFER_MS = 15000;     // Maximum buffer duration before force-flush
const VAD_CHECK_INTERVAL_MS = 200;   // How often to check for silence
const VAD_ENERGY_THRESHOLD = 200;    // RMS energy threshold for speech detection (Int16 PCM)

// Streaming STT constants (translation mode)
const DEEPGRAM_ENDPOINTING_MS = 200; // Phrase boundary: 200ms pause → is_final
const DEEPGRAM_SAMPLE_RATE = 24000;  // PCM sample rate from client
const DEEPGRAM_ENCODING = 'linear16'; // Int16 PCM

export interface AilinSessionConfig {
  modalities?: ('text' | 'audio')[];
  instructions?: string;
  voice?: string;
  temperature?: number;
  tools?: Array<{ type: string; [key: string]: unknown }>;
  /** Translation mode: skip LLM, use NLLB for direct translation */
  translation?: {
    enabled: boolean;
    sourceLanguage: string;  // ISO 639-1 (e.g., 'en', 'pt', 'ja')
    targetLanguage: string;  // ISO 639-1
  };
}

export class AilinRealtimeClient extends EventEmitter {
  private sessionConfig: AilinSessionConfig | null = null;
  private audioChunks: Buffer[] = [];
  private conversationHistory: ChatMessage[] = [];
  private connected = false;
  private cancelled = false;
  private activeAbort: AbortController | null = null;
  private processing = false;        // Prevent concurrent pipeline runs

  // Server-side VAD state
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioTime = 0;         // Timestamp of last audio chunk
  private firstAudioTime = 0;        // Timestamp of first chunk in current buffer
  private speechActive = false;      // Whether speech is currently detected
  private totalAudioBytes = 0;       // Total bytes in current buffer

  private audioService: AudioOrchestrationService;
  private organizationId: string;
  private userId: string;
  private requestId: string;
  private authToken: string;

  // Streaming STT state (translation mode — phrase-level processing)
  private deepgramWs: WebSocket | null = null;
  private streamingSTTActive = false;
  private ttsQueue: Promise<void> = Promise.resolve(); // Ordered TTS queue
  private phraseCounter = 0;

  constructor(config: { organizationId: string; userId: string; requestId: string; authToken?: string }) {
    super();
    this.organizationId = config.organizationId;
    this.userId = config.userId;
    this.requestId = config.requestId;
    this.authToken = config.authToken || '';
    this.audioService = new AudioOrchestrationService();
  }

  async connect(sessionConfig: AilinSessionConfig): Promise<void> {
    this.sessionConfig = sessionConfig;
    this.connected = true;
    this.conversationHistory = [];
    this.audioChunks = [];
    this.phraseCounter = 0;

    // Translation mode: use streaming STT for phrase-level processing
    // Non-translation mode: use legacy VAD + batch STT
    if (sessionConfig.translation?.enabled) {
      try {
        await this.startStreamingSTT(sessionConfig.translation.sourceLanguage);
      } catch (err) {
        log.error({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Streaming STT startup failed — falling back to batch VAD');
        this.startVadTimer();
      }
    } else {
      this.startVadTimer();
    }

    log.info({
      requestId: this.requestId,
      translation: !!sessionConfig.translation?.enabled,
      streamingSTT: this.streamingSTTActive,
    }, 'Ailin realtime session created');
    this.emit('session.created', { type: 'session.created', session: { ...sessionConfig, provider: 'ailin' } });
  }

  sendText(text: string): void {
    this.conversationHistory.push({ role: 'user', content: text });
  }

  sendAudio(buffer: Buffer): void {
    // ── Streaming STT path (translation mode) ──────────────────
    // Forward audio directly to Deepgram WebSocket.
    // Deepgram handles VAD + endpointing (200ms) → is_final events.
    if (this.streamingSTTActive && this.deepgramWs?.readyState === WebSocket.OPEN) {
      this.deepgramWs.send(buffer);
      return;
    }

    // ── Legacy batch path (non-translation / chat mode) ────────
    this.audioChunks.push(buffer);
    const now = Date.now();
    this.lastAudioTime = now;
    this.totalAudioBytes += buffer.length;
    if (!this.firstAudioTime) this.firstAudioTime = now;

    // Detect speech start via RMS energy
    if (!this.speechActive && buffer.length >= 2) {
      const rms = this.computeRms(buffer);
      if (rms > VAD_ENERGY_THRESHOLD) {
        this.speechActive = true;
        this.emit('input_audio_buffer.speech_started', { type: 'input_audio_buffer.speech_started' });
        log.debug({ requestId: this.requestId, rms: Math.round(rms) }, 'VAD: speech started');
      }
    }
  }

  requestResponse(): void {
    if (!this.connected || !this.sessionConfig) return;
    this.cancelled = false;
    this.activeAbort = new AbortController();

    if (this.audioChunks.length > 0) {
      const audioBuffer = Buffer.concat(this.audioChunks);
      this.audioChunks = [];
      this.processAudioInput(audioBuffer).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ requestId: this.requestId, error: message }, 'Audio pipeline failed');
        this.emit('error', { type: 'error', error: { type: 'processing_error', message } });
      });
    } else if (this.conversationHistory.length > 0) {
      const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
      if (lastMsg.role === 'user') {
        this.processTextInput(lastMsg.content as string).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ requestId: this.requestId, error: message }, 'Text pipeline failed');
          this.emit('error', { type: 'error', error: { type: 'processing_error', message } });
        });
      }
    }
  }

  cancelResponse(): void {
    this.cancelled = true;
    this.activeAbort?.abort();
    this.emit('response.cancelled', { type: 'response.cancelled' });
  }

  disconnect(): void {
    this.cancelled = true;
    this.activeAbort?.abort();
    this.stopVadTimer();
    this.stopStreamingSTT();
    this.connected = false;
    this.conversationHistory = [];
    this.audioChunks = [];
    this.sessionConfig = null;
    this.emit('close', {});
  }

  // ══════════════════════════════════════════════════════
  //  OPTIMIZED PIPELINE
  // ══════════════════════════════════════════════════════

  private async processAudioInput(audioBuffer: Buffer): Promise<void> {
    const pipeStart = Date.now();
    log.info({ requestId: this.requestId, audioBytes: audioBuffer.length }, 'Pipeline: STT start');

    // Wrap raw PCM in WAV header (WebSocket sends raw Int16LE PCM 24kHz mono)
    const wavBuffer = this.wrapPcmInWav(audioBuffer, 24000, 1, 16);

    const sttResult = await this.audioService.transcribeAudio({
      audioBuffer: wavBuffer,
      filename: 'realtime-audio.wav',
      responseFormat: 'json',
      // model: auto-select — tier filter ensures native STT (Deepgram/Whisper), not chat models
      userContext: this.buildOrchestrationContext(),
      requestId: this.requestId,
    });

    if (this.cancelled) return;

    log.info({ requestId: this.requestId, sttMs: Date.now() - pipeStart, text: sttResult.text.substring(0, 80) }, 'Pipeline: STT complete');

    this.emit('conversation.item.input_audio_transcription.completed', {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: sttResult.text,
    });

    this.conversationHistory.push({ role: 'user', content: sttResult.text });

    // Translation mode: skip LLM, translate directly via NLLB (~50ms)
    if (this.sessionConfig?.translation?.enabled) {
      await this.processAudioTranslation(sttResult.text, pipeStart);
    } else {
      await this.processTextInput(sttResult.text);
    }
  }

  private async processTextInput(_userText: string): Promise<void> {
    const pipeStart = Date.now();
    const wantAudio = this.hasAudioModality();
    let fullResponse = '';

    // TTS pipeline state
    let ttsPending: Promise<void> = Promise.resolve();
    let pendingText = '';
    let lastFlushTime = Date.now();

    const flushToTTS = (text: string): void => {
      if (!text.trim() || this.cancelled || !wantAudio) return;
      const textToSpeak = text;
      lastFlushTime = Date.now();
      log.info({ requestId: this.requestId, textLen: textToSpeak.length, text: textToSpeak.substring(0, 60) }, 'Pipeline: TTS flush');
      ttsPending = ttsPending.then(() => this.synthesizeAndStreamAudio(textToSpeak).catch(err => {
        log.warn({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Pipeline: TTS chunk failed (text delivered)');
      }));
    };

    // HTTP loopback to own /v1/chat/completions — reliable SSE parsing, full middleware stack
    const baseUrl = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`;
    log.info({ requestId: this.requestId, wantAudio }, 'Pipeline: chat stream start');

    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
          'X-Organization-Id': this.organizationId,
          'X-User-Id': this.userId,
        },
        body: JSON.stringify({
          model: 'ailin-fast',           // L9: Virtual alias — strategy:speed, diversifies providers
          messages: this.buildMessages(),
          temperature: this.sessionConfig?.temperature ?? 0.8,
          max_tokens: 1024,
          stream: true,
          prefer_speed: true,            // L9: Prioritize low-latency providers in triage
          metadata: { max_retry_attempts: 5 },  // L9: Limit retry cascade (default is 1154 candidates!)
        }),
        signal: this.activeAbort?.signal ?? AbortSignal.timeout(20000), // L9: 20s max for chat — fail fast
      });

      if (!response.ok) throw new Error(`Chat API ${response.status}: ${(await response.text()).substring(0, 200)}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let sseBuffer = '';

      // SSE drain loop: continues until either the stream finishes (`done`)
      // or we get cancelled. Use `instanceof Uint8Array` to narrow the chunk
      // value, avoiding both the `any` widening from the underlying reader
      // and the `as unknown as` laundering pattern.
      while (!this.cancelled) {
        const result = await reader.read();
        if (result.done) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            // SSE chunks come over the wire as `unknown` JSON. Narrow each
            // level structurally so `.choices[0].delta.content` is type-safe.
            const chunk: unknown = JSON.parse(data);
            const choicesRaw = isObject(chunk) ? (chunk as { choices?: unknown }).choices : undefined;
            // `Array.isArray` on `unknown` narrows to `any[]` (TS quirk),
            // so explicitly re-annotate the array element as `unknown` to
            // keep the chain honest.
            const firstChoice: unknown = Array.isArray(choicesRaw) && choicesRaw.length > 0 ? choicesRaw[0] : undefined;
            const deltaObj = isObject(firstChoice) ? (firstChoice as { delta?: unknown }).delta : undefined;
            const delta = isObject(deltaObj)
              ? (deltaObj as { content?: unknown }).content
              : undefined;
            if (typeof delta === 'string' && delta.length > 0) {
              fullResponse += delta;
              pendingText += delta;
              this.emit('response.text.delta', { type: 'response.text.delta', delta });

              if (SENTENCE_DELIMITERS.test(delta) && pendingText.length >= MIN_TTS_CHARS) {
                flushToTTS(pendingText);
                pendingText = '';
              } else if (pendingText.length >= MIN_TTS_CHARS * 3 || (Date.now() - lastFlushTime > MAX_TTS_WAIT_MS && pendingText.length >= MIN_TTS_CHARS)) {
                flushToTTS(pendingText);
                pendingText = '';
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if (this.cancelled) { /* expected */ }
      else {
        const msg = err instanceof Error ? err.message : 'Chat stream failed';
        log.error({ requestId: this.requestId, error: msg }, 'Pipeline: chat error');
        this.emit('error', { type: 'error', error: { type: 'chat_error', message: msg } });
        return;
      }
    }

    // Don't emit response.done after cancellation (response.cancelled already sent)
    if (this.cancelled) return;

    log.info({ requestId: this.requestId, chatMs: Date.now() - pipeStart, responseLen: fullResponse.length }, 'Pipeline: chat complete');

    // Flush remaining text to TTS
    if (pendingText.trim()) {
      flushToTTS(pendingText);
    }

    // Wait for all TTS to finish
    await ttsPending;

    // Store in history
    if (fullResponse) {
      this.conversationHistory.push({ role: 'assistant', content: fullResponse });
    }

    const totalMs = Date.now() - pipeStart;
    log.info({ requestId: this.requestId, totalMs, responseLen: fullResponse.length, hasAudio: wantAudio }, 'Pipeline: complete');

    // Emit response.done
    this.emit('response.done', {
      type: 'response.done',
      response: {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: fullResponse },
            ...(wantAudio ? [{ type: 'audio', transcript: fullResponse }] : []),
          ],
        }],
      },
    });
  }

  // ══════════════════════════════════════════════════════
  //  TRANSLATION PIPELINE (STT → NLLB → TTS, ~300ms E2E)
  // ══════════════════════════════════════════════════════

  private async processAudioTranslation(sourceText: string, pipeStart: number): Promise<void> {
    if (this.cancelled || !this.sessionConfig?.translation) return;

    // Skip translation for empty/whitespace-only STT results (silence, noise)
    if (!sourceText || !sourceText.trim()) {
      log.debug({ requestId: this.requestId }, 'Pipeline: skipping translation — empty STT result');
      return;
    }

    const { sourceLanguage, targetLanguage } = this.sessionConfig.translation;
    const wantAudio = this.hasAudioModality();

    // Emit original text
    this.emit('translation.text.original', {
      type: 'translation.text.original',
      text: sourceText,
      language: sourceLanguage,
    });

    // Translate via NLLB (~50ms) — skip the entire LLM step
    const translationService = getTranslationService();
    let translatedText: string;

    try {
      const result = await translationService.translateText(sourceText, sourceLanguage, targetLanguage);
      translatedText = result.translatedText;
      log.info({
        requestId: this.requestId,
        translateMs: result.latencyMs,
        model: result.model,
        from: sourceLanguage,
        to: targetLanguage,
        srcLen: sourceText.length,
        tgtLen: translatedText.length,
      }, 'Pipeline: translation complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ requestId: this.requestId, error: msg }, 'Pipeline: translation failed');
      this.emit('error', { type: 'error', error: { type: 'translation_error', message: msg } });
      return;
    }

    if (this.cancelled) return;

    // Emit translated text
    this.emit('translation.text.translated', {
      type: 'translation.text.translated',
      text: translatedText,
      language: targetLanguage,
    });
    this.emit('response.text.delta', { type: 'response.text.delta', delta: translatedText });

    // Synthesize translated text to audio
    if (wantAudio && translatedText.trim()) {
      await this.synthesizeAndStreamAudio(translatedText);
    }

    // Store in history
    this.conversationHistory.push({ role: 'assistant', content: translatedText });

    const totalMs = Date.now() - pipeStart;
    log.info({
      requestId: this.requestId,
      totalMs,
      sourceLen: sourceText.length,
      translatedLen: translatedText.length,
      hasAudio: wantAudio,
      mode: 'translation',
    }, 'Pipeline: translation E2E complete');

    this.emit('response.done', {
      type: 'response.done',
      response: {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: translatedText },
            ...(wantAudio ? [{ type: 'audio', transcript: translatedText }] : []),
          ],
        }],
        metadata: {
          mode: 'translation',
          sourceLanguage,
          targetLanguage,
          originalText: sourceText,
        },
      },
    });
  }

  // ── TTS: Stream audio chunks to client with minimum first-byte latency ──
  // Target: <200ms first byte. Uses HTTP streaming from self-hosted sidecars
  // or Cartesia WebSocket for cloud. Falls back to batch via AudioOrchestrationService.

  private async synthesizeAndStreamAudio(text: string): Promise<void> {
    if (this.cancelled) return;
    const ttsStart = Date.now();

    try {
      // Strategy 1: Direct HTTP streaming to self-hosted sidecar (lowest latency)
      const selfHostedTtsUrl = process.env.SELF_HOSTED_TTS_URL;
      if (selfHostedTtsUrl) {
        const streamed = await this.streamFromSidecar(selfHostedTtsUrl, text, ttsStart);
        if (streamed) return;
        // Fall through to batch if streaming failed
      }

      // Strategy 2: Direct HTTP streaming to Cartesia (cloud, ~40ms TTFB)
      const cartesiaAdapter = getProviderRegistry().get('cartesia');
      const cartesiaKey = cartesiaAdapter?.getApiKey();
      if (cartesiaKey) {
        const streamed = await this.streamFromCartesia(cartesiaKey, text, ttsStart);
        if (streamed) return;
      }

      // Strategy 3: Batch fallback via AudioOrchestrationService
      const ttsResult = await this.audioService.synthesizeSpeech({
        text,
        voice: this.sessionConfig?.voice || 'alloy',
        format: 'pcm',
        userContext: this.buildOrchestrationContext(),
        requestId: this.requestId,
      });

      if (this.cancelled) return;

      const audioBuffer = ttsResult.audioBuffer;
      for (let offset = 0; offset < audioBuffer.length; offset += TTS_CHUNK_BYTES) {
        if (this.cancelled) break;
        this.emit('response.audio.delta', { type: 'response.audio.delta', delta: audioBuffer.subarray(offset, Math.min(offset + TTS_CHUNK_BYTES, audioBuffer.length)).toString('base64') });
      }
      this.emit('response.audio.done', { type: 'response.audio.done' });
      log.info({ requestId: this.requestId, ttsMs: Date.now() - ttsStart, audioBytes: audioBuffer.length, method: 'batch' }, 'Pipeline: TTS done');
    } catch (err) {
      log.warn({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Pipeline: TTS failed (text delivered)');
    }
  }

  /** Stream TTS from self-hosted sidecar via HTTP chunked transfer */
  private async streamFromSidecar(baseUrl: string, text: string, startTime: number): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro', input: text, voice: this.sessionConfig?.voice || 'default', response_format: 'pcm' }),
      });

      if (!response.ok || !response.body) return false;

      const reader = response.body.getReader();
      let totalBytes = 0;
      let firstChunk = true;

      // TTS audio drain: terminates when stream ends OR caller cancels.
      while (!this.cancelled) {
        const result = await reader.read();
        if (result.done) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        const chunk = Buffer.from(value);
        totalBytes += chunk.length;

        if (firstChunk) {
          log.info({ requestId: this.requestId, ttfb: Date.now() - startTime }, 'Pipeline: TTS first byte (streaming)');
          firstChunk = false;
        }

        // Emit 4KB sub-chunks for smooth playback
        for (let i = 0; i < chunk.length; i += TTS_CHUNK_BYTES) {
          this.emit('response.audio.delta', {
            type: 'response.audio.delta',
            delta: chunk.subarray(i, Math.min(i + TTS_CHUNK_BYTES, chunk.length)).toString('base64'),
          });
        }
      }

      this.emit('response.audio.done', { type: 'response.audio.done' });
      log.info({ requestId: this.requestId, ttsMs: Date.now() - startTime, totalBytes, method: 'sidecar-stream' }, 'Pipeline: TTS streaming done');
      return totalBytes > 0;
    } catch (err) {
      log.warn({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Sidecar TTS streaming failed, falling back');
      return false;
    }
  }

  /** Stream TTS from Cartesia cloud via HTTP (TTFB ~40ms) */
  private async streamFromCartesia(apiKey: string, text: string, startTime: number): Promise<boolean> {
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Cartesia-Version': '2025-04-16' },
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

      // Cartesia audio drain: terminates when stream ends OR caller cancels.
      while (!this.cancelled) {
        const result = await reader.read();
        if (result.done) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        const chunk = Buffer.from(value);
        totalBytes += chunk.length;

        if (firstChunk) {
          log.info({ requestId: this.requestId, ttfb: Date.now() - startTime }, 'Pipeline: Cartesia first byte');
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
      log.info({ requestId: this.requestId, ttsMs: Date.now() - startTime, totalBytes, method: 'cartesia-stream' }, 'Pipeline: Cartesia streaming done');
      return totalBytes > 0;
    } catch (err) {
      log.warn({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Cartesia streaming failed, falling back');
      return false;
    }
  }

  // ── Server-side VAD (Voice Activity Detection) ──
  // Detects speech boundaries and auto-flushes audio buffer

  private startVadTimer(): void {
    this.stopVadTimer();
    this.vadTimer = setInterval(() => this.checkVadFlush(), VAD_CHECK_INTERVAL_MS);
  }

  private stopVadTimer(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    this.speechActive = false;
    this.lastAudioTime = 0;
    this.firstAudioTime = 0;
    this.totalAudioBytes = 0;
  }

  private checkVadFlush(): void {
    if (!this.connected || this.processing || this.audioChunks.length === 0) return;
    const now = Date.now();
    const silenceMs = now - this.lastAudioTime;
    const bufferDurationMs = now - this.firstAudioTime;

    // Auto-flush on silence (speech ended)
    if (silenceMs >= VAD_SILENCE_MS) {
      if (this.speechActive) {
        this.speechActive = false;
        this.emit('input_audio_buffer.speech_stopped', { type: 'input_audio_buffer.speech_stopped' });
        log.debug({ requestId: this.requestId, silenceMs, audioBytes: this.totalAudioBytes }, 'VAD: speech stopped, flushing');
      }
      this.vadFlush();
      return;
    }

    // Force-flush on max buffer duration (prevent unbounded accumulation)
    if (bufferDurationMs >= VAD_MAX_BUFFER_MS) {
      log.debug({ requestId: this.requestId, bufferDurationMs, audioBytes: this.totalAudioBytes }, 'VAD: max buffer duration, force flushing');
      this.vadFlush();
    }
  }

  private vadFlush(): void {
    if (this.audioChunks.length === 0 || this.processing) return;
    this.processing = true;
    this.firstAudioTime = 0;
    this.totalAudioBytes = 0;

    // Trigger the pipeline (same as requestResponse but with guard)
    const audioBuffer = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.cancelled = false;
    this.activeAbort = new AbortController();

    this.processAudioInput(audioBuffer)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ requestId: this.requestId, error: message }, 'VAD auto-flush pipeline failed');
        this.emit('error', { type: 'error', error: { type: 'processing_error', message } });
      })
      .finally(() => {
        this.processing = false;
      });
  }

  // ══════════════════════════════════════════════════════
  //  STREAMING STT (Translation Mode — Phrase-Level)
  // ══════════════════════════════════════════════════════
  //
  // Opens a persistent Deepgram WebSocket. Audio chunks are forwarded
  // directly from sendAudio() → Deepgram. On each is_final (200ms pause),
  // the phrase is translated via NLLB CT2 (~130ms) and TTS'd via
  // Cartesia streaming (~40ms TTFB). Each phrase is independent.

  private async startStreamingSTT(sourceLanguage: string): Promise<void> {
    // Resolve Deepgram API key from provider registry
    const registry = getProviderRegistry();
    const deepgramAdapter = registry.get('deepgram');
    const apiKey = deepgramAdapter?.getApiKey();

    if (!apiKey) {
      log.warn({ requestId: this.requestId, hasRegistry: !!registry, hasAdapter: !!deepgramAdapter }, 'Streaming STT: no Deepgram API key, falling back to batch mode');
      this.startVadTimer();
      return;
    }

    log.info({ requestId: this.requestId, apiKeyLen: apiKey.length }, 'Streaming STT: Deepgram API key found');

    // Map ISO language code to Deepgram format:
    // - 'pt_BR' → 'pt-BR' (Deepgram uses hyphens, not underscores)
    // - 'pt' → 'pt' (already correct)
    // - 'auto' → undefined (let Deepgram auto-detect)
    const dgLang = sourceLanguage === 'auto'
      ? undefined
      : sourceLanguage.replace('_', '-'); // pt_BR → pt-BR

    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: DEEPGRAM_ENCODING,
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

    return new Promise<void>((resolve, _reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      const connectTimeout = setTimeout(() => {
        ws.close();
        log.warn({ requestId: this.requestId }, 'Streaming STT: Deepgram WS connect timeout');
        this.startVadTimer(); // Fallback to batch
        resolve();
      }, 5000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.deepgramWs = ws;
        this.streamingSTTActive = true;
        log.info({
          requestId: this.requestId,
          endpointingMs: DEEPGRAM_ENDPOINTING_MS,
          language: dgLang,
        }, 'Streaming STT: Deepgram WebSocket connected');
        resolve();
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type?: string;
            is_final?: boolean;
            speech_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
          };

          if (msg.type === 'Results') {
            const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
            const confidence = msg.channel?.alternatives?.[0]?.confidence || 0;

            if (msg.is_final && transcript.trim()) {
              // ── Phrase finalized (200ms pause detected) ──
              // Process immediately: translate + TTS
              this.phraseCounter++;
              const phraseId = this.phraseCounter;
              log.info({
                requestId: this.requestId,
                phraseId,
                text: transcript.substring(0, 60),
                confidence: confidence.toFixed(2),
              }, 'Streaming STT: phrase finalized (is_final)');

              this.emit('stt.transcription', {
                type: 'stt.transcription',
                text: transcript,
                is_final: true,
              });

              // Fire-and-forget: translate + TTS this phrase
              // TTS is queued to prevent audio overlap
              this.processPhrase(transcript, phraseId);
            } else if (!msg.is_final && transcript.trim()) {
              // Interim result — UI feedback only
              this.emit('stt.transcription', {
                type: 'stt.transcription',
                text: transcript,
                is_final: false,
              });
            }
          }

          // VAD events from Deepgram
          if (msg.type === 'SpeechStarted') {
            this.emit('input_audio_buffer.speech_started', { type: 'input_audio_buffer.speech_started' });
          }
        } catch (err) {
          log.debug({ requestId: this.requestId, error: err instanceof Error ? err.message : String(err) }, 'Streaming STT: parse error');
        }
      });

      ws.on('close', () => {
        this.streamingSTTActive = false;
        this.deepgramWs = null;
        log.info({ requestId: this.requestId }, 'Streaming STT: Deepgram WebSocket closed');
      });

      ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        log.error({ requestId: this.requestId, error: err.message }, 'Streaming STT: Deepgram WebSocket error');
        this.streamingSTTActive = false;
        this.deepgramWs = null;
        // Fallback to batch mode
        this.startVadTimer();
        resolve(); // Don't reject — graceful fallback
      });
    });
  }

  private stopStreamingSTT(): void {
    if (this.deepgramWs) {
      try {
        // Signal Deepgram to finalize any remaining audio
        if (this.deepgramWs.readyState === WebSocket.OPEN) {
          this.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.deepgramWs.close();
      } catch { /* ignore */ }
      this.deepgramWs = null;
    }
    this.streamingSTTActive = false;
  }

  /**
   * Process a single phrase: translate → TTS → stream audio.
   * Each phrase is independent. TTS is queued in order to prevent overlap.
   */
  private processPhrase(text: string, phraseId: number): void {
    if (this.cancelled || !this.sessionConfig?.translation) return;
    const { sourceLanguage, targetLanguage } = this.sessionConfig.translation;
    const wantAudio = this.hasAudioModality();
    const phraseStart = Date.now();

    // Queue this phrase's TTS after any previous phrase's TTS
    this.ttsQueue = this.ttsQueue.then(async () => {
      if (this.cancelled) return;

      // Emit original text
      this.emit('translation.text.original', {
        type: 'translation.text.original',
        text,
        language: sourceLanguage,
        phraseId,
      });

      // Translate via NLLB CT2 (~130ms)
      const translationService = getTranslationService();
      let translatedText: string;
      try {
        const result = await translationService.translateText(text, sourceLanguage, targetLanguage);
        translatedText = result.translatedText;
        log.info({
          requestId: this.requestId,
          phraseId,
          translateMs: result.latencyMs,
          src: text.substring(0, 40),
          tgt: translatedText.substring(0, 40),
        }, 'Streaming: phrase translated');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ requestId: this.requestId, phraseId, error: msg }, 'Streaming: translation failed');
        this.emit('error', { type: 'error', error: { type: 'translation_error', message: msg } });
        return;
      }

      if (this.cancelled) return;

      // Emit translated text
      this.emit('translation.text.translated', {
        type: 'translation.text.translated',
        text: translatedText,
        language: targetLanguage,
        phraseId,
      });
      this.emit('response.text.delta', { type: 'response.text.delta', delta: translatedText + ' ' });

      // TTS: stream audio for this phrase
      if (wantAudio && translatedText.trim()) {
        await this.synthesizeAndStreamAudio(translatedText);
      }

      this.conversationHistory.push(
        { role: 'user', content: text },
        { role: 'assistant', content: translatedText },
      );

      const totalMs = Date.now() - phraseStart;
      log.info({
        requestId: this.requestId,
        phraseId,
        totalMs,
        hasAudio: wantAudio,
      }, 'Streaming: phrase complete (translate+TTS)');
    }).catch(err => {
      log.error({ requestId: this.requestId, phraseId, error: err instanceof Error ? err.message : String(err) }, 'Streaming: phrase processing failed');
    });
  }

  /** Wrap raw PCM data in a WAV header */
  private wrapPcmInWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                             // chunk size
    header.writeUInt16LE(1, 20);                              // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // byte rate
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32); // block align
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  /** Compute RMS energy of Int16 PCM buffer */
  private computeRms(buffer: Buffer): number {
    let sumSquares = 0;
    const sampleCount = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / (sampleCount || 1));
  }

  // ── Helpers ──

  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.sessionConfig?.instructions) {
      messages.push({ role: 'system', content: this.sessionConfig.instructions });
    }
    messages.push(...this.conversationHistory);
    return messages;
  }

  private hasAudioModality(): boolean {
    return this.sessionConfig?.modalities?.includes('audio') ?? false;
  }

  private buildOrchestrationContext(): OrchestrationContext {
    return {
      requestId: this.requestId,
      organizationId: this.organizationId,
      userId: this.userId,
      models: [],
      taskType: 'general' as import('@/types').TaskType,
      contextSize: 0,
    } as OrchestrationContext;
  }
}
