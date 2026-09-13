// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AT (2026-09-09) — GAP-AK-6 closure: relace promoted from
 * `catalog-only` (fabricated 3-model pinnedFallback) to
 * `discovery+execution` after the official OpenAPI spec
 * (docs.relace.ai/api-reference/openapi.json) confirmed a real
 * `GET /models` on `models.relace.ai` — "the catalog for open-weight
 * models hosted by Relace" — returning a shape extractRawModels /
 * convertRawModel already handle ({data:[{id,context_length,pricing,
 * input_modalities,output_modalities,...}]}), Bearer-authed.
 *
 * This closes the exact blocker `lote-al-gap-ak6-closure.test.ts` recorded
 * on 2026-09-05: a host mismatch between the documented `/models`
 * (models.relace.ai) and the row's then-baseUrl
 * (instantapply.endpoint.relace.run, which does not appear anywhere in the
 * current OpenAPI spec's servers list). The mismatch is resolved by moving
 * baseUrl to `models.relace.ai/v1` (so the default `/chat/completions` path
 * composes to the spec's documented `/v1/chat/completions`) and registering
 * discovery as a dedicated `relace-native` aggregator source in
 * central-model-discovery-service.ts — the same absolute-URL-override
 * pattern already proven for `github-models-native`, since
 * `paths.modelList` can only express relative paths and can't reach a
 * host-root `/models` that sits outside this row's `/v1` baseUrl.
 *
 * Of the 3 previously pinned ids, only `relace-apply-3` is independently
 * confirmed real in the spec (the sole enum value of
 * `InstantApplyRequest.model`) — `relace-code-reranker` and
 * `relace-embedding` appear NOWHERE in the spec (no `/v1/embeddings` path
 * exists at all). None of the 3 are carried forward as catalog rows: they
 * are fixed single-purpose tool contracts (code-apply / rerank / compact /
 * search), not a family of interchangeable chat models — see the `relace`
 * catalog entry's own notes for the full rationale. Locks in the
 * reclassification so a future edit can't silently reintroduce a hardcoded
 * inventory for this row (zero-hardcode policy).
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { DISCOVERY_COMPLIANCE_REGISTRY } from '../consolidation-matrix';

describe('LOTE AT GAP-AK-6 closure: relace discovery promotion', () => {
  const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'relace');

  it('relace catalog row is discovery+execution with no pinnedFallback', () => {
    expect(entry).toBeTruthy();
    expect(entry!.integrationMode).toBe('discovery+execution');
    expect(entry!.integrationClass).toBe('oai-compat-pure');
    expect(entry!.pinnedFallback).toBeUndefined();
  });

  it('relace baseUrl points at the current OpenAPI-documented host (models.relace.ai), not the retired instantapply host', () => {
    expect(entry!.baseUrl).toBe('https://models.relace.ai/v1');
    expect(entry!.baseUrl).not.toContain('instantapply.endpoint.relace.run');
  });

  it('relace moved out of discovery-compliance non-compliant-hardcoded-inventory', () => {
    expect(DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-hardcoded-inventory']).not.toContain(
      'relace'
    );
  });

  it('relace is now registered as compliant-dynamic-discovery', () => {
    expect(DISCOVERY_COMPLIANCE_REGISTRY['compliant-dynamic-discovery']).toContain('relace');
  });

  it('inflection (the other proprietary-schema debt row) is untouched by this closure', () => {
    // Only relace's blocker was resolved this lot — inflection's non-OAI
    // discovery shape is a separate, still-open parser gap: this closure
    // adds no inflection discovery parser, so it stays in
    // non-compliant-hardcoded-inventory.
    expect(DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-hardcoded-inventory']).toContain(
      'inflection'
    );
    // integrationMode is 'catalog-only', NOT the 'execution-only' this
    // guard originally pinned when written (2026-09-09, against the
    // 2026-06-15 promotion). Main's #561 (2026-09-10, merged into this
    // branch by 618852dd) reverted that promotion after PR #555's live
    // re-probe with a real INFLECTION_API_KEY found the ENTIRE
    // api.inflection.ai host unreachable — an identical generic nginx 404
    // for every path/method/auth combination, including the
    // /v1/chat/completions surface the promotion was premised on, and
    // developers.inflection.ai fails DNS outright. 'execution-only' would
    // keep routing live chat attempts at a host that 404s unconditionally.
    // See the inflection catalog row's comment and consolidation-matrix's
    // 'defunct-unreachable' bucket for the evidence trail. Relace's closure
    // itself makes no change to inflection either way — this assertion only
    // tracks the state main already established.
    const inflectionEntry = PROVIDER_CATALOG.find((e) => e.providerId === 'inflection');
    expect(inflectionEntry?.integrationMode).toBe('catalog-only');
  });
});
