// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Quick fusion check: materialise gpt-oss-120b after a synthetic
 * provider-declared vision assertion was injected, and show the projection.
 */
import { Pool } from 'pg';
import { materialiseOneModel } from '../src/capability/assertions/materialiser';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: targets } = await pool.query<{ uid: string }>(
      "SELECT uid FROM models WHERE id = 'openai/gpt-oss-120b';",
    );
    for (const r of targets) await materialiseOneModel(pool, r.uid);
    console.log(`rematerialised ${targets.length} models`);

    const { rows: out } = await pool.query(
      `SELECT id, capability_uris, capability_confidence, capability_sources
       FROM models WHERE id = 'openai/gpt-oss-120b' LIMIT 1;`,
    );
    console.log(JSON.stringify(out[0], null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
