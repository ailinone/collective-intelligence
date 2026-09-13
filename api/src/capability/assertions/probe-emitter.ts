// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Runtime capability probe → assertion log (GAP-A13)
 *
 * ## The asymmetry this closes
 *
 * Every capability except one is filtered fail-closed from the catalog/DB
 * projection: `dynamic-model-selector.ts` keeps only models whose
 * `capability_uris` (or legacy `capabilities`) declare ALL required
 * capabilities, and returns an EMPTY pool when none do.
 *
 * `function_calling` is excluded from that filter and deferred to an empirical
 * runtime probe instead, because the catalog's own `tools` declarations were
 * audited and found unreliable — 184 of 232 rows say `tools: true`, ZERO say
 * `tools: false`, and 48 say nothing, so the flag is a tri-state that is never
 * negative and therefore cannot fail-close on anything.
 *
 * That trade-off is defensible, but the way it was implemented left the probe's
 * verdict stranded: it lived only in Redis as a bare `'1'`/`'0'` string under a
 * 7-day TTL — no timestamp, no observation count, no audit trail — and never
 * reached `capability_uris`. Two parallel systems of record, permanently.
 *
 * This module removes the parallelism without trusting the untrustworthy flag.
 * A definitive probe verdict is written to the SAME append-only assertion log
 * everything else uses, as source `runtime-probe` (weight 0.98, just under an
 * operator override and above `provider-declared` — it is an observation, not a
 * claim). The materialiser then fuses it into `capability_uris` like any other
 * evidence, so a model that has DEMONSTRATED tool-calling satisfies a
 * hard `function_calling` requirement through the ordinary filter path.
 *
 * The promotion is therefore driven by empirical confirmation, never by the
 * catalog declaration. Nothing about `supports.tools` becomes load-bearing.
 *
 * ## Why the selector's exclusion is NOT removed in the same change
 *
 * See the GAP-A13 ADR in reports/provider-integration-gap-register.json. In
 * short: promoting positives is safe and additive, but flipping the filter to
 * fail-CLOSED on `function_calling` would exclude every model that simply has
 * not been probed yet (the probe is lazy, capped at 500 per process, and only
 * fires during execution), which would empty pools rather than filter them.
 * That step needs a measured coverage floor first, and the assertion rows this
 * module writes are what make that floor measurable.
 *
 * ## Cost
 *
 * Called only on a genuine probe MISS — i.e. at most once per (provider,model)
 * per 7 days, and at most `FC_PROBE_MAX_PROBES` (500) times per process, right
 * after an HTTP round-trip that already cost up to 10s. The write is awaited by
 * the caller's fire-and-forget wrapper, never on the request's critical path,
 * and never throws.
 */

import { prisma } from '@/database/client';
import type { PrismaClient } from '@/generated/prisma/index.js';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import { logger } from '@/utils/logger';
import { incrementCounter, METRIC_NAMES } from '@/core/operability/metrics';
import { writeAssertions } from './writer';

const log = logger.child({ component: 'probe-assertion-emitter' });

type PrismaRunner = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

/** Supersedence key: one probe generation per capability. */
const ORIGIN = 'runtime-probe@v1';

/**
 * Whether probe verdicts are persisted as assertions. Default ON. Sharing a
 * kill switch with the discovery emitter would be wrong — these are different
 * write paths with different blast radii — so this gets its own.
 */
export function isProbeAssertionsEnabled(): boolean {
  return process.env.HCRA_PROBE_ASSERTIONS_DISABLED !== 'true';
}

export interface ProbeAssertionInput {
  /** Provider id as the execution path knows it. */
  providerId: string;
  /** Model id as the execution path knows it. */
  modelId: string;
  /** Legacy capability slug, e.g. `function_calling`. */
  capability: string;
  /** The probe's verdict. Only definitive verdicts should reach here. */
  supported: boolean;
  runner?: PrismaRunner;
}

export type ProbeAssertionOutcome =
  | 'written'
  | 'disabled'
  | 'model-not-found'
  | 'unmapped-capability'
  | 'failed';

/**
 * Resolve the `models.uid` for a (provider, model) pair.
 *
 * The uid is NOT recomputed from `computeModelUid(providerId, modelId)` on
 * purpose: the probe runs on the execution path, where `providerId` is the
 * adapter/registry name and may differ from the `models.provider_id` a
 * discovery source wrote (gateways attribute models to an upstream owner, and
 * the same model id exists under several providers). A hashed guess would
 * silently violate the FK and lose the verdict; a lookup either finds the real
 * row or tells us honestly that we have nothing to attach the evidence to.
 */
async function resolveModelUid(
  runner: PrismaRunner,
  providerId: string,
  modelId: string
): Promise<string | null> {
  const rows = await runner.$queryRawUnsafe<Array<{ uid: string }>>(
    `SELECT uid FROM models
      WHERE provider_id = $1 AND id = $2 AND status = 'active'
      LIMIT 1`,
    providerId,
    modelId
  );
  return rows[0]?.uid ?? null;
}

/**
 * Persist one empirical capability verdict. Never throws.
 */
export async function recordProbeAssertion(
  input: ProbeAssertionInput
): Promise<ProbeAssertionOutcome> {
  if (!isProbeAssertionsEnabled()) return 'disabled';

  const uri = LEGACY_CAPABILITY_TO_URI[input.capability];
  if (!uri) {
    log.warn(
      { capability: input.capability },
      'No ontology URI for probed capability — verdict not persisted'
    );
    return record(input, 'unmapped-capability');
  }

  const runner = input.runner ?? prisma;

  try {
    const modelUid = await resolveModelUid(runner, input.providerId, input.modelId);
    if (!modelUid) {
      // Common and benign: the probe can fire for a model this deployment's
      // discovery has not (yet) materialised. Nothing to attach evidence to.
      log.debug(
        { providerId: input.providerId, modelId: input.modelId },
        'Probed model has no row in `models` — verdict not persisted'
      );
      return record(input, 'model-not-found');
    }

    await writeAssertions(
      [
        {
          modelUid,
          signals: [
            {
              capability: input.capability as never,
              source: 'runtime-probe',
              detail: {
                source_field: 'runtime-probe:request-accepted',
                providerId: input.providerId,
                modelId: input.modelId,
                verdict: input.supported ? 'supported' : 'unsupported',
              },
            },
          ],
        },
      ],
      // The origin is per-capability so a future probe for a DIFFERENT
      // capability does not supersede this one's row.
      { origin: `${ORIGIN}:${input.capability}`, assertedValue: input.supported },
      runner
    );

    return record(input, 'written');
  } catch (error) {
    log.warn(
      {
        providerId: input.providerId,
        modelId: input.modelId,
        capability: input.capability,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist runtime probe assertion — probe result still served from cache'
    );
    return record(input, 'failed');
  }
}

function record(input: ProbeAssertionInput, outcome: ProbeAssertionOutcome): ProbeAssertionOutcome {
  incrementCounter(
    METRIC_NAMES.CAPABILITY_PROBE_ASSERTION_TOTAL,
    { capability: input.capability, outcome },
    { log: false }
  );
  return outcome;
}

/**
 * Multi-capability variant of `recordProbeAssertion` (Tiered Capability
 * Fingerprint, 2026-09).
 *
 * `recordProbeAssertion` above is shaped for the function-calling probe,
 * which only ever asserts ONE capability per model. The Tier-1 diagnostic
 * probe (`tier1-diagnostic-probe.ts`) can structurally confirm several
 * capabilities (chat/reasoning/analysis/code_generation/json_mode/
 * streaming/translation/refactoring) from a SINGLE response, and the Tier-3
 * multimodal probe confirms exactly one modality capability per call — both
 * reuse this instead of paying `resolveModelUid`'s query once per capability.
 *
 * Same contract as `recordProbeAssertion`: never throws, only positive
 * ("the model HAS this capability") signals are written — there is no
 * decisive "explicitly rejected" shape here the way the FC probe's
 * tools-not-supported error has, so nothing negative is asserted. `origin`
 * is per-CALLER (one tag for the whole Tier-1 diagnostic pass, one for
 * Tier-3), not per-capability like the FC probe's origin: a fresh Tier-1
 * response is a full snapshot of everything that pass could detect, so
 * re-running it should supersede ALL of its own prior capabilities for that
 * model in one shot, exactly like a discovery fetcher's own full-snapshot
 * convention (`writer.ts`'s module doc).
 */
export interface MultiProbeAssertionInput {
  readonly providerId: string;
  readonly modelId: string;
  /** Supersedence key — see module doc above. e.g. `tier1-diagnostic-probe@v1`. */
  readonly origin: string;
  readonly signals: ReadonlyArray<{
    readonly capability: string;
    readonly confidence?: number;
    readonly detail?: Record<string, unknown>;
  }>;
  readonly runner?: PrismaRunner;
}

export async function recordProbeAssertions(
  input: MultiProbeAssertionInput
): Promise<ProbeAssertionOutcome> {
  if (!isProbeAssertionsEnabled()) return recordMulti(input, 'disabled');
  if (input.signals.length === 0) return recordMulti(input, 'written'); // nothing to do, not an error

  const runner = input.runner ?? prisma;

  const mappable = input.signals.filter((s) => Boolean(LEGACY_CAPABILITY_TO_URI[s.capability]));
  if (mappable.length === 0) {
    log.warn(
      { capabilities: input.signals.map((s) => s.capability) },
      'No ontology URI for any probed capability — verdicts not persisted'
    );
    return recordMulti(input, 'unmapped-capability');
  }

  try {
    const modelUid = await resolveModelUid(runner, input.providerId, input.modelId);
    if (!modelUid) {
      log.debug(
        { providerId: input.providerId, modelId: input.modelId },
        'Probed model has no row in `models` — verdicts not persisted'
      );
      return recordMulti(input, 'model-not-found');
    }

    await writeAssertions(
      [
        {
          modelUid,
          signals: mappable.map((s) => ({
            capability: s.capability as never,
            source: 'runtime-probe',
            confidence: s.confidence,
            detail: {
              source_field: `${input.origin}:request-accepted`,
              providerId: input.providerId,
              modelId: input.modelId,
              verdict: 'supported',
              ...(s.detail ?? {}),
            },
          })),
        },
      ],
      { origin: input.origin, assertedValue: true },
      runner
    );

    return recordMulti(input, 'written');
  } catch (error) {
    log.warn(
      {
        providerId: input.providerId,
        modelId: input.modelId,
        capabilities: input.signals.map((s) => s.capability),
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist multi-capability runtime probe assertions — probe result still served from cache'
    );
    return recordMulti(input, 'failed');
  }
}

function recordMulti(
  input: MultiProbeAssertionInput,
  outcome: ProbeAssertionOutcome
): ProbeAssertionOutcome {
  for (const s of input.signals) {
    incrementCounter(
      METRIC_NAMES.CAPABILITY_PROBE_ASSERTION_TOTAL,
      { capability: s.capability, outcome },
      { log: false }
    );
  }
  return outcome;
}
