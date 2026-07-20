// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ModelProviderOffering — como um provider/serving provider oferece,
 * nomeia ou aliasa um CanonicalModel.
 *
 * MVP 1 invariant: type-only declaration. No I/O, no imports of runtime
 * services. Construction happens in later MVPs from the existing `Model`
 * rows in Postgres (one Offering per `(providerId, modelId)` pair).
 *
 * Pertinência:
 *   - aliases, provider naming → ModelProviderOffering
 *   - semantic, capabilities canônicas, freshness → CanonicalModel
 *   - endpoint, pricing, quota, health, latência → ProviderModelRoute
 */

import type { OfferingLifecycle } from './types';

/**
 * One provider's offering of a canonical model. The current `Model` row
 * in Postgres maps 1:1 to a `ModelProviderOffering` — see audit § 7 for
 * the field mapping.
 */
export interface ModelProviderOffering {
  /** Stable id. Equivalent to `Model.uid` in current schema. */
  readonly offeringId: string;

  /** FK to `CanonicalModel.canonicalModelId`. May be resolved heuristically. */
  readonly canonicalModelId: string;

  /**
   * Attribution owner — who built the model. May differ from
   * `servingProviderId` when a hub re-serves a third-party model
   * (e.g. `aihubmix` serving `claude-opus-4-7` → `modelOwner='anthropic'`).
   */
  readonly modelOwner: string;

  /** Who actually serves it. Equivalent to `Model.providerId`. */
  readonly servingProviderId: string;

  /** What the provider calls it. Equivalent to `Model.id`. */
  readonly providerModelId: string;

  /**
   * Names tolerated on input that should resolve to this offering.
   * Drawn from `Provider.aliases` + observed alt-spellings.
   */
  readonly aliases: ReadonlyArray<string>;

  /**
   * Capabilities AS DECLARED BY THE PROVIDER. The canonical merged
   * capability set lives in `CanonicalModel.normalizedCapabilities`.
   */
  readonly providerReportedCapabilities: ReadonlyArray<string>;

  readonly providerReportedContextWindow: number;
  readonly providerReportedMaxOutputTokens: number;

  /** Per-offering lifecycle — independent of CanonicalModel.lifecycle. */
  readonly lifecycle: OfferingLifecycle;

  /** ISO timestamps from discovery. */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastNormalizedAt: string;
}
