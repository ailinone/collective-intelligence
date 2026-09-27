// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * /v1/models error responses (catalog load audit 2026-09-24, R3).
 *
 * Before: every failure answered 500 with `error.message` verbatim, so a
 * catalog load failure published the internal Prisma text (invocation,
 * "canceling statement due to statement timeout") to anonymous callers, and
 * a transient catalog outage looked like a server bug instead of 503.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogUnavailableError } from '@/services/catalog-errors';
import { buildModelsRouteErrorResponse } from '../models-route-errors';

const PRISMA_TEXT =
  'Invalid `prisma.model.findMany()` invocation: canceling statement due to statement timeout';

describe('buildModelsRouteErrorResponse', () => {
  it('maps CatalogUnavailableError to 503 with Retry-After, without the underlying cause', () => {
    const error = new CatalogUnavailableError(2_500, { cause: new Error(PRISMA_TEXT) });

    const response = buildModelsRouteErrorResponse(error, 'Failed to list models');

    expect(response.statusCode).toBe(503);
    expect(response.retryAfterSeconds).toBe(3);
    expect(response.body.error.code).toBe('catalog_unavailable');
    expect(JSON.stringify(response.body)).not.toMatch(/prisma|statement|findMany/i);
  });

  it('recognizes a CatalogUnavailableError from another module instance (structural check)', () => {
    const foreign = Object.assign(new Error('Model catalog is temporarily unavailable'), {
      code: 'catalog_unavailable',
      retryAfterSeconds: 7,
    });

    const response = buildModelsRouteErrorResponse(foreign, 'Failed to list models');

    expect(response.statusCode).toBe(503);
    expect(response.retryAfterSeconds).toBe(7);
  });

  it('maps any other error to 500 with the fixed message, never the internal one', () => {
    const response = buildModelsRouteErrorResponse(new Error(PRISMA_TEXT), 'Failed to list models');

    expect(response.statusCode).toBe(500);
    expect(response.retryAfterSeconds).toBeUndefined();
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Failed to list models' },
    });
  });

  it('handles non-Error throwables', () => {
    const response = buildModelsRouteErrorResponse('raw string failure', 'Failed to fetch model');
    expect(response.statusCode).toBe(500);
    expect(response.body.error.message).toBe('Failed to fetch model');
  });
});

describe('CatalogUnavailableError', () => {
  it('rounds Retry-After up to whole seconds, at least 1', () => {
    expect(new CatalogUnavailableError(1).retryAfterSeconds).toBe(1);
    expect(new CatalogUnavailableError(0).retryAfterSeconds).toBe(1);
    expect(new CatalogUnavailableError(1_001).retryAfterSeconds).toBe(2);
    expect(new CatalogUnavailableError(Number.NaN).retryAfterSeconds).toBe(1);
  });
});

describe('models-routes.ts error handlers (source guard)', () => {
  const source = readFileSync(join(__dirname, '..', 'models-routes.ts'), 'utf8');

  it('never serializes the caught error message into a response body', () => {
    expect(source).not.toMatch(/message:\s*errorMessage/);
    expect(source).not.toMatch(/status\(500\)/);
  });

  it('routes both handlers through buildModelsRouteErrorResponse', () => {
    const uses = source.match(/buildModelsRouteErrorResponse\(error,/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(source).toMatch(/reply\.header\('Retry-After'/);
  });
});
