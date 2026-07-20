// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Honest provider lifecycle audit, with explicit categorization.
//
// Categories (mutually exclusive, computed from lifecycle_status mix):
//   - healthy        : 100% of rows are lifecycle_active
//   - drifting       : >=1 lifecycle_active AND >=1 stale/inactive
//   - catalog-dead   : 0 lifecycle_active AND >=1 inactive (>INACTIVE_DAYS gone)
//   - in-grace       : 0 lifecycle_active AND only stale rows (still in grace window)
//   - unclassified   : lifecycle_status NULL on every row (classifier never ran)
//
// Catalog-dead is the ONLY bucket safe to consider for `provider.status='deprecated'`
// in housekeeping. In-grace is observation-only.
//
// The HISTORICAL_UNIVERSE_WHERE fragment and policy summary come from the
// canonical policy module — see `src/capability/inventory-lifecycle-policy.ts`
// and ADR-023.

import { Pool } from 'pg';
import {
  HISTORICAL_UNIVERSE_WHERE,
  POLICY_SUMMARY,
  resolveLifecycleThresholds,
} from '@/capability/inventory-lifecycle-policy';

type Row = {
  provider_id: string;
  total: number;
  active: number;
  stale: number;
  inactive: number;
  null_bucket: number;
};

function categorize(
  r: Row,
): 'healthy' | 'drifting' | 'catalog-dead' | 'in-grace' | 'unclassified' {
  if (r.null_bucket === r.total) return 'unclassified';
  if (r.active === r.total) return 'healthy';
  if (r.active > 0) return 'drifting';
  // active === 0 here
  if (r.inactive > 0) return 'catalog-dead';
  return 'in-grace';
}

(async () => {
  const thresholds = resolveLifecycleThresholds();
  const p = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(
    `policy=${POLICY_SUMMARY.adr}@v${POLICY_SUMMARY.version}  ` +
      `STALE_HOURS=${thresholds.staleHours}h  INACTIVE_DAYS=${thresholds.inactiveDays}d\n`,
  );

  const rows = await p.query<Row>(
    `SELECT provider_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE lifecycle_status='active')::int   AS active,
            COUNT(*) FILTER (WHERE lifecycle_status='stale')::int    AS stale,
            COUNT(*) FILTER (WHERE lifecycle_status='inactive')::int AS inactive,
            COUNT(*) FILTER (WHERE lifecycle_status IS NULL)::int    AS null_bucket
     FROM models
     WHERE ${HISTORICAL_UNIVERSE_WHERE}
     GROUP BY provider_id
     ORDER BY total DESC`,
  );

  // Group by category
  const byCat: Record<string, Row[]> = {
    healthy: [], drifting: [], 'catalog-dead': [], 'in-grace': [], unclassified: [],
  };
  for (const r of rows.rows) byCat[categorize(r)].push(r);

  // Summary header
  console.log('=== PROVIDER LIFECYCLE AUDIT ===');
  console.log(`  ${rows.rows.length} providers with status='active' rows in DB.\n`);
  console.log('  category       providers  models');
  for (const cat of ['healthy', 'drifting', 'catalog-dead', 'in-grace', 'unclassified']) {
    const ps = byCat[cat];
    const totalModels = ps.reduce((s, r) => s + r.total, 0);
    console.log(`  ${cat.padEnd(14)} ${String(ps.length).padStart(9)}  ${String(totalModels).padStart(6)}`);
  }

  // Detail per category
  for (const cat of ['catalog-dead', 'in-grace', 'drifting', 'healthy', 'unclassified']) {
    const ps = byCat[cat];
    if (ps.length === 0) continue;
    console.log(`\n--- ${cat.toUpperCase()} (${ps.length}) ---`);
    if (cat === 'catalog-dead')
      console.log(
        `  [WARN] candidates for provider.status=deprecated (no lifecycle_active rows, has inactive >${thresholds.inactiveDays}d)`,
      );
    if (cat === 'in-grace')
      console.log(
        '  observation-only (no lifecycle_active rows yet, but stale rows still within grace window)',
      );
    if (cat === 'drifting') console.log('  partial drift (some rows still active, some stale/inactive)');
    if (cat === 'healthy') console.log('  100% lifecycle_active');
    console.log('  provider                       total  active stale inactive');
    for (const r of ps.sort((a, b) => b.total - a.total)) {
      console.log(
        `  ${r.provider_id.padEnd(30)} ${String(r.total).padStart(5)} ${String(r.active).padStart(7)} ${String(r.stale).padStart(5)} ${String(r.inactive).padStart(8)}`,
      );
    }
  }

  // Operational suggestion
  console.log('\n--- OPERATIONAL SUGGESTION ---');
  const dead = byCat['catalog-dead'];
  if (dead.length > 0) {
    const total = dead.reduce((s, r) => s + r.total, 0);
    console.log(`  ${dead.length} providers (${total} models) candidates for housekeeping deprecation:`);
    for (const r of dead)
      console.log(`    - ${r.provider_id}  (${r.total} models, all >${thresholds.inactiveDays}d stale)`);
  } else {
    console.log('  No providers in catalog-dead bucket. No housekeeping action needed.');
  }
  const grace = byCat['in-grace'];
  if (grace.length > 0) {
    console.log(`  ${grace.length} providers in grace window — re-check on next cycle:`);
    for (const r of grace) console.log(`    - ${r.provider_id}  (${r.total} models)`);
  }

  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
