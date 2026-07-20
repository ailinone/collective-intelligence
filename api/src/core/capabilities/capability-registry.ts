// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ModelCapability } from '@/types';
import { MODEL_CAPABILITIES, isModelCapability } from '@/types';

export type CapabilityExecutionMode =
  | 'proxy_route'
  | 'orchestration'
  | 'native_adapter'
  | 'tool_pipeline'
  | 'sandbox_workflow';

export interface CapabilityExecutionPlan {
  id: ModelCapability;
  aliases: string[];
  modelCapabilities: ModelCapability[];
  supportsExecute: boolean;
  supportsStream: boolean;
  maturity: 'stable' | 'beta' | 'preview';
  executionPath: CapabilityExecutionMode[];
  requiredCapabilities: ModelCapability[];
  dependencies: string[];
}

type CapabilityPlanOverride = Partial<Omit<CapabilityExecutionPlan, 'id'>>;

const STREAM_CAPABILITIES = new Set<ModelCapability>([
  'chat',
  'streaming',
  'completions',
  'text_generation',
  'reasoning',
  'realtime',
  'realtime_audio',
  'audio_to_audio',
]);

const PREVIEW_CAPABILITIES = new Set<ModelCapability>([
  'video_generation',
  'video_editing',
  'video_understanding',
  'video_to_video',
  'video_to_text',
  'video_transcription',
  'image_to_video',
  'deep_compute',
]);

const BETA_CAPABILITIES = new Set<ModelCapability>([
  'code_generation',
  'code_completion',
  'coding',
  'code_review',
  'debugging',
  'refactoring',
  'testing',
  'code_interpreter',
  'computer_use',
  'mcp',
  'agents',
  'function_calling',
  'tool_use',
  'pdf_understanding',
]);

const DEFAULT_DEPENDENCIES = ['provider_registry', 'model_catalog', 'tenant_policy'];

const CAPABILITY_OVERRIDES: Partial<Record<ModelCapability, CapabilityPlanOverride>> = {
  chat: {
    aliases: ['responses'],
    executionPath: ['proxy_route', 'orchestration'],
    dependencies: ['chat_completions_route', ...DEFAULT_DEPENDENCIES],
  },
  text_generation: {
    aliases: ['generation', 'translation', 'summarization'],
    executionPath: ['orchestration', 'proxy_route'],
  },
  completions: {
    aliases: ['completion'],
    executionPath: ['proxy_route', 'orchestration'],
  },
  embeddings: {
    aliases: ['embedding'],
    executionPath: ['proxy_route', 'native_adapter', 'orchestration'],
    dependencies: ['embeddings_route', ...DEFAULT_DEPENDENCIES],
  },
  speech_to_text: {
    aliases: ['stt'],
    executionPath: ['native_adapter', 'orchestration'],
    dependencies: ['audio_transcriptions_route', ...DEFAULT_DEPENDENCIES],
  },
  transcription: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['speech_to_text'],
  },
  audio_input: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['speech_to_text'],
  },
  listen: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['speech_to_text'],
  },
  text_to_speech: {
    aliases: ['speech_synthesis'],
    executionPath: ['native_adapter', 'orchestration'],
    dependencies: ['audio_speech_route', ...DEFAULT_DEPENDENCIES],
  },
  tts: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['text_to_speech'],
  },
  audio_generation: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['text_to_speech'],
  },
  web_search: {
    aliases: ['search', 'grounding_extract'],
    executionPath: ['tool_pipeline', 'native_adapter', 'orchestration'],
    dependencies: ['search_route', ...DEFAULT_DEPENDENCIES],
  },
  deep_search: {
    executionPath: ['tool_pipeline', 'native_adapter', 'orchestration'],
    requiredCapabilities: ['web_search'],
  },
  deep_research: {
    aliases: ['research'],
    executionPath: ['tool_pipeline', 'native_adapter', 'orchestration'],
    requiredCapabilities: ['web_search'],
  },
  file_search: {
    executionPath: ['tool_pipeline', 'orchestration'],
    dependencies: ['vector_store_or_file_index', ...DEFAULT_DEPENDENCIES],
  },
  image_generation: {
    aliases: ['images', 'image', 'image_variation'],
    executionPath: ['native_adapter', 'orchestration'],
    dependencies: ['images_generation_route', ...DEFAULT_DEPENDENCIES],
  },
  image_editing: {
    aliases: ['image_edit'],
    executionPath: ['native_adapter', 'orchestration'],
    dependencies: ['images_edits_route', ...DEFAULT_DEPENDENCIES],
  },
  video_generation: {
    executionPath: ['native_adapter'],
    dependencies: ['videos_generation_route', ...DEFAULT_DEPENDENCIES],
  },
  image_to_video: {
    executionPath: ['native_adapter'],
    dependencies: ['videos_generation_route', ...DEFAULT_DEPENDENCIES],
  },
  video_to_video: {
    executionPath: ['native_adapter'],
    dependencies: ['videos_generation_route', ...DEFAULT_DEPENDENCIES],
  },
  video_editing: {
    executionPath: ['native_adapter'],
    dependencies: ['videos_generation_route', ...DEFAULT_DEPENDENCIES],
  },
  vision: {
    executionPath: ['native_adapter', 'orchestration'],
  },
  multimodal: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['vision', 'text_generation'],
  },
  image_captioning: {
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['vision'],
  },
  visual_question_answering: {
    aliases: ['vqa'],
    executionPath: ['native_adapter', 'orchestration'],
    requiredCapabilities: ['vision', 'reasoning'],
  },
  code_generation: {
    aliases: ['code', 'codegen'],
    executionPath: ['sandbox_workflow', 'orchestration'],
    dependencies: ['sandbox_runtime', ...DEFAULT_DEPENDENCIES],
  },
  code_completion: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['code_generation'],
  },
  coding: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['code_generation'],
  },
  code_review: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['analysis', 'code_generation'],
  },
  debugging: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['analysis', 'code_generation'],
  },
  refactoring: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['code_generation', 'analysis'],
  },
  testing: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    requiredCapabilities: ['code_generation'],
  },
  code_interpreter: {
    executionPath: ['sandbox_workflow', 'orchestration'],
    dependencies: ['sandbox_runtime', ...DEFAULT_DEPENDENCIES],
  },
  computer_use: {
    executionPath: ['sandbox_workflow', 'tool_pipeline', 'orchestration'],
    dependencies: ['sandbox_runtime', 'browser_automation', ...DEFAULT_DEPENDENCIES],
  },
  mcp: {
    executionPath: ['tool_pipeline', 'orchestration'],
    dependencies: ['mcp_runtime', ...DEFAULT_DEPENDENCIES],
  },
  agents: {
    executionPath: ['tool_pipeline', 'orchestration'],
  },
  reasoning: {
    executionPath: ['orchestration', 'proxy_route'],
  },
  analysis: {
    aliases: ['moderation', 'sentiment', 'entity_extraction'],
    executionPath: ['orchestration', 'proxy_route'],
  },
  realtime: {
    supportsExecute: false,
    supportsStream: true,
    executionPath: ['proxy_route'],
    dependencies: ['realtime_ws', ...DEFAULT_DEPENDENCIES],
  },
  realtime_audio: {
    supportsExecute: false,
    supportsStream: true,
    executionPath: ['proxy_route'],
    requiredCapabilities: ['realtime'],
    dependencies: ['realtime_ws', ...DEFAULT_DEPENDENCIES],
  },
  audio_to_audio: {
    supportsExecute: false,
    supportsStream: true,
    executionPath: ['proxy_route'],
    requiredCapabilities: ['realtime_audio'],
    dependencies: ['realtime_ws', ...DEFAULT_DEPENDENCIES],
  },
  health: {
    executionPath: ['orchestration'],
    dependencies: ['provider_registry', 'model_operability'],
  },
};

const LEGACY_ALIAS_TO_CANONICAL: Record<string, ModelCapability> = {
  search: 'web_search',
  grounding_extract: 'web_search',
  moderation: 'analysis',
  video: 'video_generation',
  videos: 'video_generation',
  video_gen: 'video_generation',
  video_create: 'video_generation',
  video_edit: 'video_editing',
  image2video: 'image_to_video',
  text2video: 'video_generation',
  image_variation: 'image_generation',
  audio_translation: 'speech_to_text',
  audio_to_text: 'speech_to_text',
  translation: 'text_generation',
  summarization: 'text_generation',
  action_planning: 'agents',
  self_correction: 'reasoning',
  self_correction_loop: 'reasoning',
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of values) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeInput(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]/g, '_');
}

function defaultExecutionPath(capability: ModelCapability): CapabilityExecutionMode[] {
  if (
    capability.startsWith('code_') ||
    capability === 'coding' ||
    capability === 'debugging' ||
    capability === 'refactoring' ||
    capability === 'testing'
  ) {
    return ['sandbox_workflow', 'orchestration'];
  }

  if (
    capability.includes('search') ||
    capability === 'deep_research' ||
    capability === 'research' ||
    capability === 'mcp' ||
    capability === 'agents' ||
    capability === 'computer_use'
  ) {
    return ['tool_pipeline', 'orchestration'];
  }

  if (
    capability.includes('audio') ||
    capability.includes('speech') ||
    capability.includes('image') ||
    capability.includes('video') ||
    capability === 'vision' ||
    capability === 'multimodal'
  ) {
    return ['native_adapter', 'orchestration'];
  }

  return ['orchestration'];
}

function defaultMaturity(capability: ModelCapability): 'stable' | 'beta' | 'preview' {
  if (PREVIEW_CAPABILITIES.has(capability)) return 'preview';
  if (BETA_CAPABILITIES.has(capability)) return 'beta';
  return 'stable';
}

const CAPABILITY_DEFINITIONS: CapabilityExecutionPlan[] = MODEL_CAPABILITIES.map((capability) => {
  const override = CAPABILITY_OVERRIDES[capability] ?? {};
  const aliases = uniqueStrings([capability, ...(override.aliases ?? [])]);
  const executionPath = override.executionPath ?? defaultExecutionPath(capability);
  const requiredCapabilities = override.requiredCapabilities ?? [capability];

  return {
    id: capability,
    aliases,
    modelCapabilities: override.modelCapabilities ?? [capability],
    supportsExecute: override.supportsExecute ?? true,
    supportsStream: override.supportsStream ?? STREAM_CAPABILITIES.has(capability),
    maturity: override.maturity ?? defaultMaturity(capability),
    executionPath,
    requiredCapabilities,
    dependencies: override.dependencies ?? DEFAULT_DEPENDENCIES,
  };
});

const CAPABILITY_BY_ID = new Map<ModelCapability, CapabilityExecutionPlan>();
const CAPABILITY_BY_ALIAS = new Map<string, CapabilityExecutionPlan>();
for (const definition of CAPABILITY_DEFINITIONS) {
  CAPABILITY_BY_ID.set(definition.id, definition);
  CAPABILITY_BY_ALIAS.set(definition.id, definition);
  for (const alias of definition.aliases) {
    CAPABILITY_BY_ALIAS.set(alias, definition);
  }
}

for (const [legacyAlias, canonical] of Object.entries(LEGACY_ALIAS_TO_CANONICAL)) {
  const definition = CAPABILITY_BY_ID.get(canonical);
  if (definition) {
    CAPABILITY_BY_ALIAS.set(normalizeInput(legacyAlias), definition);
  }
}

export type CapabilityDefinition = CapabilityExecutionPlan;

export function normalizeCapabilityName(value: string): string {
  const normalized = normalizeInput(value);
  const definition = CAPABILITY_BY_ALIAS.get(normalized);
  if (definition) return definition.id;
  if (isModelCapability(normalized)) return normalized;
  const legacyTarget = LEGACY_ALIAS_TO_CANONICAL[normalized];
  return legacyTarget ?? normalized;
}

export function getCapabilityDefinition(value: string): CapabilityExecutionPlan | undefined {
  const normalized = normalizeInput(value);
  return CAPABILITY_BY_ALIAS.get(normalized);
}

export function getCapabilityExecutionPlan(value: string): CapabilityExecutionPlan | undefined {
  return getCapabilityDefinition(value);
}

export function listCapabilityDefinitions(): CapabilityExecutionPlan[] {
  return CAPABILITY_DEFINITIONS;
}

export function getModelCapabilitiesForCapability(value: string): ModelCapability[] {
  const definition = getCapabilityDefinition(value);
  if (definition) {
    return definition.modelCapabilities;
  }

  const normalized = normalizeInput(value);
  if (isModelCapability(normalized)) {
    return [normalized];
  }

  const legacyTarget = LEGACY_ALIAS_TO_CANONICAL[normalized];
  return legacyTarget ? [legacyTarget] : [];
}
