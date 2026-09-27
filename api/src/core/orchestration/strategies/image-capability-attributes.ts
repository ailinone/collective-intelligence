// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ImageCapabilityAttributes — LOCAL STUB, Section D dependency on Section B.
 *
 * Section B ("Attribute-aware catalog — generic type + 3-tier discovery")
 * defines the CANONICAL `ImageCapabilityAttributes` as part of a generic
 * `capabilityAttributes: Partial<Record<Capability, CapabilityAttributes>>`
 * on `ProviderCatalogEntry` (`api/src/providers/catalog/provider-catalog.types.ts`,
 * sibling to the real `VideoCapabilityAttributes` at line 247 of that file).
 *
 * As of this plan's writing (2026-09-23), Section B's plan had not yet been
 * executed in this codebase — `ImageCapabilityAttributes` did not exist
 * anywhere. Section D (image editing with verify) needs SOME shape for
 * "dimensions, supported formats" to keep `image-deterministic-gate.ts`'s
 * request-vs-actual comparison type-safe, so this file defines a minimal
 * local stand-in.
 *
 * TODO(section-B-dependency): once Section B's plan lands and defines the
 * real `ImageCapabilityAttributes` in `provider-catalog.types.ts`, delete
 * this file and re-point every import of it (currently only
 * `image-deterministic-gate.ts`) at the real type instead. The field names
 * below were chosen to match Section B's own spec wording ("dimensions,
 * supported formats") as closely as possible so the swap should not require
 * changing any call site's logic — only the import path.
 */
export interface ImageCapabilityAttributes {
  readonly maxWidthPx?: number;
  readonly maxHeightPx?: number;
  readonly minWidthPx?: number;
  readonly minHeightPx?: number;
  /** Lowercase format identifiers, e.g. ['png', 'jpeg', 'webp'] — matches
   *  the `type` string the `image-size` library returns (see
   *  `image-deterministic-gate.ts`), not a MIME type. */
  readonly supportedFormats?: readonly string[];
  readonly attributesVerifiedAt?: string;
}
