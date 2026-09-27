// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Generic capability-attribute predicate — LOTE AZ (2026-09-23).
 *
 * Dispatches to the per-capability matcher based on the `capability` key
 * (the map key IS the discriminant — see `CapabilityAttributes`'s doc
 * comment in provider-catalog.types.ts). Enforces one cross-cutting rule
 * ahead of dispatch: an `llm_draft`-sourced attribute object is NEVER used
 * to accept or reject a candidate — it is treated as if it were absent
 * (fail-open), exactly like an undeclared field. Drafts only ever reach a
 * human via the admin endpoints in `catalog-attribute-drafts-admin-routes.ts`.
 */
import type { ModelCapability } from '@/types';
import type { CapabilityAttributes } from './provider-catalog.types';
import {
  canSatisfyVideoAttributes,
  type VideoAttributeRequest,
} from './video-capability-matcher';
import {
  canSatisfyImageAttributes,
  type ImageAttributeRequest,
} from './image-capability-matcher';
import {
  canSatisfyDocumentAttributes,
  type DocumentAttributeRequest,
} from './document-capability-matcher';

export type CapabilityAttributeRequest =
  | VideoAttributeRequest
  | ImageAttributeRequest
  | DocumentAttributeRequest;

export function canSatisfyCapabilityAttributes(
  capability: ModelCapability,
  attrs: CapabilityAttributes | undefined,
  request: CapabilityAttributeRequest
): boolean {
  const effectiveAttrs = attrs && attrs.source === 'llm_draft' ? undefined : attrs;

  switch (capability) {
    case 'video_generation':
      return canSatisfyVideoAttributes(effectiveAttrs, request as VideoAttributeRequest);
    case 'image_generation':
    case 'image_editing':
      return canSatisfyImageAttributes(effectiveAttrs, request as ImageAttributeRequest);
    case 'pdf_understanding':
      return canSatisfyDocumentAttributes(effectiveAttrs, request as DocumentAttributeRequest);
    default:
      // No matcher registered for this capability yet — fail open, same
      // convention as an undeclared field within a known matcher.
      return true;
  }
}
