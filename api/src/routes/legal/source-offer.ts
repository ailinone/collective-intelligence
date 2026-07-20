// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AGPL §13 — "Remote Network Interaction" source offer.
 *
 * The AGPL requires that if a MODIFIED version of this program is made available
 * to users interacting with it over a network, those users must be offered the
 * program's Corresponding Source. This public, unauthenticated endpoint is that
 * offer: it tells any network user where to obtain the complete source of the
 * running version.
 *
 * Operators who deploy a MODIFIED build MUST update SOURCE_URL (via the
 * AGPL_SOURCE_URL env var) to point at *their* published modified source — that
 * is precisely the obligation §13 imposes. The env override exists so that
 * fulfilling the obligation is a one-line configuration change, not a code fork.
 */

import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { config } from '@/config';

const CANONICAL_SOURCE = 'https://github.com/ailinone/collective-intelligence';

function sourceUrl(): string {
  // A modified network deployment sets AGPL_SOURCE_URL to its own source repo.
  return process.env.AGPL_SOURCE_URL || CANONICAL_SOURCE;
}

const sourceOfferRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /source — AGPL §13 Corresponding Source offer (JSON).
   */
  fastify.get('/source', async (_request, reply) => {
    const modified = !!process.env.AGPL_SOURCE_URL && process.env.AGPL_SOURCE_URL !== CANONICAL_SOURCE;
    return reply.status(200).send({
      program: 'Collective Intelligence Engine (ci)',
      copyright: '(C) 2026 Ailin One, Inc.',
      license: 'AGPL-3.0-or-later',
      license_url: 'https://www.gnu.org/licenses/agpl-3.0.html',
      // The Corresponding Source of THIS running instance, per AGPL §13.
      corresponding_source: sourceUrl(),
      canonical_upstream: CANONICAL_SOURCE,
      is_modified_deployment: modified,
      version: config.app.version,
      notice:
        'This service runs software licensed under the GNU AGPL-3.0-or-later. ' +
        'You are entitled to the complete corresponding source code of the version ' +
        'running here, at the URL in "corresponding_source".',
    });
  });

  /**
   * GET /license — short machine/human hint pointing at the full terms.
   */
  fastify.get('/license', async (_request, reply) => {
    return reply.status(200).send({
      license: 'AGPL-3.0-or-later',
      full_text: 'https://www.gnu.org/licenses/agpl-3.0.txt',
      source_offer: '/source',
    });
  });
};

export function registerSourceOffer(fastify: FastifyInstance): void {
  fastify.register(sourceOfferRoutes);
}
