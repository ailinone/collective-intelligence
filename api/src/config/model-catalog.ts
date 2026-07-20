// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ProviderCatalogEntry } from '@/services/model-catalog-service';

/**
 * DEPRECATED — kept ONLY as a shape-stable empty export.
 *
 * Until 2026-04-27 this module exported a 1768-line hand-curated bootstrap
 * catalog of OpenAI/Anthropic/Google models. The `/v1/models` route used it
 * as a fallback when the database was empty, materialising the static rows
 * directly into the response body.
 *
 * That fallback violated the SOTA dynamic-discovery policy: the route was
 * advertising models that were not necessarily reachable, hiding genuine
 * cold-start emptiness behind invented inventory. The route now reflects
 * only the runtime-materialised catalog (DB rows populated by
 * `central-model-discovery-service`); cold-start returns an empty list +
 * a warn log instead of a synthetic catalog.
 *
 * Why we keep this file as an empty stub instead of deleting it:
 *   - Preserves the exported symbol so any unforeseen historical import
 *     compiles to a no-op (empty array) rather than a hard build failure.
 *   - Makes the deprecation explicit in code, reviewable in a single diff,
 *     and unambiguous to anyone considering re-introducing a static seed.
 *   - The accompanying CI guard
 *     (`api/src/__tests__/architecture/no-static-model-catalog-fallback.test.ts`)
 *     blocks new imports of this symbol from production paths.
 *
 * If you find yourself wanting to re-add hand-curated model rows here,
 * STOP. That's the bug we just fixed. Add a real provider model fetcher
 * under `services/model-fetchers/` instead, register it in
 * `central-model-discovery-service.ts`, and let discovery populate the
 * database on its own.
 */
export const DEFAULT_MODEL_CATALOG: readonly ProviderCatalogEntry[] = [];
