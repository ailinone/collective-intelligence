// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Training Data Export Job
 *
 * Closes the feedback loop between ci/api execution data and model-stack training.
 * Extracts execution outcomes and shadow evaluations as JSONL files that the
 * model-stack Python pipeline can consume for SFT and DPO training.
 *
 * Design:
 * - Cursor-based extraction with persistent watermarks (idempotent, resumable)
 * - Strips all PII (org_id, user_id never exported; trace IDs hashed)
 * - Writes to a configurable output directory (shared volume or local path)
 * - Produces an extraction manifest with SHA-256 checksums
 *
 * Schedule: 02:00 UTC daily (before benchmark at 03:00 and evaluation at 04:00)
 * Override: FEEDBACK_EXPORT_CRON env var
 *
 * Output files:
 * - feedback-outcomes-YYYY-MM-DD.jsonl  (execution outcomes for SFT)
 * - feedback-shadow-YYYY-MM-DD.jsonl    (shadow evaluations for DPO)
 * - extraction-manifest-YYYY-MM-DD.json (checksums, row counts, watermarks)
 */

import cron, { type ScheduledTask } from 'node-cron';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import {
  trainingDataExportDuration,
  trainingDataExportRowsTotal,
  trainingDataExportErrors,
} from '@/utils/metrics';

const log = logger.child({ component: 'training-data-export' });

const CONFIG = {
  enabled: process.env.FEEDBACK_EXPORT_ENABLED !== 'false',
  cronSchedule: process.env.FEEDBACK_EXPORT_CRON || '0 2 * * *',
  outputDir: process.env.FEEDBACK_EXPORT_DIR || './data/feedback-export',
  batchSize: 10_000,
  // SHA-256 pepper for hashing trace IDs (prevents reversal). No default:
  // a publicly known pepper makes the hashes reversible by dictionary attack,
  // so the export refuses to run without an explicit value (fail-closed).
  hashPepper: process.env.FEEDBACK_HASH_PEPPER || null,
  // Only export data older than this (avoids inflight data)
  safetyMarginMs: 3_600_000, // 1 hour
};

let cronJob: ScheduledTask | null = null;

// ─── Types ──────────────────────────────────────────────────────────────────

interface OutcomeRecord {
  trace_id_hash: string;
  strategy: string;
  task_type: string;
  complexity: string;
  quality_score: number | null;
  quality_dimensions: Record<string, number> | null;
  latency_ms: number;
  cost_usd: number;
  total_tokens: number;
  success: boolean;
  feedback_iterations: number;
  models_used: string[];
  decision_source: string | null;
  input_hash: string | null;
  created_at: string;
}

interface ShadowRecord {
  trace_id_hash: string;
  task_type: string;
  complexity: string;
  chosen_strategy: string;
  chosen_quality: number;
  shadow_strategy: string;
  shadow_quality: number;
  quality_regret: number;
  winner_strategy: string;
  created_at: string;
}

interface CollectiveRunExportRecord {
  run_id_hash: string;
  request_id_hash: string | null;
  strategy: string;
  rounds: number;
  stop_reason: string;
  convergence_score: number;
  decision_flip_rate: number;
  dissent: number;
  total_cost_usd: number;
  total_latency_ms: number;
  total_tokens: number;
  final_decision_type: string | null;
  final_confidence: number | null;
  config: unknown;
  metadata: unknown;
  created_at: string;
}

interface CollectiveSignalExportRecord {
  run_id_hash: string;
  round: number;
  agent_id: string;
  model_id: string;
  provider_id: string;
  role: string | null;
  decision_type: string;
  decision_value: unknown;
  decision_confidence: number;
  decision_rationale: string | null;
  sensitivities: unknown;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

interface ExtractionManifest {
  extraction_id: string;
  extracted_at: string;
  outcomes: { file: string; row_count: number; sha256: string };
  shadow: { file: string; row_count: number; sha256: string };
  collective: {
    runs: { file: string; row_count: number; sha256: string };
    signals: { file: string; row_count: number; sha256: string };
  };
  watermarks: {
    outcomes: { start: string; end: string };
    shadow: { start: string; end: string };
    collective: { start: string; end: string };
  };
}

// ─── Test-only state ─────────────────────────────────────────────────────────
//
// _testing.lastSignalRecords is populated on every runTrainingDataExport()
// call so unit tests can assert on the records produced (pre-serialization)
// without mocking fs. Production callers MUST NOT rely on this — it's
// scoped to the most recent call and gets clobbered on the next run.
export const _testing: { lastSignalRecords: CollectiveSignalExportRecord[] } = {
  lastSignalRecords: [],
};

// ─── Core Export ─────────────────────────────────────────────────────────────

export async function runTrainingDataExport(): Promise<ExtractionManifest> {
  if (!CONFIG.hashPepper) {
    throw new Error(
      'FEEDBACK_HASH_PEPPER is not set — refusing to export training data. ' +
        'Trace-ID hashes would be reversible with a known/default pepper; set the env var to enable the export.',
    );
  }
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const extractionId = `extract-${dateStr}-${Date.now()}`;
  const cutoff = new Date(now.getTime() - CONFIG.safetyMarginMs);

  // Ensure output directory exists
  if (!existsSync(CONFIG.outputDir)) {
    mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  log.info({ extractionId, cutoff: cutoff.toISOString(), outputDir: CONFIG.outputDir },
    'Starting training data export');

  // ── Extract outcomes ────────────────────────────────────────────────
  const outcomesFile = join(CONFIG.outputDir, `feedback-outcomes-${dateStr}.jsonl`);
  const outcomesTimer = trainingDataExportDuration.startTimer({ stream: 'outcomes' });
  let outcomesResult;
  try {
    outcomesResult = await extractOutcomes(extractionId, cutoff, outcomesFile);
    trainingDataExportRowsTotal.inc({ stream: 'outcomes' }, outcomesResult.rowCount);
  } catch (err) {
    trainingDataExportErrors.inc({ stream: 'outcomes', stage: 'fetch' });
    throw err;
  } finally {
    outcomesTimer();
  }

  // ── Extract shadow evaluations ──────────────────────────────────────
  const shadowFile = join(CONFIG.outputDir, `feedback-shadow-${dateStr}.jsonl`);
  const shadowTimer = trainingDataExportDuration.startTimer({ stream: 'shadow' });
  let shadowResult;
  try {
    shadowResult = await extractShadowEvals(extractionId, cutoff, shadowFile);
    trainingDataExportRowsTotal.inc({ stream: 'shadow' }, shadowResult.rowCount);
  } catch (err) {
    trainingDataExportErrors.inc({ stream: 'shadow', stage: 'fetch' });
    throw err;
  } finally {
    shadowTimer();
  }

  // ── Extract collective coordination runs + signals (F3.3) ───────────
  const collectiveRunsFile = join(CONFIG.outputDir, `feedback-collective-runs-${dateStr}.jsonl`);
  const collectiveSignalsFile = join(CONFIG.outputDir, `feedback-collective-signals-${dateStr}.jsonl`);
  const collectiveTimer = trainingDataExportDuration.startTimer({ stream: 'collective' });
  let collectiveResult;
  try {
    collectiveResult = await extractCollective(
      extractionId,
      cutoff,
      collectiveRunsFile,
      collectiveSignalsFile,
    );
    trainingDataExportRowsTotal.inc({ stream: 'collective_runs' }, collectiveResult.runRowCount);
    trainingDataExportRowsTotal.inc({ stream: 'collective_signals' }, collectiveResult.signalRowCount);
  } catch (err) {
    trainingDataExportErrors.inc({ stream: 'collective', stage: 'fetch' });
    throw err;
  } finally {
    collectiveTimer();
  }

  // ── Write manifest ──────────────────────────────────────────────────
  const manifest: ExtractionManifest = {
    extraction_id: extractionId,
    extracted_at: now.toISOString(),
    outcomes: {
      file: `feedback-outcomes-${dateStr}.jsonl`,
      row_count: outcomesResult.rowCount,
      sha256: outcomesResult.sha256,
    },
    shadow: {
      file: `feedback-shadow-${dateStr}.jsonl`,
      row_count: shadowResult.rowCount,
      sha256: shadowResult.sha256,
    },
    collective: {
      runs: {
        file: `feedback-collective-runs-${dateStr}.jsonl`,
        row_count: collectiveResult.runRowCount,
        sha256: collectiveResult.runSha256,
      },
      signals: {
        file: `feedback-collective-signals-${dateStr}.jsonl`,
        row_count: collectiveResult.signalRowCount,
        sha256: collectiveResult.signalSha256,
      },
    },
    watermarks: {
      outcomes: {
        start: outcomesResult.watermarkStart.toISOString(),
        end: outcomesResult.watermarkEnd.toISOString(),
      },
      shadow: {
        start: shadowResult.watermarkStart.toISOString(),
        end: shadowResult.watermarkEnd.toISOString(),
      },
      collective: {
        start: collectiveResult.watermarkStart.toISOString(),
        end: collectiveResult.watermarkEnd.toISOString(),
      },
    },
  };

  const manifestFile = join(CONFIG.outputDir, `extraction-manifest-${dateStr}.json`);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  log.info({
    extractionId,
    outcomesCount: outcomesResult.rowCount,
    shadowCount: shadowResult.rowCount,
    collectiveRunsCount: collectiveResult.runRowCount,
    collectiveSignalsCount: collectiveResult.signalRowCount,
    outputDir: CONFIG.outputDir,
  }, 'Training data export completed');

  return manifest;
}

// ─── Outcome Extraction ─────────────────────────────────────────────────────

async function extractOutcomes(
  extractionId: string,
  cutoff: Date,
  outputFile: string,
): Promise<{ rowCount: number; sha256: string; watermarkStart: Date; watermarkEnd: Date }> {
  // Get current watermark
  const state = await prisma.$queryRaw<Array<{ last_watermark: Date }>>`
    SELECT last_watermark FROM feedback_extraction_state WHERE extraction_type = 'outcomes'
  `;
  const watermarkStart = state[0]?.last_watermark ?? new Date('1970-01-01');

  const rows = await prisma.$queryRaw<Array<{
    decision_trace_id: string;
    strategy: string;
    task_type: string | null;
    complexity: string | null;
    quality_score: number | null;
    quality_dimensions: unknown;
    latency_ms: number;
    cost_usd: number;
    total_tokens: number;
    success: boolean;
    feedback_iterations: number;
    models_used: string[];
    decision_source: string | null;
    input_hash: string | null;
    created_at: Date;
  }>>`
    SELECT
      eo.decision_trace_id,
      eo.strategy,
      da.task_type,
      da.complexity,
      eo.quality_score,
      eo.quality_dimensions,
      eo.latency_ms,
      eo.cost_usd,
      eo.total_tokens,
      eo.success,
      eo.feedback_iterations,
      eo.models_used,
      da.decision_source,
      da.input_hash,
      eo.created_at
    FROM execution_outcomes eo
    LEFT JOIN decision_audit da ON da.request_id = eo.decision_trace_id
    WHERE eo.created_at > ${watermarkStart}
      AND eo.created_at <= ${cutoff}
    ORDER BY eo.created_at ASC
    LIMIT ${CONFIG.batchSize}
  `;

  // Build JSONL
  const lines: string[] = [];
  let maxCreatedAt = watermarkStart;

  for (const row of rows) {
    const record: OutcomeRecord = {
      trace_id_hash: hashTraceId(row.decision_trace_id),
      strategy: row.strategy,
      task_type: row.task_type ?? 'general',
      complexity: row.complexity ?? 'medium',
      quality_score: row.quality_score ? Number(row.quality_score) : null,
      quality_dimensions: row.quality_dimensions as Record<string, number> | null,
      latency_ms: row.latency_ms,
      cost_usd: Number(row.cost_usd),
      total_tokens: row.total_tokens,
      success: row.success,
      feedback_iterations: row.feedback_iterations,
      models_used: row.models_used,
      decision_source: row.decision_source,
      input_hash: row.input_hash,
      created_at: row.created_at.toISOString(),
    };
    lines.push(JSON.stringify(record));
    if (row.created_at > maxCreatedAt) maxCreatedAt = row.created_at;
  }

  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  writeFileSync(outputFile, content);
  const sha256 = computeSha256(content);

  // Update watermark and log
  if (rows.length > 0) {
    await prisma.$executeRaw`
      UPDATE feedback_extraction_state
      SET last_watermark = ${maxCreatedAt},
          last_extraction_id = ${extractionId},
          rows_extracted = rows_extracted + ${BigInt(rows.length)},
          updated_at = NOW()
      WHERE extraction_type = 'outcomes'
    `;

    await prisma.$executeRaw`
      INSERT INTO feedback_extraction_log (
        extraction_id, extraction_type, watermark_start, watermark_end,
        row_count, file_path, file_sha256
      ) VALUES (
        ${extractionId + '-outcomes'}, 'outcomes', ${watermarkStart}, ${maxCreatedAt},
        ${rows.length}, ${outputFile}, ${sha256}
      )
    `;
  }

  return { rowCount: rows.length, sha256, watermarkStart, watermarkEnd: maxCreatedAt };
}

// ─── Shadow Evaluation Extraction ───────────────────────────────────────────

async function extractShadowEvals(
  extractionId: string,
  cutoff: Date,
  outputFile: string,
): Promise<{ rowCount: number; sha256: string; watermarkStart: Date; watermarkEnd: Date }> {
  const state = await prisma.$queryRaw<Array<{ last_watermark: Date }>>`
    SELECT last_watermark FROM feedback_extraction_state WHERE extraction_type = 'shadow'
  `;
  const watermarkStart = state[0]?.last_watermark ?? new Date('1970-01-01');

  const rows = await prisma.$queryRaw<Array<{
    decision_trace_id: string;
    task_type: string;
    complexity: string;
    chosen_strategy: string;
    chosen_quality: number;
    shadow_strategy: string;
    shadow_quality: number;
    quality_regret: number;
    winner_strategy: string;
    created_at: Date;
  }>>`
    SELECT
      decision_trace_id, task_type, complexity,
      chosen_strategy, chosen_quality, shadow_strategy, shadow_quality,
      quality_regret, winner_strategy, created_at
    FROM shadow_evaluations
    WHERE created_at > ${watermarkStart}
      AND created_at <= ${cutoff}
    ORDER BY created_at ASC
    LIMIT ${CONFIG.batchSize}
  `;

  const lines: string[] = [];
  let maxCreatedAt = watermarkStart;

  for (const row of rows) {
    const record: ShadowRecord = {
      trace_id_hash: hashTraceId(row.decision_trace_id),
      task_type: row.task_type,
      complexity: row.complexity,
      chosen_strategy: row.chosen_strategy,
      chosen_quality: Number(row.chosen_quality),
      shadow_strategy: row.shadow_strategy,
      shadow_quality: Number(row.shadow_quality),
      quality_regret: Number(row.quality_regret),
      winner_strategy: row.winner_strategy,
      created_at: row.created_at.toISOString(),
    };
    lines.push(JSON.stringify(record));
    if (row.created_at > maxCreatedAt) maxCreatedAt = row.created_at;
  }

  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  writeFileSync(outputFile, content);
  const sha256 = computeSha256(content);

  if (rows.length > 0) {
    await prisma.$executeRaw`
      UPDATE feedback_extraction_state
      SET last_watermark = ${maxCreatedAt},
          last_extraction_id = ${extractionId},
          rows_extracted = rows_extracted + ${BigInt(rows.length)},
          updated_at = NOW()
      WHERE extraction_type = 'shadow'
    `;

    await prisma.$executeRaw`
      INSERT INTO feedback_extraction_log (
        extraction_id, extraction_type, watermark_start, watermark_end,
        row_count, file_path, file_sha256
      ) VALUES (
        ${extractionId + '-shadow'}, 'shadow', ${watermarkStart}, ${maxCreatedAt},
        ${rows.length}, ${outputFile}, ${sha256}
      )
    `;
  }

  return { rowCount: rows.length, sha256, watermarkStart, watermarkEnd: maxCreatedAt };
}

// ─── Collective Coordination Extraction (F3.3) ──────────────────────────────

/**
 * Extracts Ailin¹ Collective Coordination Layer runs + their per-agent signals
 * for downstream training (e.g. ailin-1b coordination model).
 *
 * Tenant isolation: organization_id is intentionally NOT exported. Run and
 * signal records are linked by `run_id_hash` so the trainer can reconstruct
 * trajectories without ever seeing org/user identifiers. Trace identifiers
 * (run.id, request_id) are hashed via the same SHA-256+pepper helper used
 * for outcomes/shadow.
 *
 * Watermark: a single watermark on `runs.created_at` covers both files.
 * Signals are pulled by `run_id IN (...)` after the runs page is loaded,
 * so a signal can never appear without its parent run in the same batch.
 *
 * decisionRationale is exported as-is because signal-validator.ts already
 * redacts PII before persistence (the migration comment is the contract).
 */
async function extractCollective(
  extractionId: string,
  cutoff: Date,
  runsOutputFile: string,
  signalsOutputFile: string,
): Promise<{
  runRowCount: number;
  runSha256: string;
  signalRowCount: number;
  signalSha256: string;
  watermarkStart: Date;
  watermarkEnd: Date;
}> {
  const state = await prisma.$queryRaw<Array<{ last_watermark: Date }>>`
    SELECT last_watermark FROM feedback_extraction_state WHERE extraction_type = 'collective'
  `;
  const watermarkStart = state[0]?.last_watermark ?? new Date('1970-01-01');

  const runRows = await prisma.$queryRaw<Array<{
    id: string;
    request_id: string | null;
    strategy: string;
    rounds: number;
    stop_reason: string;
    convergence_score: number;
    decision_flip_rate: number;
    dissent: number;
    total_cost_usd: number;
    total_latency_ms: number;
    total_tokens: number;
    final_decision_type: string | null;
    final_confidence: number | null;
    config: unknown;
    metadata: unknown;
    created_at: Date;
  }>>`
    SELECT
      id,
      request_id,
      strategy,
      rounds,
      stop_reason,
      convergence_score,
      decision_flip_rate,
      dissent,
      total_cost_usd,
      total_latency_ms,
      total_tokens,
      final_decision_type,
      final_confidence,
      config,
      metadata,
      created_at
    FROM collective_runs
    WHERE created_at > ${watermarkStart}
      AND created_at <= ${cutoff}
    ORDER BY created_at ASC
    LIMIT ${CONFIG.batchSize}
  `;

  const runLines: string[] = [];
  let maxCreatedAt = watermarkStart;
  const runIdMap = new Map<string, string>(); // raw runId -> run_id_hash

  for (const row of runRows) {
    const runIdHash = hashTraceId(row.id);
    runIdMap.set(row.id, runIdHash);

    const record: CollectiveRunExportRecord = {
      run_id_hash: runIdHash,
      request_id_hash: row.request_id ? hashTraceId(row.request_id) : null,
      strategy: row.strategy,
      rounds: row.rounds,
      stop_reason: row.stop_reason,
      convergence_score: Number(row.convergence_score),
      decision_flip_rate: Number(row.decision_flip_rate),
      dissent: Number(row.dissent),
      total_cost_usd: Number(row.total_cost_usd),
      total_latency_ms: row.total_latency_ms,
      total_tokens: row.total_tokens,
      final_decision_type: row.final_decision_type,
      final_confidence: row.final_confidence !== null ? Number(row.final_confidence) : null,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at.toISOString(),
    };
    runLines.push(JSON.stringify(record));
    if (row.created_at > maxCreatedAt) maxCreatedAt = row.created_at;
  }

  const runContent = runLines.join('\n') + (runLines.length > 0 ? '\n' : '');
  writeFileSync(runsOutputFile, runContent);
  const runSha256 = computeSha256(runContent);

  // Pull signals for the runs we just exported. We always write the
  // signals file (empty when there are no runs) so the manifest stays
  // structurally consistent across days.
  const signalLines: string[] = [];
  // Test-only: capture the records before serialization so unit tests
  // can assert decision_value pass-through without mocking the fs
  // module (vitest can't redefine non-configurable native fs exports).
  const capturedSignalRecords: CollectiveSignalExportRecord[] = [];
  if (runRows.length > 0) {
    const runIds = runRows.map((r) => r.id);
    const signalRows = await prisma.$queryRaw<Array<{
      run_id: string;
      round: number;
      agent_id: string;
      model_id: string;
      provider_id: string;
      role: string | null;
      decision_type: string;
      decision_value: unknown;
      decision_confidence: number;
      decision_rationale: string | null;
      sensitivities: unknown;
      latency_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number | null;
      created_at: Date;
    }>>`
      SELECT
        run_id,
        round,
        agent_id,
        model_id,
        provider_id,
        role,
        decision_type,
        decision_value,
        decision_confidence,
        decision_rationale,
        sensitivities,
        latency_ms,
        input_tokens,
        output_tokens,
        cost_usd,
        created_at
      FROM collective_signals
      WHERE run_id = ANY(${runIds}::uuid[])
      ORDER BY run_id, round, created_at
    `;

    for (const row of signalRows) {
      const runIdHash = runIdMap.get(row.run_id);
      if (!runIdHash) continue; // defensive — should never happen given the IN clause
      const record: CollectiveSignalExportRecord = {
        run_id_hash: runIdHash,
        round: row.round,
        agent_id: row.agent_id,
        model_id: row.model_id,
        provider_id: row.provider_id,
        role: row.role,
        decision_type: row.decision_type,
        decision_value: row.decision_value,
        decision_confidence: Number(row.decision_confidence),
        decision_rationale: row.decision_rationale,
        sensitivities: row.sensitivities,
        latency_ms: row.latency_ms,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost_usd: row.cost_usd !== null ? Number(row.cost_usd) : null,
        created_at: row.created_at.toISOString(),
      };
      signalLines.push(JSON.stringify(record));
      capturedSignalRecords.push(record);
    }
  }

  // Update test-only record cache so the F3.3 schema regression test
  // can verify pass-through of fields like decision_value.shadowEnsemble.
  _testing.lastSignalRecords = capturedSignalRecords;

  const signalContent = signalLines.join('\n') + (signalLines.length > 0 ? '\n' : '');
  writeFileSync(signalsOutputFile, signalContent);
  const signalSha256 = computeSha256(signalContent);

  // Watermark + audit log: one update covers both files because they
  // share the same time window. Two log rows so the audit trail tells
  // them apart.
  if (runRows.length > 0) {
    await prisma.$executeRaw`
      UPDATE feedback_extraction_state
      SET last_watermark = ${maxCreatedAt},
          last_extraction_id = ${extractionId},
          rows_extracted = rows_extracted + ${BigInt(runRows.length)},
          updated_at = NOW()
      WHERE extraction_type = 'collective'
    `;

    await prisma.$executeRaw`
      INSERT INTO feedback_extraction_log (
        extraction_id, extraction_type, watermark_start, watermark_end,
        row_count, file_path, file_sha256
      ) VALUES (
        ${extractionId + '-collective-runs'}, 'collective', ${watermarkStart}, ${maxCreatedAt},
        ${runRows.length}, ${runsOutputFile}, ${runSha256}
      )
    `;

    await prisma.$executeRaw`
      INSERT INTO feedback_extraction_log (
        extraction_id, extraction_type, watermark_start, watermark_end,
        row_count, file_path, file_sha256
      ) VALUES (
        ${extractionId + '-collective-signals'}, 'collective', ${watermarkStart}, ${maxCreatedAt},
        ${signalLines.length}, ${signalsOutputFile}, ${signalSha256}
      )
    `;
  }

  return {
    runRowCount: runRows.length,
    runSha256,
    signalRowCount: signalLines.length,
    signalSha256,
    watermarkStart,
    watermarkEnd: maxCreatedAt,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashTraceId(traceId: string): string {
  if (!CONFIG.hashPepper) {
    throw new Error('FEEDBACK_HASH_PEPPER is not set — cannot hash trace IDs');
  }
  return createHash('sha256').update(traceId + CONFIG.hashPepper).digest('hex').slice(0, 16);
}

function computeSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Cron Lifecycle ─────────────────────────────────────────────────────────

export function startTrainingDataExportJob(): void {
  if (!CONFIG.enabled) {
    log.info('Training data export job disabled');
    return;
  }

  if (!CONFIG.hashPepper) {
    log.error(
      'FEEDBACK_HASH_PEPPER is not set — training data export disabled (fail-closed). ' +
        'Set the env var to a strong secret to enable the export.',
    );
    return;
  }

  if (cronJob) {
    log.warn('Training data export job already running');
    return;
  }

  cronJob = cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      try {
        await runTrainingDataExport();
      } catch (err) {
        log.error({ error: String(err) }, 'Training data export job failed');
      }
    },
    { timezone: 'UTC' },
  );

  log.info({ schedule: CONFIG.cronSchedule }, 'Training data export job scheduled');
}

export function stopTrainingDataExportJob(): void {
  if (!cronJob) return;
  cronJob.stop();
  cronJob = null;
  log.info('Training data export job stopped');
}
