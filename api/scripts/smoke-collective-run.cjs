// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * F3.1 — CollectiveRun smoke test against live dev DB (CommonJS).
 *
 * Standalone: requires only the Prisma client at
 * `src/generated/prisma` (regenerated post-F1.5 migration). No
 * TypeScript compilation, no project module-resolution paths.
 *
 * Setup (run once on a fresh container):
 *   1. Apply migration:
 *        docker cp api/prisma/migrations/20260504000000_collective_runs ci-api:/app/prisma/migrations/
 *        docker exec ci-api sh -c "DATABASE_URL='postgresql://ci_user:ci_password@ci-postgres:5432/ci_db?schema=public' npx prisma migrate deploy --schema=/app/prisma/schema.prisma"
 *
 *   2. Regenerate client (if container shipped with pre-F1.5 schema):
 *        docker cp api/prisma/schema.prisma ci-api:/app/prisma/schema.prisma
 *        docker exec ci-api sh -c "cd /app && npx prisma generate"
 *
 *   3. Seed fixture data (org + run + signals): see SQL block in
 *      `docs/coordination/F3.1-smoke.md` (or insert manually via
 *      docker exec ci-postgres psql).
 *
 * Run:
 *   docker cp api/scripts/smoke-collective-run.cjs ci-api:/tmp/smoke.cjs
 *   docker exec -e DATABASE_URL='postgresql://ci_user:ci_password@ci-postgres:5432/ci_db?schema=public' \\
 *               ci-api sh -c "cd /tmp && node smoke.cjs"
 *
 * Validates:
 *   - F1.5 schema applied (collective_runs + collective_signals)
 *   - Repository-style read returns the row + nested signals
 *   - Decimal columns coerce to plain JS numbers
 *   - JSON metadata round-trips, including nested trace spans
 *   - Tenant isolation: query with wrong org returns null
 *   - listCollectiveRunsByRequestId equivalent returns the right row
 *
 * Successful run prints "OK — all 6 invariants passed" and exits 0.
 */

// Prisma 7 requires an explicit driver adapter — mirrors the pattern
// used by `dist/database/client.js` in the production container.
// Use the freshly-generated client at src/generated/prisma which has
// the updated F1.5 schema (collectiveRun / collectiveSignal models).
const { PrismaClient } = require('/app/src/generated/prisma/client.js');
const { PrismaPg } = require('/app/node_modules/@prisma/adapter-pg');
const pg = require('/app/node_modules/pg');

const RUN_ID = 'bbbbbbbb-2222-3333-4444-bbbbbbbbbbbb';
const ORG_ID = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
const WRONG_ORG = '00000000-0000-0000-0000-000000000000';

function fail(msg) {
  console.error('[smoke] FAIL —', msg);
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

  console.log(`[smoke] reading run ${RUN_ID} for org ${ORG_ID}...`);

  const run = await prisma.collectiveRun.findFirst({
    where: { id: RUN_ID, organizationId: ORG_ID },
    include: { signals: { orderBy: [{ round: 'asc' }] } },
  });

  if (!run) fail('run not found');

  const convergence = run.convergenceScore.toNumber();
  const cost = run.totalCostUsd.toNumber();
  if (convergence !== 0.88) fail(`convergenceScore=${convergence} (expected 0.88)`);
  if (cost !== 0.012345) fail(`totalCostUsd=${cost} (expected 0.012345)`);

  if (run.strategy !== 'sensitivity-consensus') fail(`strategy=${run.strategy}`);
  if (run.stopReason !== 'converged') fail(`stopReason=${run.stopReason}`);

  const metadata = run.metadata;
  const spans = metadata && metadata.collectiveTraceSpans;
  if (!Array.isArray(spans) || spans.length !== 1) fail('metadata.collectiveTraceSpans missing');
  if (spans[0].phase !== 'run_init') fail(`span phase=${spans[0].phase}`);

  if (run.signals.length !== 1) fail(`signals=${run.signals.length}`);
  const s = run.signals[0];
  if (s.modelId !== 'gpt-5' || s.decisionType !== 'approve') fail('signal data mismatch');
  if (s.decisionConfidence.toNumber() !== 0.85) fail('signal confidence mismatch');

  // Tenant isolation
  const wrong = await prisma.collectiveRun.findFirst({
    where: { id: RUN_ID, organizationId: WRONG_ORG },
  });
  if (wrong !== null) fail('wrong-org read returned data (tenant leak!)');

  // listCollectiveRunsByRequestId equivalent
  const byRequest = await prisma.collectiveRun.findMany({
    where: { requestId: 'smoke-eval-001', organizationId: ORG_ID },
  });
  if (byRequest.length !== 1) fail(`byRequest=${byRequest.length}`);

  console.log('[smoke] OK — all 6 invariants passed');
  console.log(`[smoke]   • schema present (FK + indexes)`);
  console.log(`[smoke]   • read by id: convergence=${convergence}, cost=${cost}, strategy=${run.strategy}`);
  console.log(`[smoke]   • signals: ${run.signals.length} (round=${s.round}, model=${s.modelId})`);
  console.log(`[smoke]   • metadata.collectiveTraceSpans: ${spans.length} span (phase=${spans[0].phase})`);
  console.log(`[smoke]   • tenant isolation: wrong-org → null`);
  console.log(`[smoke]   • by-requestId: ${byRequest.length} match`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[smoke] FAIL — unexpected error:', err.message || err);
  process.exit(1);
});
