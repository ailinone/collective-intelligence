// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SharedArrayBuffer byte layout for one "generation" (one of the two
// double-buffer slots). Structure-of-arrays: every field is a fixed-length
// typed array, indexed by a model's integer "slot" (0..rowCount-1) within
// this generation. Strings (model id, provider id, provider name) cannot be
// stored in a TypedArray directly, so they live as UTF-8 byte blobs with
// parallel offset/length index arrays.
import {
  MAX_MODELS,
  CURATED_CAP,
  AGGREGATED_CAP,
  MAX_PROVIDERS,
  ID_BLOB_BYTES,
  PROVIDER_BLOB_BYTES,
} from './capacity.mjs';

function align(offset, bytes) {
  return Math.ceil(offset / bytes) * bytes;
}

// Order here is arbitrary (each field is independently offset-aligned to its
// own element size, per the SharedArrayBuffer/TypedArray spec requirement
// that a view's byteOffset be a multiple of BYTES_PER_ELEMENT), grouped by
// purpose for readability.
const FIELD_SPECS = [
  // ── per-model SoA, index = model slot ────────────────────────────────
  { name: 'idStrOffset', ctor: Int32Array, length: MAX_MODELS },
  { name: 'idStrLen', ctor: Int32Array, length: MAX_MODELS },
  { name: 'providerIdx', ctor: Int32Array, length: MAX_MODELS }, // -> provider table row
  { name: 'contextWindow', ctor: Int32Array, length: MAX_MODELS },
  { name: 'maxOutputTokens', ctor: Int32Array, length: MAX_MODELS },
  { name: 'usageCount', ctor: Int32Array, length: MAX_MODELS },
  { name: 'capabilityBitmask', ctor: Uint32Array, length: MAX_MODELS },
  { name: 'inputCostPer1k', ctor: Float64Array, length: MAX_MODELS },
  { name: 'outputCostPer1k', ctor: Float64Array, length: MAX_MODELS },
  { name: 'latencyMs', ctor: Float64Array, length: MAX_MODELS },
  { name: 'throughput', ctor: Float64Array, length: MAX_MODELS },
  { name: 'quality', ctor: Float64Array, length: MAX_MODELS },
  { name: 'reliability', ctor: Float64Array, length: MAX_MODELS },
  { name: 'bucketFlag', ctor: Uint8Array, length: MAX_MODELS }, // 0 curated / 1 aggregated / 2 invisible
  { name: 'statusFlag', ctor: Uint8Array, length: MAX_MODELS }, // 0 active / 1 disabled

  // ── model-id string blob (UTF-8) ─────────────────────────────────────
  { name: 'idStringBlob', ctor: Uint8Array, length: ID_BLOB_BYTES },

  // ── provider table (small; cardinality ~95-200 in real prod) ────────
  { name: 'providerIdStrOffset', ctor: Int32Array, length: MAX_PROVIDERS },
  { name: 'providerIdStrLen', ctor: Int32Array, length: MAX_PROVIDERS },
  { name: 'providerNameStrOffset', ctor: Int32Array, length: MAX_PROVIDERS },
  { name: 'providerNameStrLen', ctor: Int32Array, length: MAX_PROVIDERS },
  { name: 'providerStringBlob', ctor: Uint8Array, length: PROVIDER_BLOB_BYTES },

  // ── curated-bucket precomputed fairness ranking ──────────────────────
  // Flat array of model slots, grouped by provider (providers ordered
  // ascending by providerId, matching selectCuratedFairUids' own
  // `.sort(([a],[b]) => a<b?-1:...)`), each provider's run sorted by
  // usageCount desc / id asc (matches sortByUsageThenUid).
  { name: 'curatedOrder', ctor: Int32Array, length: CURATED_CAP },
  { name: 'curatedProviderIdx', ctor: Int32Array, length: MAX_PROVIDERS }, // -> provider table row
  { name: 'curatedProviderStart', ctor: Int32Array, length: MAX_PROVIDERS }, // offset into curatedOrder
  { name: 'curatedProviderLen', ctor: Int32Array, length: MAX_PROVIDERS },

  // ── aggregated-bucket precomputed ranking (id ascending) ─────────────
  { name: 'aggregatedOrder', ctor: Int32Array, length: AGGREGATED_CAP },
];

export function computeLayout() {
  let offset = 0;
  const layout = {};
  for (const spec of FIELD_SPECS) {
    const bytesPerEl = spec.ctor.BYTES_PER_ELEMENT;
    offset = align(offset, bytesPerEl);
    layout[spec.name] = {
      ctor: spec.ctor,
      byteOffset: offset,
      length: spec.length,
      byteLength: spec.length * bytesPerEl,
    };
    offset += spec.length * bytesPerEl;
  }
  return { layout, totalBytes: align(offset, 8) };
}

export function wrapViews(arrayBuffer, layout) {
  const views = {};
  for (const [name, spec] of Object.entries(layout)) {
    views[name] = new spec.ctor(arrayBuffer, spec.byteOffset, spec.length);
  }
  return views;
}

// Small fixed control block shared between the worker and the main thread.
// One Int32Array slot per field, accessed via Atomics so the "which
// generation is active" publish is a real cross-thread-visible operation
// (see worker.mjs / reader.mjs for the release/acquire discipline this
// relies on).
export const CONTROL = {
  ACTIVE_GEN: 0, // 0 or 1 (or -1 before the first build completes)
  VERSION: 1, // monotonically incrementing, bumped once per completed flip
  ROW_COUNT_0: 2,
  ROW_COUNT_1: 3,
  BUILDING_GEN: 4, // diagnostic only: which slot the worker is currently writing (-1 idle)
};
export const CONTROL_SLOTS = 16;
export const CONTROL_BYTES = CONTROL_SLOTS * 4;
