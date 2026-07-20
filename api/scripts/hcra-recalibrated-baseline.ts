// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// HCRA Recalibrated Coverage Baseline
// =====================================
//
// Reports coverage on the LIVE inventory only — i.e. models whose
// lifecycle_status='active'. The historical baseline that yielded
// "mcp=1111" was computed against the entire `status='active'` population,
// which silently included stale ghosts (entries the hub no longer publishes
// but our DB still remembers). Comparing fresh measurements against that
// historical number conflates "code regression" with "external drift".
//
// This script emits BOTH:
//   - the historical-style number (status='active' only)
//   - the recalibrated number (status='active' AND lifecycle_status='active')
//   - the delta and its attribution to stale/inactive ghosts
//
// The WHERE clauses come from the canonical policy module — see
// `src/capability/inventory-lifecycle-policy.ts` and ADR-023.
//
// Run AFTER hcra-lifecycle-classify.ts.

import { Pool } from 'pg';
import {
  HISTORICAL_UNIVERSE_WHERE,
  LIVE_UNIVERSE_WHERE,
  POLICY_SUMMARY,
  resolveLifecycleThresholds,
} from '@/capability/inventory-lifecycle-policy';

const TARGET_CAPS = [
  { uri: 'http://ailin.dev/cap/v1/mcp', short: 'mcp', oldBaseline: 1111 },
  { uri: 'http://ailin.dev/cap/v1/file_search', short: 'file_search', oldBaseline: 773 },
  { uri: 'http://ailin.dev/cap/v1/code_interpreter', short: 'code_interpreter', oldBaseline: 801 },
  { uri: 'http://ailin.dev/cap/v1/computer_use', short: 'computer_use', oldBaseline: 1020 },
];

(async () => {
  const thresholds = resolveLifecycleThresholds();
  const p = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(
    `policy=${POLICY_SUMMARY.adr}@v${POLICY_SUMMARY.version}  ` +
      `STALE_HOURS=${thresholds.staleHours}h  INACTIVE_DAYS=${thresholds.inactiveDays}d`,
  );

  // Universe sizes using the canonical WHERE clauses.
  const sizes = await p.query<{ k: string; n: number }>(
    `SELECT 'all_status_active' AS k, COUNT(*)::int AS n FROM models WHERE ${HISTORICAL_UNIVERSE_WHERE}
     UNION ALL
     SELECT 'lifecycle_active',          COUNT(*)::int FROM models WHERE ${LIVE_UNIVERSE_WHERE}
     UNION ALL
     SELECT 'lifecycle_stale',           COUNT(*)::int FROM models WHERE status='active' AND lifecycle_status='stale'
     UNION ALL
     SELECT 'lifecycle_inactive',        COUNT(*)::int FROM models WHERE status='active' AND lifecycle_status='inactive'`,
  );
  console.log('=== UNIVERSE SIZES ===');
  for (const r of sizes.rows) console.log(`  ${r.k.padEnd(25)} ${r.n}`);

  // Per-cap recalibrated coverage.
  console.log('\n=== COVERAGE: HISTORICAL vs RECALIBRATED ===');
  console.log('  cap                  hist_baseline  hist_now  Δhist  recalib  rate     ghost_w_cov');
  const results: Array<{
    cap: string; histNow: number; recalib: number; ghostWithCov: number; rate: string;
  }> = [];
  for (const { uri, short, oldBaseline } of TARGET_CAPS) {
    const r = await p.query<{ hist: number; recalib: number; ghost: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE $1 = ANY(capability_uris))::int AS hist,
         COUNT(*) FILTER (WHERE $1 = ANY(capability_uris) AND lifecycle_status='active')::int AS recalib,
         COUNT(*) FILTER (WHERE $1 = ANY(capability_uris) AND lifecycle_status<>'active')::int AS ghost
       FROM models WHERE ${HISTORICAL_UNIVERSE_WHERE}`,
      [uri],
    );
    const liveUniverse = sizes.rows.find(s => s.k === 'lifecycle_active')!.n;
    const rate = (r.rows[0].recalib / liveUniverse * 100).toFixed(1) + '%';
    const dHist = r.rows[0].hist - oldBaseline;
    const sign = (n: number) => (n >= 0 ? '+' : '') + n;
    console.log(
      `  ${short.padEnd(20)} ${String(oldBaseline).padStart(13)} ${String(r.rows[0].hist).padStart(9)} ${sign(dHist).padStart(6)} ${String(r.rows[0].recalib).padStart(7)} ${rate.padStart(7)} ${String(r.rows[0].ghost).padStart(11)}`,
    );
    results.push({ cap: short, histNow: r.rows[0].hist, recalib: r.rows[0].recalib, ghostWithCov: r.rows[0].ghost, rate });
  }

  // Verdict per cap.
  console.log('\n=== DELTA ATTRIBUTION ===');
  console.log('  Historical baseline numbers were computed before the synthetic');
  console.log('  tool-surface-family@v1 origin was removed AND before stale ghost');
  console.log('  inventory was identified. Recalibrated baseline reflects only');
  console.log('  models that the hub/native source still publishes.');
  console.log('');
  for (const { short, oldBaseline } of TARGET_CAPS) {
    const r = results.find(x => x.cap === short)!;
    const liveUniverse = sizes.rows.find(s => s.k === 'lifecycle_active')!.n;
    const oldUniverse = sizes.rows.find(s => s.k === 'all_status_active')!.n;
    const oldRate = (oldBaseline / oldUniverse * 100).toFixed(1);
    const newRate = (r.recalib / liveUniverse * 100).toFixed(1);
    const better = parseFloat(newRate) >= parseFloat(oldRate) ? 'improved or held' : 'rate dropped';
    console.log(
      `  ${short.padEnd(20)} old_rate=${oldRate}% (${oldBaseline}/${oldUniverse})   new_rate=${newRate}% (${r.recalib}/${liveUniverse})  ${better}`,
    );
  }

  // Hero models still covered?
  console.log('\n=== HERO MODELS — lifecycle status ===');
  const heroes = [
    ['openai', 'gpt-4o'],
    ['anthropic', 'claude-opus-4-6'],
    ['anthropic', 'claude-sonnet-4-5-20250929'],
    ['aihubmix', 'gpt-4o'],
    ['aihubmix', 'claude-opus-4-6'],
    ['aihubmix', 'claude-sonnet-4-5-20250929'],
  ];
  for (const [pid, id] of heroes) {
    const h = await p.query<{ ls: string; reason: string; cu: boolean; mcp: boolean; updated: string }>(
      `SELECT lifecycle_status AS ls, lifecycle_reason AS reason,
              ('http://ailin.dev/cap/v1/computer_use' = ANY(capability_uris)) AS cu,
              ('http://ailin.dev/cap/v1/mcp' = ANY(capability_uris)) AS mcp,
              updated_at::text AS updated
       FROM models WHERE provider_id=$1 AND id=$2 AND ${HISTORICAL_UNIVERSE_WHERE} LIMIT 1`,
      [pid, id],
    );
    if (h.rows.length === 0) console.log(`  ${pid}/${id}  (not active)`);
    else {
      const r = h.rows[0];
      console.log(`  ${(`${pid}/${id}`).padEnd(45)} lifecycle=${r.ls.padEnd(8)} mcp=${r.mcp ? 'Y' : 'N'} cu=${r.cu ? 'Y' : 'N'} reason=${r.reason ?? '-'}`);
    }
  }

  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
