// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SharedArrayBuffer byte layout for one "generation" (one of the two
 * double-buffer slots). Ported from
 * `investigation/sab-worker-feasibility/schema.mjs` (PR #531).
 *
 * Structure-of-arrays: every field is a fixed-length typed array, indexed by
 * a model's integer "slot" (0..rowCount-1) within this generation. Strings
 * (model id, provider id, provider name) cannot be stored in a TypedArray
 * directly, so they live as UTF-8 byte blobs with parallel offset/length
 * index arrays.
 */
import {
  MAX_MODELS,
  CURATED_CAP,
  AGGREGATED_CAP,
  MAX_PROVIDERS,
  ID_BLOB_BYTES,
  METADATA_BLOB_BYTES,
  PROVIDER_BLOB_BYTES,
  CAPABILITY_MASK_WORDS,
} from './capacity';
import { narrowAs } from '@/utils/type-guards';

type TypedArrayCtor =
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Uint8ArrayConstructor
  | Float64ArrayConstructor;

type TypedArrayFor<C extends TypedArrayCtor> = C extends Int32ArrayConstructor
  ? Int32Array
  : C extends Uint32ArrayConstructor
    ? Uint32Array
    : C extends Uint8ArrayConstructor
      ? Uint8Array
      : Float64Array;

interface FieldSpec<C extends TypedArrayCtor = TypedArrayCtor> {
  name: string;
  ctor: C;
  length: number;
}

function align(offset: number, bytes: number): number {
  return Math.ceil(offset / bytes) * bytes;
}

// Order here is arbitrary (each field is independently offset-aligned to its
// own element size, per the SharedArrayBuffer/TypedArray spec requirement
// that a view's byteOffset be a multiple of BYTES_PER_ELEMENT), grouped by
// purpose for readability.
const FIELD_SPECS: readonly FieldSpec[] = [
  // ── per-model SoA, index = model slot ────────────────────────────────
  { name: 'idStrOffset', ctor: Int32Array, length: MAX_MODELS },
  { name: 'idStrLen', ctor: Int32Array, length: MAX_MODELS },
  // Full metadata JSON (see capacity.ts's METADATA_BLOB_BYTES doc for why
  // this exists — production correctness, not part of the original
  // prototype).
  { name: 'metadataStrOffset', ctor: Int32Array, length: MAX_MODELS },
  { name: 'metadataStrLen', ctor: Int32Array, length: MAX_MODELS },
  { name: 'providerIdx', ctor: Int32Array, length: MAX_MODELS }, // -> provider table row
  { name: 'contextWindow', ctor: Int32Array, length: MAX_MODELS },
  { name: 'maxOutputTokens', ctor: Int32Array, length: MAX_MODELS },
  { name: 'usageCount', ctor: Int32Array, length: MAX_MODELS },
  // Row-major, CAPABILITY_MASK_WORDS words per slot — see capability-mask.ts.
  { name: 'capabilityBitmask', ctor: Uint32Array, length: MAX_MODELS * CAPABILITY_MASK_WORDS },
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
  // ── per-model metadata JSON blob (UTF-8) ─────────────────────────────
  { name: 'metadataBlob', ctor: Uint8Array, length: METADATA_BLOB_BYTES },

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
  // usageCount desc / id asc (matches sortByUsageThenUid's tie-break).
  { name: 'curatedOrder', ctor: Int32Array, length: CURATED_CAP },
  { name: 'curatedProviderIdx', ctor: Int32Array, length: MAX_PROVIDERS }, // -> provider table row
  { name: 'curatedProviderStart', ctor: Int32Array, length: MAX_PROVIDERS }, // offset into curatedOrder
  { name: 'curatedProviderLen', ctor: Int32Array, length: MAX_PROVIDERS },

  // ── aggregated-bucket precomputed ranking (id ascending) ─────────────
  { name: 'aggregatedOrder', ctor: Int32Array, length: AGGREGATED_CAP },
] as const;

export interface FieldLayout {
  ctor: TypedArrayCtor;
  byteOffset: number;
  length: number;
  byteLength: number;
}

export type Layout = Record<string, FieldLayout>;

export interface ComputedLayout {
  layout: Layout;
  totalBytes: number;
}

export function computeLayout(): ComputedLayout {
  let offset = 0;
  const layout: Layout = {};
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

/** The typed-array views one generation's SharedArrayBuffer is wrapped into.
 *  Field names match `FIELD_SPECS` above 1:1 — kept as an index signature
 *  (rather than one field per named property) so `computeLayout`'s single
 *  source of truth can't drift from this type; every consumer (encode.ts,
 *  reader.ts) accesses fields by literal string key, which TypeScript still
 *  checks against this signature's value type. */
export interface GenerationViews {
  idStrOffset: Int32Array;
  idStrLen: Int32Array;
  metadataStrOffset: Int32Array;
  metadataStrLen: Int32Array;
  providerIdx: Int32Array;
  contextWindow: Int32Array;
  maxOutputTokens: Int32Array;
  usageCount: Int32Array;
  capabilityBitmask: Uint32Array;
  inputCostPer1k: Float64Array;
  outputCostPer1k: Float64Array;
  latencyMs: Float64Array;
  throughput: Float64Array;
  quality: Float64Array;
  reliability: Float64Array;
  bucketFlag: Uint8Array;
  statusFlag: Uint8Array;
  idStringBlob: Uint8Array;
  metadataBlob: Uint8Array;
  providerIdStrOffset: Int32Array;
  providerIdStrLen: Int32Array;
  providerNameStrOffset: Int32Array;
  providerNameStrLen: Int32Array;
  providerStringBlob: Uint8Array;
  curatedOrder: Int32Array;
  curatedProviderIdx: Int32Array;
  curatedProviderStart: Int32Array;
  curatedProviderLen: Int32Array;
  aggregatedOrder: Int32Array;
}

/** Constructs the correct concrete typed-array view for a runtime-selected
 *  constructor without an `any`/`unknown` cast: each branch calls the named
 *  global constructor directly (not through the narrowed `ctor` parameter),
 *  so the return type of every branch is a real, checked TypedArray type —
 *  the `ctor === X` check only decides WHICH literal branch runs. */
function constructTypedArrayView(
  ctor: TypedArrayCtor,
  buffer: SharedArrayBuffer,
  byteOffset: number,
  length: number
): TypedArrayFor<TypedArrayCtor> {
  if (ctor === Int32Array) return new Int32Array(buffer, byteOffset, length);
  if (ctor === Uint32Array) return new Uint32Array(buffer, byteOffset, length);
  if (ctor === Uint8Array) return new Uint8Array(buffer, byteOffset, length);
  if (ctor === Float64Array) return new Float64Array(buffer, byteOffset, length);
  throw new Error('sab-candidate-index schema: unknown typed array constructor in FIELD_SPECS');
}

export function wrapViews(arrayBuffer: SharedArrayBuffer, layout: Layout): GenerationViews {
  // A plain homogeneous Record (not Partial<GenerationViews>) sidesteps a
  // TypeScript limitation with writing through a generic `keyof T` key into
  // a mapped/interface type (each property's own narrower type makes the
  // write side unsound to check generically) — every value written here IS
  // one of GenerationViews' possible field types, so the single cast at the
  // return is a real, checked narrowing, not a type-safety escape hatch.
  const views: Record<string, GenerationViews[keyof GenerationViews]> = {};
  for (const [name, spec] of Object.entries(layout)) {
    views[name] = constructTypedArrayView(spec.ctor, arrayBuffer, spec.byteOffset, spec.length);
  }
  // A plain Record<string, X> doesn't structurally overlap enough with the
  // many-named-required-properties GenerationViews interface for a direct
  // `as` assertion (TS2352) — narrowAs (@/utils/type-guards) is this repo's
  // sanctioned escape hatch for exactly this trust-boundary shape: every
  // value in `views` was constructed to match its corresponding
  // GenerationViews field name 1:1 by the loop above (driven by the SAME
  // FIELD_SPECS this file defines both `layout` and `GenerationViews` from),
  // so the narrow is correct by construction, not a type-safety bypass.
  return narrowAs<GenerationViews>(views);
}

/**
 * Small fixed control block shared between the worker and the main thread.
 * One Int32Array slot per field, accessed via Atomics so the "which
 * generation is active" publish is a real cross-thread-visible operation.
 *
 * ACTIVE_GEN's Atomics.store (by the worker, after every field in that
 * generation's views has been written) is the RELEASE half of a
 * release/acquire pair; the main thread's corresponding Atomics.load of
 * ACTIVE_GEN is the ACQUIRE half. This is the same pattern used by every
 * lock-free SPSC/double-buffer scheme in the C++11/Rust memory models
 * SharedArrayBuffer+Atomics is deliberately modeled after (ECMA-262 Memory
 * Model, "SharedDataBlock" + Atomics ordering) — a plain non-atomic write is
 * NOT guaranteed visible cross-thread without such a paired atomic
 * operation. Every read of ACTIVE_GEN in this codebase MUST go through
 * `Atomics.load`, never a cached JS variable or a plain array index read —
 * see `manager.ts`/`reader.ts`.
 */
export const CONTROL = {
  ACTIVE_GEN: 0, // 0 or 1 (or -1 before the first build completes)
  VERSION: 1, // monotonically incrementing, bumped once per completed flip
  ROW_COUNT_0: 2,
  ROW_COUNT_1: 3,
  BUILDING_GEN: 4, // diagnostic only: which slot the worker is currently writing (-1 idle)
} as const;
export const CONTROL_SLOTS = 16;
export const CONTROL_BYTES = CONTROL_SLOTS * 4;
