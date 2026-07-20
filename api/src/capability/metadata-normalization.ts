// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Single-call metadata normalization for the discovery persistence path.
 *
 * Closes the same kind of gap the Chip 6 endpoint inference closed, but for
 * `tools`. Each normalization is a separate module so the rules can be
 * tested in isolation; this composer is the function the seven persistence
 * sites in `central-model-discovery-service.ts` actually call.
 *
 * Why a composer instead of inlining `withInferredTools(withInferredEndpoint(...))`
 * at every call site:
 *
 *   - Seven call sites × two helpers = fourteen places where someone could
 *     forget the second helper. The composer makes "all metadata
 *     normalizations" a single-line change as we add more (provider
 *     reliability defaults, deprecation flags, etc.).
 *   - The fetcher path normalizes only `endpoint` today (it sets `tools`
 *     directly via `extractTools`). When we eventually fold the fetcher
 *     `extractTools` into this composer too, the seam is already in place.
 *
 * The composer does not reorder existing keys or drop unknown fields:
 * `passthrough()` semantics in the metadata schema preserve whatever the
 * caller wrote.
 */

import { withInferredEndpoint } from './endpoint-inference';
import { withInferredTools } from './tools-inference';

export function withNormalizedMetadata<T extends Record<string, unknown>>(
  metadata: T,
  capabilities: readonly string[],
): T & { endpoint: string; tools: string[] } {
  return withInferredTools(withInferredEndpoint(metadata, capabilities), capabilities);
}
