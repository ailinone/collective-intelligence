// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// HCRA Inventory Lifecycle Classifier
// =====================================
//
// Applies the canonical policy from `src/capability/inventory-lifecycle-policy.ts`
// to the `models` table, then derives the lifecycle bucket per row from the
// `updated_at` timestamp.
//
// The policy constants (STALE_HOURS, INACTIVE_DAYS) and the SQL CASE expression
// are imported from the policy module — this script is now a pure executor,
// not a policy authority.
//
// Idempotent. Safe to run repeatedly — recomputes the bucket from current
// timestamps without destroying the manual `status` column.
//
// `lifecycle_status` is INTENTIONALLY orthogonal to `models.status`:
//   - models.status         = catalog availability (active/deprecated/withdrawn)
//   - models.lifecycle_*    = freshness of last successful discovery sighting
//
// Usage:
//   DATABASE_URL=… npx tsx scripts/hcra-lifecycle-classify.ts
//   DATABASE_URL=… STALE_HOURS=72 INACTIVE_DAYS=14 npx tsx scripts/...

import { Pool } from 'pg';
import {
  classifyExpressionSql,
  reasonExpressionSql,
  resolveLifecycleThresholds,
  POLICY_SUMMARY,
} from '@/capability/inventory-lifecycle-policy';

(async () => {
  const thresholds = resolveLifecycleThresholds();
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const t0 = Date.now();
  console.log(
    `[lifecycle] policy=${POLICY_SUMMARY.adr}@v${POLICY_SUMMARY.version}  ` +
      `STALE_HOURS=${thresholds.staleHours}h  INACTIVE_DAYS=${thresholds.inactiveDays}d`,
  );

  // 1. Ensure columns exist (idempotent DDL).
  await p.query(`
    ALTER TABLE models
      ADD COLUMN IF NOT EXISTS lifecycle_status TEXT,
      ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT,
      ADD COLUMN IF NOT EXISTS lifecycle_evaluated_at TIMESTAMPTZ
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_models_lifecycle_status
      ON models (lifecycle_status) WHERE status='active'
  `);

  // 2. Classify in a single SQL transaction using the canonical expressions.
  //    The expressions are sourced from the policy module so any future change
  //    propagates through every consumer in one diff.
  const classifyExpr = classifyExpressionSql('updated_at', thresholds);
  const reasonExpr = reasonExpressionSql('updated_at', thresholds);
  const updated = await p.query<{ lifecycle_status: string; n: number }>(
    `WITH classified AS (
       SELECT uid,
              ${classifyExpr} AS new_status,
              ${reasonExpr}   AS reason
       FROM models
       WHERE status='active'
     )
     UPDATE models m
        SET lifecycle_status      = c.new_status,
            lifecycle_reason      = c.reason,
            lifecycle_evaluated_at = NOW()
     FROM classified c
     WHERE m.uid = c.uid
     RETURNING m.lifecycle_status`,
  );

  const counts: Record<string, number> = {};
  for (const r of updated.rows) counts[r.lifecycle_status] = (counts[r.lifecycle_status] ?? 0) + 1;

  console.log(
    `[lifecycle] classified ${updated.rowCount} active models in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(10)} ${counts[k]}`);

  // 3. Audit summary by provider (top movers).
  const audit = await p.query<{
    provider_id: string;
    active: number;
    stale: number;
    inactive: number;
  }>(
    `SELECT provider_id,
            COUNT(*) FILTER (WHERE lifecycle_status='active')::int   AS active,
            COUNT(*) FILTER (WHERE lifecycle_status='stale')::int    AS stale,
            COUNT(*) FILTER (WHERE lifecycle_status='inactive')::int AS inactive
     FROM models WHERE status='active'
     GROUP BY provider_id
     HAVING COUNT(*) FILTER (WHERE lifecycle_status<>'active') > 0
     ORDER BY inactive DESC, stale DESC LIMIT 15`,
  );
  console.log('\nProvider lifecycle distribution (top movers):');
  console.log('  provider                       active stale inactive');
  for (const r of audit.rows)
    console.log(
      `  ${r.provider_id.padEnd(30)} ${String(r.active).padStart(6)} ${String(r.stale).padStart(5)} ${String(r.inactive).padStart(8)}`,
    );

  await p.end();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
