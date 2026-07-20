// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Legacy model fixture — pure data for MVP 2 tests.
 *
 * 30 deterministic snapshots covering:
 *   - active / inactive / deprecated status
 *   - same modelId across different providers
 *   - same provider with multiple models
 *   - capabilityUris-only / legacy capabilities-only / no capabilities
 *   - varied costs and contextWindow
 *   - lifecycleStatus preview / current / deprecated
 *   - local/self-hosted simulated (providerId='ollama')
 *   - aggregator simulated (providerId='aihubmix', 'openrouter')
 *
 * All timestamps frozen — fixture is identity-stable across reruns.
 */

import type { LegacyModelSnapshot } from '../../legacy-model-snapshot';

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-03-15T12:00:00Z';
const T2 = '2026-05-10T00:00:00Z';

/**
 * The fixture array. Order is intentional: tests assert that the
 * registry preserves THIS order verbatim.
 */
export const LEGACY_MODELS_FIXTURE: ReadonlyArray<LegacyModelSnapshot> = Object.freeze([
  // 1 — Anthropic native, current, full capabilities (URI)
  {
    id: 'claude-opus-4-7',
    uid: 'uid-anthropic-claude-opus-4-7',
    providerId: 'anthropic',
    status: 'active',
    name: 'Claude Opus 4.7',
    displayName: 'Claude Opus 4.7',
    capabilityUris: ['chat', 'tools', 'json_mode', 'streaming', 'vision'],
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
    lastSyncedAt: T2,
  },

  // 2 — Anthropic native, deprecated previous-gen
  {
    id: 'claude-3-5-sonnet-20240620',
    providerId: 'anthropic',
    status: 'deprecated',
    capabilityUris: ['chat', 'tools'],
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    lifecycleStatus: 'deprecated',
    createdAt: T0,
    updatedAt: T1,
  },

  // 3 — OpenAI native, current, json/tools/vision
  {
    id: 'gpt-5.5-pro',
    providerId: 'openai',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode', 'vision', 'streaming'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.020,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
    lastSyncedAt: T2,
  },

  // 4 — OpenAI native, preview reasoning
  {
    id: 'o3-mini-preview',
    providerId: 'openai',
    status: 'active',
    capabilityUris: ['chat', 'reasoning'],
    contextWindow: 200_000,
    maxOutputTokens: 65_536,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.012,
    lifecycleStatus: 'preview',
    createdAt: T1,
    updatedAt: T2,
  },

  // 5 — Google Gemini native
  {
    id: 'gemini-2.5-pro',
    providerId: 'google',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'vision', 'audio_generation'],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 6 — aihubmix aggregator serving same OpenAI model (different cost)
  {
    id: 'openai/gpt-5.5-pro',
    providerId: 'aihubmix',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode', 'vision', 'streaming'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1k: 0.00575, // typical hub markup
    outputCostPer1k: 0.023,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 7 — openrouter aggregator serving Anthropic model
  {
    id: 'anthropic/claude-opus-4-7',
    providerId: 'openrouter',
    status: 'active',
    capabilities: ['chat', 'tools'], // legacy JSON column form
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.01725,
    outputCostPer1k: 0.0863,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 8 — Mistral native
  {
    id: 'mistral-large-2',
    providerId: 'mistral',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode'],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.006,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 9 — Mistral magistral-medium (reasoning variant)
  {
    id: 'magistral-medium',
    providerId: 'mistral',
    status: 'active',
    capabilityUris: ['chat', 'reasoning'],
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.005,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 10 — DeepSeek native
  {
    id: 'deepseek-v4',
    providerId: 'deepseek',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode'],
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00027,
    outputCostPer1k: 0.0011,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 11 — DeepSeek R1 reasoning
  {
    id: 'deepseek-r1',
    providerId: 'deepseek',
    status: 'active',
    capabilityUris: ['chat', 'reasoning'],
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00055,
    outputCostPer1k: 0.0022,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 12 — xAI native (legacy capabilities JSON form)
  {
    id: 'grok-4',
    providerId: 'xai',
    status: 'active',
    capabilities: ['chat', 'tools'],
    contextWindow: 131_072,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 13 — Moonshot Kimi (latest)
  {
    id: 'kimi-k2.6',
    providerId: 'moonshot',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'vision'],
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.003,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 14 — Moonshot Kimi PRIOR generation (still active, less fresh)
  {
    id: 'kimi-k2-0905-preview',
    providerId: 'moonshot',
    status: 'active',
    capabilityUris: ['chat', 'tools'],
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.0024,
    lifecycleStatus: 'preview',
    createdAt: T0,
    updatedAt: T1,
  },

  // 15 — Cohere command-a
  {
    id: 'command-a',
    providerId: 'cohere',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode'],
    contextWindow: 256_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 16 — Groq fast inference of llama
  {
    id: 'llama-3.3-70b-versatile',
    providerId: 'groq',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'streaming'],
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00059,
    outputCostPer1k: 0.00079,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 17 — Fireworks serving same llama (different shape)
  {
    id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    providerId: 'fireworks',
    status: 'active',
    capabilityUris: ['chat', 'tools'],
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.0009,
    outputCostPer1k: 0.0009,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 18 — Ollama local llama
  {
    id: 'llama-3.3-70b',
    providerId: 'ollama',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'streaming'],
    contextWindow: 131_072,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 19 — Ollama local mistral
  {
    id: 'mistral-small-3',
    providerId: 'ollama',
    status: 'active',
    capabilityUris: ['chat'],
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 20 — Ollama local qwen vision
  {
    id: 'qwen-2.5-vl-7b',
    providerId: 'ollama',
    status: 'active',
    capabilityUris: ['chat', 'vision'],
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 21 — vllm self-hosted
  {
    id: 'qwen-3-72b',
    providerId: 'vllm',
    status: 'active',
    capabilityUris: ['chat', 'tools'],
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 22 — Inactive model (kept in DB but disabled)
  {
    id: 'gpt-4-0314',
    providerId: 'openai',
    status: 'inactive',
    capabilityUris: ['chat'],
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.03,
    outputCostPer1k: 0.06,
    lifecycleStatus: 'deprecated',
    createdAt: T0,
    updatedAt: T0,
  },

  // 23 — Model with NO capabilities declared
  {
    id: 'unknown-experimental-x',
    providerId: 'experimental-lab',
    status: 'active',
    // no capabilityUris, no capabilities
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: null,
    outputCostPer1k: null,
    lifecycleStatus: 'preview',
    createdAt: T2,
    updatedAt: T2,
  },

  // 24 — Capabilities as a record (legacy alt shape)
  {
    id: 'mixtral-8x22b',
    providerId: 'mistral',
    status: 'active',
    capabilities: { chat: true, tools: true, vision: false, streaming: true },
    contextWindow: 65_536,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.0024,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T1,
  },

  // 25 — High context premium
  {
    id: 'gemini-2.5-pro-1m',
    providerId: 'google',
    status: 'active',
    capabilityUris: ['chat', 'vision'],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.0035,
    outputCostPer1k: 0.014,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 26 — Embeddings-only model (no chat) — included to test no-filter
  {
    id: 'embed-large-v3',
    providerId: 'cohere',
    status: 'active',
    capabilityUris: ['embedding'],
    contextWindow: 8192,
    maxOutputTokens: 0,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 27 — Image-gen model
  {
    id: 'flux-pro-1.1',
    providerId: 'replicate',
    status: 'active',
    capabilityUris: ['image_generation'],
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0.04,
    outputCostPer1k: 0,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 28 — cometapi serving anthropic
  {
    id: 'anthropic/claude-3-5-sonnet',
    providerId: 'cometapi',
    status: 'active',
    capabilityUris: ['chat', 'tools'],
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0035,
    outputCostPer1k: 0.0175,
    lifecycleStatus: 'current',
    createdAt: T1,
    updatedAt: T2,
  },

  // 29 — Azure deployment-distinct offering
  {
    id: 'gpt-4o',
    uid: 'uid-azure-openai-prod-chat-gpt-4o',
    providerId: 'azure-openai-prod-chat',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode', 'streaming', 'vision'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },

  // 30 — Azure SECOND deployment of the same logical model — pricing
  // and identity must remain DISTINCT from #29
  {
    id: 'gpt-4o',
    uid: 'uid-azure-openai-prod-fallback-gpt-4o',
    providerId: 'azure-openai-prod-fallback',
    status: 'active',
    capabilityUris: ['chat', 'tools', 'json_mode', 'streaming', 'vision'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    // Different deployment can have different SKU/pricing
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.0075,
    lifecycleStatus: 'current',
    createdAt: T0,
    updatedAt: T2,
  },
] as const);

/**
 * Builds the `routeKindByProvider` map matching the fixture above.
 * Exposed so tests can express provider-tier classification without
 * hardcoding lists inside the builder.
 */
export const FIXTURE_ROUTE_KIND_BY_PROVIDER: Readonly<Record<string, 'native' | 'aggregator' | 'gateway' | 'edge' | 'local' | 'self_hosted'>> = Object.freeze({
  // Aggregators / hubs
  aihubmix: 'aggregator',
  openrouter: 'aggregator',
  cometapi: 'aggregator',
  // Local / self-hosted
  ollama: 'local',
  vllm: 'self_hosted',
  // Everything else defaults to 'native' inside the builder.
});
