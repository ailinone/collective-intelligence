// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Invoker
 *
 * Unified interface for strategies to invoke ANY modality:
 * chat, STT, TTS, translation, image generation, embeddings.
 *
 * This is the bridge between the OrchestrationEngine (which selects
 * models and strategies) and the specialized services (which know
 * how to process audio, translate text, etc.).
 *
 * Strategies receive a CapabilityInvoker in their execution context
 * and can compose cross-modal pipelines:
 *
 *   const text = await invoker.transcribe(audioBuffer);
 *   const translated = await invoker.translate(text, 'en', 'pt');
 *   const audio = await invoker.synthesize(translated);
 */

import { logger } from '@/utils/logger';
import type { ChatMessage, ChatResponse, OrchestrationContext } from '@/types';

const log = logger.child({ component: 'capability-invoker' });

// ── Result types ────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
}

export interface SynthesisResult {
  audioBuffer: Buffer;
  format: string;
  durationMs?: number;
  provider?: string;
  model?: string;
}

export interface TranslationResult {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  latencyMs: number;
  model: string;
}

// ── Options types ───────────────────────────────────────────

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Forces structured JSON output — used by generateFile() for the
   *  csv/json formats so the model's content can be parsed reliably
   *  (same lesson as the triage parse-hardening: content fields from an
   *  LLM must be requested in strict JSON mode, not hoped for via prompt). */
  responseFormat?: 'json_object' | 'text';
  /**
   * Forces a specific execution strategy on the recursive chat() call made
   * through this invoker's `chatHandler`. CRITICAL for generateFile(): its
   * prompt is the caller's original request text (e.g. "generate a csv of
   * X") — if that text is sent back through the full triage/heuristic
   * pipeline (`chatHandler`'s default wiring calls the engine's own
   * `execute()`), the SAME file-generation intent gets re-detected, builds
   * ANOTHER file-generation stage, and calls generateFile() again —
   * unbounded recursion (found in production, 2026-07-15: hundreds of
   * nested `csv_generation` stages, ~4s apart, until the service was
   * cycled). Setting `strategy: 'single'` here makes
   * `autoStrategyRequested` false in `execute()`, which skips the ENTIRE
   * triage/heuristic block — the recursive call becomes a plain one-shot
   * completion with no chance of re-triggering stage detection.
   */
  strategy?: string;
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  responseFormat?: string;
}

/**
 * Audio format for TTS output. Mirrors `TTSOptions.format` from the audio
 * orchestration service so callers can't request a format the underlying
 * adapters can't emit. Add a literal here only after the corresponding
 * adapter wiring exists.
 */
export type SynthesizeFormat = 'wav' | 'mp3' | 'aac' | 'flac' | 'opus' | 'pcm';

export interface SynthesizeOptions {
  model?: string;
  voice?: string;
  format?: SynthesizeFormat;
  speed?: number;
}

export interface TranslateOptions {
  model?: string;
}

// ── CapabilityInvoker Interface ─────────────────────────────

/**
 * Strategies use this interface to invoke any capability.
 * The invoker wraps the specialized services and handles
 * model selection, error recovery, and logging.
 */
export interface CapabilityInvoker {
  /**
   * Chat completion — invoke an LLM with messages.
   * Uses the OrchestrationEngine for model selection.
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /**
   * Speech-to-Text — transcribe audio buffer to text.
   * Uses AudioOrchestrationService with tier-filtered native STT models.
   */
  transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;

  /**
   * Text-to-Speech — synthesize text to audio buffer.
   * Uses AudioOrchestrationService with tier-filtered native TTS models.
   */
  synthesize(text: string, options?: SynthesizeOptions): Promise<SynthesisResult>;

  /**
   * Translation — translate text between languages.
   * Uses TranslationService (NLLB for speed, LLM fallback).
   */
  translate(text: string, sourceLang: string, targetLang: string, options?: TranslateOptions): Promise<TranslationResult>;

  /**
   * Video generation — generate video from a prompt (+ optional image/audio).
   * Uses VideoOrchestrationService. Enables a text flow to drive video
   * generation as a tool (DUP-bridge / option B, 2026-06-11).
   */
  generateVideo(options: VideoGenInvokeOptions): Promise<VideoGenInvokeResult>;

  /**
   * Image generation — generate images from a text prompt.
   * Uses ImagesOrchestrationService (the same service backing
   * `/v1/images/generations`). Added for multi-stage triage plans that
   * decompose a request into per-modality stages.
   */
  generateImage(options: ImageGenInvokeOptions): Promise<ImageGenInvokeResult>;

  /**
   * File generation — render a real file (CSV/JSON/Markdown today) from a
   * prompt. Unlike image/video/audio, there is no specialized external
   * "file generation model" — a normal chat model produces STRUCTURED
   * content (forced into JSON mode for csv/json), then FileGenerationService
   * deterministically renders the bytes. The model never emits raw
   * binary/base64 file data directly.
   */
  generateFile(options: FileGenInvokeOptions): Promise<FileGenInvokeResult>;
}

export interface FileGenInvokeOptions {
  format: 'csv' | 'json' | 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'zip' | 'code';
  prompt: string;
  filenameBase?: string;
}

export interface FileGenInvokeResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  model?: string;
}

export interface ImageGenInvokeOptions {
  prompt: string;
  model?: string;
  n?: number;
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  responseFormat?: 'url' | 'b64_json';
}

export interface ImageGenInvokeResult {
  images: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  provider?: string;
  model?: string;
}

export interface VideoGenInvokeOptions {
  prompt: string;
  model?: string;
  /** Optional reference image as a URL or base64 string (image-to-video). */
  image?: string;
  duration?: number;
  aspectRatio?: string;
  size?: string;
  n?: number;
  responseFormat?: 'url' | 'b64_json';
}

export interface VideoGenInvokeResult {
  videos: Array<{ id?: string; url?: string; b64_json?: string }>;
  provider?: string;
  model?: string;
}

// ── Default Implementation ──────────────────────────────────

/**
 * Creates a CapabilityInvoker that wraps the existing services.
 *
 * This is the "glue" that connects the strategy execution context
 * to the specialized services without coupling them.
 *
 * `AudioServiceLike` is a structural shape that mirrors the surface of
 * AudioOrchestrationService that this invoker actually uses. We avoid an
 * import-of-the-real-class to dodge circular module deps, and we type the
 * arguments/results structurally — `unknown` for opaque options + a
 * post-result narrow helper at the call site.
 */
interface AudioTranscribeOptions {
  audioBuffer: Buffer;
  filename: string;
  responseFormat?: string;
  model?: string;
  language?: string;
  userContext: OrchestrationContext;
  requestId: string;
}
interface AudioSynthesizeOptions {
  text: string;
  voice: string;
  // Tighten the format union to mirror `TTSOptions.format` exactly. A
  // looser `string` here makes `AudioOrchestrationService` non-assignable
  // to `AudioServiceLike` (function-arg contravariance: a method that
  // accepts only a 6-literal union cannot satisfy a contract that
  // accepts arbitrary strings).
  format: 'wav' | 'mp3' | 'aac' | 'flac' | 'opus' | 'pcm' | undefined;
  model?: string;
  userContext: OrchestrationContext;
  requestId: string;
}
type AudioResultLike = { text?: unknown; audioBuffer?: unknown; provider?: unknown; modelUsed?: unknown };
type AudioServiceLike = {
  transcribeAudio(options: AudioTranscribeOptions): Promise<AudioResultLike>;
  synthesizeSpeech(options: AudioSynthesizeOptions): Promise<AudioResultLike>;
};

interface VideoGenerateServiceOptions {
  prompt: string;
  model?: string;
  image?: string;
  duration?: number;
  aspectRatio?: string;
  size?: string;
  n?: number;
  responseFormat?: 'url' | 'b64_json';
  userContext: OrchestrationContext;
  requestId: string;
}
type VideoResultLike = {
  videos?: unknown;
  provider?: unknown;
  modelUsed?: unknown;
};
type VideoServiceLike = {
  generateVideo(options: VideoGenerateServiceOptions): Promise<VideoResultLike>;
};

interface ImageGenerateServiceOptions {
  prompt: string;
  model?: string;
  n: number;
  size: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  quality: 'standard' | 'hd';
  responseFormat: 'url' | 'b64_json';
  style: 'vivid' | 'natural';
  userContext: OrchestrationContext;
  requestId: string;
}
type ImageResultLike = { images?: unknown; provider?: unknown; modelUsed?: unknown };
type ImageServiceLike = {
  generateImages(options: ImageGenerateServiceOptions): Promise<ImageResultLike>;
};

type FileServiceLike = {
  generate(
    format: 'csv' | 'json' | 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'zip' | 'code',
    content: unknown,
    filenameBase?: string
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> | { buffer: Buffer; filename: string; mimeType: string };
};

const FILE_FORMAT_INSTRUCTIONS: Record<FileGenInvokeOptions['format'], string> = {
  csv: 'Respond ONLY with a JSON object of the exact shape {"headers": string[], "rows": Array<Array<string|number|boolean|null>>} representing the requested data as a table. No prose, no markdown code fences, no extra keys.',
  json: 'Respond ONLY with the raw JSON value being requested (object or array) — no prose, no markdown code fences, no wrapping unless explicitly asked for one.',
  markdown: 'Respond ONLY with the markdown document itself — no prose framing before or after it, no code fence wrapping the whole document.',
  docx: 'Respond ONLY with a JSON object of the exact shape {"title"?: string, "sections": Array<{"type":"heading","text":string,"level"?:1|2|3|4} | {"type":"paragraph","text":string} | {"type":"bullet_list","items":string[]} | {"type":"table","headers":string[],"rows":Array<Array<string|number|boolean|null>>}>} representing the full document body, in order. No prose, no markdown code fences, no extra keys.',
  xlsx: 'Respond ONLY with a JSON object of the exact shape {"sheets": Array<{"name":string,"headers"?:string[],"rows":Array<Array<string|number|boolean|null>>}>} representing one or more worksheets. No prose, no markdown code fences, no extra keys.',
  pdf: 'Respond ONLY with a JSON object of the exact shape {"title"?: string, "sections": Array<{"type":"heading","text":string,"level"?:1|2|3|4} | {"type":"paragraph","text":string} | {"type":"bullet_list","items":string[]} | {"type":"table","headers":string[],"rows":Array<Array<string|number|boolean|null>>}>} representing the full document body, in order. No prose, no markdown code fences, no extra keys.',
  pptx: 'Respond ONLY with a JSON object of the exact shape {"title"?: string, "slides": Array<{"title"?: string, "items": Array<{"type":"paragraph","text":string} | {"type":"bullet_list","items":string[]} | {"type":"table","headers":string[],"rows":Array<Array<string|number|boolean|null>>}>}>} representing the full slide deck, in order. No prose, no markdown code fences, no extra keys.',
  zip: 'Respond ONLY with a JSON object of the exact shape {"files": Array<{"filename": string, "format": "csv"|"json"|"markdown"|"docx"|"xlsx"|"pdf"|"pptx"|"code", "content": <the exact JSON content shape that "format" alone would require — e.g. for "csv" that is {"headers":string[],"rows":Array<Array<string|number|boolean|null>>}, for "docx"/"pdf" that is {"title"?:string,"sections":[...]}, for "pptx" that is {"title"?:string,"slides":[...]}, for "xlsx" that is {"sheets":[...]}, for "markdown" that is the raw string, for "json" that is the raw JSON value, for "code" that is {"language":string,"code":string}>}>} — one entry per file to bundle into the archive, at least one entry required. No prose, no markdown code fences, no extra keys.',
  code: 'Respond ONLY with a JSON object of the exact shape {"language": string, "code": string} where "language" is the programming language name (e.g. "python", "javascript", "typescript", "go", "rust") and "code" is the complete source code as a single string, using actual newline characters. No prose, no markdown code fences, no extra keys.',
};

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export function createCapabilityInvoker(deps: {
  /** For chat — can be null if audio-only context */
  chatHandler?: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  /** AudioOrchestrationService instance (loosely typed to avoid circular imports) */
  audioService?: AudioServiceLike;
  /** TranslationService instance */
  translationService?: {
    translateText(text: string, sourceLang: string, targetLang: string): Promise<{ translatedText: string; latencyMs: number; model: string; sourceLang: string; targetLang: string }>;
  };
  /** VideoOrchestrationService instance (loosely typed to avoid circular imports) */
  videoService?: VideoServiceLike;
  /** ImagesOrchestrationService instance (loosely typed to avoid circular imports) */
  imageService?: ImageServiceLike;
  /** FileGenerationService instance (loosely typed to avoid circular imports) */
  fileService?: FileServiceLike;
  /** Orchestration context for model selection */
  context: OrchestrationContext;
}): CapabilityInvoker {
  const requestId = deps.context.requestId;

  return {
    async chat(messages, options) {
      if (!deps.chatHandler) {
        throw new Error('Chat capability not available in this context');
      }
      log.debug({ requestId, messageCount: messages.length }, 'Invoking chat capability');
      return deps.chatHandler(messages, options);
    },

    async transcribe(audioBuffer, options) {
      if (!deps.audioService) {
        throw new Error('Audio transcription capability not available');
      }
      log.debug({ requestId, audioBytes: audioBuffer.length, model: options?.model }, 'Invoking STT capability');
      const result = await deps.audioService.transcribeAudio({
        audioBuffer,
        filename: 'invoker-audio.wav',
        responseFormat: options?.responseFormat || 'json',
        model: options?.model,
        language: options?.language,
        userContext: deps.context,
        requestId,
      });
      return {
        text: typeof result.text === 'string' ? result.text : '',
        language: options?.language,
        provider: typeof result.provider === 'string' ? result.provider : undefined,
        model: typeof result.modelUsed === 'string' ? result.modelUsed : undefined,
      };
    },

    async synthesize(text, options) {
      if (!deps.audioService) {
        throw new Error('Audio synthesis capability not available');
      }
      log.debug({ requestId, textLen: text.length, voice: options?.voice }, 'Invoking TTS capability');
      const result = await deps.audioService.synthesizeSpeech({
        text,
        voice: options?.voice || 'alloy',
        format: options?.format || 'wav',
        model: options?.model,
        userContext: deps.context,
        requestId,
      });
      // Buffer typing in @types/node 20+ uses generic Buffer<ArrayBufferLike>;
      // narrow via runtime guard then re-cast to the canonical Buffer type
      // for the caller (Buffer is structurally identical regardless of param).
      const safeBuf: Buffer =
        result.audioBuffer instanceof Buffer ? (result.audioBuffer as Buffer) : Buffer.alloc(0);
      return {
        audioBuffer: safeBuf,
        format: options?.format || 'wav',
        provider: typeof result.provider === 'string' ? result.provider : undefined,
        model: typeof result.modelUsed === 'string' ? result.modelUsed : undefined,
      };
    },

    async translate(text, sourceLang, targetLang, _options) {
      if (!deps.translationService) {
        throw new Error('Translation capability not available');
      }
      log.debug({ requestId, textLen: text.length, from: sourceLang, to: targetLang }, 'Invoking translation capability');
      const result = await deps.translationService.translateText(text, sourceLang, targetLang);
      return {
        translatedText: result.translatedText,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        latencyMs: result.latencyMs,
        model: result.model,
      };
    },

    async generateVideo(options) {
      if (!deps.videoService) {
        throw new Error('Video generation capability not available');
      }
      log.debug({ requestId, promptLen: options.prompt.length, model: options.model }, 'Invoking video generation capability');
      const result = await deps.videoService.generateVideo({
        prompt: options.prompt,
        model: options.model,
        image: options.image,
        duration: options.duration,
        aspectRatio: options.aspectRatio,
        size: options.size,
        n: options.n,
        responseFormat: options.responseFormat,
        userContext: deps.context,
        requestId,
      });
      const videos = Array.isArray(result.videos)
        ? (result.videos as Array<{ id?: string; url?: string; b64_json?: string }>)
        : [];
      return {
        videos,
        provider: typeof result.provider === 'string' ? result.provider : undefined,
        model: typeof result.modelUsed === 'string' ? result.modelUsed : undefined,
      };
    },

    async generateImage(options) {
      if (!deps.imageService) {
        throw new Error('Image generation capability not available');
      }
      log.debug({ requestId, promptLen: options.prompt.length, model: options.model }, 'Invoking image generation capability');
      const result = await deps.imageService.generateImages({
        prompt: options.prompt,
        model: options.model,
        n: options.n ?? 1,
        size: options.size ?? '1024x1024',
        quality: options.quality ?? 'standard',
        style: options.style ?? 'vivid',
        responseFormat: options.responseFormat ?? 'url',
        userContext: deps.context,
        requestId,
      });
      const images = Array.isArray(result.images)
        ? (result.images as Array<{ url?: string; b64_json?: string; revised_prompt?: string }>)
        : [];
      return {
        images,
        provider: typeof result.provider === 'string' ? result.provider : undefined,
        model: typeof result.modelUsed === 'string' ? result.modelUsed : undefined,
      };
    },

    async generateFile(options) {
      if (!deps.chatHandler) {
        throw new Error('File generation capability not available in this context — no chat handler');
      }
      if (!deps.fileService) {
        throw new Error('File generation capability not available in this context — no file service');
      }
      log.debug({ requestId, promptLen: options.prompt.length, format: options.format }, 'Invoking file generation capability');

      // CRITICAL: strategy: 'single' — see the ChatOptions.strategy doc.
      // options.prompt is the CALLER's original request text (often the
      // literal user message that triggered file-generation detection in
      // the first place); without forcing single-model here, the default
      // chatHandler wiring re-enters the full engine, re-detects the same
      // file-generation intent, and recurses without bound.
      const response = await deps.chatHandler(
        [{ role: 'user', content: `${options.prompt}\n\n${FILE_FORMAT_INSTRUCTIONS[options.format]}` }],
        { temperature: 0, responseFormat: options.format === 'markdown' ? 'text' : 'json_object', strategy: 'single' }
      );
      const rawContent = response.choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
        throw new Error(`File generation model returned no content for format "${options.format}"`);
      }

      let structuredContent: unknown;
      if (options.format === 'markdown') {
        structuredContent = rawContent;
      } else {
        try {
          structuredContent = JSON.parse(stripJsonCodeFence(rawContent));
        } catch (err) {
          throw new Error(
            `File generation model returned invalid JSON for format "${options.format}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const rendered = await deps.fileService.generate(options.format, structuredContent, options.filenameBase);
      return { ...rendered, model: response.model };
    },
  };
}
