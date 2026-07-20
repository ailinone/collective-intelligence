// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Modality Cost Integrity (COST #6, 2026-06-11)
 *
 * The non-chat modality orchestrators (audio / video / image / search /
 * moderation) historically bypassed cost accounting ENTIRELY — they execute,
 * spend money on provider fallbacks, and report nothing to the unified cost
 * metrics. This helper closes that gap by feeding every successful modality
 * execution through the SAME `normalizeCost` pipeline + the SAME
 * `ailin_dev_llm_cost_usd_total` Prometheus counter the chat path uses.
 *
 * IMPORTANT honesty note: image/audio/video are priced PER-UNIT (per image, per
 * second), not per-token, and their adapter responses are untyped w.r.t. cost.
 * We therefore read the adapter-reported `cost`/`usage` DEFENSIVELY and delegate
 * to `normalizeCost`, which returns `costSource: 'missing'` (cost = null) when
 * neither an adapter-reported cost nor token counts are available — the common
 * case until per-unit pricing is populated. The point is to make the gap
 * VISIBLE and falsifiable (auditors see "missing"), NOT to fabricate a cost.
 * This is the seed of the cost method the future ModalityExecutor base class
 * (DUP #2 consolidation) will absorb.
 */

import type { Model } from '@/types';
import { normalizeCost, type CostRecord } from '@/services/cost-normalization-service';
import { llmCostUSD } from '@/utils/metrics';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'modality-cost' });

/** Defensive shape for the untyped modality adapter responses. */
interface CostBearingResponse {
  cost?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  } | null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Compute the normalized cost of one successful modality execution and record
 * it into the unified `llmCostUSD` counter. Returns the full `CostRecord` so the
 * caller can also surface `cost`/`costSource`/`costConfidence` on its result
 * envelope. Never throws — metric emission is best-effort.
 *
 * @param response  raw adapter response (may carry `cost` and/or `usage`)
 * @param model     the model that produced the response (for id + DB pricing)
 * @param provider  lowercase provider name (e.g. `adapter.getName().toLowerCase()`)
 */
export function computeModalityCost(params: {
  response: unknown;
  model: Model;
  provider: string;
}): CostRecord {
  const r = (params.response ?? {}) as CostBearingResponse;
  const rawCost = asFiniteNumber(r.cost) ?? null;
  const inputTokens = asFiniteNumber(r.usage?.prompt_tokens);
  const outputTokens = asFiniteNumber(r.usage?.completion_tokens);

  const record = normalizeCost(
    rawCost,
    params.provider,
    params.model.id,
    inputTokens,
    outputTokens,
    params.model.inputCostPer1k,
    params.model.outputCostPer1k,
  );

  // Feed the same counter as the chat path — only when a real cost exists, so a
  // 'missing'/'genuinely_free' record never inflates the spend metric.
  if (typeof record.normalizedCostUsd === 'number' && record.normalizedCostUsd > 0) {
    try {
      llmCostUSD.inc({ provider: params.provider, model: params.model.id }, record.normalizedCostUsd);
    } catch (err) {
      log.debug({ err: String(err) }, 'modality cost metric emit failed (non-fatal)');
    }
  }

  return record;
}

/** The cost fields a modality result envelope should expose, derived from a CostRecord. */
export interface ModalityCostFields {
  cost: number | null;
  rawCost: number | null;
  costSource: CostRecord['costSource'];
  costConfidence: CostRecord['costConfidence'];
}

/** Project a CostRecord onto the public envelope fields. */
export function toModalityCostFields(record: CostRecord): ModalityCostFields {
  return {
    cost: record.normalizedCostUsd,
    rawCost: record.rawCostUsd,
    costSource: record.costSource,
    costConfidence: record.costConfidence,
  };
}
