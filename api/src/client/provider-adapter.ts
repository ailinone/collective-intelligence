// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ModelRecord } from '@/types/model-client';
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
import type { ProviderRawResponse } from '@/types/provider-request-types';

/**
 * Interface do adapter de provider
 * Cada provedor implementa essa interface para mapear suas APIs para os tipos universais
 */
export interface ProviderAdapter {
  // Texto
  text(model: ModelRecord, req: TextRequest): Promise<TextResponse>;
  streamText(model: ModelRecord, req: TextRequest): AsyncIterable<StreamChunk>;

  // Ferramentas
  toolChat(model: ModelRecord, req: ToolChatRequest): Promise<ToolChatResponse>;

  // JSON mode
  structuredJson<T = unknown>(
    model: ModelRecord,
    req: TextRequest & { schema?: Record<string, unknown> }
  ): Promise<{ json: T; raw: ProviderRawResponse }>;

  // Embeddings
  embeddings(model: ModelRecord, req: EmbeddingsRequest): Promise<EmbeddingsResponse>;

  // Visão
  vision(model: ModelRecord, req: VisionRequest): Promise<VisionResponse>;

  // Imagem
  imageGenerate(model: ModelRecord, req: ImageGenRequest): Promise<ImageGenResponse>;

  // Áudio
  textToSpeech(model: ModelRecord, req: AudioTTSRequest): Promise<AudioTTSResponse>;
  speechToText(model: ModelRecord, req: AudioSTTRequest): Promise<AudioSTTResponse>;

  // Fallback genérico
  rawInvoke(model: ModelRecord, op: string, payload: Record<string, unknown>): Promise<unknown>;
}
