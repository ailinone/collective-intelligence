// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Structural Capability Derivation Job (ADR-022/HCRA closure)
 *
 * Runs `deriveStructuralSignals` (capability/assertions/structural-derivation.ts)
 * across every active model and writes the resulting `modality-derived`
 * assertions via the same append-only writer discovery uses.
 *
 * Why this needs its own recurring job instead of living inside discovery:
 *
 *   - Structural rules read a model's ALREADY-MATERIALISED capability
 *     projection (`capability_uris` / `capability_confidence`) and combine
 *     base capabilities into derived ones (e.g. `reasoning` → `analysis`,
 *     `vision + chat` → `visual_question_answering`, any code-family
 *     capability → the `coding` umbrella). That projection is the OUTPUT of
 *     `capability-materialise-job.ts`, not of discovery — so this pass must
 *     run AFTER materialise has fused the base signals, on its own tick.
 *   - Before this job existed, `deriveStructuralSignals` was reachable only
 *     from `scripts/hcra-close-coverage.ts`, a one-shot CLI script nobody
 *     re-runs after the initial manual pass. Every model discovered or
 *     re-scored after that one run never got its structural derivations
 *     (image_captioning, visual_question_answering, qa, coding, agents, tts,
 *     analysis) — the same "manual script, never wired" failure mode as the
 *     ontology seed itself (SOTA audit, 2026-09-07).
 *
 * Ordering in the 6-hourly capability-table-writer trio (offset to avoid the
 * three heavy writers contending on the same rows in the same tick):
 *   :15 embedding-refresh   (reads capability_uris to build search vectors)
 *   :30 structural-derivation (this job — writes derived assertions)
 *   :45 capability-materialise (re-fuses assertions incl. the ones above)
 *
 * A structural assertion written at :30 is picked up by the :45 materialise
 * tick in the SAME cycle, so the umbrella/derived capabilities converge
 * within one 6-hour window rather than lagging a full cycle behind.
 *
 * Idempotent: `writeAssertions`' supersede-by-origin means re-running with an
 * unchanged base projection produces the same row count — no growth on
 * repeat runs. Read-only against `models`; writes only to the append-only
 * assertion log (the materialise job owns the actual `models.capability_*`
 * columns).
 */

import { logger } from '@/utils/logger';
import { getCapabilityPool } from '@/capability/db/capability-pool';
import { prisma } from '@/database/client';
import { writeAssertions, type ModelAssertionBatch } from '@/capability/assertions/writer';
import { deriveStructuralSignals, structuralTargets } from '@/capability/assertions/structural-derivation';
import type { ModelCapability } from '@/types';

const log = logger.child({ component: 'structural-derivation-job' });

const ORIGIN = 'structural-derivation@v1';
/** Matches the TTL the one-shot backfill used for the same origin. */
const TTL_DAYS = 60;
/** Chunk writes to avoid holding one enormous UNNEST payload / pool timeout. */
const CHUNK_SIZE = 250;

interface ModelProjectionRow {
  uid: string;
  capability_uris: string[] | null;
  capability_confidence: Record<string, number> | null;
}

/**
 * Whether the structural derivation pass runs. Default ON — mirrors
 * `isCapabilityMaterialiseEnabled` / `isDiscoveryAssertionsEnabled`. Operators
 * can quiesce it independently (e.g. during a migration) without touching the
 * other two capability-table writers.
 */
export function isStructuralDerivationEnabled(): boolean {
  return process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED !== 'true';
}

export interface StructuralDerivationStats {
  modelsScanned: number;
  modelsMatched: number;
  signalsWritten: number;
  rowsSuperseded: number;
  targetHits: Record<string, number>;
  skipped: 'disabled' | null;
  elapsedMs: number;
}

async function loadActiveModelProjections(): Promise<ModelProjectionRow[]> {
  const pool = getCapabilityPool();
  const { rows } = await pool.query<ModelProjectionRow>(
    `SELECT uid, capability_uris, capability_confidence
       FROM models
      WHERE status = 'active';`
  );
  return rows;
}

export async function runStructuralDerivationNow(): Promise<StructuralDerivationStats> {
  const startedAt = Date.now();

  if (!isStructuralDerivationEnabled()) {
    log.info('HCRA_STRUCTURAL_DERIVATION_DISABLED=true — skipping structural derivation tick');
    return {
      modelsScanned: 0,
      modelsMatched: 0,
      signalsWritten: 0,
      rowsSuperseded: 0,
      targetHits: {},
      skipped: 'disabled',
      elapsedMs: Date.now() - startedAt,
    };
  }

  const models = await loadActiveModelProjections();
  const targetHits = new Map<ModelCapability, number>();
  for (const t of structuralTargets()) targetHits.set(t, 0);

  const batch: ModelAssertionBatch[] = [];
  let signalsProduced = 0;

  for (const row of models) {
    const signals = deriveStructuralSignals({
      capabilityUris: row.capability_uris ?? [],
      capabilityConfidence: row.capability_confidence ?? undefined,
    });
    if (signals.length === 0) continue;
    batch.push({ modelUid: row.uid, signals });
    signalsProduced += signals.length;
    for (const s of signals) {
      targetHits.set(s.capability, (targetHits.get(s.capability) ?? 0) + 1);
    }
  }

  let signalsWritten = 0;
  let rowsSuperseded = 0;
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const slice = batch.slice(i, i + CHUNK_SIZE);
    const stats = await writeAssertions(slice, { origin: ORIGIN, ttlDays: TTL_DAYS }, prisma);
    signalsWritten += stats.rowsInserted;
    rowsSuperseded += stats.rowsSuperseded;
  }

  const stats: StructuralDerivationStats = {
    modelsScanned: models.length,
    modelsMatched: batch.length,
    signalsWritten,
    rowsSuperseded,
    targetHits: Object.fromEntries(targetHits),
    skipped: null,
    elapsedMs: Date.now() - startedAt,
  };

  log.info(
    {
      modelsScanned: stats.modelsScanned,
      modelsMatched: stats.modelsMatched,
      signalsProduced,
      signalsWritten: stats.signalsWritten,
      rowsSuperseded: stats.rowsSuperseded,
      targetHits: stats.targetHits,
      elapsedMs: stats.elapsedMs,
    },
    'Structural capability derivation tick complete'
  );

  return stats;
}
