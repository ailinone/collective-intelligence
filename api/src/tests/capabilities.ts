// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Lista completa de capacidades suportadas para testes
 */
export type CapabilityId =
  // Texto & NLP clássico
  | 'text_generation'
  | 'completions'
  | 'chat'
  | 'qa'
  | 'translation'
  | 'summarization'
  | 'sentiment_analysis'
  | 'entity_recognition'
  | 'analysis'
  | 'query_generation'
  | 'data_extraction'
  | 'table_understanding'
  | 'schema_mapping'
  | 'knowledge_retrieval'

  // Raciocínio & Matemática
  | 'reasoning'
  | 'thinking_mode'
  | 'mathematical_problem_solving'
  | 'logic_&_inference'
  | 'temporal_reasoning'
  | 'causal_inference'
  | 'counterfactual_reasoning'
  | 'hypothesis_generation'
  | 'zero-shot_learning'
  | 'few-shot_learning'
  | 'reinforcement_learning'

  // Áudio & Fala
  | 'diarization'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'tts'
  | 'realtime_audio'
  | 'voice_cloning'
  | 'audio_generation'

  // Multimodal, Imagem, Vídeo, 3D, Motion
  | 'multimodal'
  | 'vision'
  | 'image_generation'
  | 'image_editing'
  | 'video_generation'
  | 'video_editing'
  | 'video_understanding'
  | 'lip_synchronization'
  | 'text_to_3d'
  | 'text_to_motion'
  | 'image_captioning'
  | 'visual_question_answering'

  // Código
  | 'code_generation'
  | 'code_review'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'testing'
  | 'code_interpreter'

  // Ferramentas, agentes e uso de recursos externos
  | 'function_calling'
  | 'tool_use'
  | 'streaming'
  | 'json_mode'
  | 'embeddings'
  | 'web_search'
  | 'file_search'
  | 'computer_use'
  | 'mcp'
  | 'deep_research'
  | 'agents'
  | 'action_planning'
  | 'self-correction';

/**
 * Resultado de teste de capacidade
 */
export interface CapabilityTestResult {
  success: boolean;
  score: number; // 0–1
  metadata?: Record<string, unknown>;
}

import type { ModelRecord } from '@/types/model-client';
import type { UniversalModelClient } from '@/client/universal-model-client';

/**
 * Contexto para execução de teste
 */
export interface CapabilityTestContext {
  model: ModelRecord;
  client: UniversalModelClient;
}

/**
 * Função de teste de capacidade
 */
export type CapabilityTester = (ctx: CapabilityTestContext) => Promise<CapabilityTestResult>;
