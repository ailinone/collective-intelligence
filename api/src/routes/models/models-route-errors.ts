// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Error responses for the /v1/models routes.
 *
 * The handlers used to answer every failure with 500 and `error.message`
 * verbatim, which on a catalog load failure published the internal Prisma
 * text (query shape, table names, "canceling statement due to statement
 * timeout") to anonymous callers (catalog load audit 2026-09-24, R3).
 *
 * Now:
 *   - CatalogUnavailableError (no servable catalog, loader timed out, failed
 *     or is backing off) -> 503 + Retry-After, a transient condition;
 *   - anything else -> 500 with a fixed message.
 * The real error is only logged by the handler, never serialized.
 *
 * Dependency-light (only catalog-errors.ts) so it is unit-testable without
 * the provider registry or Prisma.
 */
import { isCatalogUnavailableError } from '@/services/catalog-errors';

export interface ModelsRouteErrorResponse {
  statusCode: 500 | 503;
  /** Set for 503: value of the Retry-After header, in whole seconds. */
  retryAfterSeconds?: number;
  body: { error: { code: string; message: string } };
}

export function buildModelsRouteErrorResponse(
  error: unknown,
  genericMessage: string
): ModelsRouteErrorResponse {
  if (isCatalogUnavailableError(error)) {
    return {
      statusCode: 503,
      retryAfterSeconds: error.retryAfterSeconds,
      body: {
        error: {
          code: 'catalog_unavailable',
          message: 'The model catalog is temporarily unavailable. Retry after the Retry-After interval.',
        },
      },
    };
  }
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: genericMessage } },
  };
}
