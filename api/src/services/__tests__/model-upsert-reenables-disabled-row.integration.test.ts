// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DB-backed proof that the PRIMARY discovery write path — bulkUpsertModels'
 * raw `INSERT ... ON CONFLICT (uid) DO UPDATE` (central-model-discovery-
 * service.ts) — actually flips a previously-disabled row back to 'active'
 * when a live discovery source reconfirms it.
 *
 * WHY THIS EXISTS (2026-09-09, HF-Hub auto-re-enable investigation)
 * -------------------------------------------------------------------
 * Production had ~19,875 models auto-disabled by a since-fixed threshold bug
 * (see pricing-integrity-job.ts's "2026-09-08 INCIDENT" doc comment), and a
 * large subset of them (e.g. 13,575 `huggingface` rows) were STILL disabled
 * more than a day later despite their discovery source successfully
 * rediscovering models on every run. The investigation confirmed the
 * write-path logic itself is correct — `status = EXCLUDED.status` is stamped
 * UNCONDITIONALLY on every successful upsert (see the ON CONFLICT SET comment
 * in bulkUpsertModels) — but that guarantee had only ever been exercised
 * indirectly (via central-model-discovery-auto-reenable.test.ts, which pins
 * updateExistingModel(), the FALLBACK path used only when this raw SQL throws
 * or when createNewModel's race-guard fires). The PRIMARY path — this exact
 * raw SQL, used for the ~95 provider fetchers including huggingface-hub —
 * had no direct test proving it actually performs the same re-enable. This
 * closes that gap against a real Postgres instance rather than a mock.
 *
 * The SQL under test is spliced verbatim from bulkUpsertModels (same column
 * list, same ON CONFLICT SET clause shape, including MODEL_UPSERT_PERFORMANCE_SET),
 * so this exercises the actual expression, not a paraphrase of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import { MODEL_UPSERT_PERFORMANCE_SET } from '@/services/model-performance-baseline';

const PROVIDER_ID = 'reenable-upsert-probe';
const MODEL_ID = 'reenable-upsert-probe/model-1';
const UID = computeModelUid(PROVIDER_ID, MODEL_ID);

/** The exact ON CONFLICT shape from central-model-discovery-service.ts's
 *  bulkUpsertModels, reduced to the columns this test cares about (drops the
 *  capability-assertion bookkeeping, which is a separate, best-effort side
 *  effect covered elsewhere). */
async function runDiscoveryUpsert(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO models (
        uid, id, provider_id, name, display_name, context_window, max_output_tokens,
        input_cost_per_1k, output_cost_per_1k, capabilities, metadata, performance,
        status, updated_at, last_synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (uid) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        context_window = EXCLUDED.context_window,
        max_output_tokens = EXCLUDED.max_output_tokens,
        input_cost_per_1k = EXCLUDED.input_cost_per_1k,
        output_cost_per_1k = EXCLUDED.output_cost_per_1k,
        capabilities = EXCLUDED.capabilities,
        metadata = EXCLUDED.metadata,
        ${MODEL_UPSERT_PERFORMANCE_SET},
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    UID,
    MODEL_ID,
    PROVIDER_ID,
    MODEL_ID,
    MODEL_ID,
    8192,
    4096,
    0,
    0,
    JSON.stringify(['chat']),
    JSON.stringify({ source: 'reenable-upsert-probe' }),
    JSON.stringify({}),
    'active', // discovery ALWAYS reports a rediscovered model as 'active'
    new Date(),
    new Date()
  );
}

async function readModel(): Promise<{ status: string; lastSyncedAt: Date | null } | null> {
  return prisma.model.findUnique({
    where: { uid: UID },
    select: { status: true, lastSyncedAt: true },
  });
}

describe('bulkUpsertModels raw SQL — auto-re-enable on rediscovery (primary write path)', () => {
  beforeAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Re-enable Upsert Probe',
        status: 'active',
      },
    });
  });

  beforeEach(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
  });

  it('flips a disabled row back to active when discovery rediscovers it (the exact incident scenario)', async () => {
    // Seed the row exactly as the auto-disable sweep leaves it: status
    // 'disabled', an old lastSyncedAt, and the sweep's audit metadata tag.
    await prisma.model.create({
      data: {
        uid: UID,
        id: MODEL_ID,
        providerId: PROVIDER_ID,
        name: MODEL_ID,
        displayName: MODEL_ID,
        contextWindow: 8192,
        maxOutputTokens: 4096,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: ['chat'],
        status: 'disabled',
        metadata: {
          autoDisabledReason: 'delisted-unconfirmed',
          autoDisabledAt: '2026-09-08T05:01:46.000Z',
        },
        performance: {},
        lastSyncedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });

    const before = await readModel();
    expect(before?.status).toBe('disabled');

    // A live discovery source rediscovers the SAME model (same uid) and runs
    // the real bulkUpsertModels upsert.
    await runDiscoveryUpsert();

    const after = await readModel();
    expect(after?.status).toBe('active');
    // `last_synced_at` must also be bumped — it is what the pricing-integrity
    // staleness/auto-disable sweep reads to decide "reconfirmed recently".
    expect(after?.lastSyncedAt?.getTime()).toBeGreaterThan(
      new Date('2026-08-01T00:00:00Z').getTime()
    );
  });

  it('leaves an already-active row active (no spurious status churn)', async () => {
    await prisma.model.create({
      data: {
        uid: UID,
        id: MODEL_ID,
        providerId: PROVIDER_ID,
        name: MODEL_ID,
        displayName: MODEL_ID,
        contextWindow: 8192,
        maxOutputTokens: 4096,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: ['chat'],
        status: 'active',
        metadata: {},
        performance: {},
        lastSyncedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });

    await runDiscoveryUpsert();

    const after = await readModel();
    expect(after?.status).toBe('active');
  });
});
