// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Branding Utilities
 * Handles model name obfuscation and metadata filtering
 */

import type { ChatResponse, AilinMetadata } from '@/types';
import { brandingConfig } from '@/config';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'branding' });

export interface BrandingOptions {
  /**
   * The model id the client explicitly pinned on this request. Undefined for
   * auto/alias/strategy requests (see getPinnedModelId).
   */
  explicitModel?: string;
}

/**
 * Both sides are compared as their full trimmed id AND their last '/'
 * segment: a catalog id like "openai/gpt-4o" (or "@cf/meta/llama-…") may be
 * executed and echoed back under the provider-stripped form, and vice versa.
 * Only an exact id/name match preserves identity — anything else keeps the
 * current branding (fail-closed).
 */
function modelRefVariants(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return [];
  const last = trimmed.split('/').pop() ?? trimmed;
  return last && last !== trimmed ? [trimmed, last] : [trimmed];
}

function responseExecutedExplicitModel(response: ChatResponse, explicitModel: string): boolean {
  const requested = modelRefVariants(explicitModel);
  if (requested.length === 0) return false;
  const metadata = response.ailin_metadata;
  const executed = [
    response.model,
    metadata && !('type' in metadata) ? metadata.resolved_model : undefined,
    metadata && !('type' in metadata) ? metadata.final_decider_model_id : undefined,
    metadata && !('type' in metadata) ? metadata.final_decider_model_name : undefined,
  ];
  return executed.some((executedRef) => {
    const variants = modelRefVariants(executedRef);
    return variants.length > 0 && variants.some((v) => requested.includes(v));
  });
}

/**
 * Apply branding to chat response
 *
 * This function:
 * 1. Replaces actual model names with "Ailin¹" (if configured)
 * 2. Hides detailed metadata (if configured)
 * 3. Preserves internal tracking for analytics
 *
 * @param response - Original chat response
 * @param options - When `explicitModel` is set to the model the client
 *   explicitly pinned on this request (see getPinnedModelId) and the response
 *   was executed by that exact model, branding is SKIPPED: the user named the
 *   model themselves, so redacting its identity would only obscure their own
 *   choice. Strategy/alias/auto requests never match here — their requested
 *   id is not a catalog model id, so the executed model is always a different
 *   (delegated) one and stays branded. A pin that FAILED OVER to another
 *   model also stays branded: the user did not get what they asked for.
 * @returns Branded response
 */
export function applyBranding(response: ChatResponse, options?: BrandingOptions): ChatResponse {
  if (options?.explicitModel && responseExecutedExplicitModel(response, options.explicitModel)) {
    // Identity of the pinned model stays, but the defensive passthrough-strip
    // below still applies: a pinned request can hit a provider that passes
    // its raw upstream JSON through, and system_fingerprint leaked verbatim
    // through exactly this class of hole before (see the P1-3 comment).
    // Copied (not mutated in place) so both paths have the same
    // returns-a-new-object contract.
    const preserved = { ...response };
    if (brandingConfig.hideModels) {
      delete (preserved as Record<string, unknown>).system_fingerprint;
    }
    return preserved;
  }

  const branded = { ...response };

  // Replace model name with brand name
  if (brandingConfig.hideModels) {
    branded.model = brandingConfig.brandName;

    // `system_fingerprint` isn't in the ChatResponse type (no adapter sets
    // it) but reaches this function anyway on responses that pass a
    // provider's raw upstream JSON straight through -- TS structural typing
    // doesn't strip excess runtime properties a variable carries, only
    // flags object literals. Confirmed live: a self-hosted vLLM response
    // leaked "system_fingerprint":"vllm-0.21.0-..." verbatim in the exact
    // JSON payload whose message.content correctly refused to name the
    // underlying model — the branding filter needs to catch fields it
    // doesn't know the shape of, not just the ones it does.
    delete (branded as Record<string, unknown>).system_fingerprint;
  }

  // Process metadata.
  //
  // `ailin_metadata` is a discriminated union: SSE chunk variants
  // (`AilinProgressMetadata`, `AilinObserverMetadata`,
  // `AilinClarificationMetadata`) carry a `type` discriminator field.
  // Completion metadata (`AilinMetadata`) does NOT have `type`. Branding
  // only applies to the completion variant (the others don't carry model
  // names or strategy info to redact). Discriminate via `'type' in m`.
  if (branded.ailin_metadata && !('type' in branded.ailin_metadata)) {
    branded.ailin_metadata = applyMetadataBranding(branded.ailin_metadata);
  }

  return branded;
}

/**
 * Apply branding to metadata
 *
 * Modes:
 * 1. hideModels: false, minimalMetadata: false
 *    → Show everything (default, transparent mode)
 *
 * 2. hideModels: true, minimalMetadata: false
 *    → Hide model names, KEEP strategy visible
 *
 * 3. hideModels: true, minimalMetadata: true
 *    → Hide everything except cost, time, and strategy
 *
 * Strategy is ALWAYS visible to maintain transparency about orchestration approach.
 *
 * @param metadata - Original metadata
 * @returns Branded metadata
 */
function applyMetadataBranding(metadata: AilinMetadata): AilinMetadata {
  const branded = { ...metadata };

  // Store actual data for internal tracking
  if (brandingConfig.hideModels || brandingConfig.minimalMetadata) {
    branded._internal = {
      actual_models: [...metadata.models_used],
      actual_providers: extractProviders(metadata.models_used),
      actual_strategy: metadata.strategy_used,
    };

    // Log detailed metadata for internal analytics
    if (brandingConfig.logDetailedMetadata) {
      log.debug(
        {
          actual_models: branded._internal.actual_models,
          actual_providers: branded._internal.actual_providers,
          actual_strategy: branded._internal.actual_strategy,
          cost: metadata.cost_usd,
          duration: metadata.execution_time_ms,
          quality: metadata.quality_score,
        },
        'Detailed metadata (internal tracking)'
      );
    }
  }

  // Apply branding based on configuration
  if (brandingConfig.hideModels) {
    // Replace model names with brand name
    branded.models_used = [brandingConfig.brandName];
    if (typeof branded.resolved_model === 'string' && branded.resolved_model.length > 0) {
      branded.resolved_model = brandingConfig.brandName;
    }
    if (Array.isArray(branded.fallback_chain) && branded.fallback_chain.length > 0) {
      branded.fallback_chain = [brandingConfig.brandName];
    }
    if (
      typeof branded.final_decider_model_id === 'string' &&
      branded.final_decider_model_id.length > 0
    ) {
      branded.final_decider_model_id = brandingConfig.brandName;
    }
    if (
      typeof branded.final_decider_model_name === 'string' &&
      branded.final_decider_model_name.length > 0
    ) {
      branded.final_decider_model_name = brandingConfig.brandName;
    }

    // ALWAYS keep strategy visible (transparency about orchestration approach)
    // Strategy is NOT prefixed with "ailin-" to keep it clean and informative
    // Examples: "single", "collaborative", "consensus", "cost-cascade"

    if (brandingConfig.minimalMetadata) {
      // Minimal mode: hide triage details and quality score, but KEEP strategy
      delete branded.triage_intent;
      delete branded.triage_complexity;
      delete branded.triage_strategy;
      delete branded.quality_score;
      // strategy_used is preserved
    }
    // else: Full metadata mode - keep everything except model names
  }

  return branded;
}

/**
 * Extract provider names from model names
 *
 * Examples:
 * - "gpt-4o" → "openai"
 * - "claude-3-opus" → "anthropic"
 * - "gemini-pro" → "google"
 *
 * @param modelNames - Array of model names
 * @returns Array of provider names
 */
function extractProviders(modelNames: string[]): string[] {
  const providers = new Set<string>();

  for (const modelName of modelNames) {
    const provider = inferProvider(modelName);
    if (provider) {
      providers.add(provider);
    }
  }

  return Array.from(providers);
}

/**
 * Infer provider from model name
 *
 * @param modelName - Model name
 * @returns Provider name or 'unknown'
 */
function inferProvider(modelName: string): string {
  const lower = modelName.toLowerCase();

  if (
    lower.includes('gpt') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4') ||
    lower.includes('dall-e') ||
    lower.includes('sora')
  ) {
    return 'openai';
  }
  if (lower.includes('claude')) {
    return 'anthropic';
  }
  if (lower.includes('gemini')) {
    return 'google';
  }
  if (lower.includes('deepseek')) {
    return 'deepseek';
  }
  if (
    lower.includes('mistral') ||
    lower.includes('mixtral') ||
    lower.includes('codestral') ||
    lower.includes('pixtral')
  ) {
    return 'mistral';
  }
  if (lower.includes('grok')) {
    return 'xai';
  }
  if (lower.includes('command') || lower.includes('embed') || lower.includes('rerank')) {
    return 'cohere';
  }
  if (lower.includes('qwen')) {
    return 'qwen';
  }
  if (lower.includes('ernie')) {
    return 'ernie';
  }

  return 'unknown';
}

/**
 * Get branding configuration (for debugging)
 */
export function getBrandingConfig() {
  return {
    hideModels: brandingConfig.hideModels,
    brandName: brandingConfig.brandName,
    minimalMetadata: brandingConfig.minimalMetadata,
    logDetailedMetadata: brandingConfig.logDetailedMetadata,
  };
}

/**
 * Check if branding is enabled
 */
export function isBrandingEnabled(): boolean {
  return brandingConfig.hideModels || brandingConfig.minimalMetadata;
}
