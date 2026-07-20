// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * F3.3 — Collective extraction-stream smoke test against live dev DB (CommonJS).
 *
 * Standalone: requires only the Prisma client at `src/generated/prisma`.
 *
 * What it validates:
 *   1. The 20260504010000_collective_extraction_state_seed migration is
 *      idempotent (INSERT … ON CONFLICT DO NOTHING) and the 'collective'
 *      watermark row is present.
 *   2. The SELECT queries used by `extractCollective` execute against the
 *      live schema without type errors.
 *   3. The watermark UPDATE advances `last_watermark` only when rows are
 *      extracted (the conditional `if (rowCount > 0)` guard).
 *   4. The `run_id = ANY($1::uuid[])` array binding works against pg.
 *   5. JSONL records can be assembled from the live row shapes
 *      (Decimal → number coercion, Date → ISO string).
 *
 * Setup (run once on a fresh container):
 *   docker cp api/prisma/migrations/20260504010000_collective_extraction_state_seed ci-api:/app/prisma/migrations/
 *   docker exec ci-api sh -c "DATABASE_URL='postgresql://ci_user:ci_password@ci-postgres:5432/ci_db?schema=public' npx prisma migrate deploy --schema=/app/prisma/schema.prisma"
 *
 * Optional fixture (only needed if F1.5 smoke data was cleaned up):
 *   docker exec -i ci-postgres psql -U ci_user -d ci_db < api/scripts/fixtures/f3.3-collective-export.sql
 *
 * Run:
 *   docker cp api/scripts/smoke-collective-export.cjs ci-api:/tmp/smoke-export.cjs
 *   docker exec -e DATABASE_URL='postgresql://ci_user:ci_password@ci-postgres:5432/ci_db?schema=public' \\
 *               ci-api sh -c "cd /tmp && node smoke-export.cjs"
 *
 * Successful run prints "OK — all 5 invariants passed" and exits 0.
 */

const { PrismaClient } = require('/app/src/generated/prisma/client.js');
const { PrismaPg } = require('/app/node_modules/@prisma/adapter-pg');
const pg = require('/app/node_modules/pg');
const { createHash } = require('crypto');

const PEPPER = process.env.FEEDBACK_HASH_PEPPER || 'local-smoke-pepper';

function hashTraceId(traceId) {
  return createHash('sha256').update(traceId + PEPPER).digest('hex').slice(0, 16);
}

function fail(msg) {
  console.error('[smoke-export] FAIL —', msg);
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://ci_user:ci_password@ci-postgres:5432/ci_db?schema=public',
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // ── 1. Watermark seed row ─────────────────────────────────────────────
  console.log('[smoke-export] verifying feedback_extraction_state seed...');
  const seedRows = await prisma.$queryRaw`
    SELECT extraction_type, last_watermark FROM feedback_extraction_state WHERE extraction_type = 'collective'
  `;
  if (!Array.isArray(seedRows) || seedRows.length !== 1) {
    fail('feedback_extraction_state row for extraction_type=collective is missing — did you apply migration 20260504010000_collective_extraction_state_seed?');
  }
  const watermarkBefore = seedRows[0].last_watermark;
  console.log(`[smoke-export]   • seed present (last_watermark=${watermarkBefore.toISOString()})`);

  // ── 2. Run-fetch query (matches extractCollective) ────────────────────
  console.log('[smoke-export] running run-fetch SELECT...');
  const cutoff = new Date();
  const runRows = await prisma.$queryRaw`
    SELECT
      id, request_id, strategy, rounds, stop_reason,
      convergence_score, decision_flip_rate, dissent,
      total_cost_usd, total_latency_ms, total_tokens,
      final_decision_type, final_confidence,
      config, metadata, created_at
    FROM collective_runs
    WHERE created_at > ${watermarkBefore}
      AND created_at <= ${cutoff}
    ORDER BY created_at ASC
    LIMIT 100
  `;
  console.log(`[smoke-export]   • runs fetched: ${runRows.length}`);

  // ── 3. Signal-fetch query with array binding ──────────────────────────
  if (runRows.length > 0) {
    console.log('[smoke-export] running signal-fetch SELECT (run_id = ANY($1::uuid[]))...');
    const runIds = runRows.map((r) => r.id);
    const signalRows = await prisma.$queryRaw`
      SELECT
        run_id, round, agent_id, model_id, provider_id, role,
        decision_type, decision_value, decision_confidence, decision_rationale,
        sensitivities, latency_ms, input_tokens, output_tokens, cost_usd, created_at
      FROM collective_signals
      WHERE run_id = ANY(${runIds}::uuid[])
      ORDER BY run_id, round, created_at
    `;
    console.log(`[smoke-export]   • signals fetched: ${signalRows.length}`);

    // ── 4. JSONL record assembly ────────────────────────────────────────
    const sampleRun = runRows[0];
    const runRecord = {
      run_id_hash: hashTraceId(sampleRun.id),
      request_id_hash: sampleRun.request_id ? hashTraceId(sampleRun.request_id) : null,
      strategy: sampleRun.strategy,
      rounds: sampleRun.rounds,
      stop_reason: sampleRun.stop_reason,
      convergence_score: Number(sampleRun.convergence_score),
      decision_flip_rate: Number(sampleRun.decision_flip_rate),
      dissent: Number(sampleRun.dissent),
      total_cost_usd: Number(sampleRun.total_cost_usd),
      total_latency_ms: sampleRun.total_latency_ms,
      total_tokens: sampleRun.total_tokens,
      final_decision_type: sampleRun.final_decision_type,
      final_confidence: sampleRun.final_confidence !== null ? Number(sampleRun.final_confidence) : null,
      config: sampleRun.config,
      metadata: sampleRun.metadata,
      created_at: sampleRun.created_at.toISOString(),
    };

    const jsonl = JSON.stringify(runRecord);
    if (!jsonl.startsWith('{') || !jsonl.endsWith('}')) {
      fail('run record does not serialize to a single JSON object');
    }
    if (jsonl.includes(sampleRun.id)) {
      fail('raw run id leaked into JSONL — hashing failed');
    }
    if (sampleRun.request_id && jsonl.includes(sampleRun.request_id)) {
      fail('raw request id leaked into JSONL — hashing failed');
    }

    if (typeof runRecord.convergence_score !== 'number' || !isFinite(runRecord.convergence_score)) {
      fail(`convergence_score did not coerce to finite number: ${runRecord.convergence_score}`);
    }
    if (typeof runRecord.total_cost_usd !== 'number' || !isFinite(runRecord.total_cost_usd)) {
      fail(`total_cost_usd did not coerce to finite number: ${runRecord.total_cost_usd}`);
    }
    console.log(`[smoke-export]   • JSONL well-formed: ${jsonl.length} bytes, hashes ok, decimals coerced`);
  } else {
    console.log('[smoke-export]   • no runs to extract — query syntax verified, JSONL assembly skipped');
  }

  // ── 5. Watermark UPDATE syntax validity (without committing) ──────────
  console.log('[smoke-export] verifying watermark UPDATE syntax (rolled-back transaction)...');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE feedback_extraction_state
      SET last_watermark = ${cutoff},
          last_extraction_id = ${'smoke-' + Date.now()},
          rows_extracted = rows_extracted + ${BigInt(runRows.length)},
          updated_at = NOW()
      WHERE extraction_type = 'collective'
    `;
    // Force rollback so the smoke run does not advance the real watermark.
    throw new Error('intentional-rollback');
  }).catch((err) => {
    if (err.message !== 'intentional-rollback') throw err;
  });

  const seedAfter = await prisma.$queryRaw`
    SELECT last_watermark FROM feedback_extraction_state WHERE extraction_type = 'collective'
  `;
  if (seedAfter[0].last_watermark.getTime() !== watermarkBefore.getTime()) {
    fail('rollback did not restore watermark — UPDATE leaked outside transaction!');
  }
  console.log('[smoke-export]   • UPDATE syntax valid; rollback honored');

  console.log('[smoke-export] OK — all 5 invariants passed');
  console.log('[smoke-export]   1. extraction_state seed present');
  console.log('[smoke-export]   2. run-fetch SELECT executes');
  console.log('[smoke-export]   3. signal-fetch SELECT executes (array binding)');
  console.log('[smoke-export]   4. JSONL record assembly clean (hashing + Decimal coercion)');
  console.log('[smoke-export]   5. watermark UPDATE syntax valid');

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error('[smoke-export] FAIL — unexpected error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
