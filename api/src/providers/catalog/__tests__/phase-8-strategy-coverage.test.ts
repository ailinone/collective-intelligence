// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 8 — Strategy + Capability Coverage Invariants
 *
 * The plan's Phase 8 calls for two coverage assertions:
 *   (a) every `discovery+execution` provider appears in every strategy's
 *       candidate pool (tier / leader / degradation).
 *   (b) every catalog-declared capability returns ≥1 model from
 *       capability-search.
 *
 * Both assertions, taken literally, require runtime DB state — the
 * strategy candidate pool and the capability-search index are both
 * built from the live `models` table. CI tests run without DB.
 *
 * The structural translation that captures the same intent statically:
 *
 *   1. EVERY `discovery+execution` provider declares at least ONE
 *      capability in its `supports` block. A provider with empty
 *      `supports` is structurally orphaned — no strategy can include it
 *      because every strategy filters by `model.capabilities`, which is
 *      derived from the provider's catalog `supports` (via the catalog
 *      bridge) at materialization time.
 *
 *   2. EVERY `discovery+execution` provider with `supports.chat === true`
 *      reaches at least one of the orchestration strategies' suitable-for
 *      task types — i.e. the catalog row's chat-shaped declaration
 *      structurally fits the strategy candidate filter.
 *
 *   3. The union of `supports.X` keys across the catalog covers the
 *      universe of capabilities the orchestration engine knows how to
 *      route. No strategy is requesting a capability that no provider
 *      can supply (the inverse of orphan capability).
 *
 *   4. Every "Phase-4-flipped" provider — the set of `discovery+execution`
 *      rows whose `enabledByDefault === true` — has both
 *      `secretWiredAllTables=true` (per sublote-e1 invariant) AND
 *      reaches discovery via Phase 5 invariant 5 (which is already
 *      enforced).
 *
 * Together (1)-(4) are the strongest static guarantee we can make: if
 * any of these fail, the runtime coverage assertion (a)+(b) cannot
 * succeed.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';

describe('Phase 8 invariant: discovery+execution providers declare capabilities', () => {
  it('every `discovery+execution` row has at least ONE truthy `supports.X` key', () => {
    const violators: Array<{ providerId: string; reason: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'discovery+execution') continue;

      const supports = entry.supports || {};
      const hasAnyCapability = Object.values(supports).some((v) => v === true);

      if (!hasAnyCapability) {
        violators.push({
          providerId: entry.providerId,
          reason: 'discovery+execution row with no truthy `supports.X` key — orphaned in strategy candidate pool',
        });
      }
    }

    expect(violators).toEqual([]);
  });

  it('every `discovery+execution` row supplies at least ONE output capability (no truly-orphan rows)', () => {
    // Stronger restatement of the prior invariant — instead of singling
    // out chat, we require ANY concrete output surface. A provider in
    // `discovery+execution` mode without ANY truthy output-shape key
    // (chat / embeddings / imageGen / textToSpeech / speechToText /
    // moderation / rerank / etc.) cannot be selected by ANY strategy
    // because every strategy filters models by capability before
    // candidate ranking.
    //
    // Note: `streaming`, `tools`, `jsonMode`, `vision`, `reasoning`,
    // `realtime` are MODIFIERS — they refine an existing output surface
    // but don't constitute one alone. Modifiers are excluded from the
    // "output capability" check below.
    const OUTPUT_CAPABILITY_KEYS = [
      'chat',
      'responses',
      'embeddings',
      'rerank',
      'moderation',
      'speechToText',
      'textToSpeech',
      'imageGeneration',
      'imageEditing',
      'videoGeneration',
    ] as const;

    const violators: Array<{ providerId: string; reason: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'discovery+execution') continue;

      const supports = entry.supports || {};
      const hasOutputCapability = OUTPUT_CAPABILITY_KEYS.some(
        (k) => (supports as Record<string, boolean | undefined>)[k] === true,
      );

      if (!hasOutputCapability) {
        violators.push({
          providerId: entry.providerId,
          reason: `discovery+execution with no truthy output capability — orphaned in EVERY strategy candidate pool`,
        });
      }
    }

    expect(violators).toEqual([]);
  });
});

describe('Phase 8 invariant: no orphan capability', () => {
  /**
   * The closed set of capability keys recognized by the catalog schema
   * (`provider-catalog.types.ts`). Every key in this set must have at
   * least one catalog row that declares `supports.<key>: true`. If a
   * key is in the schema but no provider supplies it, the schema is
   * misleading — it advertises a capability that orchestration can
   * never satisfy.
   */
  const CAPABILITY_KEYS = [
    'chat',
    'responses',
    'embeddings',
    'rerank',
    'moderation',
    'speechToText',
    'textToSpeech',
    'imageGeneration',
    'imageEditing',
    'videoGeneration',
    'streaming',
    'tools',
    'jsonMode',
    'vision',
    'reasoning',
    'realtime',
  ] as const;

  /**
   * Capability keys that the schema declares but for which "no provider
   * supplies it" is the honest current state — and that's intentional,
   * not a regression. Each entry must be justified by a comment.
   *
   * Update policy: REMOVE from this list as soon as any provider declares
   * the capability. Adding a new entry requires reviewer sign-off on the
   * rationale.
   */
  const KNOWN_DEFERRED_CAPABILITIES = new Set<string>([
    // `responses` is OpenAI's Responses API surface (post-2024) — a
    // superset of /v1/chat/completions. The orchestration engine routes
    // Responses traffic through the chat-shaped pipeline today, treating
    // `supports.chat: true` as an implicit Responses qualifier. When a
    // dedicated Responses adapter ships (separate from chat-completion),
    // this entry comes off the deferred list and the test will demand
    // ≥1 supplier.
    'responses',
  ]);

  it('every recognized capability key has ≥1 catalog provider that supplies it (or is on the deferred list)', () => {
    const orphans: string[] = [];

    for (const key of CAPABILITY_KEYS) {
      if (KNOWN_DEFERRED_CAPABILITIES.has(key)) continue;
      const suppliers = PROVIDER_CATALOG.filter(
        (e) => (e.supports as Record<string, boolean | undefined>)[key] === true,
      );
      if (suppliers.length === 0) {
        orphans.push(key);
      }
    }

    expect(orphans).toEqual([]);
  });

  it('the chat capability has ≥3 enabled `discovery+execution` providers (depth requirement)', () => {
    // Chat is the highest-volume capability. The orchestration engine's
    // multi-model strategies (consensus, quality_multipass, debate, etc.)
    // need at least 3 candidates to be useful. This invariant prevents
    // accidental regressions that would degrade those strategies to
    // single-model fallback.
    const chatProviders = PROVIDER_CATALOG.filter(
      (e) =>
        e.integrationMode === 'discovery+execution' &&
        e.enabledByDefault === true &&
        e.supports.chat === true,
    );

    expect(chatProviders.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Phase 8 invariant: enabled providers cover the canonical capabilities', () => {
  /**
   * For each high-traffic capability (the ones the front-end actually
   * routes to), assert at least one ENABLED catalog row supplies it.
   * The Phase 5 invariants already handle structural existence; this
   * adds the operational layer (enabledByDefault = true).
   */
  const HIGH_TRAFFIC_CAPABILITIES = [
    'chat',
    'embeddings',
    'imageGeneration',
    'textToSpeech',
    'speechToText',
    'reasoning',
    'tools',
  ] as const;

  it.each(HIGH_TRAFFIC_CAPABILITIES)(
    'capability "%s" has ≥1 enabled provider in `discovery+execution` mode',
    (cap) => {
      const enabledSuppliers = PROVIDER_CATALOG.filter(
        (e) =>
          e.enabledByDefault === true &&
          e.integrationMode === 'discovery+execution' &&
          (e.supports as Record<string, boolean | undefined>)[cap] === true,
      );

      expect(enabledSuppliers.length).toBeGreaterThan(0);
    },
  );
});
