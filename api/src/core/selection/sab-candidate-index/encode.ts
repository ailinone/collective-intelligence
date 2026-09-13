// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The "structure of arrays" encode/decode logic — ported from
 * `investigation/sab-worker-feasibility/encode.mjs` (PR #531) and typed
 * against the real `Model` shape (`@/types`). Turns an array of catalog
 * `Model`s into the SharedArrayBuffer-backed layout defined in `schema.ts`,
 * precomputing the curated-bucket per-provider fairness ranking (the
 * expensive part of `selectCuratedFairUids`) ONCE here, per rebuild, instead
 * of once per request — mirrors `getFullCacheFairCandidateModels`'s own
 * curated/aggregated bucket predicates exactly (see that function's module
 * doc in `dynamic-model-selector.ts`) so this is a faithful re-encoding, not
 * a re-derivation of the business rule.
 *
 * Runs ENTIRELY on the worker thread (see `worker.ts`) — never on the main
 * thread, and never fed by a `postMessage`-transferred row array (see
 * `worker.ts`'s module doc for why that specific mistake was the single
 * biggest risk this design's own feasibility investigation surfaced).
 */
import type { Model } from '@/types';
import {
  CURATED_CAP,
  AGGREGATED_CAP,
  MAX_PROVIDERS,
  MAX_CAPABILITIES,
  ID_BLOB_BYTES,
  METADATA_BLOB_BYTES,
  PROVIDER_BLOB_BYTES,
  MAX_MODELS,
} from './capacity';
import { clearRow, maskKey, rowWords, setBit } from './capability-mask';
import type { GenerationViews } from './schema';
import type { GenerationMeta, ProviderTableEntry } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function decodeStr(blob: Uint8Array, offset: number, len: number): string {
  // subarray is a zero-copy view over the shared bytes; TextDecoder.decode
  // then materializes exactly one JS string. The only per-row string
  // allocation in the whole read path — and it only ever runs for the small
  // winning candidate set, never for the full catalog.
  return dec.decode(blob.subarray(offset, offset + len));
}

/** Thrown when ANY fixed capacity bound (row count, string blob size,
 *  curated/aggregated ranking capacity, provider table size, capability
 *  mask width) is exceeded. None of these can be truncated without
 *  silently changing the answer the index gives: dropping rows or
 *  providers shrinks the pool, and dropping capabilities from the mask
 *  (what this encoder did before 2026-09-11) makes the decoded Model lose
 *  those capabilities, which the selector's fail-closed post-hydration
 *  filter then turns into an empty pool. Failing the rebuild outright and
 *  continuing to serve the last-good generation is strictly better — see
 *  `worker.ts`'s rebuild handler, which catches this and never lets it
 *  reach `parentPort` as an uncaught exception. */
export class SabEncodeCapacityError extends Error {}

interface CuratedRow {
  slot: number;
  idStr: string;
}

function metadataJson(m: Model): string {
  // `undefined` metadata is stored as `{}`, matching
  // `toSyntheticModelWithProvider`'s own `model.metadata ?? {}` read pattern.
  return JSON.stringify(m.metadata ?? {});
}

/**
 * Measures the two variable-size string blobs BEFORE any byte is written.
 * The previous encoder only discovered a metadata overflow on the first row
 * that no longer fit, after encoding ~65k rows, and its error said nothing
 * about how much space was actually needed (2026-09-11 canary). Re-running
 * `JSON.stringify` here costs CPU on the worker thread, which is the cheap
 * resource; caching the strings instead would add ~110 MB to the worker's
 * transient heap on top of the parsed catalog it already holds.
 */
function measureBlobs(models: readonly Model[]): { idBytes: number; metadataBytes: number } {
  let idBytes = 0;
  let metadataBytes = 0;
  for (const m of models) {
    idBytes += Buffer.byteLength(m.id, 'utf8');
    metadataBytes += Buffer.byteLength(metadataJson(m), 'utf8');
  }
  return { idBytes, metadataBytes };
}

export function encodeGeneration(models: readonly Model[], views: GenerationViews): GenerationMeta {
  const n = models.length;
  if (n > MAX_MODELS) {
    throw new SabEncodeCapacityError(
      `row count ${n} exceeds MAX_MODELS capacity ${MAX_MODELS} (raise SAB_CANDIDATE_MAX_MODELS)`
    );
  }

  const needed = measureBlobs(models);
  if (needed.metadataBytes > METADATA_BLOB_BYTES) {
    const avg = n > 0 ? Math.ceil(needed.metadataBytes / n) : 0;
    throw new SabEncodeCapacityError(
      `metadata string blob needs ${needed.metadataBytes} bytes for ${n} rows (avg ${avg} bytes/row) ` +
        `but capacity is ${METADATA_BLOB_BYTES}; raise SAB_CANDIDATE_METADATA_BYTES_PER_MODEL ` +
        `or SAB_CANDIDATE_METADATA_BLOB_BYTES`
    );
  }
  if (needed.idBytes > ID_BLOB_BYTES) {
    throw new SabEncodeCapacityError(
      `id string blob needs ${needed.idBytes} bytes for ${n} rows but capacity is ${ID_BLOB_BYTES} ` +
        `(raise SAB_CANDIDATE_ID_BLOB_BYTES)`
    );
  }

  // 1. Discover distinct legacy capability strings -> bit position. Sorted
  //    for determinism (stable bit assignment run-to-run — the map ships
  //    alongside the data every generation via `meta.capNames`, so stability
  //    across rebuilds isn't a correctness requirement, but it keeps encode
  //    output diffable/debuggable).
  //
  //    Real production catalog: 64 distinct strings on 2026-09-11 against a
  //    128-bit mask (`CAPABILITY_MASK_WORDS` x 32). Exceeding the width is a
  //    hard failure, never a truncation — see `SabEncodeCapacityError`'s doc.
  const capSet = new Set<string>();
  for (const m of models) for (const c of m.capabilities ?? []) capSet.add(c);
  const capNames = [...capSet].sort();
  if (capNames.length > MAX_CAPABILITIES) {
    throw new SabEncodeCapacityError(
      `distinct capability count ${capNames.length} exceeds the ${MAX_CAPABILITIES}-bit capability mask ` +
        `(would drop: ${capNames.slice(MAX_CAPABILITIES).join(', ')}); widen CAPABILITY_MASK_WORDS in capacity.ts`
    );
  }
  const capBit = new Map(capNames.map((c, i) => [c, i]));

  // 2. Discover distinct providers (by providerId; 1:1 with providerName in
  //    this dataset) -> provider-table row index, and write their id/name
  //    strings into the small provider string blob.
  const providerByIdMap = new Map<string, { name: string; idx: number }>();
  let providerBlobPos = 0;
  for (const m of models) {
    if (providerByIdMap.has(m.providerId)) continue;
    const idx = providerByIdMap.size;
    if (idx >= MAX_PROVIDERS) {
      throw new SabEncodeCapacityError(
        `provider count exceeds MAX_PROVIDERS capacity ${MAX_PROVIDERS} (raise SAB_CANDIDATE_MAX_PROVIDERS)`
      );
    }
    providerByIdMap.set(m.providerId, { name: m.provider, idx });

    const idBytes = enc.encode(m.providerId);
    const nameBytes = enc.encode(m.provider);
    if (providerBlobPos + idBytes.length + nameBytes.length > PROVIDER_BLOB_BYTES) {
      throw new SabEncodeCapacityError(
        `provider string blob overflow (raise SAB_CANDIDATE_PROVIDER_BLOB_BYTES)`
      );
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
  //    reader.ts).
  let idBlobPos = 0;
  let metadataBlobPos = 0;
  const curatedByProvider = new Map<string, CuratedRow[]>();
  const aggregatedSlots: CuratedRow[] = [];
  const distinctMasks = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const m = models[i];
    const idBytes = enc.encode(m.id);
    // Defense in depth behind the pre-pass above (a mismatch here would mean
    // measureBlobs and this loop disagree on the encoding).
    if (idBlobPos + idBytes.length > ID_BLOB_BYTES) {
      throw new SabEncodeCapacityError(`id string blob overflow (raise SAB_CANDIDATE_ID_BLOB_BYTES)`);
    }
    views.idStrOffset[i] = idBlobPos;
    views.idStrLen[i] = idBytes.length;
    views.idStringBlob.set(idBytes, idBlobPos);
    idBlobPos += idBytes.length;

    const metadataBytes = enc.encode(metadataJson(m));
    if (metadataBlobPos + metadataBytes.length > METADATA_BLOB_BYTES) {
      throw new SabEncodeCapacityError(
        `metadata string blob overflow (raise SAB_CANDIDATE_METADATA_BLOB_BYTES)`
      );
    }
    views.metadataStrOffset[i] = metadataBlobPos;
    views.metadataStrLen[i] = metadataBytes.length;
    views.metadataBlob.set(metadataBytes, metadataBlobPos);
    metadataBlobPos += metadataBytes.length;

    const providerInfo = providerByIdMap.get(m.providerId);
    if (!providerInfo) {
      // Unreachable given the pass above visits the same `models` array, but
      // guarded explicitly rather than a non-null assertion (repo convention
      // — see .eslintrc.cjs's ban on unchecked non-null assertions in
      // several other modules).
      throw new SabEncodeCapacityError(`internal error: provider info missing for ${m.providerId}`);
    }
    views.providerIdx[i] = providerInfo.idx;
    views.contextWindow[i] = m.contextWindow | 0;
    views.maxOutputTokens[i] = m.maxOutputTokens | 0;
    // Same limitation as the existing SELECTION_USE_FULL_CACHE_INDEX path
    // (CATALOG_HOT_PATH_SELECT excludes usage_count) — see this module's own
    // limitation doc in the manager/reader.
    views.usageCount[i] = 0;

    // The inactive generation still holds the previous build's bits for
    // this slot; clear before OR-ing.
    clearRow(views.capabilityBitmask, i);
    for (const c of m.capabilities ?? []) {
      const bit = capBit.get(c);
      if (bit !== undefined) setBit(views.capabilityBitmask, i, bit);
    }
    const words = rowWords(views.capabilityBitmask, i);
    const key = maskKey(words);
    if (!distinctMasks.has(key)) distinctMasks.set(key, words);

    const perf = m.performance ?? { latencyMs: 0, throughput: 0, quality: 0, reliability: 0 };
    views.inputCostPer1k[i] = m.inputCostPer1k ?? 0;
    views.outputCostPer1k[i] = m.outputCostPer1k ?? 0;
    views.latencyMs[i] = perf.latencyMs ?? 0;
    views.throughput[i] = perf.throughput ?? 0;
    views.quality[i] = perf.quality ?? 0;
    views.reliability[i] = perf.reliability ?? 0;
    views.statusFlag[i] = m.status === 'disabled' ? 1 : 0;

    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const hubInventoryClass =
      typeof metadata.hubInventoryClass === 'string' ? metadata.hubInventoryClass : undefined;
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
      views.bucketFlag[i] = 2; // invisible/orphan — structurally excluded from both buckets, same as the SQL/Map paths
    }
  }

  // 4. Precompute curated fairness ranking: each provider's rows sorted by
  //    usageCount desc / id asc (matches sortByUsageThenUid's tie-break
  //    exactly — usageCount is uniformly 0 today, same real limitation the
  //    existing flag-gated path already documents), providers laid out in
  //    the flat curatedOrder array in ascending-providerId order (matches
  //    selectCuratedFairUids' own provider ordering).
  for (const list of curatedByProvider.values()) {
    list.sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
  }
  const providerIdsSorted = [...curatedByProvider.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (providerIdsSorted.length > MAX_PROVIDERS) {
    throw new SabEncodeCapacityError('curated provider count exceeds MAX_PROVIDERS');
  }

  let curatedPos = 0;
  for (let p = 0; p < providerIdsSorted.length; p++) {
    const providerId = providerIdsSorted[p];
    const list = curatedByProvider.get(providerId);
    if (!list) continue;
    const providerInfo = providerByIdMap.get(providerId);
    if (!providerInfo) continue;
    views.curatedProviderIdx[p] = providerInfo.idx;
    views.curatedProviderStart[p] = curatedPos;
    views.curatedProviderLen[p] = list.length;
    if (curatedPos + list.length > CURATED_CAP) {
      throw new SabEncodeCapacityError(
        `curatedOrder capacity ${CURATED_CAP} exceeded (raise SAB_CANDIDATE_CURATED_CAP)`
      );
    }
    for (const row of list) views.curatedOrder[curatedPos++] = row.slot;
  }

  // 5. Precompute aggregated ranking: id ascending (matches
  //    aggregatedCandidates.sort in getFullCacheFairCandidateModels).
  aggregatedSlots.sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
  if (aggregatedSlots.length > AGGREGATED_CAP) {
    throw new SabEncodeCapacityError(
      `aggregatedOrder capacity ${AGGREGATED_CAP} exceeded (raise SAB_CANDIDATE_AGGREGATED_CAP)`
    );
  }
  for (let i = 0; i < aggregatedSlots.length; i++) views.aggregatedOrder[i] = aggregatedSlots[i].slot;

  const curatedTotal = [...curatedByProvider.values()].reduce((sum, l) => sum + l.length, 0);

  const providers: ProviderTableEntry[] = [...providerByIdMap.entries()].map(([id, info]) => ({
    id,
    name: info.name,
    idx: info.idx,
  }));

  const flatMasks: number[] = [];
  for (const words of distinctMasks.values()) flatMasks.push(...words);

  return {
    rowCount: n,
    curatedTotal,
    aggregatedTotal: aggregatedSlots.length,
    curatedProviderCount: providerIdsSorted.length,
    providerCount: providerByIdMap.size,
    capNames,
    distinctMasks: flatMasks,
    providers,
    distinctCapabilities: capNames.length,
    metadataBlobUsedBytes: metadataBlobPos,
    idBlobUsedBytes: idBlobPos,
  };
}
