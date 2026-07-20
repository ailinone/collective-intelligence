// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Training Data Admin Routes (F3.3)
 *
 * Operator endpoints for the training-data export pipeline. The job runs
 * automatically at 02:00 UTC, but operators sometimes need to:
 *   - Trigger an ad-hoc export to test a watermark advance
 *   - Read the current watermark state without shelling into the DB
 *   - Inspect the latest extraction manifest after an emergency run
 *
 * Endpoints:
 *   POST /v1/admin/training-data/export    — trigger an ad-hoc export now
 *   GET  /v1/admin/training-data/state     — current watermark state per stream
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { runTrainingDataExport } from '@/jobs/training-data-export-job';
import { prisma } from '@/database/client';

const log = logger.child({ component: 'training-data-admin' });

interface ExtractionStateRow {
  extraction_type: string;
  last_watermark: Date;
  last_extraction_id: string | null;
  rows_extracted: bigint;
  updated_at: Date;
}

export async function registerTrainingDataAdminRoutes(server: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/training-data/export — Trigger an ad-hoc export
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Returns the manifest produced by the export. Errors propagate as 500.
  // Concurrency: this is fire-and-forget at the API level — if two operators
  // fire it simultaneously, both will run and the second will see an empty
  // window because the first will have advanced the watermark.

  server.post(
    '/v1/admin/training-data/export',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'TrainingData'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      log.info('Admin-triggered training-data export');
      try {
        const manifest = await runTrainingDataExport();
        return reply.send({
          ok: true,
          extractionId: manifest.extraction_id,
          extractedAt: manifest.extracted_at,
          counts: {
            outcomes: manifest.outcomes.row_count,
            shadow: manifest.shadow.row_count,
            collectiveRuns: manifest.collective.runs.row_count,
            collectiveSignals: manifest.collective.signals.row_count,
          },
          watermarks: manifest.watermarks,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ error: msg }, 'Ad-hoc training-data export failed');
        return reply.status(500).send({
          ok: false,
          error: 'training_data_export_failed',
          message: msg,
        });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/training-data/state — Watermark state per stream
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/training-data/state',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'TrainingData'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const rows = await prisma.$queryRaw<ExtractionStateRow[]>`
        SELECT extraction_type, last_watermark, last_extraction_id, rows_extracted, updated_at
        FROM feedback_extraction_state
        ORDER BY extraction_type ASC
      `;

      // Convert BigInt → number for JSON serialization. The actual count is
      // bounded by daily volume (millions at the high end, well within
      // Number.MAX_SAFE_INTEGER), so the lossy cast is safe.
      const streams = rows.map((row) => ({
        extractionType: row.extraction_type,
        lastWatermark: row.last_watermark.toISOString(),
        lastExtractionId: row.last_extraction_id,
        rowsExtracted: Number(row.rows_extracted),
        updatedAt: row.updated_at.toISOString(),
      }));

      return reply.send({ streams, count: streams.length });
    },
  );
}
