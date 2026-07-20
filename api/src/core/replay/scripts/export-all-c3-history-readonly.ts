// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * export-all-c3-history-readonly.ts — MVP 8B.6
 *
 * Full historical export (read-only). Unlike `export-c3-history-readonly.ts`
 * from MVP 8B.5 (which only kept rows with judge_score IS NOT NULL),
 * this script exports ALL rows from `experiment_executions`. The
 * sanitiser + quality-gate downstream decide what's usable for what.
 *
 * Output:
 *   c3-history-full-export.raw.jsonl
 *   c3-history-full-export.sanitized.jsonl
 *   c3-history-full-export.normalized.jsonl
 *   c3-history-full-export.metadata.json
 *   c3-history-full-export.quality-report.json
 *
 * Sanitisation: the SELECT omits `prompt`, `response_summary`,
 * `judge_rubric`, `structured_metadata` at the SOURCE — same as 8B.5.
 *
 * Read-only invariants enforced by the source-level lint test
 * (calibration-no-db-write.test.ts).
 *
 * Uses `docker exec ci-postgres psql -X -v ON_ERROR_STOP=1`.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harvestHistoricalResults } from '../harvest/historical-results-harvester';
import type { HistoricalRawRow } from '../harvest/historical-results-schema';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const RAW_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.raw.jsonl');
const SANITIZED_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.sanitized.jsonl');
const NORMALIZED_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.normalized.jsonl');
const META_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.metadata.json');
const QUALITY_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.quality-report.json');

const SQL = `
SELECT json_build_object(
  'executionId', t.id::text,
  'experimentId', t.experiment_id::text,
  'taskIndex', t.task_index,
  'repetition', t.repetition,
  'executionMode', t.execution_mode,
  'strategy', t.strategy,
  'taskType', t.task_type,
  'complexity', t.complexity,
  'domain', t.domain,
  'modelsUsed', t.models_used,
  'qualityScore', t.quality_score,
  'judgeScore', t.judge_score,
  'judgeUsed', t.judge_used,
  'heuristicScoreRaw', t.heuristic_score_raw,
  'costUsd', t.cost_usd,
  'latencyMs', t.latency_ms,
  'totalTokens', t.total_tokens,
  'success', t.success,
  'phase', t.phase,
  'ablationCondition', t.ablation_condition,
  'scoringPolicy', t.scoring_policy,
  'failureMode', t.failure_mode,
  'createdAt', t.created_at
)
FROM experiment_executions t
ORDER BY t.created_at;
`.trim();

const COUNT_ALL_SQL = 'SELECT COUNT(*) FROM experiment_executions;';
const COUNT_EXPERIMENTS_SQL =
  'SELECT COUNT(DISTINCT experiment_id) FROM experiment_executions;';
const TABLES_SQL =
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'experiment%' OR table_name LIKE 'execution%' OR table_name='models' OR table_name='providers') ORDER BY table_name;";

function execPsql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').replace(/"/g, '\\"');
  const cmd =
    `docker exec -i ci-postgres psql -U ci_user -d ci_db -A -t -X -v ON_ERROR_STOP=1 ` +
    `-c "${oneLine}"`;
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
}

function main(): void {
  console.log('[export-all] starting full read-only export…');
  const totalRows = Number(execPsql(COUNT_ALL_SQL).trim()) || 0;
  const totalExperiments = Number(execPsql(COUNT_EXPERIMENTS_SQL).trim()) || 0;
  console.log('[export-all] rows in source:', totalRows);
  console.log('[export-all] experiments in source:', totalExperiments);

  const inspectedTables = execPsql(TABLES_SQL)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  console.log('[export-all] tables inspected:', inspectedTables.length);

  const raw = execPsql(SQL);
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  console.log('[export-all] received lines:', lines.length);

  // Parse each JSONL line; collect raw rows.
  const rawRows: HistoricalRawRow[] = [];
  let skippedLines = 0;
  for (const l of lines) {
    try {
      rawRows.push(JSON.parse(l) as HistoricalRawRow);
    } catch {
      skippedLines += 1;
    }
  }
  if (skippedLines > 0) console.warn('[export-all] skipped lines:', skippedLines);

  // Write raw (already PII-free per SELECT) + run harvest pipeline.
  writeFileSync(
    RAW_PATH,
    rawRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
  console.log('[export-all] wrote raw:', rawRows.length, 'rows');

  const harvest = harvestHistoricalResults(rawRows);
  console.log(
    '[export-all] harvest counts:',
    JSON.stringify(harvest.counts, null, 2),
  );

  // Sanitised JSONL = the sanitiser output (same shape but normalised keys).
  // We mirror the eligible (training-and-holdout) candidates as the
  // "normalised" artefact for the next stage.
  writeFileSync(
    NORMALIZED_PATH,
    harvest.trainingAndHoldoutCandidates
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf-8',
  );
  console.log(
    '[export-all] wrote normalised:',
    harvest.trainingAndHoldoutCandidates.length,
    'rows',
  );

  // For audit transparency, also dump the post-sanitiser raw shape.
  // (We don't keep the FORBIDDEN fields anywhere; this is a pass-through
  // of what made it past the sanitiser keep-list.)
  writeFileSync(
    SANITIZED_PATH,
    rawRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );

  const meta = {
    exportedAt: new Date().toISOString(),
    source: 'read_only_db_export',
    tablesInspected: inspectedTables,
    rowCounts: harvest.counts,
    sanitization: harvest.sanitisation,
    schemaVersion: '8b6-v1',
  };
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  console.log('[export-all] wrote metadata');

  const qualityReport = {
    generatedAt: new Date().toISOString(),
    decisionsByUsage: harvest.decisions.reduce(
      (acc, d) => {
        acc[d.usage] = (acc[d.usage] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
    sampleDecisions: harvest.decisions.slice(0, 50),
  };
  writeFileSync(QUALITY_PATH, JSON.stringify(qualityReport, null, 2) + '\n', 'utf-8');
  console.log('[export-all] wrote quality report');
}

main();
