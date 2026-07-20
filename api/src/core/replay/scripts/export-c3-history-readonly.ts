// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * export-c3-history-readonly.ts — MVP 8B.5
 *
 * Exports C3 historical executions to a sanitised JSONL artefact +
 * metadata file. The script ONLY issues SELECT statements via
 * `docker exec ci-postgres psql …`; it NEVER writes to the DB.
 *
 * Output:
 *   api/src/core/replay/artifacts/c3-history-export.jsonl
 *   api/src/core/replay/artifacts/c3-history-export.metadata.json
 *
 * Sanitisation: the SELECT explicitly omits `prompt`, `response_summary`,
 * `judge_rubric`, `structured_metadata` — the only PII-bearing columns
 * in `experiment_executions`.
 *
 * Usage (offline shell):
 *   pnpm exec tsx api/src/core/replay/scripts/export-c3-history-readonly.ts
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const JSONL_PATH = resolve(ARTIFACTS_DIR, 'c3-history-export.jsonl');
const META_PATH = resolve(ARTIFACTS_DIR, 'c3-history-export.metadata.json');

// ─── Build the read-only query ──────────────────────────────────────────

/**
 * Selects sanitised columns only. We omit:
 *   - prompt
 *   - response_summary
 *   - judge_rubric
 *   - structured_metadata
 *
 * The output is JSON via `to_jsonb(t)` so each row is one valid JSON line.
 */
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
  'ablationDisabled', t.ablation_disabled,
  'ablationCondition', t.ablation_condition,
  'scoringPolicy', t.scoring_policy,
  'failureMode', t.failure_mode,
  'createdAt', t.created_at
)
FROM experiment_executions t
WHERE t.judge_score IS NOT NULL
ORDER BY t.created_at;
`.trim();

const COUNT_EXECUTIONS_SQL =
  "SELECT COUNT(*) FROM experiment_executions WHERE judge_score IS NOT NULL;";
const COUNT_EXPERIMENTS_SQL =
  "SELECT COUNT(DISTINCT experiment_id) FROM experiment_executions WHERE judge_score IS NOT NULL;";

// ─── Execute via docker exec (read-only) ────────────────────────────────

function execPsql(sql: string): string {
  // Collapse SQL into single line, escape double quotes.
  const oneLine = sql.replace(/\s+/g, ' ').replace(/"/g, '\\"');
  const cmd =
    `docker exec -i ci-postgres psql -U ci_user -d ci_db -A -t -X -v ON_ERROR_STOP=1 ` +
    `-c "${oneLine}"`;
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
}

function execPsqlMultiline(sql: string): string {
  // Multi-line SQL is collapsed to one line; psql accepts that.
  return execPsql(sql);
}

// ─── Main ───────────────────────────────────────────────────────────────

function main(): void {
  console.log('[export] starting read-only export…');
  console.log('[export] target artifacts dir:', ARTIFACTS_DIR);

  const totalExecutionsStr = execPsql(COUNT_EXECUTIONS_SQL).trim();
  const totalExperimentsStr = execPsql(COUNT_EXPERIMENTS_SQL).trim();
  const totalExecutions = Number(totalExecutionsStr) || 0;
  const totalExperiments = Number(totalExperimentsStr) || 0;
  console.log('[export] rows to export:', totalExecutions);
  console.log('[export] distinct experiments:', totalExperiments);

  const raw = execPsqlMultiline(SQL);
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  console.log('[export] received lines:', lines.length);

  // Validate each line is valid JSON before writing.
  const valid: string[] = [];
  let skipped = 0;
  for (const l of lines) {
    try {
      JSON.parse(l);
      valid.push(l);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.warn('[export] skipped non-JSON lines:', skipped);

  writeFileSync(JSONL_PATH, valid.join('\n') + '\n', 'utf-8');
  console.log('[export] wrote', valid.length, 'rows to', JSONL_PATH);

  const meta = {
    exportedAt: new Date().toISOString(),
    source: 'read_only_db_export',
    rowCounts: {
      executions: valid.length,
      experiments: totalExperiments,
    },
    filters: {
      onlyWithJudgeScore: true,
      onlyCompletedExecutions: false,
    },
    schemaVersion: '8b5-v1',
    sanitisation: {
      strippedColumns: [
        'prompt',
        'response_summary',
        'judge_rubric',
        'structured_metadata',
      ],
    },
  };
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  console.log('[export] wrote metadata to', META_PATH);
}

main();
