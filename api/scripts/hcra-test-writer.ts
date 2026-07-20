// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Smoke test for assertion writer (ADR-022 Sprint 2 wiring).
 *
 * 1. Picks a real model from the DB.
 * 2. Builds a fake fetcher signal payload (provider-declared vision, etc.).
 * 3. Calls writeAssertions twice with the same origin → second call MUST
 *    supersede the first (counts must match).
 * 4. Materialises the model and prints the projection.
 */
import { writeAssertions } from '../src/capability/assertions/writer';
import { materialiseOneModel } from '../src/capability/assertions/materialiser';
import { prisma } from '../src/database/client';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const targetId = 'openai/gpt-oss-120b';
  const row = await prisma.model.findFirst({ where: { id: targetId }, select: { uid: true } });
  if (!row) {
    console.error(`No model found with id=${targetId}`);
    process.exit(1);
  }
  const modelUid = row.uid;
  console.log('Target model uid:', modelUid);

  const signals = [
    { capability: 'vision' as const, source: 'provider-declared' as const, confidence: 1.0, detail: { test: true } },
    { capability: 'function_calling' as const, source: 'parameter-derived' as const, confidence: 0.8, detail: { test: true } },
    { capability: 'reasoning' as const, source: 'modality-derived' as const, confidence: 0.7, detail: { test: true } },
  ];

  console.log('\n--- First write ---');
  const r1 = await writeAssertions([{ modelUid, signals }], { origin: 'test-writer@v1' });
  console.log(r1);

  console.log('\n--- Second write (should supersede first) ---');
  const r2 = await writeAssertions([{ modelUid, signals }], { origin: 'test-writer@v1' });
  console.log(r2);

  console.log('\n--- Materialising ---');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await materialiseOneModel(pool, modelUid);
    const { rows } = await pool.query(
      `SELECT capability_uris, capability_confidence, capability_sources
       FROM models WHERE uid = $1;`,
      [modelUid],
    );
    console.log(JSON.stringify(rows[0], null, 2));

    const { rows: live } = await pool.query(
      `SELECT capability_uri, source, confidence, source_detail
       FROM model_capability_assertions
       WHERE model_uid = $1 AND superseded_at IS NULL
       ORDER BY capability_uri, source;`,
      [modelUid],
    );
    console.log('\n--- Live (non-superseded) assertions ---');
    console.log(JSON.stringify(live, null, 2));
  } finally {
    await pool.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
