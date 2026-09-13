// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Main-thread, per-request read path against the SharedArrayBuffer-backed
 * index. Ported from `investigation/sab-worker-feasibility/reader.mjs`
 * (PR #531) and typed against the real `SelectionCriteria`/
 * `FullCacheFairCandidateResult` shapes so it is a drop-in alternative to
 * `getFullCacheFairCandidateModels` (`dynamic-model-selector.ts`) at the call
 * site — see `manager.ts`.
 *
 * Runs synchronously, zero I/O, zero message-passing to the worker — mirrors
 * `getFullCacheFairCandidateModels`/`selectCuratedFairUids`'s semantics
 * exactly (same rank-tier round-robin, same hard per-provider cap, same
 * fail-open rules) but reads pre-sorted/pre-grouped typed arrays instead of
 * re-deriving that grouping+sort from a fresh O(catalog) scan on every call.
 * Correctness against the real function is asserted byte-for-byte in
 * `__tests__/encode-reader-correctness.test.ts`.
 */
import type { Model } from '@/types';
import type {
  FullCacheFairCandidateResult,
  SelectionCriteria,
} from '@/core/selection/dynamic-model-selector';
import { logger } from '@/utils/logger';
import { decodeStr } from './encode';
import { anyMaskHasAll, hasBit, isZero, requiredFromBits, rowHasAll } from './capability-mask';
import type { GenerationViews } from './schema';
import type { GenerationMeta } from './types';

const log = logger.child({ component: 'sab-candidate-index-reader' });

export type SabCandidateCriteria = Pick<
  SelectionCriteria,
  'contextSize' | 'preferredProviders' | 'excludeProviders' | 'requiredCapabilities'
>;

/** Per-generation lookup structures derived ONCE per rebuild from the small
 *  `GenerationMeta` a `rebuilt` worker message carries — never rebuilt per
 *  request. */
export interface GenLookup extends GenerationMeta {
  providerNameToIdx: Map<string, number>;
  providerNames: string[];
  providerIds: string[];
  capBit: Map<string, number>;
}

export function buildGenLookup(meta: GenerationMeta): GenLookup {
  const providerNameToIdx = new Map(meta.providers.map((p) => [p.name, p.idx]));
  const providerNames: string[] = new Array<string>(meta.providerCount);
  const providerIds: string[] = new Array<string>(meta.providerCount);
  for (const p of meta.providers) {
    providerNames[p.idx] = p.name;
    providerIds[p.idx] = p.id;
  }
  const capBit = new Map(meta.capNames.map((c, i) => [c, i]));
  return {
    ...meta,
    providerNameToIdx,
    providerNames,
    providerIds,
    capBit,
  };
}

const EMPTY_RESULT: FullCacheFairCandidateResult = {
  models: [],
  uids: [],
  curatedCount: 0,
  aggregatedCount: 0,
  curatedDistinctProviders: 0,
  curatedTopProviderShare: 0,
};

export function getCandidatesFromSharedIndex(
  views: GenerationViews,
  gen: GenLookup,
  criteria: SabCandidateCriteria,
  curatedTake: number,
  aggregatedTake: number,
  curatedMaxProviderShare: number
): FullCacheFairCandidateResult {
  const { curatedProviderCount, aggregatedTotal } = gen;
  if (curatedProviderCount === 0 && aggregatedTotal === 0) return EMPTY_RESULT;

  // Required-capability bitmask, with the SAME fail-open rule as
  // getFullCacheFairCandidateModels: if no model in the whole catalog
  // satisfies the AND of required capabilities, drop the filter rather than
  // assert emptiness here. A capability string absent from `capNames` is
  // absent from the whole catalog (the encoder never drops one — it fails
  // the rebuild instead), which is exactly the Map path's "intersection
  // with an empty set" case. The real fail-closed decision belongs solely
  // to findModelsByRequirements' own post-hydration filter downstream,
  // unconditional and unchanged by this path.
  const hardCaps = (criteria.requiredCapabilities ?? []).filter((c) => c !== 'function_calling');
  const requiredBits: number[] = [];
  let unknownCap = false;
  for (const c of hardCaps) {
    const bit = gen.capBit.get(c);
    if (bit === undefined) {
      unknownCap = true;
      break;
    }
    requiredBits.push(bit);
  }
  let requiredMask = requiredFromBits(unknownCap ? [] : requiredBits);
  if (!isZero(requiredMask) && !anyMaskHasAll(gen.distinctMasks, requiredMask)) {
    requiredMask = requiredFromBits([]); // fail open
  }
  const hasCapFilter = !isZero(requiredMask);

  const includeIdx = criteria.preferredProviders?.length
    ? new Set(
        criteria.preferredProviders
          .map((name) => gen.providerNameToIdx.get(name))
          .filter((x): x is number => x !== undefined)
      )
    : null;
  const excludeIdx = criteria.excludeProviders?.length
    ? new Set(
        criteria.excludeProviders
          .map((name) => gen.providerNameToIdx.get(name))
          .filter((x): x is number => x !== undefined)
      )
    : null;
  const minContext = criteria.contextSize ?? 0;

  function rowPasses(slot: number): boolean {
    if (views.statusFlag[slot] === 1) return false;
    if (hasCapFilter && !rowHasAll(views.capabilityBitmask, slot, requiredMask)) return false;
    if (minContext > 0 && views.contextWindow[slot] < minContext) return false;
    const pIdx = views.providerIdx[slot];
    if (includeIdx && !includeIdx.has(pIdx)) return false;
    if (excludeIdx && excludeIdx.has(pIdx)) return false;
    return true;
  }

  // ── Curated bucket: rank-tier round robin over pre-sorted provider runs ──
  const perProviderCap = Math.max(1, Math.ceil(curatedTake * curatedMaxProviderShare));
  const eligibleProviderSlots: number[] = [];
  for (let p = 0; p < curatedProviderCount; p++) {
    const pIdx = views.curatedProviderIdx[p];
    if (includeIdx && !includeIdx.has(pIdx)) continue;
    if (excludeIdx && excludeIdx.has(pIdx)) continue;
    eligibleProviderSlots.push(p);
  }

  // Per-provider cursor into curatedOrder — monotonically advances, so each
  // rank's "next passing row" for a provider is found by skipping forward
  // over filtered-out rows, never rescanning from the start. This reproduces
  // "index the rank-th element of the row-level-filtered, already-sorted
  // list" (what selectCuratedFairUids does eagerly) lazily, with identical
  // output and an early-exit once curatedTake is reached.
  const cursor = new Int32Array(curatedProviderCount);
  for (const p of eligibleProviderSlots) cursor[p] = views.curatedProviderStart[p];

  const curatedSlots: number[] = [];
  const takenPerProvider = new Map<number, number>();
  for (let rank = 0; rank < perProviderCap && curatedSlots.length < curatedTake; rank++) {
    let addedThisRound = false;
    for (const p of eligibleProviderSlots) {
      if (curatedSlots.length >= curatedTake) break;
      const rangeEnd = views.curatedProviderStart[p] + views.curatedProviderLen[p];
      let found = -1;
      while (cursor[p] < rangeEnd) {
        const slot = views.curatedOrder[cursor[p]];
        cursor[p]++;
        if (rowPasses(slot)) {
          found = slot;
          break;
        }
      }
      if (found === -1) continue; // provider exhausted
      curatedSlots.push(found);
      takenPerProvider.set(p, (takenPerProvider.get(p) ?? 0) + 1);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }

  // ── Aggregated bucket: linear scan of the id-sorted precomputed order ────
  const aggregatedSlots: number[] = [];
  for (let i = 0; i < aggregatedTotal && aggregatedSlots.length < aggregatedTake; i++) {
    const slot = views.aggregatedOrder[i];
    if (rowPasses(slot)) aggregatedSlots.push(slot);
  }

  // ── Decode winners only (the one place a JS string/object is ever
  //    materialized on this path — bounded by curatedTake+aggregatedTake,
  //    ~700 by default, never by catalog size) ──────────────────────────
  function decodeModel(slot: number): Model {
    const id = decodeStr(views.idStringBlob, views.idStrOffset[slot], views.idStrLen[slot]);
    const pIdx = views.providerIdx[slot];
    const caps: string[] = [];
    for (let b = 0; b < gen.capNames.length; b++) {
      if (hasBit(views.capabilityBitmask, slot, b)) caps.push(gen.capNames[b]);
    }
    const providerId = gen.providerIds[pIdx];
    const providerName = gen.providerNames[pIdx];
    const metadataJson = decodeStr(
      views.metadataBlob,
      views.metadataStrOffset[slot],
      views.metadataStrLen[slot]
    );
    let metadata: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(metadataJson);
      metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch (err) {
      // Should be unreachable — encode.ts only ever writes valid
      // JSON.stringify output into this blob — but a corrupted read must
      // never crash the request hot path (fail open, same posture as every
      // other guard on this read path).
      log.error({ id, error: err instanceof Error ? err.message : String(err) }, 'sab-candidate-index: failed to parse decoded metadata JSON — serving model with empty metadata');
      metadata = undefined;
    }
    return {
      id,
      providerId,
      provider: providerName,
      name: id,
      displayName: id,
      contextWindow: views.contextWindow[slot],
      maxOutputTokens: views.maxOutputTokens[slot],
      inputCostPer1k: views.inputCostPer1k[slot],
      outputCostPer1k: views.outputCostPer1k[slot],
      // Cast is safe: every string here originated from a real Model's
      // `capabilities` array at encode time (encode.ts only ever writes bits
      // for strings observed on `m.capabilities`), so decoding them back
      // yields the same ModelCapability-typed strings, just round-tripped
      // through a bitmask rather than copied by reference.
      capabilities: caps as Model['capabilities'],
      capabilityUris: [],
      capabilityConfidence: undefined,
      performance: {
        latencyMs: views.latencyMs[slot],
        throughput: views.throughput[slot],
        quality: views.quality[slot],
        reliability: views.reliability[slot],
      },
      status: views.statusFlag[slot] === 1 ? 'disabled' : 'active',
      metadata,
    };
  }

  const curatedModels = curatedSlots.map(decodeModel);
  const aggregatedModels = aggregatedSlots.map(decodeModel);
  const topProviderCount = takenPerProvider.size > 0 ? Math.max(...takenPerProvider.values()) : 0;

  const models = [...curatedModels, ...aggregatedModels];
  return {
    models,
    uids: models.map((m) => m.id),
    curatedCount: curatedModels.length,
    aggregatedCount: aggregatedModels.length,
    curatedDistinctProviders: takenPerProvider.size,
    curatedTopProviderShare: curatedSlots.length > 0 ? topProviderCount / curatedSlots.length : 0,
  };
}
