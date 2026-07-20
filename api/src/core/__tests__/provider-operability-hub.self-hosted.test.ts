// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Coherence guard: `SELF_HOSTED_PROVIDERS` set in
 * `core/provider-operability-hub.ts` must contain EVERY catalog entry whose
 * `integrationClass` starts with `self-hosted-`.
 *
 * ## Why this test exists
 *
 * `SELF_HOSTED_PROVIDERS` is a policy-level classification set used by
 * multiple cross-cutting concerns:
 *   - balance-check skipping (local providers have no external credit)
 *   - primary-pool exclusion (local providers are never "first-choice")
 *   - self-healing discovery special-casing
 *
 * Those consumers read a hand-maintained set rather than the catalog's
 * `integrationClass` field. That's intentional — the catalog answers
 * "how do we talk to this provider", not "does it need credit management" —
 * but it creates a drift risk: if someone adds a new self-hosted-*
 * catalog row without updating the classification set, the new provider
 * leaks into balance probes and primary-pool selection.
 *
 * This test catches that drift by asserting the forward direction:
 *
 *    catalog.integrationClass startsWith 'self-hosted-'  ⇒  SELF_HOSTED_PROVIDERS.has(providerId)
 *
 * It deliberately does NOT assert the reverse direction (set entries like
 * `local-ocr` / `local-docling` are intentionally absent from the catalog
 * because the `integrationClass` enum doesn't yet cover their non-OAI
 * shapes — OCR, PDF→JSON, TTS, translation).
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../providers/catalog/providers.catalog';
import { getSelfHostedProvidersForTesting } from '../provider-operability-hub';

describe('provider-operability-hub: SELF_HOSTED_PROVIDERS coherence', () => {
  it('contains every catalog entry classified as self-hosted-*', () => {
    const catalogSelfHostedIds = PROVIDER_CATALOG.filter((entry) =>
      entry.integrationClass.startsWith('self-hosted-'),
    ).map((entry) => entry.providerId);

    // Smoke: the catalog MUST already have at least one self-hosted entry
    // (ollama, local-llama, local-kobold, local-embeddings as of 2026-04-22).
    // If this fires it means the catalog lost its self-hosted rows entirely —
    // that would be a real regression, not a drift.
    expect(catalogSelfHostedIds.length).toBeGreaterThan(0);

    const selfHosted = getSelfHostedProvidersForTesting();
    const missing = catalogSelfHostedIds.filter((id) => !selfHosted.has(id));

    // If this fires: a new `self-hosted-*` catalog row was added without
    // updating the `SELF_HOSTED_PROVIDERS` set in provider-operability-hub.ts.
    // The fix is to append the providerId to that set (not to remove it
    // from the catalog). Downstream policy consumers — balance-check
    // skipping, primary-pool exclusion — depend on the set, not the
    // catalog, so drift here means new providers silently pay external-
    // credit overhead they don't actually have.
    expect(missing).toEqual([]);
  });
});
