// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA Materialiser Runner
 *
 * One-shot CLI: rebuilds models.capability_uris/confidence/sources from
 * model_capability_assertions using Bayesian noisy-OR fusion. Idempotent.
 *
 * Usage:
 *   DATABASE_URL="postgresql://ci_user:ci_password@localhost:5434/ci_db" \
 *     npx tsx scripts/hcra-materialise.ts
 */

import { Pool } from 'pg';
import { materialiseAllCapabilities } from '../src/capability/assertions/materialiser';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log('[hcra-materialise] running Bayesian fusion over all active assertions...');
    const stats = await materialiseAllCapabilities(pool);
    const elapsedSec = (stats.elapsedMs / 1000).toFixed(1);
    console.log(
      `[hcra-materialise] done in ${elapsedSec}s — ` +
        `models_written=${stats.modelsWritten} ` +
        `models_cleared=${stats.modelsCleared} ` +
        `caps_emitted=${stats.capabilitiesEmitted} ` +
        `caps_suppressed=${stats.capabilitiesSuppressed}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[hcra-materialise] FAILED:', err);
  process.exit(1);
});
