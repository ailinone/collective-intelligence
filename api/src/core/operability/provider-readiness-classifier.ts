// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Provider Readiness Classifier helpers.
 *
 * `looksLikeAliasMismatch` is the heuristic that distinguishes:
 *   - G_model_alias_mismatch_probable (catalog id format is wrong;
 *     the provider has the model under a different id) →
 *     **cheap operator fix (add alias entry)**
 * from
 *   - H_model_not_supported_confirmed (the provider genuinely does
 *     not offer this model) →
 *     **expensive operator fix (upgrade plan or remove from catalog)**
 *
 * The function is a HEURISTIC, not an oracle. It returns true when
 * evidence STRONGLY suggests the catalog id can be rewritten to an
 * API-acceptable form. False negatives are OK (we fall back to
 * H_model_not_supported_confirmed, and operator can still add an alias
 * manually). False positives are worse (we'd send a billable reprobe
 * that 404s again).
 */

import { PROVIDER_MODEL_ALIASES } from './provider-model-aliases';

export interface AliasMismatchInput {
  readonly providerId: string;
  readonly modelId?: string | null;
  readonly apiModelId?: string | null;
  readonly errorMessage?: string | null;
  readonly discoveredModelIds?: readonly string[];
}

/**
 * Returns true when the catalog model id likely has a format issue that
 * a provider-specific alias would fix.
 *
 * Signals (any one triggers true):
 *   1. The model id contains the providerId as a prefix (double-prefix
 *      pattern): `openai/openai-gpt-5.1-mini` for providerId=`openai`.
 *   2. The model id is `provider/something` for providers that don't
 *      accept slash in chat endpoint (openai native, anthropic, etc.).
 *   3. The model id is already in the PROVIDER_MODEL_ALIASES map but the
 *      audit forgot to apply it (defensive — should never happen, but
 *      catches accidental regressions).
 *   4. Discovery lists a candidate that matches the bare form of the
 *      catalog id (e.g., catalog has `openai/gpt-5.1-mini`, discovery
 *      has `gpt-5.1-mini`).
 *   5. Error message specifically says "model not found" / "no provider
 *      supports" with the EXACT model string — i.e., the provider knows
 *      what model was requested but doesn't have that exact id.
 */
export function looksLikeAliasMismatch(input: AliasMismatchInput): boolean {
  const providerId = input.providerId.toLowerCase();
  const modelId = (input.modelId ?? '').toLowerCase();
  if (modelId.length === 0) return false;

  // Signal 1 — double-prefix detected.
  // `openai/openai-gpt-5.1-mini` for providerId=`openai`
  const providerPrefix = `${providerId}/${providerId}-`;
  if (modelId.startsWith(providerPrefix)) return true;
  // `openai/gpt-5.1-mini` for providerId=`openai` is a single-prefix —
  // some providers don't accept the prefix.
  const singlePrefix = `${providerId}/`;
  if (modelId.startsWith(singlePrefix)) {
    // Single-prefix providers that DO accept prefix (hub-style): vercel-ai-gateway,
    // openrouter, edenai, aihubmix, etc. Native providers do NOT accept prefix.
    const NATIVE_PROVIDERS_REJECTING_PREFIX = new Set([
      'openai', 'anthropic', 'google', 'xai', 'mistral', 'cohere', 'deepseek',
      'fireworks-ai', 'huggingface', 'nvidia', 'sambanova', 'togetherai',
      'cerebras', 'groq', 'perplexity', 'replicate', 'inworld', 'azure-openai',
    ]);
    if (NATIVE_PROVIDERS_REJECTING_PREFIX.has(providerId)) return true;
  }

  // Signal 3 — already mapped but missed.
  const providerMap = PROVIDER_MODEL_ALIASES[providerId];
  if (providerMap && providerMap[modelId]) return true;

  // Signal 4 — discovery has bare-form match.
  if (input.discoveredModelIds && input.discoveredModelIds.length > 0) {
    const lastSlash = modelId.lastIndexOf('/');
    if (lastSlash > 0) {
      const bare = modelId.slice(lastSlash + 1);
      if (input.discoveredModelIds.some((d) => d.toLowerCase() === bare)) return true;
    }
    // Also try removing the `<providerId>-` infix.
    const stripped = modelId.replace(new RegExp(`^${providerId}[/-]`), '').replace(new RegExp(`^${providerId}-`), '');
    if (stripped !== modelId && input.discoveredModelIds.some((d) => d.toLowerCase() === stripped.toLowerCase())) {
      return true;
    }
  }

  // Signal 5 — error message indicates exact string mismatch.
  const err = (input.errorMessage ?? '').toLowerCase();
  if (err.includes('model not found') || err.includes('no provider supports') || err.includes('model_not_supported')) {
    // The error mentions the model wasn't found. If the catalog id has
    // any structural oddity (slash, double prefix), it's likely alias.
    if (modelId.includes('/')) return true;
  }

  return false;
}
