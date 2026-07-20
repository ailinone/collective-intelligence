// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Provider Model Aliases.
 *
 * Maps catalog model IDs (the form stored in the `models` table) to the
 * actual API model ID the provider's endpoint expects. The audit reprobe
 * + planner consult this map BEFORE issuing a chat completion so we
 * don't waste calls on a model id format mismatch.
 *
 * Why this matters (concrete G evidence):
 *   - openai/openai-gpt-5.1-mini → API expects `gpt-5.1-mini`
 *     The catalog double-prefixes when the model originally came from a
 *     hub that namespaced by provider. The native openai adapter would
 *     get 404 on the prefixed form.
 *   - replicate/openai/gpt-4o-mini → Replicate hosts models from many
 *     providers, but the API expects model identifiers like
 *     `<owner>/<model>:<version>`. The flat `openai/gpt-4o-mini` is a
 *     catalog leakage from a different source, not a Replicate model.
 *   - sambanova/MiniMax-M2.7 → SambaNova has its own model catalog;
 *     a MiniMax model in this row is catalog leakage (wrong providerId
 *     binding).
 *
 * The alias map is OPERATOR-MAINTAINED. There is no automated way to
 * derive it without per-provider discovery API knowledge. Adding an
 * alias here unblocks the affected provider for the consensus dry-run.
 *
 * Format:
 *   PROVIDER_MODEL_ALIASES[providerId][catalogModelId] = apiModelId
 *
 * When the catalog model ID itself IS the API ID (most common case),
 * leave it out of this map — the canonical resolver falls back to the
 * catalog ID by default.
 */
export type ProviderModelAliasMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const PROVIDER_MODEL_ALIASES: ProviderModelAliasMap = {
  // ── OpenAI ─────────────────────────────────────────────────────────
  // Observed: openai/openai-gpt-5.1-mini (404). Native OpenAI API
  // expects the bare model id without provider prefix. The
  // double-prefix happens when an OpenAI model row was originally
  // discovered via a hub that namespaces by provider.
  openai: {
    'openai/openai-gpt-5.1-mini': 'gpt-5.1-mini',
    'openai/openai-gpt-5-mini': 'gpt-5-mini',
    'openai/openai-gpt-5': 'gpt-5',
    'openai/openai-gpt-5.1': 'gpt-5.1',
    'openai/openai-gpt-4o': 'gpt-4o',
    'openai/openai-gpt-4o-mini': 'gpt-4o-mini',
    'openai/openai-gpt-4.1': 'gpt-4.1',
    'openai/openai-gpt-4.1-mini': 'gpt-4.1-mini',
    // TODO (USER CONTRIBUTION): extend with the GPT-5.* / o3.* / o4.*
    // catalog ids you've seen if they appear in dry-runs. The pattern
    // is `openai/openai-<id>` → `<id>`.
  },

  // ── Replicate ──────────────────────────────────────────────────────
  // Replicate expects `<owner>/<model>` form (no version pinning here
  // since we probe with default revision). The G probe got
  // `openai/gpt-4o-mini` — that's catalog leakage from a different
  // source, NOT a Replicate model. No alias possible; this provider
  // should be classified as P_provider_id_catalog_mismatch when a non-
  // Replicate model is returned.
  replicate: {
    // empty — Replicate model IDs are discovery-driven; no static aliases.
  },

  // ── HuggingFace router ────────────────────────────────────────────
  // The HF inference router accepts ids like
  // `meta-llama/Llama-3.2-11B-Vision-Instruct`. The G probe used the
  // form from the meta-llama org which IS the correct format — the
  // 400 was likely a router-side routing issue (model not enabled for
  // the token's plan), not an alias bug. No static alias entries here.
  huggingface: {},

  // ── Fireworks AI ──────────────────────────────────────────────────
  // Fireworks expects `accounts/fireworks/models/<model>` for its
  // native models, plus a flat id for some. The catalog stores the
  // short form. Adding aliases here once observed in dry-run probes.
  'fireworks-ai': {
    // TODO (USER CONTRIBUTION): when Fireworks-native models appear
    // in dry-runs and 404, add their `short-id` → `accounts/fireworks/models/short-id` mapping here.
  },

  // ── NVIDIA NIM ─────────────────────────────────────────────────────
  // NVIDIA Inference Microservices expect ids like `meta/llama-3.2-3b-instruct`
  // matching their deployment names. The catalog stores them prefixed.
  nvidia: {
    // TODO (USER CONTRIBUTION): observed NVIDIA NIM aliases.
  },

  // ── Chutes / v0 / Inworld ─────────────────────────────────────────
  chutes: {},
  v0: {},
  inworld: {},

  // ── 01C.1B-J1E — Anthropic native ──────────────────────────────────
  // The catalog stores Claude models with `anthropic-` prefix baked in,
  // but the native Anthropic API accepts the bare model id (with the
  // versioned suffix for hard pinning, or the alias `claude-3.7-sonnet`
  // for the latest of that family). The resolver's strict mode prefers
  // an explicit entry here over conservative derivation.
  anthropic: {
    'anthropic-claude-3.7-sonnet': 'claude-3-7-sonnet-latest',
    'anthropic-claude-3.5-sonnet': 'claude-3-5-sonnet-latest',
    'anthropic-claude-3-opus': 'claude-3-opus-latest',
    'anthropic-claude-3-haiku': 'claude-3-haiku-20240307',
    'anthropic-claude-3-sonnet': 'claude-3-sonnet-20240229',
    'anthropic-claude-opus-4-6': 'claude-opus-4-6-latest',
    'anthropic-claude-opus-4-5': 'claude-opus-4-5-latest',
    'anthropic-claude-opus-4': 'claude-opus-4-latest',
    'anthropic-claude-sonnet-4-7': 'claude-sonnet-4-7-latest',
  },

  // ── 01C.1B-J1E — Router peerings for Anthropic models ─────────────
  // Routers/aggregators that proxy to Anthropic typically expect the
  // form `anthropic/<bare-model-id>` (NOT `anthropic/anthropic-<model>`).
  // The catalog id is `anthropic-claude-X-Y-sonnet`; the router id is
  // `anthropic/claude-X-Y-sonnet`.
  openrouter: {
    'anthropic-claude-3.7-sonnet': 'anthropic/claude-3.7-sonnet',
    'anthropic-claude-3.5-sonnet': 'anthropic/claude-3.5-sonnet',
    'anthropic-claude-3-opus': 'anthropic/claude-3-opus',
    'anthropic-claude-3-haiku': 'anthropic/claude-3-haiku',
    'anthropic-claude-3-sonnet': 'anthropic/claude-3-sonnet',
  },
  aiml: {
    'anthropic-claude-3.7-sonnet': 'claude-3-7-sonnet-20250219',
    'anthropic-claude-3.5-sonnet': 'claude-3-5-sonnet-20240620',
    'anthropic-claude-3-opus': 'claude-3-opus-20240229',
  },
  routeway: {
    'anthropic-claude-3.7-sonnet': 'anthropic/claude-3-7-sonnet',
  },
  'vercel-ai-gateway': {
    'anthropic-claude-3.7-sonnet': 'anthropic/claude-3.7-sonnet',
    'anthropic-claude-3.5-sonnet': 'anthropic/claude-3.5-sonnet',
  },
  cometapi: {
    'anthropic-claude-3.7-sonnet': 'claude-3-7-sonnet-20250219',
  },
  aihubmix: {
    'anthropic-claude-3.7-sonnet': 'claude-3-7-sonnet-20250219',
  },
};

/**
 * Resolve `(providerId, catalogModelId)` to the API model id the provider
 * expects. Returns the catalog id unchanged when no alias is defined —
 * which is correct for the vast majority of providers where the catalog
 * id IS the API id.
 */
export function resolveProviderApiModelId(
  providerId: string,
  catalogModelId: string,
): { apiModelId: string; aliasUsed: boolean } {
  const providerMap = PROVIDER_MODEL_ALIASES[providerId.toLowerCase()];
  if (!providerMap) return { apiModelId: catalogModelId, aliasUsed: false };
  const aliased = providerMap[catalogModelId];
  if (aliased) return { apiModelId: aliased, aliasUsed: true };
  return { apiModelId: catalogModelId, aliasUsed: false };
}

/**
 * Reverse-lookup: given a provider's discovery-listed model id, find
 * the catalog id that would map to it. Useful when discovery is the
 * source of truth and we need to find the catalog row.
 */
export function findCatalogIdForApiModelId(
  providerId: string,
  apiModelId: string,
): string | undefined {
  const providerMap = PROVIDER_MODEL_ALIASES[providerId.toLowerCase()];
  if (!providerMap) return undefined;
  for (const [catalogId, mappedApiId] of Object.entries(providerMap)) {
    if (mappedApiId === apiModelId) return catalogId;
  }
  return undefined;
}
