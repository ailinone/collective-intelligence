// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Typed failure of the in-process catalog cache (model-catalog-service.ts).
 *
 * Raised when no usable catalog can be served: the load timed out or failed
 * and the last-good copy is missing or older than the stale-if-error bound,
 * or the loader is backing off after a recent failure. HTTP routes map it to
 * 503 with Retry-After instead of leaking the underlying Prisma/Postgres
 * message in a 500. The original error stays available as `cause` for logs.
 *
 * Kept in its own dependency-free module so route error mapping can be unit
 * tested without importing Prisma or Redis.
 */
export class CatalogUnavailableError extends Error {
  readonly code = 'catalog_unavailable' as const;
  /** Whole seconds, at least 1, suitable for a Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number, options?: { cause?: unknown }) {
    super('Model catalog is temporarily unavailable', options);
    this.name = 'CatalogUnavailableError';
    const seconds = Number.isFinite(retryAfterMs) ? Math.ceil(retryAfterMs / 1000) : 1;
    this.retryAfterSeconds = Math.max(1, seconds);
  }
}

/** Structural check as well as instanceof: a module graph reset (tests,
 *  hot reload) can yield two copies of the class. */
export function isCatalogUnavailableError(error: unknown): error is CatalogUnavailableError {
  if (error instanceof CatalogUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; retryAfterSeconds?: unknown };
  return (
    candidate.code === 'catalog_unavailable' &&
    typeof candidate.retryAfterSeconds === 'number' &&
    Number.isFinite(candidate.retryAfterSeconds)
  );
}
