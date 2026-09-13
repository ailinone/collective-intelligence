// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pricing Integrity Job — catalog-wide safeguard against silent pricing
 * corruption (2026-09 remediation).
 *
 * Closes the gap documented in the vertex-ai/openai pricing incidents: this
 * repo had NO automated integrity check on catalog pricing at all — only two
 * narrow per-fetcher unit tests (alibaba, bedrock) with synthetic inputs that
 * never touched the real DB, and openai/vertex-ai had no pricing tests
 * whatsoever. Two concrete bugs shipped to production undetected on the same
 * day because of this gap (see vertex-ai-model-fetcher.ts and
 * openai-model-fetcher.ts for the fixes). This job is the missing safeguard.
 *
 * Two independent checks run on every tick:
 *
 *  1. STALENESS QUARANTINE — a model whose `lastSyncedAt` predates
 *     PRICING_STALENESS_THRESHOLD_MS (or is NULL) has not been reconfirmed by
 *     any live discovery source recently. Its pricing may be correct, or it
 *     may be a "phantom row" for a model the provider delisted long ago whose
 *     wrong price can never self-correct because central-model-discovery-
 *     service's INSERT ... ON CONFLICT only touches rows the provider's
 *     current live listing still returns (see central-model-discovery-service.ts
 *     bulkUpsertModels for the fix that makes `lastSyncedAt` mean something —
 *     before that fix, discovery NEVER wrote it, so every row looked equally
 *     "fresh" or "stale" regardless of reality; that alone was a live bug this
 *     job's threshold depends on). Rather than silently keep trusting an
 *     unconfirmed price, we tag `metadata.pricingSource = 'stale-unverified'`
 *     so downstream cost-accounting/display can flag it. This is additive and
 *     non-destructive: it never changes the price numbers themselves, only
 *     whether they're presented as confirmed.
 *
 *     This is also the mechanism that retroactively closes the two concrete
 *     stale-pricing instances found in the 2026-09 audit (AWS Bedrock's
 *     gpt-oss-120b/gpt-oss-safeguard-120b/nvidia.nemotron-super-3-120b priced
 *     at Anthropic-flagship rates, and ~10 Alibaba qwen rows priced above any
 *     real frontier model): both sets have a `lastSyncedAt` far older than
 *     the threshold (Bedrock: NULL since 2026-05-10), so the very first tick
 *     after this job ships flags them without any separate data migration.
 *
 *  2. CROSS-TIER SANITY — delegates to cross-tier-pricing-check.ts to find any
 *     cheap/fast-tier-named model priced at or above its own family's
 *     flagship price. Violations are logged loudly (not auto-corrected — a
 *     wrong "fix" applied blind is its own risk) so an operator or a follow-up
 *     fetcher fix can act on them.
 *
 *  3. AUTO-DISABLE DELISTED MODELS (2026-09 follow-up) — sweep 1 above is
 *     additive and non-destructive by design: it tags a row, but the model
 *     stays fully selectable forever with a stale price, even for a provider
 *     that stopped listing it months ago. This sweep closes that gap: a model
 *     unconfirmed by ANY discovery source for MODEL_AUTO_DISABLE_THRESHOLD_MS
 *     (default 14 days — deliberately ~4.7x sweep 1's 72h flag threshold, so
 *     an ordinary multi-day provider outage cannot trip this on its own) gets
 *     `status` flipped from 'active' to 'disabled' via a real UPDATE, which
 *     `models.status: { not: 'disabled' }` catalog queries already exclude
 *     everywhere that matters. This is safely reversible: central-model-
 *     discovery-service.ts's write paths (bulkUpsertModels's ON CONFLICT SET
 *     and updateExistingModel's per-field diff) unconditionally set
 *     `status = 'active'` on every successful upsert, so a model this sweep
 *     disables auto-re-enables itself the moment a provider lists it again —
 *     no manual intervention, no separate "undo" code path to keep in sync.
 *     Every disable/re-enable is logged structurally (this file for disable;
 *     central-model-discovery-service.ts for re-enable) so catalog-membership
 *     changes stay auditable. Threshold override: MODEL_AUTO_DISABLE_THRESHOLD_MS.
 *     Kill-switch: MODEL_AUTO_DISABLE_DISABLED.
 *
 *     2026-09-08 INCIDENT + FIX: this sweep mass-disabled 19,875 models
 *     (17% of the catalog) in one run because several discovery sources
 *     (openai-native, anthropic-native, aws-bedrock-hub, orqai-hub,
 *     edenai-hub, ai302-hub, routeway-hub, and more) had zero working
 *     credentials in the process that runs this job — the worker
 *     entrypoint never loaded GCP secrets into process.env (fixed in
 *     workers/queue-runner.ts) — so `last_synced_at` staleness looked
 *     identical to genuine delisting for every model under those
 *     providers. `autoDisableDelistedModels()` now consults
 *     central-model-discovery-service.ts's
 *     `getProvidersWithoutHealthyDiscovery()` circuit breaker and skips
 *     disabling any row whose provider has NO currently-healthy discovery
 *     source, logging loudly (ERROR level) every tick that fires so a
 *     persistently-broken source cannot hide behind the exemption.
 *
 * Why a cron and not just a one-time backfill: new rows land wrong tomorrow
 * the same way they did on 2026-09-04 unless something keeps checking. See
 * metadata-backfill-job.ts for the identical idempotent-sweep argument.
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import {
  findCrossTierPricingViolations,
  type PricedModel,
  type CrossTierViolation,
} from '@/services/pricing-integrity/cross-tier-pricing-check';
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';

const log = logger.child({ component: 'pricing-integrity-job' });

const BATCH_SIZE = 500;

/**
 * Staleness threshold, justified against this repo's own discovery cadence
 * (model-discovery-scheduler.ts): `daily-full-discovery` runs once every 24h
 * and is the schedule guaranteed to sweep every provider end-to-end (the
 * 4-hourly schedule is incremental). 3x that interval (72h) gives headroom
 * for a missed run or two from transient provider/API outages — which are
 * common enough to be routine, not exceptional — while still catching a
 * genuinely delisted model within a few days instead of leaving it stale
 * forever, which is what happened before this job existed (Bedrock's
 * affected rows had `last_synced_at` NULL for 4+ months).
 */
export const PRICING_STALENESS_THRESHOLD_MS = 72 * 60 * 60 * 1000;

export function isPricingIntegrityCheckEnabled(): boolean {
  return process.env.PRICING_INTEGRITY_CHECK_DISABLED !== 'true';
}

/**
 * Auto-disable threshold — the point at which "unconfirmed by discovery"
 * stops meaning "flag as unverified" (PRICING_STALENESS_THRESHOLD_MS, 72h)
 * and starts meaning "this provider has very likely delisted the model;
 * stop offering it." Default is deliberately ~4.7x the staleness-flag
 * threshold: a provider would need to be unreachable across roughly TWO FULL
 * WEEKS of daily discovery runs (not just one or two missed cycles, which the
 * 72h flag already tolerates) before this fires, keeping the same kind of
 * transient-outage headroom PRICING_STALENESS_THRESHOLD_MS documents, scaled
 * up for a much higher-consequence action (catalog membership, not just a
 * metadata tag). 14 days is also comfortably shorter than the status quo
 * this closes: the Bedrock/Alibaba phantom rows PRICING_STALENESS_THRESHOLD_MS's
 * own comment describes went unconfirmed for MONTHS with zero enforcement.
 *
 * Env-overridable (MODEL_AUTO_DISABLE_THRESHOLD_MS, milliseconds) so an
 * operator can tune it without a redeploy — e.g. widen it further if a
 * legitimately slow provider trips false positives, or confirm the blast
 * radius with a shorter value in a staging environment first. An invalid or
 * non-positive override falls back to the 14-day default rather than
 * disabling the threshold entirely.
 */
export const MODEL_AUTO_DISABLE_THRESHOLD_MS = (() => {
  const override = Number(process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS);
  const DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_MS;
})();

export function isModelAutoDisableEnabled(): boolean {
  return process.env.MODEL_AUTO_DISABLE_DISABLED !== 'true';
}

export interface PricingIntegrityStats {
  staleCandidatesFound: number;
  staleRowsFlagged: number;
  crossTierViolations: number;
  crossTierViolationSamples: CrossTierViolation[];
  autoDisableCandidatesFound: number;
  modelsAutoDisabled: number;
  autoDisableSkippedUnhealthySource: number;
  elapsedMs: number;
}

const STALE_PRICING_SOURCE = 'stale-unverified';
const AUTO_DISABLE_REASON = 'delisted-unconfirmed';

/**
 * Sweep 1 — quarantine rows discovery hasn't reconfirmed within the
 * staleness threshold. Cursor-paginated on `uid` (the PK) for the same
 * reason as metadata-backfill-job.ts: OFFSET pagination re-scans the batch
 * prefix on every page (O(n^2)), `WHERE uid > $cursor` is an index seek.
 */
async function quarantineStaleModels(): Promise<{ found: number; flagged: number }> {
  const cutoff = new Date(Date.now() - PRICING_STALENESS_THRESHOLD_MS);

  const totalRow = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM models
    WHERE status = 'active'
      AND (last_synced_at IS NULL OR last_synced_at < ${cutoff})
      AND (metadata->>'pricingSource') IS DISTINCT FROM ${STALE_PRICING_SOURCE}
  `;
  const found = Number(totalRow[0]?.count ?? 0n);

  if (found === 0) {
    return { found: 0, flagged: 0 };
  }

  log.warn(
    { found, cutoff: cutoff.toISOString() },
    'Pricing integrity: found models not reconfirmed by discovery within the staleness threshold — quarantining'
  );

  let flagged = 0;
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition -- exits via `break` on empty batch.
  while (true) {
    const batch: Array<{ uid: string; metadata: unknown; id: string; provider_id: string }> =
      await prisma.$queryRawUnsafe(
        `SELECT uid, metadata, id, provider_id
           FROM models
          WHERE status = 'active'
            AND (last_synced_at IS NULL OR last_synced_at < $1)
            AND (metadata->>'pricingSource') IS DISTINCT FROM $2
            ${cursor ? 'AND uid > $3' : ''}
          ORDER BY uid ASC
          LIMIT ${BATCH_SIZE}`,
        ...(cursor ? [cutoff, STALE_PRICING_SOURCE, cursor] : [cutoff, STALE_PRICING_SOURCE])
      );

    if (batch.length === 0) break;

    for (const row of batch) {
      const meta =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};

      const newMeta: Record<string, unknown> = {
        ...meta,
        pricingSource: STALE_PRICING_SOURCE,
        staleDetectedAt: new Date().toISOString(),
        // Preserve whatever the fetcher originally reported, if any, so a
        // future reconciliation can tell "was never priced" apart from "was
        // priced but discovery stopped confirming it".
        priorPricingSource: meta.pricingSource ?? null,
      };

      try {
        await prisma.model.update({
          where: { uid: row.uid },
          data: { metadata: newMeta as Prisma.InputJsonValue },
        });
        flagged++;
      } catch (error) {
        log.warn(
          { uid: row.uid, id: row.id, providerId: row.provider_id, error },
          'Pricing integrity: failed to quarantine one stale model row'
        );
      }
    }

    cursor = batch[batch.length - 1].uid;
    if (batch.length < BATCH_SIZE) break;
  }

  return { found, flagged };
}

/**
 * Sweep 2 — disables a model that no discovery source has reconfirmed within
 * MODEL_AUTO_DISABLE_THRESHOLD_MS. Real catalog-membership change:
 * `status: 'active' → 'disabled'`. Cursor-paginated on `uid` for the same
 * reason as quarantineStaleModels above (sweep 1).
 *
 * Deliberately independent of the `stale-unverified` metadata tag sweep 1
 * writes: this queries `last_synced_at` directly rather than requiring the
 * tag to be present first, so it cannot be silently skipped by a row whose
 * sweep-1 UPDATE happened to fail on an earlier tick (see the try/catch in
 * quarantineStaleModels above — that failure path already logs a warning,
 * this sweep does not additionally depend on its success).
 *
 * Race guard (2026-09, adversarial-review fix): the candidate SELECT and the
 * per-row disable are two separate round-trips, and `model-discovery-hourly`
 * runs on the SAME `0 * * * *`-aligned tick this daily sweep's 05:00 UTC run
 * lands on — so a row can legitimately be reconfirmed by a live discovery
 * source (bulkUpsertModels/updateExistingModel bump `last_synced_at` and set
 * `status='active'`) in the gap between this sweep's SELECT and its UPDATE
 * for that same row. Unlike sweep 1 (a metadata tag — a stale write there is
 * a harmless, self-correcting label), this sweep's write is a real
 * catalog-membership change, so a stale write here would wrongly disable a
 * model discovery just reconfirmed, leaving it unselectable until the next
 * hourly tick's re-enable. The per-row write below is therefore a
 * conditional `updateMany` that re-asserts `status='active' AND
 * last_synced_at` staleness at write time (not just at SELECT time) and only
 * counts/logs a row as disabled when that guard actually matched — a
 * concurrent reconfirmation makes it match zero rows instead of clobbering
 * the fresh state.
 */
export async function autoDisableDelistedModels(): Promise<{
  found: number;
  disabled: number;
  skippedUnhealthySource: number;
}> {
  if (!isModelAutoDisableEnabled()) {
    log.info(
      'MODEL_AUTO_DISABLE_DISABLED=true — skipping delisted-model auto-disable sweep'
    );
    return { found: 0, disabled: 0, skippedUnhealthySource: 0 };
  }

  const cutoff = new Date(Date.now() - MODEL_AUTO_DISABLE_THRESHOLD_MS);

  const totalRow = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM models
    WHERE status = 'active'
      AND (last_synced_at IS NULL OR last_synced_at < ${cutoff})
  `;
  const found = Number(totalRow[0]?.count ?? 0n);

  if (found === 0) {
    return { found: 0, disabled: 0, skippedUnhealthySource: 0 };
  }

  // Circuit breaker (2026-09-08 incident fix): a provider whose discovery
  // coverage is CURRENTLY fully broken (every covering source reporting
  // zero models, e.g. a credential-loading bug) must not have its entire
  // stale-candidate catalog silently marched to 'disabled' — that conflates
  // "the provider delisted these" with "our pipeline can't see any of this
  // provider's models right now". See central-model-discovery-service.ts's
  // getProvidersWithoutHealthyDiscovery() for the full rationale. Failing to
  // compute this set (discovery service init error, etc.) falls back to
  // treating no provider as exempt — i.e. the pre-existing 14-day behavior —
  // rather than silently widening what this sweep protects against.
  let unhealthyProviders: Set<string> = new Set();
  try {
    const discoveryService = await getCentralModelDiscoveryService();
    unhealthyProviders = discoveryService.getProvidersWithoutHealthyDiscovery();
  } catch (error) {
    log.error(
      { error },
      'Model auto-disable: failed to compute unhealthy-discovery-source exemptions — ' +
        'proceeding WITHOUT the circuit breaker for this tick (pre-existing behavior)'
    );
  }

  if (unhealthyProviders.size > 0) {
    // Loud and ERROR-level on purpose: this exemption existing at all means
    // some provider's discovery is currently blind, and if this keeps firing
    // for the SAME provider across many days it means the underlying source
    // is still broken and needs a real fix — this log line (repeated every
    // tick it applies) is the mechanism that stops the exemption from
    // silently masking a genuinely broken source forever.
    log.error(
      { providers: Array.from(unhealthyProviders) },
      'Model auto-disable: provider(s) have NO currently-healthy discovery source — ' +
        'their stale-candidate rows are EXEMPTED from auto-disable this tick. If this ' +
        'persists across multiple days, the discovery source(s) covering these providers ' +
        'are broken and need investigation, not a permanent exemption.'
    );
  }

  log.warn(
    {
      found,
      cutoff: cutoff.toISOString(),
      thresholdDays: MODEL_AUTO_DISABLE_THRESHOLD_MS / (24 * 60 * 60 * 1000),
    },
    'Model auto-disable: found models unconfirmed by any discovery source past the delisted threshold — disabling'
  );

  let disabled = 0;
  let skippedUnhealthySource = 0;
  let cursor: string | null = null;
  const disabledSample: Array<{
    uid: string;
    id: string;
    providerId: string;
    lastSyncedAt: string | null;
  }> = [];

  // eslint-disable-next-line no-constant-condition -- exits via `break` on empty batch.
  while (true) {
    const batch: Array<{
      uid: string;
      id: string;
      provider_id: string;
      metadata: unknown;
      last_synced_at: Date | null;
    }> = await prisma.$queryRawUnsafe(
      `SELECT uid, id, provider_id, metadata, last_synced_at
         FROM models
        WHERE status = 'active'
          AND (last_synced_at IS NULL OR last_synced_at < $1)
          ${cursor ? 'AND uid > $2' : ''}
        ORDER BY uid ASC
        LIMIT ${BATCH_SIZE}`,
      ...(cursor ? [cutoff, cursor] : [cutoff])
    );

    if (batch.length === 0) break;

    for (const row of batch) {
      if (unhealthyProviders.has(row.provider_id)) {
        skippedUnhealthySource++;
        log.info(
          { uid: row.uid, id: row.id, providerId: row.provider_id },
          'Model auto-disable: skipped — provider has no currently-healthy discovery source ' +
            '(circuit breaker; see the ERROR-level summary log for this tick)'
        );
        continue;
      }

      const meta =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};

      const lastSyncedAtIso = row.last_synced_at ? row.last_synced_at.toISOString() : null;
      const newMeta: Record<string, unknown> = {
        ...meta,
        autoDisabledReason: AUTO_DISABLE_REASON,
        autoDisabledAt: new Date().toISOString(),
        autoDisabledLastSyncedAt: lastSyncedAtIso,
      };

      try {
        // Conditional write (race guard): re-assert staleness at UPDATE time,
        // not just at SELECT time. If a concurrent discovery run reconfirmed
        // this row (bumped last_synced_at and/or flipped status back to
        // 'active') between our SELECT above and this UPDATE, `count` comes
        // back 0 and we correctly skip disabling a model that is no longer
        // actually stale — see the doc comment above this function.
        const result = await prisma.model.updateMany({
          where: {
            uid: row.uid,
            status: 'active',
            OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
          },
          data: {
            status: 'disabled',
            metadata: newMeta as Prisma.InputJsonValue,
            updatedAt: new Date(),
          },
        });

        if (result.count > 0) {
          disabled++;
          if (disabledSample.length < 50) {
            disabledSample.push({
              uid: row.uid,
              id: row.id,
              providerId: row.provider_id,
              lastSyncedAt: lastSyncedAtIso,
            });
          }
          log.warn(
            {
              uid: row.uid,
              id: row.id,
              providerId: row.provider_id,
              lastSyncedAt: lastSyncedAtIso,
              cutoff: cutoff.toISOString(),
            },
            'Model auto-disable: model unconfirmed by discovery past the delisted threshold — status flipped to disabled'
          );
        } else {
          log.info(
            { uid: row.uid, id: row.id, providerId: row.provider_id },
            'Model auto-disable: skipped — row was reconfirmed by discovery between scan and write (race avoided)'
          );
        }
      } catch (error) {
        log.warn(
          { uid: row.uid, id: row.id, providerId: row.provider_id, error },
          'Model auto-disable: failed to disable one delisted model row'
        );
      }
    }

    cursor = batch[batch.length - 1].uid;
    if (batch.length < BATCH_SIZE) break;
  }

  log.warn(
    { found, disabled, skippedUnhealthySource, sample: disabledSample },
    'Model auto-disable sweep complete — see central-model-discovery-service.ts for the matching auto-re-enable path'
  );

  return { found, disabled, skippedUnhealthySource };
}

/**
 * Sweep 3 — cross-tier sanity check across the whole active catalog. Read-only:
 * violations are logged, not auto-corrected.
 */
async function checkCrossTierPricing(): Promise<CrossTierViolation[]> {
  const rows: Array<{
    id: string;
    provider_id: string;
    input_cost_per_1k: Prisma.Decimal;
    output_cost_per_1k: Prisma.Decimal;
  }> = await prisma.$queryRaw`
    SELECT id, provider_id, input_cost_per_1k, output_cost_per_1k
    FROM models
    WHERE status = 'active'
  `;

  const models: PricedModel[] = rows.map((r) => ({
    id: r.id,
    providerId: r.provider_id,
    inputCostPer1M: Number(r.input_cost_per_1k) * 1000,
    outputCostPer1M: Number(r.output_cost_per_1k) * 1000,
  }));

  const violations = findCrossTierPricingViolations(models);

  if (violations.length > 0) {
    log.error(
      {
        violationCount: violations.length,
        // Cap the inline sample so a catalog-wide regression doesn't flood
        // the log line; the full count above is still visible either way.
        sample: violations.slice(0, 20),
      },
      'Pricing integrity: cross-tier violations found — a cheap/fast-tier model is priced at or above its own family flagship price'
    );
  }

  return violations;
}

export async function runPricingIntegrityCheckNow(): Promise<PricingIntegrityStats> {
  const startedAt = Date.now();

  if (!isPricingIntegrityCheckEnabled()) {
    log.info('PRICING_INTEGRITY_CHECK_DISABLED=true — skipping pricing integrity tick');
    return {
      staleCandidatesFound: 0,
      staleRowsFlagged: 0,
      crossTierViolations: 0,
      crossTierViolationSamples: [],
      autoDisableCandidatesFound: 0,
      modelsAutoDisabled: 0,
      autoDisableSkippedUnhealthySource: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const { found, flagged } = await quarantineStaleModels();
  const {
    found: autoDisableFound,
    disabled: autoDisabled,
    skippedUnhealthySource,
  } = await autoDisableDelistedModels();
  const violations = await checkCrossTierPricing();

  const stats: PricingIntegrityStats = {
    staleCandidatesFound: found,
    staleRowsFlagged: flagged,
    crossTierViolations: violations.length,
    crossTierViolationSamples: violations.slice(0, 20),
    autoDisableCandidatesFound: autoDisableFound,
    modelsAutoDisabled: autoDisabled,
    autoDisableSkippedUnhealthySource: skippedUnhealthySource,
    elapsedMs: Date.now() - startedAt,
  };

  log.info(
    {
      staleCandidatesFound: stats.staleCandidatesFound,
      staleRowsFlagged: stats.staleRowsFlagged,
      crossTierViolations: stats.crossTierViolations,
      autoDisableCandidatesFound: stats.autoDisableCandidatesFound,
      modelsAutoDisabled: stats.modelsAutoDisabled,
      autoDisableSkippedUnhealthySource: stats.autoDisableSkippedUnhealthySource,
      elapsedMs: stats.elapsedMs,
    },
    'Pricing integrity tick complete'
  );

  return stats;
}
