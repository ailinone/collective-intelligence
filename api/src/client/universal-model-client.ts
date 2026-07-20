// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  TextRequest,
  TextResponse,
  StreamChunk,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ImageGenRequest,
  ImageGenResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  VisionRequest,
  VisionResponse,
  ToolChatRequest,
  ToolChatResponse,
} from '@/types/model-client';

import type { ModelRecord } from '@/types/model-client';

/**
 * Interface Universal Model Client
 * Abstrai todas as diferenças entre provedores/modelos
 */
export interface UniversalModelClient {
  readonly model: ModelRecord;

  // Texto / chat
  text(req: TextRequest): Promise<TextResponse>;

  // Streaming de texto
  streamText(req: TextRequest): AsyncIterable<StreamChunk>;

  // Ferramentas / function calling / tool_use
  toolChat(req: ToolChatRequest): Promise<ToolChatResponse>;

  // JSON estruturado (json_mode, data_extraction, etc.)
  structuredJson<T = unknown>(req: TextRequest & { schema?: Record<string, unknown> }): Promise<{ json: T; raw: unknown }>;

  // Embeddings
  embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse>;

  // Visão / multimodal
  vision(req: VisionRequest): Promise<VisionResponse>;

  // Imagem
  imageGenerate(req: ImageGenRequest): Promise<ImageGenResponse>;

  // Áudio
  textToSpeech(req: AudioTTSRequest): Promise<AudioTTSResponse>;
  speechToText(req: AudioSTTRequest): Promise<AudioSTTResponse>;

  // Hooks genéricos se precisar coisas exóticas:
  rawInvoke(op: string, payload: Record<string, unknown>): Promise<unknown>;
}
