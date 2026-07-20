// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin Alias Resolver
 *
 * Resolves ailin_alias strings (e.g., 'ailin-ultra', 'ailin-budget') into
 * concrete request configuration overrides: strategy, quality_target, max_cost,
 * prefer_speed, ailin_constraints, etc.
 *
 * Aliases are NOT hardcoded model IDs — they define BEHAVIOR PROFILES that the
 * orchestration engine resolves dynamically based on available models and conditions.
 *
 * This follows the principle of "configuration over hardcoding" — aliases define
 * intent, the engine resolves to specific models/strategies at runtime.
 */

import type { ChatRequest, AilinRuntimeConstraints } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'alias-resolver' });

export interface AliasProfile {
  /** Human-readable description */
  description: string;
  /** Override strategy selection */
  strategy?: string;
  /** Quality target (0.0-1.0) */
  quality_target?: number;
  /** Maximum cost per request in USD */
  max_cost?: number;
  /** Prefer speed over quality */
  prefer_speed?: boolean;
  /** Number of models to use in collective strategies (overrides strategy default) */
  model_count?: number;
  /** Diversity mode: 'max-provider' (1 per provider), 'max-architecture' (diverse archs), 'any' (engine decides) */
  diversity_mode?: 'max-provider' | 'max-architecture' | 'any';
  /** Runtime constraints for model selection */
  ailin_constraints?: Partial<AilinRuntimeConstraints>;
}

/**
 * Built-in alias profiles.
 * These are NOT hardcoded models — they define behavior intent.
 * The orchestration engine resolves to specific models at runtime.
 *
 * Additional aliases can be loaded from DB via organization settings.
 */
const BUILT_IN_ALIASES: Record<string, AliasProfile> = {
  // ─── Performance Tiers ──────────────────────────────────────────
  'ailin-ultra': {
    description: 'Maximum quality — 9 diverse models with collaborative refinement from every major provider',
    strategy: 'collaborative',
    quality_target: 0.98,
    model_count: 9,
    diversity_mode: 'max-provider',
    ailin_constraints: { requiredCapabilities: ['chat', 'reasoning'] },
  },
  'ailin-max': {
    description: 'Absolute maximum — 9 models, swarm exploration + synthesis, no cost limit',
    strategy: 'swarm-explore',
    quality_target: 1.0,
    model_count: 9,
    diversity_mode: 'max-architecture',
  },
  'ailin-quality': {
    description: 'High quality — 3 diverse models with blind debate verification',
    strategy: 'blind-debate',
    quality_target: 0.90,
    model_count: 3,
    diversity_mode: 'max-provider',
  },
  'ailin-balanced': {
    description: 'Balanced quality and cost — adaptive engine decides',
    quality_target: 0.75,
    model_count: 3,
    diversity_mode: 'any',
  },
  'ailin-budget': {
    description: 'Minimize cost — cheapest single model with cost cascade',
    strategy: 'cost',
    quality_target: 0.50,
    max_cost: 0.005,
    model_count: 1,
    diversity_mode: 'any',
  },
  'ailin-nano': {
    description: 'Absolute minimum — smallest/cheapest single model',
    strategy: 'single',
    quality_target: 0.30,
    max_cost: 0.001,
    prefer_speed: true,
    model_count: 1,
    diversity_mode: 'any',
  },

  // ─── Speed Tiers ────────────────────────────────────────────────
  'ailin-fast': {
    description: 'Minimum latency — fastest available model',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.60,
  },
  'ailin-small': {
    description: 'Small model, fast response — good for simple tasks',
    strategy: 'single',
    prefer_speed: true,
    max_cost: 0.003,
  },

  // ─── Voice & Audio Profiles ─────────────────────────────────────
  'ailin-voice': {
    description: 'Best voice model — covers all TTS/STT/STS providers (cloud + self-hosted). API selects optimal model by latency, quality, and health.',
    strategy: 'speed',
    prefer_speed: true,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },
  'ailin-voice-quality': {
    description: 'Highest quality voice — prioritizes naturalness over speed',
    strategy: 'quality',
    quality_target: 0.95,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },
  'ailin-stt': {
    description: 'Best speech-to-text — fastest available STT model',
    strategy: 'speed',
    prefer_speed: true,
    ailin_constraints: { requiredCapabilities: ['speech_to_text'] },
  },
  'ailin-realtime': {
    description: 'Realtime voice pipeline — optimized for lowest latency STS (speech-to-speech)',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.70,
  },

  // ─── Realtime Audio Variants ────────────────────────────────────
  'ailin-realtime-mini': {
    description: 'Ultra-low latency realtime — smallest models for fastest response',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.40,
    max_cost: 0.001,
  },
  'ailin-realtime-small': {
    description: 'Low latency realtime — small models balancing speed and quality',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.60,
    max_cost: 0.005,
  },
  'ailin-realtime-large': {
    description: 'High quality realtime — larger models for better voice quality',
    strategy: 'quality',
    quality_target: 0.90,
  },

  // ─── STT (Speech-to-Text) Variants ────────────────────────────
  'ailin-stt-fast': {
    description: 'Fastest STT — optimized for real-time transcription (Deepgram/self-hosted)',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.50,
    ailin_constraints: { requiredCapabilities: ['speech_to_text'] },
  },
  'ailin-stt-quality': {
    description: 'Highest accuracy STT — uses best transcription model (Whisper large)',
    strategy: 'quality',
    quality_target: 0.95,
    ailin_constraints: { requiredCapabilities: ['speech_to_text'] },
  },

  // ─── TTS (Text-to-Speech) Variants ────────────────────────────
  'ailin-tts': {
    description: 'Default TTS — balanced speed and quality',
    strategy: 'speed',
    prefer_speed: true,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },
  'ailin-tts-fast': {
    description: 'Fastest TTS — lowest latency voice synthesis (self-hosted/Cartesia)',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.50,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },
  'ailin-tts-quality': {
    description: 'Highest quality TTS — natural voice (ElevenLabs/Cartesia)',
    strategy: 'quality',
    quality_target: 0.95,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },
  'ailin-tts-multilingual': {
    description: 'Multilingual TTS — best for non-English languages (CosyVoice2/ElevenLabs)',
    strategy: 'quality',
    quality_target: 0.85,
    ailin_constraints: { requiredCapabilities: ['text_to_speech'] },
  },

  // ─── Audio (General) Variants ─────────────────────────────────
  'ailin-audio': {
    description: 'Default audio processing — auto-selects STT, TTS, or STS based on request',
    strategy: 'speed',
    prefer_speed: true,
    ailin_constraints: { requiredCapabilities: ['audio'] },
  },
  'ailin-audio-quality': {
    description: 'High quality audio — best models for speech processing',
    strategy: 'quality',
    quality_target: 0.90,
    ailin_constraints: { requiredCapabilities: ['audio'] },
  },

  // ─── Translation Variants ─────────────────────────────────────
  'ailin-translation': {
    description: 'Default translation — CTranslate2 int8 NLLB (<200ms), LLM fallback',
    strategy: 'speed',
    prefer_speed: true,
    ailin_constraints: { requiredCapabilities: ['translation'] },
  },
  'ailin-translation-fast': {
    description: 'Fastest translation — CTranslate2 int8 NLLB-200 (~130ms per sentence)',
    strategy: 'speed',
    prefer_speed: true,
    quality_target: 0.60,
    ailin_constraints: { requiredCapabilities: ['translation'] },
  },
  'ailin-translation-quality': {
    description: 'Highest quality translation — LLM-based for nuanced context',
    strategy: 'quality',
    quality_target: 0.95,
    ailin_constraints: { requiredCapabilities: ['translation'] },
  },

  // ─── Capability Profiles ────────────────────────────────────────
  'ailin-reasoning': {
    description: 'Deep reasoning — models with thinking/reasoning capabilities',
    quality_target: 0.95,
    ailin_constraints: { requiredCapabilities: ['chat', 'reasoning', 'thinking_mode'] },
  },
  'ailin-expert': {
    description: 'Expert panel — 5 specialists from diverse providers collaborate',
    strategy: 'expert-panel',
    quality_target: 0.90,
    model_count: 5,
    diversity_mode: 'max-provider',
  },
  'ailin-creative': {
    description: 'Creative tasks — 5 diverse models for maximum perspective diversity',
    strategy: 'diversity-ensemble',
    quality_target: 0.80,
    model_count: 5,
    diversity_mode: 'max-architecture',
  },
  'ailin-logic': {
    description: 'Logical/mathematical — 5 reasoning models with cross-verification',
    strategy: 'blind-debate',
    quality_target: 0.95,
    model_count: 5,
    diversity_mode: 'max-provider',
    ailin_constraints: { requiredCapabilities: ['chat', 'reasoning'] },
  },

  // ─── Strategy Profiles ──────────────────────────────────────────
  'ailin-tier1': {
    description: 'Force Tier 1 models only — premium providers',
    quality_target: 0.95,
    ailin_constraints: {
      preferredProviders: ['openai', 'anthropic', 'google', 'xai'],
    },
  },
  'ailin-collective': {
    description: 'Force collective intelligence — multi-model consensus',
    strategy: 'consensus',
    quality_target: 0.85,
  },
  'ailin-debate': {
    description: 'Structured debate between models',
    strategy: 'debate',
    quality_target: 0.85,
  },
  'ailin-blind-debate': {
    description: 'Independent parallel responses + adjudicator (anti-cascade)',
    strategy: 'blind-debate',
    quality_target: 0.85,
  },
  'ailin-devil': {
    description: "Devil's advocate consensus — forced dissent for critical analysis",
    strategy: 'devil-advocate-consensus',
    quality_target: 0.90,
  },
  'ailin-safety': {
    description: 'Safety quorum — majority vote for safety-critical tasks',
    strategy: 'safety-quorum',
    quality_target: 0.80,
  },
  'ailin-swarm': {
    description: 'Multi-angle exploration — 9 models explore different perspectives in parallel',
    strategy: 'swarm-explore',
    quality_target: 0.85,
    model_count: 9,
    diversity_mode: 'max-architecture',
  },
  'ailin-agent': {
    description: 'Autonomous agent — plans and executes multi-step workflows with tools',
    strategy: 'agentic',
    quality_target: 0.85,
    model_count: 2,
    ailin_constraints: { requiredCapabilities: ['chat', 'reasoning'] },
  },
  'ailin-pipeline': {
    description: 'Strategy pipeline — compose strategies sequentially (e.g., debate then collaborative)',
    strategy: 'compositor',
    quality_target: 0.85,
    model_count: 5,
    diversity_mode: 'max-provider',
  },
  'ailin-compositor': {
    description: 'Strategy compositor — compose multiple strategies as pipeline, parallel, or DAG',
    strategy: 'compositor',
    quality_target: 0.85,
    model_count: 5,
    diversity_mode: 'max-provider',
  },
  'ailin-workflow': {
    description: 'Strategy workflow — DAG of sub-strategies with explicit dependencies',
    strategy: 'compositor',
    quality_target: 0.90,
    model_count: 7,
    diversity_mode: 'max-provider',
  },
  'ailin-research': {
    description: 'Deep research — parallel investigation with evidence ranking and confidence-based synthesis',
    strategy: 'research-synthesize',
    quality_target: 0.95,
    model_count: 7,
    diversity_mode: 'max-provider',
  },
  'ailin-review': {
    description: 'Thorough review — 9 reviewers independently check for errors (Lei de Linus)',
    strategy: 'blind-debate',
    quality_target: 0.95,
    model_count: 9,
    diversity_mode: 'max-provider',
  },
  'ailin-consensus-large': {
    description: 'Large consensus — 9 models vote for maximum majority-vote accuracy',
    strategy: 'consensus',
    quality_target: 0.90,
    model_count: 9,
    diversity_mode: 'max-architecture',
  },

  // ─── New P0/P1 Strategy Aliases ──────────────────────────────────
  'ailin-clarify': {
    description: 'Clarification-first — assesses ambiguity and asks questions before answering',
    strategy: 'clarification-first',
    quality_target: 0.85,
    model_count: 3,
  },
  'ailin-deep-research': {
    description: 'Deep research — parallel investigation with evidence ranking and confidence synthesis',
    strategy: 'research-synthesize',
    quality_target: 0.90,
    model_count: 5,
    diversity_mode: 'max-provider',
  },
  'ailin-quality-max': {
    description: 'Maximum quality — adaptive critique-repair loop until quality target met',
    strategy: 'critique-repair',
    quality_target: 0.95,
    model_count: 3,
    ailin_constraints: { enable_reasoning: true },
  },
  'ailin-diamond': {
    description: 'Double Diamond — structured discover→define→develop→deliver for complex problems',
    strategy: 'double-diamond',
    quality_target: 0.90,
    model_count: 5,
    diversity_mode: 'max-provider',
    ailin_constraints: { enable_reasoning: true, enable_observer: true },
  },
  'ailin-multi-hop': {
    description: 'Multi-hop reasoning — decomposes questions into sub-questions with dependency chain',
    strategy: 'multi-hop-qa',
    quality_target: 0.90,
    model_count: 3,
    ailin_constraints: { enable_reasoning: true },
  },
  'ailin-personas': {
    description: 'Persona exploration — 12+ diverse perspectives (CTO, auditor, economist, designer...)',
    strategy: 'persona-exploration',
    quality_target: 0.85,
    model_count: 4,
    diversity_mode: 'max-provider',
  },
};

/**
 * Resolve an ailin_alias to configuration overrides.
 * Returns null if alias is not recognized (no override applied).
 */
export function resolveAilinAlias(alias: string | undefined): AliasProfile | null {
  if (!alias) return null;

  const normalized = alias.trim().toLowerCase();
  const profile = BUILT_IN_ALIASES[normalized];

  if (profile) {
    log.debug({ alias: normalized, profile: profile.description }, 'Resolved ailin alias');
    return profile;
  }

  log.debug({ alias: normalized }, 'Unknown ailin alias — no override applied');
  return null;
}

/**
 * Apply alias profile overrides to a ChatRequest.
 * Only overrides fields that the alias specifies — preserves explicit user settings.
 */
export function applyAliasToRequest(request: ChatRequest, profile: AliasProfile): ChatRequest {
  return {
    ...request,
    strategy: request.strategy ?? (profile.strategy as ChatRequest['strategy']) ?? request.strategy,
    quality_target: request.quality_target ?? profile.quality_target,
    max_cost: request.max_cost ?? profile.max_cost,
    prefer_speed: request.prefer_speed ?? profile.prefer_speed,
    ailin_constraints: request.ailin_constraints ?? profile.ailin_constraints as ChatRequest['ailin_constraints'],
  };
}

/**
 * Get all available aliases for documentation/listing.
 */
export function listAliases(): Record<string, { description: string; strategy?: string; quality_target?: number }> {
  const result: Record<string, { description: string; strategy?: string; quality_target?: number }> = {};
  for (const [key, profile] of Object.entries(BUILT_IN_ALIASES)) {
    result[key] = {
      description: profile.description,
      strategy: profile.strategy,
      quality_target: profile.quality_target,
    };
  }
  return result;
}
