// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Document/PDF capability attribute matcher — LOTE AZ (2026-09-23).
 * Same fail-open/fail-closed contract as the video/image matchers.
 */
import type { DocumentCapabilityAttributes } from './provider-catalog.types';

export interface DocumentAttributeRequest {
  readonly pageCount?: number;
}

export function canSatisfyDocumentAttributes(
  attrs: DocumentCapabilityAttributes | undefined,
  request: DocumentAttributeRequest
): boolean {
  if (!attrs) return true;
  if (request.pageCount !== undefined && attrs.maxPages !== undefined) {
    if (request.pageCount > attrs.maxPages) return false;
  }
  return true;
}
