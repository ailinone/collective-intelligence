// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Pure regression check: did any lifecycle_active model that was discoverable
// recently lose a cap it held in the historical baseline?
//
// Approach: count caps for *every* lifecycle_active model now, and compare
// against the historical-style population. Any active model with zero target
// caps that has a regex-matchable family identifier is a regression candidate.
//
// The WHERE fragments come from the canonical policy module — see
// `src/capability/inventory-lifecycle-policy.ts` and ADR-023.

import { Pool } from 'pg';
import {
  HISTORICAL_UNIVERSE_WHERE,
  LIVE_UNIVERSE_WHERE,
} from '@/capability/inventory-lifecycle-policy';

const TARGET_CAPS = ['mcp', 'file_search', 'code_interpreter', 'computer_use'];
const TARGET_URIS = TARGET_CAPS.map(c => `http://ailin.dev/cap/v1/${c}`);

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });

  // Active models that match a known capability-bearing family but have ZERO
  // of the 4 target caps. These would be live regressions if the family
  // truly should have the cap.
  const sus = await p.query<{ provider_id: string; id: string; updated: string }>(
    `SELECT m.provider_id, m.id, m.updated_at::text AS updated
     FROM models m
     WHERE ${LIVE_UNIVERSE_WHERE}
       AND NOT EXISTS (
         SELECT 1 FROM unnest($1::text[]) cap
         WHERE cap = ANY(m.capability_uris)
       )
       AND (
         m.id ~* '^(gpt-4o(-2024|$)|gpt-4\\.1|gpt-5|o1$|o1-(mini|preview)|o3|o4)' OR
         m.id ~* '^claude-(3-5-sonnet-2024(10|11|12)|3-7-sonnet|sonnet-4|opus-4|haiku-4|opus-4-[0-9])'
       )
     ORDER BY m.provider_id, m.id LIMIT 30`,
    [TARGET_URIS],
  );

  console.log('=== LIVE-ACTIVE MODELS MATCHING CAP-BEARING FAMILY BUT ZERO COVERAGE ===');
  if (sus.rows.length === 0) {
    console.log('  [OK] NONE — no live-active model with cap-bearing family signature lacks coverage.');
  } else {
    console.log(`  [WARN] ${sus.rows.length} candidate regressions:`);
    for (const r of sus.rows) console.log(`  ${r.provider_id.padEnd(20)} ${r.id.padEnd(45)} updated=${r.updated}`);
  }

  // Counter-check: how many lifecycle_active models hold each target cap
  console.log('\n=== LIFECYCLE-ACTIVE COVERAGE PER CAP ===');
  for (const cap of TARGET_URIS) {
    const r = await p.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM models
       WHERE ${LIVE_UNIVERSE_WHERE} AND $1 = ANY(capability_uris)`,
      [cap],
    );
    const slug = cap.replace('http://ailin.dev/cap/v1/', '');
    console.log(`  ${slug.padEnd(20)} ${r.rows[0].n}`);
  }

  // Anti-check: any inactive model still in coverage matrix? (acceptable
  // residue but inform.)
  const ghosts = await p.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM models
     WHERE ${HISTORICAL_UNIVERSE_WHERE} AND lifecycle_status<>'active'
       AND capability_uris && $1::text[]`,
    [TARGET_URIS],
  );
  console.log(`\n=== GHOSTS (lifecycle<>active) STILL IN TARGET COVERAGE: ${ghosts.rows[0].n} ===`);

  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
