// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ModelRecord } from '@/types/model-client';
import type { UniversalModelClient } from '@/client/universal-model-client';

export type CapabilityId =
  | 'text_generation'
  | 'completions'
  | 'chat'
  | 'qa'
  | 'translation'
  | 'summarization'
  | 'sentiment_analysis'
  | 'entity_recognition'
  | 'analysis'
  | 'mathematical_problem_solving'
  | 'logic_&_inference'
  | 'temporal_reasoning'
  | 'causal_inference'
  | 'counterfactual_reasoning'
  | 'hypothesis_generation'
  | 'zero-shot_learning'
  | 'few-shot_learning'
  | 'reinforcement_learning'
  | 'diarization'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'tts'
  | 'realtime_audio'
  | 'voice_cloning'
  | 'audio_generation'
  | 'multimodal'
  | 'vision'
  | 'image_generation'
  | 'image_editing'
  | 'video_generation'
  | 'video_editing'
  | 'text_to_3d'
  | 'text_to_motion'
  | 'video_understanding'
  | 'image_captioning'
  | 'visual_question_answering'
  | 'lip_synchronization'
  | 'reasoning'
  | 'thinking_mode'
  | 'code_generation'
  | 'code_review'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'testing'
  | 'code_interpreter'
  | 'query_generation'
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
  | 'self-correction'
  | 'data_extraction'
  | 'table_understanding'
  | 'schema_mapping'
  | 'knowledge_retrieval'

  // pseudo-capacities por role
  | 'backend_suite'
  | 'frontend_suite'
  | 'data_science_suite';

export interface CapabilityTestResult {
  success: boolean;

  score: number; // 0–1

  metadata?: Record<string, unknown>;
}

export interface CapabilityTestContext {
  model: ModelRecord;

  client: UniversalModelClient;

  // opcional: logger ou trace

  logger?: {
    debug: (meta: Record<string, unknown>, msg: string) => void;
    info: (meta: Record<string, unknown>, msg: string) => void;
    warn: (meta: Record<string, unknown>, msg: string) => void;
    error: (meta: Record<string, unknown>, msg: string) => void;
  };
}

export type CapabilityTester = (ctx: CapabilityTestContext) => Promise<CapabilityTestResult>;
