// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// The real "structure of arrays" encode/decode logic — this is the part the
// task explicitly says not to hand-wave. Turns an array of plain Model
// objects (same shape as fixture.mjs / the real catalog cache) into the
// SharedArrayBuffer-backed layout defined in schema.mjs, precomputing the
// curated-bucket per-provider fairness ranking (the expensive part of
// selectCuratedFairUids) ONCE here instead of once per request.
import { CURATED_CAP, AGGREGATED_CAP, MAX_PROVIDERS, ID_BLOB_BYTES, PROVIDER_BLOB_BYTES, MAX_MODELS } from './capacity.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function decodeStr(blob, offset, len) {
  // subarray is a zero-copy view over the shared bytes; TextDecoder.decode
  // then materializes exactly one JS string. The only per-row string
  // allocation in the whole read path — and it only ever runs for the small
  // winning candidate set, never for the full catalog.
  return dec.decode(blob.subarray(offset, offset + len));
}

/**
 * Writes one full generation into `views` (a schema.mjs wrapView() result
 * over ONE of the two double-buffer slots). Returns the small, low-
 * cardinality metadata (capability names, provider table, distinct
 * capability-bitmask combinations) the main thread needs — cheap enough
 * (tens to hundreds of entries) to message-pass wholesale on every rebuild,
 * unlike the per-model bulk data, which never leaves shared memory.
 */
export function encodeGeneration(models, views) {
  const n = models.length;
  if (n > MAX_MODELS) throw new Error(`row count ${n} exceeds MAX_MODELS capacity ${MAX_MODELS}`);

  // 1. Discover distinct legacy capability strings -> bit position.
  //    Sorted for determinism (stable bit assignment run-to-run, not that it
  //    matters for correctness since the map ships alongside the data every
  //    generation, but it keeps encode output diffable/debuggable).
  const capSet = new Set();
  for (const m of models) for (const c of m.capabilities ?? []) capSet.add(c);
  const capNames = [...capSet].sort();
  if (capNames.length > 32) throw new Error('capability bitmask overflow: >32 distinct capabilities');
  const capBit = new Map(capNames.map((c, i) => [c, i]));

  // 2. Discover distinct providers (by providerId; 1:1 with providerName in
  //    this dataset) -> provider-table row index, and write their id/name
  //    strings into the small provider string blob.
  const providerByIdMap = new Map(); // providerId -> { name, idx }
  let providerBlobPos = 0;
  for (const m of models) {
    if (providerByIdMap.has(m.providerId)) continue;
    const idx = providerByIdMap.size;
    if (idx >= MAX_PROVIDERS) throw new Error(`provider count exceeds MAX_PROVIDERS capacity ${MAX_PROVIDERS}`);
    providerByIdMap.set(m.providerId, { name: m.provider, idx });

    const idBytes = enc.encode(m.providerId);
    const nameBytes = enc.encode(m.provider);
    if (providerBlobPos + idBytes.length + nameBytes.length > PROVIDER_BLOB_BYTES) {
      throw new Error('provider string blob overflow');
    }
    views.providerIdStrOffset[idx] = providerBlobPos;
    views.providerIdStrLen[idx] = idBytes.length;
    views.providerStringBlob.set(idBytes, providerBlobPos);
    providerBlobPos += idBytes.length;

    views.providerNameStrOffset[idx] = providerBlobPos;
    views.providerNameStrLen[idx] = nameBytes.length;
    views.providerStringBlob.set(nameBytes, providerBlobPos);
    providerBlobPos += nameBytes.length;
  }

  // 3. Per-model SoA fields + model-id string blob, in one pass. Also
  //    collects the (unsorted) curated/aggregated candidate slot lists and
  //    the set of distinct capability-bitmask combinations actually present
  //    (needed later for the fail-open capability-filter semantics — see
  //    reader.mjs).
  let idBlobPos = 0;
  const curatedByProvider = new Map(); // providerId -> [{slot, idStr}]
  const aggregatedSlots = []; // [{slot, idStr}]
  const distinctMasks = new Set();

  for (let i = 0; i < n; i++) {
    const m = models[i];
    const idBytes = enc.encode(m.id);
    if (idBlobPos + idBytes.length > ID_BLOB_BYTES) throw new Error('id string blob overflow');
    views.idStrOffset[i] = idBlobPos;
    views.idStrLen[i] = idBytes.length;
    views.idStringBlob.set(idBytes, idBlobPos);
    idBlobPos += idBytes.length;

    const providerInfo = providerByIdMap.get(m.providerId);
    views.providerIdx[i] = providerInfo.idx;
    views.contextWindow[i] = m.contextWindow | 0;
    views.maxOutputTokens[i] = m.maxOutputTokens | 0;
    views.usageCount[i] = 0; // same limitation as the real flag-gated path today (CATALOG_HOT_PATH_SELECT excludes usage_count)

    let mask = 0;
    for (const c of m.capabilities ?? []) {
      const bit = capBit.get(c);
      if (bit !== undefined) mask |= 1 << bit;
    }
    mask = mask >>> 0;
    views.capabilityBitmask[i] = mask;
    distinctMasks.add(mask);

    const perf = m.performance ?? {};
    views.inputCostPer1k[i] = m.inputCostPer1k ?? 0;
    views.outputCostPer1k[i] = m.outputCostPer1k ?? 0;
    views.latencyMs[i] = perf.latencyMs ?? 0;
    views.throughput[i] = perf.throughput ?? 0;
    views.quality[i] = perf.quality ?? 0;
    views.reliability[i] = perf.reliability ?? 0;
    views.statusFlag[i] = m.status === 'disabled' ? 1 : 0;

    const metadata = m.metadata ?? {};
    const hubInventoryClass = typeof metadata.hubInventoryClass === 'string' ? metadata.hubInventoryClass : undefined;
    const serverlessCallable = metadata.serverless_callable === true;

    if (hubInventoryClass !== 'aggregated_index') {
      views.bucketFlag[i] = 0; // curated
      let list = curatedByProvider.get(m.providerId);
      if (!list) {
        list = [];
        curatedByProvider.set(m.providerId, list);
      }
      list.push({ slot: i, idStr: m.id });
    } else if (serverlessCallable) {
      views.bucketFlag[i] = 1; // aggregated
      aggregatedSlots.push({ slot: i, idStr: m.id });
    } else {
      views.bucketFlag[i] = 2; // invisible/orphan — structurally excluded from both buckets, same as the SQL path
    }
  }

  // 4. Precompute curated fairness ranking: each provider's rows sorted by
  //    usageCount desc / id asc (matches sortByUsageThenUid's tie-break
  //    exactly — usageCount is uniformly 0 today, same real limitation the
  //    flag-gated path already documents), providers laid out in the flat
  //    curatedOrder array in ascending-providerId order (matches
  //    selectCuratedFairUids' own provider ordering).
  for (const list of curatedByProvider.values()) {
    list.sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
  }
  const providerIdsSorted = [...curatedByProvider.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (providerIdsSorted.length > MAX_PROVIDERS) throw new Error('curated provider count exceeds MAX_PROVIDERS');

  let curatedPos = 0;
  for (let p = 0; p < providerIdsSorted.length; p++) {
    const providerId = providerIdsSorted[p];
    const list = curatedByProvider.get(providerId);
    const providerInfo = providerByIdMap.get(providerId);
    views.curatedProviderIdx[p] = providerInfo.idx;
    views.curatedProviderStart[p] = curatedPos;
    views.curatedProviderLen[p] = list.length;
    if (curatedPos + list.length > CURATED_CAP) throw new Error('curatedOrder capacity exceeded');
    for (const row of list) views.curatedOrder[curatedPos++] = row.slot;
  }

  // 5. Precompute aggregated ranking: id ascending (matches
  //    aggregatedCandidates.sort in getFullCacheFairCandidateModels).
  aggregatedSlots.sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
  if (aggregatedSlots.length > AGGREGATED_CAP) throw new Error('aggregatedOrder capacity exceeded');
  for (let i = 0; i < aggregatedSlots.length; i++) views.aggregatedOrder[i] = aggregatedSlots[i].slot;

  const curatedTotal = [...curatedByProvider.values()].reduce((sum, l) => sum + l.length, 0);

  return {
    rowCount: n,
    curatedTotal,
    aggregatedTotal: aggregatedSlots.length,
    curatedProviderCount: providerIdsSorted.length,
    providerCount: providerByIdMap.size,
    capNames,
    distinctMasks: [...distinctMasks],
    providers: [...providerByIdMap.entries()].map(([id, info]) => ({ id, name: info.name, idx: info.idx })),
  };
}
