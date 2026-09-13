// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Main-thread, per-request read path against the SharedArrayBuffer-backed
// index. Runs synchronously, zero I/O, zero message-passing to the worker —
// mirrors getFullCacheFairCandidateModels/selectCuratedFairUids' semantics
// exactly (same rank-tier round-robin, same hard per-provider cap, same
// fail-open rules) but reads pre-sorted/pre-grouped typed arrays instead of
// re-deriving that grouping+sort from a fresh O(catalog) scan on every call.
import { decodeStr } from './encode.mjs';

/**
 * Builds the small per-generation lookup structures (provider name -> table
 * index, capability name -> bit) ONCE per rebuild from the metadata a
 * 'rebuilt' worker message carries — never per request.
 */
export function buildGenLookup(meta) {
  const providerNameToIdx = new Map(meta.providers.map((p) => [p.name, p.idx]));
  const providerNames = new Array(meta.providerCount);
  const providerIds = new Array(meta.providerCount);
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

export function getCandidatesFromSharedIndex(views, gen, criteria, curatedTake, aggregatedTake, curatedMaxProviderShare) {
  const { curatedProviderCount, curatedTotal, aggregatedTotal } = gen;
  const empty = {
    models: [],
    curatedCount: 0,
    aggregatedCount: 0,
    curatedDistinctProviders: 0,
    curatedTopProviderShare: 0,
  };
  if (curatedProviderCount === 0 && aggregatedTotal === 0) return empty;

  // Required-capability bitmask, with the SAME fail-open rule as the Map
  // path: if no model in the whole catalog satisfies the AND of required
  // capabilities, drop the filter rather than assert emptiness here (that
  // decision belongs to findModelsByRequirements' own post-hydration filter
  // downstream — this function is a candidate-retrieval optimization only).
  let requiredMask = 0;
  const hardCaps = (criteria.requiredCapabilities ?? []).filter((c) => c !== 'function_calling');
  let unknownCap = false;
  for (const c of hardCaps) {
    const bit = gen.capBit.get(c);
    if (bit === undefined) {
      unknownCap = true;
      break;
    }
    requiredMask |= 1 << bit;
  }
  if (unknownCap) {
    requiredMask = 0;
  } else if (requiredMask !== 0) {
    const anyMatches = gen.distinctMasks.some((m) => (m & requiredMask) === requiredMask);
    if (!anyMatches) requiredMask = 0; // fail open
  }

  const includeIdx = criteria.preferredProviders?.length
    ? new Set(criteria.preferredProviders.map((name) => gen.providerNameToIdx.get(name)).filter((x) => x !== undefined))
    : null;
  const excludeIdx = criteria.excludeProviders?.length
    ? new Set(criteria.excludeProviders.map((name) => gen.providerNameToIdx.get(name)).filter((x) => x !== undefined))
    : null;
  const minContext = criteria.contextSize ?? 0;

  function rowPasses(slot) {
    if (views.statusFlag[slot] === 1) return false;
    if (requiredMask !== 0 && (views.capabilityBitmask[slot] & requiredMask) !== requiredMask) return false;
    if (minContext > 0 && views.contextWindow[slot] < minContext) return false;
    const pIdx = views.providerIdx[slot];
    if (includeIdx && !includeIdx.has(pIdx)) return false;
    if (excludeIdx && excludeIdx.has(pIdx)) return false;
    return true;
  }

  // ── Curated bucket: rank-tier round robin over pre-sorted provider runs ──
  const perProviderCap = Math.max(1, Math.ceil(curatedTake * curatedMaxProviderShare));
  const eligibleProviderSlots = [];
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

  const curatedSlots = [];
  const takenPerProvider = new Map();
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
  const aggregatedSlots = [];
  for (let i = 0; i < aggregatedTotal && aggregatedSlots.length < aggregatedTake; i++) {
    const slot = views.aggregatedOrder[i];
    if (rowPasses(slot)) aggregatedSlots.push(slot);
  }

  // ── Decode winners only (the one place a JS string/object is ever
  //    materialized on this path — bounded by curatedTake+aggregatedTake,
  //    ~700 by default, never by catalog size) ──────────────────────────
  function decodeModel(slot) {
    const id = decodeStr(views.idStringBlob, views.idStrOffset[slot], views.idStrLen[slot]);
    const pIdx = views.providerIdx[slot];
    const caps = [];
    const mask = views.capabilityBitmask[slot];
    for (let b = 0; b < gen.capNames.length; b++) if (mask & (1 << b)) caps.push(gen.capNames[b]);
    return {
      id,
      provider: gen.providerNames[pIdx],
      providerId: gen.providerIds[pIdx],
      contextWindow: views.contextWindow[slot],
      maxOutputTokens: views.maxOutputTokens[slot],
      inputCostPer1k: views.inputCostPer1k[slot],
      outputCostPer1k: views.outputCostPer1k[slot],
      capabilities: caps,
      performance: {
        latencyMs: views.latencyMs[slot],
        throughput: views.throughput[slot],
        quality: views.quality[slot],
        reliability: views.reliability[slot],
      },
      status: views.statusFlag[slot] === 1 ? 'disabled' : 'active',
    };
  }

  const curatedModels = curatedSlots.map(decodeModel);
  const aggregatedModels = aggregatedSlots.map(decodeModel);
  const topProviderCount = takenPerProvider.size > 0 ? Math.max(...takenPerProvider.values()) : 0;

  return {
    models: [...curatedModels, ...aggregatedModels],
    curatedCount: curatedModels.length,
    aggregatedCount: aggregatedModels.length,
    curatedDistinctProviders: takenPerProvider.size,
    curatedTopProviderShare: curatedSlots.length > 0 ? topProviderCount / curatedSlots.length : 0,
  };
}
