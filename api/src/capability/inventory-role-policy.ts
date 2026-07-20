// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inventory Role Policy — single source of truth for "what role does THIS
 * model row play in the catalog?"
 *
 * ## Why this module exists (Gap 2 closure, 2026-04-30)
 *
 * The capability histogram surfaced a structural truth: 64,799 catalog rows
 * are NOT 64,799 distinct models. They are:
 *
 *   - 58,129 huggingface community uploads (~90% of the catalog)
 *   - ~5,000 hub re-exports (orqai, nanogpt, cometapi, openrouter, ...)
 *   - ~500 native-provider primaries (openai, anthropic, mistral, ...)
 *   - a handful of synthetic ensembles / aggregator-only entries
 *
 * Capability inference (Gap 1 + Gap 3) made the URIs correct. But a search
 * UX asking "show me models that support image_generation" wants the 5
 * flagship primaries, not 45K HF community SD forks. `inventory_role`
 * exposes that structural distinction so consumers can filter intelligently
 * without baking provider lists into client code.
 *
 * ## Scope
 *
 * Orthogonal to the existing dimensions:
 *   - `models.status`            → catalog availability (active/deprecated/withdrawn)
 *   - `models.lifecycle_status`  → observation freshness (active/stale/inactive)
 *   - `provider.inventoryClass`  → provider-level discovery compliance (9-bucket)
 *   - `models.inventory_role`    → THIS module: model-level identity role
 *
 * A row can be `status='active'` AND `lifecycle_status='active'` AND
 * `inventory_role='community'` — perfectly fresh and serviceable, but
 * NOT the canonical identity for its capability set.
 *
 * ## The four roles
 *
 *   primary    — the canonical identity for this model. Native-provider
 *                catalogs (openai, anthropic, mistral, vertex-ai, cohere,
 *                deepseek, ...). One row per model. Stable id over time.
 *
 *   secondary  — a hub re-export of a primary that exists elsewhere in the
 *                catalog. The model resolution pipeline can resolve to either
 *                this row or the primary; preferring the primary is usually
 *                correct (lower latency, direct billing, native features).
 *                Examples: cometapi/openai/gpt-4o, openrouter/anthropic/claude-3-5-sonnet.
 *
 *   community  — community-uploaded fork or fine-tune. No upstream "primary"
 *                exists. The author/uploader is responsible for the model
 *                identity. Examples: 99% of HuggingFace catalog, replicate
 *                user-published models.
 *
 *   synthetic  — hub-only model with no native upstream — typically an
 *                aggregator's own ensemble, routing alias, or merge.
 *                Examples: openrouter/auto, requesty/coding-engine.
 */

import type { Provider } from '@/generated/prisma';

/**
 * The four roles a model row can play. Listed in approximate order of
 * "stability" — primary identities are most stable, synthetic ones are
 * the most ephemeral.
 */
export type InventoryRole = 'primary' | 'secondary' | 'community' | 'synthetic';

/**
 * Minimum input contract for the classifier. Kept narrow so callers can
 * pass either a hydrated Prisma row or a lightweight DTO.
 *
 * `providerInventoryClass` is the 9-bucket compliance value from
 * `consolidation-matrix.ts`'s `DISCOVERY_COMPLIANCE_REGISTRY`. Pass it
 * through so the classifier can use it as a strong signal (e.g.
 * `compliant-deployment-discovery` providers like Vertex AI publish
 * primaries; `non-compliant-runtime-not-materialized` providers don't
 * publish anything live).
 */
export interface InventoryRoleInput {
  modelId: string;
  providerId: string;
  providerInventoryClass?: string | null;
  /**
   * Whether a "twin" — a different row with the same canonical model
   * identity — exists at another provider in the catalog. Computed
   * upstream by the model-equivalence service (L2). Optional; the
   * classifier should degrade gracefully when undefined.
   */
  hasUpstreamTwin?: boolean;
}

// ─── User-defined classification table ────────────────────────────────────────

/**
 * TODO (user contribution): fill in the provider-id sets that map to
 * each role. These three lists are the entire policy — the classifier
 * below uses them to decide.
 *
 * GUIDANCE:
 *   - `COMMUNITY_PROVIDERS`: providers whose models are user-uploaded and
 *     identity-owned by the uploader, not the platform. The HF catalog
 *     is the canonical case. Keep this list small but EXACT — false
 *     positives hide native primaries; false negatives bloat the
 *     "primary" set with community noise.
 *
 *   - `HUB_PROVIDERS`: aggregator/router providers that re-export upstream
 *     models. Look at `_capability_by_provider.ts` output: any provider
 *     whose model count is dominated by `vendor/model` style ids and
 *     whose business model is API resale belongs here. From the histogram:
 *     orqai, nanogpt, cometapi, aiml, requesty, poe, openrouter, edenai,
 *     vercel-ai-gateway, aihubmix, routeway, deepinfra, novita, heliconeai,
 *     phala. Some are debatable (deepinfra serves both primaries and
 *     re-exports) — when in doubt prefer HUB so the classifier defaults
 *     to `secondary`+twin-check.
 *
 *   - Anything NOT in either set is treated as a native-provider primary
 *     by default. This is the safe default — small false-primary count
 *     is acceptable; the L2 twin-detection catches the rest.
 *
 * Aim for 5-10 lines total. You can leave entries unsorted; the runtime
 * builds Sets at module load.
 */
/**
 * Initial seed (2026-04-30, conservative). Derived from the histogram in
 * `_capability_by_provider.ts` output:
 *   - huggingface: 58,129 rows, all user-uploaded → COMMUNITY
 *   - replicate:    9 rows in our catalog, but the platform itself is a
 *                   community-publishing model → COMMUNITY
 * Operator: extend or trim this list as you refine your view of what
 * "community" means for routing decisions.
 */
export const COMMUNITY_PROVIDERS: ReadonlyArray<string> = [
  'huggingface',
  'replicate',
];

/**
 * Initial seed (2026-04-30, conservative). Drawn from the catalog rows
 * whose business model is API resale of upstream natives. Numbers in
 * comments are catalog counts at HEAD; ordering follows histogram size.
 *
 * Judgment-call providers (left OUT for now — flip them in if your
 * routing layer treats them as hubs):
 *   - deepinfra (155): mixes some natives with re-exports
 *   - novita (100):    similar dual-mode
 *   - heliconeai (111): primarily an analytics shim, but resells
 *   - phala (76):      confidential-compute hub, debatable
 *   - synthetic (16):  literally named 'synthetic' but unclear shape
 *   - bytez:           native fetcher, not a hub
 */
export const HUB_PROVIDERS: ReadonlyArray<string> = [
  'orqai',
  'nanogpt',
  'cometapi',
  'aiml',
  'requesty',
  'poe',
  'openrouter',
  'edenai',
  'vercel-ai-gateway',
  'aihubmix',
  'routeway',
  'nvidia-hub',
];

/**
 * Provider IDs whose entire inventory is synthetic (router aliases, merges,
 * ensembles with no upstream native model). Empty by default — synthetic
 * is usually a per-MODEL distinction within a HUB provider (see decision
 * order #4 in classifyInventoryRole), not a whole-provider classification.
 * Populate only if you find a provider that is 100% synthetic.
 */
export const SYNTHETIC_PROVIDERS: ReadonlyArray<string> = [
  // (typically empty — synthetic is a per-row outcome, see classifier)
];

const COMMUNITY_SET = new Set(COMMUNITY_PROVIDERS);
const HUB_SET = new Set(HUB_PROVIDERS);
const SYNTHETIC_SET = new Set(SYNTHETIC_PROVIDERS);

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Map a model row to its `InventoryRole`. Pure function — same input
 * always produces same output, no IO.
 *
 * Decision order (first match wins):
 *   1. Synthetic provider                 → 'synthetic'
 *   2. Community provider                 → 'community'
 *   3. Hub provider WITH upstream twin    → 'secondary' (re-export of a primary)
 *   4. Hub provider WITHOUT upstream twin → 'synthetic' (hub-only invention)
 *   5. Anything else                      → 'primary'
 */
export function classifyInventoryRole(input: InventoryRoleInput): InventoryRole {
  if (SYNTHETIC_SET.has(input.providerId)) return 'synthetic';
  if (COMMUNITY_SET.has(input.providerId)) return 'community';
  if (HUB_SET.has(input.providerId)) {
    return input.hasUpstreamTwin ? 'secondary' : 'synthetic';
  }
  return 'primary';
}

/**
 * Convenience: take a Prisma `Model` row + the provider's `inventoryClass`
 * + a twin-existence hint, return the role. Splits the row apart so the
 * core classifier stays unaware of the persistence shape.
 */
export function roleForModel(
  model: { id: string; providerId: string },
  provider: Pick<Provider, 'id'> | null,
  ctx: { providerInventoryClass?: string | null; hasUpstreamTwin?: boolean } = {},
): InventoryRole {
  // Truthiness check (not `??`) so empty-string providerId — which appears in
  // malformed test fixtures and partially-populated DTOs — also triggers the
  // provider.id fallback. `??` only catches null/undefined, which would let
  // `providerId: ''` through and silently mis-classify the row as 'primary'.
  const resolvedProviderId =
    (model.providerId && model.providerId.length > 0)
      ? model.providerId
      : (provider?.id ?? 'unknown');
  return classifyInventoryRole({
    modelId: model.id,
    providerId: resolvedProviderId,
    providerInventoryClass: ctx.providerInventoryClass,
    hasUpstreamTwin: ctx.hasUpstreamTwin,
  });
}
