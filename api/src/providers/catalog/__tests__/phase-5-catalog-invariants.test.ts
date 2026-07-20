// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 5 — Catalog Invariants (regression-blockers, not validators).
 *
 * These tests answer the question: "if a future PR were to silently
 * regress catalog hygiene, would CI catch it?" Each describe block
 * encodes one invariant from the SOTA closure plan
 * (C:\Users\aliss\.claude\plans\prompt-sota-bright-stroustrup.md, Phase 5).
 *
 *   1. no-static-models       — `staticModels` is forbidden post-Phase 4d.
 *                               The legacy field still exists in the Zod
 *                               schema for the migration window, but no
 *                               catalog row may carry it.
 *   2. enabled-by-default     — every `enabledByDefault: false` row must
 *                               be a self-hosted/local provider OR carry
 *                               `apiKeyOptional: true`. Anything else is a
 *                               policy violation per the universal
 *                               "habilitado e nunca censurado" directive.
 *   3. no-deny-by-default     — `denyByDefault: true` is dead. Mancer and
 *                               venice were the last carriers; Phase 4b
 *                               replaced the gate with the
 *                               `contentPolicyClass: 'uncensored'`
 *                               informational tag.
 *   4. integration-mode-canonical
 *                             — the legal modes are `discovery+execution`,
 *                               `catalog-only`, and `discovery-only`.
 *                               `execution-only` was retired structurally
 *                               by Phase 4d (every former execution-only
 *                               row now either flipped or carries
 *                               `pinnedFallback`, both of which let the
 *                               catalog-bridge synthesize a discovery
 *                               source — i.e. *some* discovery happens).
 *                               Per Phase 5 spec, the canonical set
 *                               INCLUDES `execution-only` but only when
 *                               accompanied by pinnedFallback (already
 *                               enforced by Rule 5 in the Zod schema);
 *                               the canonical set here is therefore the
 *                               schema enum itself.
 *   5. every-provider-reaches-discovery
 *                             — every catalog row of mode
 *                               `discovery+execution` must be reachable by
 *                               at least one path: (a) a hardcoded
 *                               discovery source covers the providerId, OR
 *                               (b) the catalog-bridge in
 *                               `central-model-discovery-service.ts`
 *                               would synthesize one
 *                               (`isOpenAICompatibleEntry === true` AND
 *                               not catalog-only AND not deny-by-default).
 *
 * Failure semantics: every assertion uses `expect(violators).toEqual([])`
 * so the test output names the offending providerId(s) — not just "false"
 * vs "true". The error array shape is (providerId, reason) when context
 * matters.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { isOpenAICompatibleEntry } from '../provider-catalog.types';

// ──────────────────────────────────────────────────────────────────────────
// Invariant 1 — no `staticModels` on any catalog row.
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 5 invariant: no-static-models', () => {
  it('no entry carries the deprecated `staticModels` field (Phase 4d migration is complete)', () => {
    const offenders = PROVIDER_CATALOG.filter(
      (e) => 'staticModels' in e && (e as { staticModels?: readonly string[] }).staticModels !== undefined,
    ).map((e) => e.providerId);

    expect(offenders).toEqual([]);
  });

  it('every `pinnedFallback` carries a closed-enum reason and ISO date', () => {
    const ALLOWED_REASONS = new Set([
      'no-list-endpoint',
      'workspace-scoped',
      'per-deployment',
      'proprietary-schema',
      'curated-shortlist',
    ]);
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const violators: Array<{ providerId: string; reason: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      const pf = (entry as { pinnedFallback?: { models?: readonly string[]; reason?: string; lastReviewedAt?: string } })
        .pinnedFallback;
      if (!pf) continue;

      if (!Array.isArray(pf.models) || pf.models.length === 0) {
        violators.push({ providerId: entry.providerId, reason: 'pinnedFallback.models empty or missing' });
        continue;
      }
      if (!pf.reason || !ALLOWED_REASONS.has(pf.reason)) {
        violators.push({
          providerId: entry.providerId,
          reason: `pinnedFallback.reason=${pf.reason ?? 'undefined'} not in canonical set`,
        });
        continue;
      }
      if (!pf.lastReviewedAt || !ISO_DATE.test(pf.lastReviewedAt)) {
        violators.push({
          providerId: entry.providerId,
          reason: `pinnedFallback.lastReviewedAt=${pf.lastReviewedAt ?? 'undefined'} not ISO YYYY-MM-DD`,
        });
      }
    }

    expect(violators).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 2 — enabledByDefault: false is reserved for self-hosted /
// apiKey-optional rows (universal "habilitado" policy, Phase 4a).
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 5 invariant: enabled-by-default', () => {
  /**
   * Self-hosted classes never need a remote API key, so `false` is the
   * structurally honest default. Catalog and switch self-hosted entries
   * both qualify.
   */
  const SELF_HOSTED_CLASSES = new Set([
    'self-hosted-oai-compat',
    'self-hosted-native',
  ]);

  it('every `enabledByDefault: false` row is self-hosted or `apiKeyOptional: true`', () => {
    const violators: Array<{ providerId: string; reason: string }> = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.enabledByDefault !== false) continue;

      const isSelfHosted = SELF_HOSTED_CLASSES.has(entry.integrationClass);
      const isApiKeyOptional = entry.apiKeyOptional === true;
      if (!isSelfHosted && !isApiKeyOptional) {
        violators.push({
          providerId: entry.providerId,
          reason: `enabledByDefault=false on integrationClass=${entry.integrationClass} without apiKeyOptional — violates universal "habilitado" policy`,
        });
      }
    }
    expect(violators).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 3 — denyByDefault is dead.
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 5 invariant: no-deny-by-default', () => {
  it('no catalog row carries `denyByDefault: true` (Phase 4b retired the gate)', () => {
    const offenders = PROVIDER_CATALOG.filter(
      (e) => (e as { denyByDefault?: boolean }).denyByDefault === true,
    ).map((e) => e.providerId);

    expect(offenders).toEqual([]);
  });

  it('uncensored providers are admitted via `contentPolicyClass: "uncensored"` informational tag, not denyByDefault', () => {
    // Sanity: the historical denyByDefault carriers (mancer, venice) must
    // now both be enabled AND tagged. If a future PR removes the tag
    // without restoring denyByDefault, this test will catch it.
    const HISTORICAL_DENY_CARRIERS = ['mancer', 'venice'];
    const violators: Array<{ providerId: string; reason: string }> = [];

    for (const id of HISTORICAL_DENY_CARRIERS) {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === id);
      if (!entry) {
        violators.push({ providerId: id, reason: 'no longer in PROVIDER_CATALOG' });
        continue;
      }
      if (entry.enabledByDefault !== true) {
        violators.push({ providerId: id, reason: `enabledByDefault=${entry.enabledByDefault}, expected true` });
      }
      const cpc = (entry as { contentPolicyClass?: string }).contentPolicyClass;
      if (cpc !== 'uncensored') {
        violators.push({
          providerId: id,
          reason: `contentPolicyClass=${cpc ?? 'undefined'}, expected 'uncensored'`,
        });
      }
    }

    expect(violators).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 4 — integrationMode is one of the canonical enum values.
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 5 invariant: integration-mode-canonical', () => {
  const ALLOWED_MODES = new Set([
    'discovery+execution',
    'execution-only', // legal only when accompanied by pinnedFallback (Rule 5 enforced by Zod)
    'catalog-only',
    'discovery-only',
  ]);

  it('every catalog row uses an allowed `integrationMode`', () => {
    const violators = PROVIDER_CATALOG.filter((e) => !ALLOWED_MODES.has(e.integrationMode)).map(
      (e) => ({ providerId: e.providerId, integrationMode: e.integrationMode }),
    );
    expect(violators).toEqual([]);
  });

  it('every `execution-only` row carries pinnedFallback.models (no orphan execution-only)', () => {
    // Belt-and-suspenders for Zod Rule 5: the schema refinement enforces
    // this at boot, but a top-level invariant test catches accidental
    // bypass (e.g. someone adds a row with `as any` casts).
    const violators: Array<{ providerId: string; reason: string }> = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'execution-only') continue;
      const pinned = (entry as { pinnedFallback?: { models?: readonly string[] } }).pinnedFallback?.models;
      const legacy = (entry as { staticModels?: readonly string[] }).staticModels;
      const hasInventory = (Array.isArray(pinned) && pinned.length > 0) || (Array.isArray(legacy) && legacy.length > 0);
      if (!hasInventory) {
        violators.push({
          providerId: entry.providerId,
          reason: 'execution-only without pinnedFallback.models or legacy staticModels',
        });
      }
    }
    expect(violators).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 5 — every discovery+execution provider is reachable by some
// discovery path (hardcoded source OR catalog-bridge synthesizable).
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 5 invariant: every-provider-reaches-discovery', () => {
  /**
   * Providers covered by a hardcoded discovery source in
   * central-model-discovery-service.ts (native APIs, hub aggregators,
   * dedicated fetchers). Kept in sync with addProviderSources() and
   * addAggregatorSources(); update both together.
   *
   * NOTE: this list is intentionally defensive. A providerId in here
   * means "the file central-model-discovery-service.ts contains a
   * discoverySources.set call for it". We don't grep the file at test
   * time because that turns runtime semantics into a string-search;
   * instead we mirror the set explicitly and the
   * adapter-factory-registry.test.ts already enforces that every
   * catalog providerId resolves to *some* factory, which is the
   * symmetric guarantee.
   */
  const HARDCODED_DISCOVERY_PROVIDERS = new Set<string>([
    // Native / first-party APIs
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'mistral',
    'xai',
    'cohere',
    'jina',
    'voyage',
    // Aggregator hubs with dedicated fetchers
    'huggingface',
    'bytez',
  ]);

  /**
   * Classes whose discovery path is the dedicated adapter, not the
   * catalog-bridge. The plugin manager exposes `plugin.listModels()`
   * which delegates to the adapter's `getModels()` (e.g. WatsonxAdapter
   * → /ml/v1/foundation_model_specs, AnthropicAdapter → /v1/models).
   * For these classes, presence of a dedicated factory or adapterClass
   * IS the discovery contract.
   */
  const PER_ADAPTER_DISCOVERY_CLASSES = new Set([
    'first-party-native',
  ]);

  /**
   * Self-hosted-native runtimes (e.g. Triton HTTP, Petals) discover
   * via runtime probes against the operator's local endpoint. Not
   * covered by central-discovery; the per-plugin health check is the
   * effective discovery surface. These rows are honest runtime-bound.
   */
  const RUNTIME_BOUND_CLASSES = new Set([
    'self-hosted-native',
    'self-hosted-oai-compat',
  ]);

  it('every `discovery+execution` row is reachable by hardcoded source OR catalog-bridge OR per-adapter path', () => {
    const violators: Array<{ providerId: string; reason: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'discovery+execution') continue;

      // Path 1: hardcoded discovery source.
      if (HARDCODED_DISCOVERY_PROVIDERS.has(entry.providerId)) continue;

      // Path 2: catalog-bridge synthesis. The bridge runs for OAI-compat
      // entries that aren't catalog-only and aren't denyByDefault. Phase
      // 4b retired denyByDefault, so the deny check is academic but kept
      // for symmetry with the runtime code in
      // central-model-discovery-service.ts:1687-1702.
      const isBridgeEligible =
        isOpenAICompatibleEntry(entry) &&
        entry.integrationMode !== 'catalog-only' &&
        (entry as { denyByDefault?: boolean }).denyByDefault !== true;
      if (isBridgeEligible) continue;

      // Path 3: per-adapter discovery (first-party-native classes whose
      // adapter implements getModels(), surfaced via plugin.listModels()).
      if (PER_ADAPTER_DISCOVERY_CLASSES.has(entry.integrationClass)) continue;

      // Path 4: runtime-bound (self-hosted). Discovery is operator-local;
      // central-discovery does not orchestrate it.
      if (RUNTIME_BOUND_CLASSES.has(entry.integrationClass)) continue;

      violators.push({
        providerId: entry.providerId,
        reason: `discovery+execution with integrationClass=${entry.integrationClass} has no covered discovery path (not in HARDCODED, not bridge-eligible, not per-adapter, not runtime-bound)`,
      });
    }

    expect(violators).toEqual([]);
  });

  it('every `execution-only` row reaches inventory via catalog-provider-plugin OR catalog-bridge pinned-fallback', () => {
    // execution-only providers don't probe a /models endpoint; their
    // inventory comes from `pinnedFallback.models`. Two materialization
    // paths exist and both are valid:
    //
    //   (a) Catalog-bridge (central-model-discovery-service.ts:1739)
    //       synthesizes a discoverySource for OAI-compat entries whose
    //       fetcher emits the pinned list as DiscoveredModel[].
    //
    //   (b) catalog-provider-plugin.ts:264-279 listModels() reads
    //       pinnedFallback.models directly when the central-discovery
    //       bridge skips the entry (specialty modalities, first-party
    //       native). The plugin manager surfaces those models to
    //       /v1/models via the same registry pipeline.
    //
    // Path (b) is what makes specialty execution-only entries
    // (image-only, video-only, speech-only) and first-party-native
    // execution-only entries (replicate) legitimately reachable.
    // The Zod refinement (Rule 5) already guarantees pinnedFallback
    // exists; this invariant asserts that the read paths cover every
    // class.
    const COVERED_NON_OAI_CLASSES = new Set([
      // Specialty single-modality (path b): image-only ships flux/recraft
      // shortlists, video-only ships gen3a/runwayml, speech-only ships
      // TTS voices, embeddings-only ships voyage-style families.
      'image-only',
      'video-only',
      'speech-only',
      'embeddings-only',
      // First-party-native (path b): replicate has /v1/models but
      // operator opted for a curated-shortlist; inventory comes from
      // catalog-provider-plugin.listModels() reading pinnedFallback.
      'first-party-native',
    ]);

    const violators: Array<{ providerId: string; reason: string }> = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'execution-only') continue;

      // Path (a): OAI-compat, catalog-bridge handles it.
      if (isOpenAICompatibleEntry(entry)) continue;

      // Path (b): non-OAI but in a class whose plugin path
      // materializes pinnedFallback directly.
      if (COVERED_NON_OAI_CLASSES.has(entry.integrationClass)) continue;

      violators.push({
        providerId: entry.providerId,
        reason: `execution-only with integrationClass=${entry.integrationClass} not covered by catalog-bridge (path a) or catalog-provider-plugin specialty/native path (path b)`,
      });
    }
    expect(violators).toEqual([]);
  });
});
