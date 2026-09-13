// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Tipos universais para requests/responses padronizados
import type { Model } from './index';

export interface TextRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface TextResponse {
  content: string;
  raw: unknown; // payload bruto do provedor
}

export interface StreamChunk {
  content: string;
  raw: unknown;
}

export interface EmbeddingsRequest {
  inputs: string[]; // ou número[][] para multi-modal text?
}

export interface EmbeddingsResponse {
  vectors: number[][];
  raw: unknown;
}

export interface ImageGenRequest {
  prompt: string;
  size?: string; // "512x512"
  options?: Record<string, unknown>;
}

export interface ImageGenResponse {
  image: Buffer; // binário
  format: 'png' | 'jpg' | 'webp' | string;
  raw: unknown;
}

export interface ImageEditRequest {
  image: Buffer;
  mask?: Buffer;
  prompt: string;
  size?: string;
  n?: number;
  response_format?: 'url' | 'b64_json';
  options?: Record<string, unknown>;
}

export interface ImageEditResponse {
  image: Buffer;
  format: 'png' | 'jpg' | 'webp' | string;
  raw: unknown;
}

export interface ImageVariationRequest {
  image: Buffer;
  size?: string;
  n?: number;
  response_format?: 'url' | 'b64_json';
  options?: Record<string, unknown>;
}

export interface ImageVariationResponse {
  image: Buffer;
  format: 'png' | 'jpg' | 'webp' | string;
  raw: unknown;
}

export interface VideoGenRequest {
  prompt: string;
  image?: string;
  startImage?: string;
  endImage?: string;
  audio?: string;
  video?: string;
  duration?: number;
  aspectRatio?: string;
  size?: string;
  /**
   * Open bag for adapter-specific fields with no dedicated typed slot above.
   * LOTE AS (2026-09-06): `video-orchestration-service.ts#generateVideo`
   * mirrors duration/aspectRatio/size/audio/video into this bag too (using
   * each adapter's own key convention, e.g. RunwayML's `ratio` vs the
   * canonical `aspectRatio`), because some adapters (RunwayML, BytePlus,
   * Google Veo) read their inputs from HERE, not from the typed fields above
   * — a bag that only carried orchestration bookkeeping ({n, response_format,
   * video}) left those reads permanently dead. New provider-specific fields
   * with no generic equivalent (BytePlus's `resolution`/`generate_audio`,
   * Google's `resolution`/`generateAudio`) live here rather than growing this
   * interface further.
   */
  options?: Record<string, unknown>;
}

export interface VideoGenResponse {
  video:
    | Array<{
        id?: string;
        url?: string;
        b64_json?: string;
      }>
    | Buffer;
  format: 'mp4' | 'webm' | string;
  raw: unknown;
}

export interface AudioTTSRequest {
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg' | string;
  options?: Record<string, unknown>;
}

export interface AudioTTSResponse {
  audio: Buffer;
  format: string;
  raw: unknown;
}

/**
 * Music generation (LOTE AX, 2026-09-06) — distinct from `AudioTTSRequest`:
 * no spoken text, an optional structured composition plan instead of a bare
 * prompt, and a duration measured in minutes rather than a sentence. Modeled
 * on ElevenLabs Music (`POST /v1/music`), the first (and, as of this LOTE,
 * only) provider wired to this contract — the shape is intentionally the
 * vendor-neutral subset every documented music API would need (prompt OR a
 * structured plan, length, seed, instrumental-only flag), not an ElevenLabs
 * passthrough.
 */
export interface MusicGenRequest {
  /** Free-text description of the desired composition. Mutually exclusive
   *  with `compositionPlan` in practice — a provider that requires one MUST
   *  reject a request supplying neither. */
  prompt?: string;
  /** Structured, section-by-section composition plan. Vendor-shaped; passed
   *  through opaquely by adapters that support it. */
  compositionPlan?: Record<string, unknown>;
  /** Desired output length in milliseconds. */
  musicLengthMs?: number;
  /** Force instrumental-only output (no generated vocals). */
  forceInstrumental?: boolean;
  /** Deterministic generation seed, when the vendor supports one. */
  seed?: number;
  options?: Record<string, unknown>;
}

export interface MusicGenResponse {
  audio: Buffer;
  format: string;
  raw: unknown;
}

export interface AudioSTTRequest {
  audio: Buffer;
  language?: string;
  options?: Record<string, unknown>;
}

export interface AudioSTTResponse {
  text: string;
  raw: unknown;
}

export interface ModerationRequest {
  text: string;
  options?: Record<string, unknown>;
}

export interface ModerationResponse {
  flagged: boolean;
  categories: {
    sexual: boolean;
    hate: boolean;
    harassment: boolean;
    'self-harm': boolean;
    'sexual/minors': boolean;
    'hate/threatening': boolean;
    'violence/graphic': boolean;
    'self-harm/intent': boolean;
    'self-harm/instructions': boolean;
    'harassment/threatening': boolean;
    violence: boolean;
  };
  category_scores: {
    sexual: number;
    hate: number;
    harassment: number;
    'self-harm': number;
    'sexual/minors': number;
    'hate/threatening': number;
    'violence/graphic': number;
    'self-harm/intent': number;
    'self-harm/instructions': number;
    'harassment/threatening': number;
    violence: number;
  };
  raw: unknown;
}

/**
 * Cross-encoder DOCUMENT reranking (LOTE AP, 2026-09-05).
 *
 * Not to be confused with the RRF "semantic rerank" in
 * `core/selection/dynamic-model-selector.ts`, which reorders candidate
 * *models* inside the router. This contract reorders candidate *documents*
 * against a query — the classic retrieval second stage.
 *
 * The wire shapes diverge per vendor (Voyage: `top_k` + `data[].document`
 * as a bare string; Cohere-compatible: `top_n` + `results[].document.text`),
 * so adapters normalize INTO this shape rather than the router learning each
 * vendor's dialect.
 */
export interface RerankRequest {
  query: string;
  documents: readonly string[];
  /** Truncate the ranked output to the N most relevant documents. */
  topN?: number;
  /** Echo the document text back on each result (costs response bytes). */
  returnDocuments?: boolean;
  options?: Record<string, unknown>;
}

export interface RerankResultItem {
  /** Index into the ORIGINAL `documents` array — never a re-numbered rank. */
  index: number;
  /** Provider-reported relevance. Scales differ per vendor; order is what's portable. */
  relevanceScore: number;
  /** Present only when `returnDocuments` was requested and the vendor echoes it. */
  document?: string;
}

export interface RerankResponse {
  /** Sorted by descending `relevanceScore`. */
  results: RerankResultItem[];
  /** Tokens billed by the provider, when reported. */
  totalTokens?: number;
  raw: unknown;
}

export interface VisionRequest {
  prompt: string;
  image: Buffer | string; // path/URL/base64
  options?: Record<string, unknown>;
}

export interface VisionResponse {
  content: string;
  raw: unknown;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | { name: string };
}

export interface ToolChatResponse {
  toolCalls: ToolCall[];
  raw: unknown;
}

// Tipos para testes de capacidades (mantidos para compatibilidade)
export interface CapabilityTestResult {
  success: boolean;
  score: number; // 0–1
  metadata?: Record<string, unknown>;
}

// Tipos antigos do ModelClient (para compatibilidade)
export interface ModelClient {
  chat(model: Model, options: ChatTestOptions): Promise<ChatTestResult>;
  stream(model: Model, options: ChatTestOptions): Promise<StreamTestResult>;
  callTools(
    model: Model,
    params: {
      prompt: string;
      tools: Array<{
        type: string;
        function?: { name: string; description?: string; parameters?: Record<string, unknown> };
        [key: string]: unknown;
      }>;
    }
  ): Promise<FunctionCallTestResult>;
  vision(
    model: Model,
    params: { prompt: string; image: Buffer | string }
  ): Promise<VisionTestResult>;
  jsonMode(
    model: Model,
    params: { prompt: string; schema: Record<string, unknown> }
  ): Promise<JsonModeTestResult>;
}

export interface ChatTestOptions {
  prompt: string;
  system?: string;
  temperature?: number;
}

export interface ChatTestResult {
  content: string;
  raw: unknown;
}

export interface StreamTestResult {
  chunks: string[];
  fullText: string;
  raw: unknown;
}

export interface FunctionCallTestResult {
  toolName: string;
  arguments: Record<string, unknown>;
  raw: unknown;
}

export interface VisionTestResult {
  content: string;
  raw: unknown;
}

export interface JsonModeTestResult {
  json: Record<string, unknown>;
  raw: unknown;
}

export interface TextToSpeechTestResult {
  audioBuffer: Buffer;
  format: string;
  raw: unknown;
}

export interface SpeechToTextTestResult {
  text: string;
  raw: unknown;
}

export interface EmbeddingsTestResult {
  embeddings: number[][];
  raw: unknown;
}

export interface ImageGenerationTestResult {
  imageBuffer: Buffer;
  format: string;
  raw: unknown;
}

export interface ReasoningTestResult {
  response: string;
  hasCorrectAnswer?: boolean;
  raw: unknown;
}

export interface CodeInterpreterTestResult {
  response: string;
  hasCorrectResult?: boolean;
  raw: unknown;
}

// Tipos de modelo para o banco
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'deepinfra'
  | 'huggingface'
  | 'custom_http'
  | string; // extensível

export interface ModelRecord {
  id: string; // id interno da sua plataforma
  name: string; // nome amigável
  provider: ProviderId; // openai, anthropic, etc.
  providerModelId: string; // nome exatamente como o provedor espera
  capabilities: string[]; // suas capabilities (as 60+ que você listou)
  type: 'text' | 'vision' | 'audio' | 'image' | 'video' | 'router' | 'other';

  // Config vinda do discovery (baseUrl, rota, etc.)
  config: {
    baseUrl?: string;
    apiKeyRef?: string; // referência para buscar a key em secret store
    endpointOverrides?: Record<string, string>;
    extra?: Record<string, unknown>;
  };
}
