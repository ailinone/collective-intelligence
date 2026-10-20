// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GET /v1/models/strategies (CAT-001 / A1) — the versioned collective-strategy
 * catalog.
 *
 * Response: `{ catalogVersion: "v1", strategies: descriptor[] }` where every
 * descriptor is built by strategy-descriptors.ts from
 * `listOfferedPricingCells() ∩ STRATEGY_POLICY.executionReady` (that filter is
 * listOfferedPricingCells' own). ALL 8 executionReady families appear here —
 * CI returns the truth; Chat's BFF is the layer that filters to Phase 1
 * exposure (spec: "chat BFF filters to Phase 1 exposure — CI returns truth").
 * Shadow-wired families (debate, war-room, …) are structurally absent:
 * isOfferedCell/listOfferedPricingCells never emit them.
 *
 * Route conventions mirror models-routes.ts: authentication is handled by the
 * global middleware (the catalog itself is a public, read-only surface — the
 * A2 chat-identity bulk ban lives on the model LIST routes, whose `?all=true`
 * stream is the payload-size hazard; this endpoint's payload is bounded by
 * construction: offered cells only, currently 27 rows).
 */

import type { FastifyInstance } from 'fastify';
import { buildStrategyCatalog, STRATEGY_CATALOG_VERSION } from './strategy-descriptors';

export function registerStrategyCatalogRoutes(server: FastifyInstance): void {
  server.get(
    '/v1/models/strategies',
    {
      schema: {
        tags: ['Models'],
        security: [],
        description:
          'List the collective strategy targets (`<family>:<tier>` cells) as VERSIONED descriptors ' +
          '(catalogVersion "v1"). Built from the offered pricing cells ∩ the executionReady strategy ' +
          'policy — every family here genuinely executes today; shadow-wired strategies are absent by ' +
          'construction. `selectable` is derived (executionReady && operability === "operational"), ' +
          'never hand-set. `capabilities` is per-target truth (consensus does NOT advertise streaming — ' +
          'its execution blocks the streaming path until evaluator parity lands). `pricing` is an ' +
          'allowlist projection: currency + declared per-1M-token list rates only. Chat fails closed on ' +
          'unknown catalogVersion/kind/enum values.',
        response: {
          200: {
            description: 'Strategy catalog',
            type: 'object',
            required: ['catalogVersion', 'strategies'],
            properties: {
              catalogVersion: { type: 'string', const: STRATEGY_CATALOG_VERSION },
              strategies: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            additionalProperties: false,
          },
        },
      },
      // Authentication handled by global middleware
    },
    async (_request, reply) => {
      const catalog = buildStrategyCatalog();
      return reply.send(catalog);
    }
  );
}
