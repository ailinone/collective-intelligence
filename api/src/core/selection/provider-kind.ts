// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider-kind classification (Lote 5 — S1 single source of truth).
 *
 * The `DynamicModelSelector` was biased: when the same model id existed on
 * both a native provider (`openai`) and a hub/proxy provider (`nanogpt`
 * routing `openai/gpt-4o-mini`), the hub version often won ranking because:
 *
 *   1. Hub entries carry a populated `performance.quality` from catalog sync,
 *      while native entries in the dev DB often have `performance = {}`
 *      (quality coerces to 0 → `fallbackScore = 0.5` from config).
 *   2. Balance-status enrichment populates a differential (+0.3 / -0.5) only
 *      when `providerBalanceStatus` has been probed. In dev/staging many
 *      providers stay `'unknown'` (neutral 0), so the balance tiebreaker
 *      never fires.
 *
 * Result in `local-run-4`: the selector routed `openai/*` tasks through
 * `nanogpt` (HTTP 402 exhausted credit) while OpenAI native ($19.02 balance)
 * sat idle.
 *
 * This module defines the classification so the selector can apply an
 * explicit bias correction ("native is preferred over hub when the same
 * capability is available and balance signal is ambiguous") that is
 * **audited, logged, and testable** — NOT a hardcoded magic constant buried
 * in scoreModel.
 *
 * The classification is intentionally a typed closed enum + two static Sets
 * rather than a DB field. The membership of a provider in `native` vs `hub`
 * is a stable property of the provider itself, not of the DB row or runtime
 * state — putting it in config/DB would create drift without value.
 */

export type ProviderKind = 'native' | 'hub' | 'local' | 'unknown';

/**
 * Providers that talk directly to the model owner's API (OpenAI's API,
 * Anthropic's API, Google's Gemini API, etc.). These are the "authoritative"
 * routes — when they have balance, they should be preferred over proxied
 * equivalents because:
 *   - lower latency (no extra hop through a gateway)
 *   - lower cost (no gateway markup)
 *   - more reliable features (hubs may not pass through every endpoint feature)
 *   - predictable rate limits (gateways stack on top of provider limits)
 */
const NATIVE_PROVIDERS: ReadonlySet<string> = new Set([
  // Canonical switch-case natives (provider-registry.ts)
  'openai',
  'anthropic',
  'google',
  'vertex-ai',
  'xai',
  'mistral',
  'cohere',
  'deepseek',
  'aws-bedrock',
  'aws-sagemaker',
  'elevenlabs',
  'deepgram',
  'cartesia',
  'palabraai',
  'jina',
  // Canonical catalog natives (first-party APIs with dedicated adapters)
  'groq',
  'fireworks-ai',
  'togetherai',
  'perplexity',
  'cerebras',
  'sambanova',
  'nvidia',
  'moonshot',
  'writer',
  'upstage',
  'rekaai',
  'replicate',
  // NOTE: 'ai21' removed 2026-04-23 — not present in catalog nor switch
  // (VERIFIED-CLEAN in consolidation-matrix); secret `ailin-ai21-key`
  // exists but is not consumed by any adapter.
  // NOTE: 'bedrock' replaced by canonical 'aws-bedrock'; 'fireworks' by
  // 'fireworks-ai'; 'together' by 'togetherai'. 'google-vertex' removed
  // 2026-04-23 late-pass — it was an alias of canonical 'vertex-ai',
  // which is already listed above. The alias had no callers because the
  // selector only sees canonical ids; kept in the NOTE for future grep
  // context (so someone searching for 'google-vertex' lands here).
]);

/**
 * Hub / proxy / aggregator providers that re-sell access to models owned by
 * other companies. They are not inherently bad — they are often the only way
 * to reach certain models, and they may offer balance/quota advantages. But
 * they are a riskier default when:
 *   - the same model exists on a native provider with balance
 *   - the hub's balance state is unknown (may be exhausted)
 *   - latency or feature fidelity matters
 */
const HUB_PROVIDERS: ReadonlySet<string> = new Set([
  // Canonical hubs/aggregators — 2026-04-23: drift fixed, canonical IDs only
  'openrouter', // dedicated adapter but functionally a proxy to 3rd-party models — HUB for routing-preference classification
  'aihubmix',
  'cometapi',
  'aiml', // canonical — 'aimlapi' removed as drift
  'nanogpt',
  'poe',
  'requesty',
  'routeway',
  'edenai',
  'heliconeai', // canonical — 'helicone' removed as drift
  'novita',
  'friendli',
  'orqai',
  'imagerouter',
  'wandb',
  'featherless-ai', // canonical — bare 'featherless' alias removed as drift
  // NOTE: 'nvidia-hub' removed — alias absorbed into 'nvidia' catalog row.
  // NOTE: 'featherless' bare alias removed 2026-04-23 late-pass. Catalog
  // row is 'featherless-ai' (hyphenated), so that is the canonical id the
  // selector sees. Keeping only the canonical form ensures classifyProviderKind
  // returns 'hub' for the canonical call site and 'unknown' for any stray
  // caller using the bare alias (which is a bug that should fail loudly).
  // NOTE: 'openrouter' kept in HUB despite having a dedicated switch-case
  // adapter: the classification is about routing *preference* (prefer native
  // over proxy), not adapter architecture. Functionally it proxies requests
  // to third-party model owners.
]);

/**
 * Classify a provider identifier into its kind. Unknown identifiers return
 * `'unknown'` so the selector can treat them neutrally rather than accidentally
 * mis-classifying a new integration.
 *
 * Matching is case-insensitive and tolerates the legacy `local-*` prefix used
 * by self-hosted provider adapters.
 */
export function classifyProviderKind(providerId: string | undefined | null): ProviderKind {
  if (!providerId) return 'unknown';
  const normalized = providerId.trim().toLowerCase();
  if (!normalized) return 'unknown';

  if (normalized.startsWith('local-') || normalized.startsWith('self-hosted')) {
    return 'local';
  }
  if (normalized === 'ollama' || normalized === 'local') {
    return 'local';
  }
  if (NATIVE_PROVIDERS.has(normalized)) return 'native';
  if (HUB_PROVIDERS.has(normalized)) return 'hub';
  return 'unknown';
}

/**
 * Return the entire classification as a record — useful for admin endpoints
 * and debugging. Consumers should NOT use this for per-call classification
 * (that is what `classifyProviderKind` is for).
 */
export function getProviderKindRegistry(): Readonly<Record<ProviderKind, readonly string[]>> {
  return {
    native: Array.from(NATIVE_PROVIDERS).sort(),
    hub: Array.from(HUB_PROVIDERS).sort(),
    local: ['ollama', 'local-*', 'self-hosted-*'],
    unknown: [],
  };
}
