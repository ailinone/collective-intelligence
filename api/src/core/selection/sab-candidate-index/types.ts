// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/** Shared types between the SAB candidate-index worker and its main-thread
 *  manager. Deliberately tiny and JSON/structured-clone-friendly — this is
 *  the ONLY data that ever crosses the worker<->main postMessage boundary on
 *  the hot path; the bulk per-model catalog data never does (see
 *  `worker.ts`'s module doc for why that constraint exists). */

export interface ProviderTableEntry {
  id: string;
  name: string;
  idx: number;
}

/** Small, low-cardinality metadata describing one completed generation —
 *  cheap enough (tens to hundreds of entries) to message-pass wholesale on
 *  every rebuild, unlike the per-model bulk data, which never leaves shared
 *  memory. Mirrors `investigation/sab-worker-feasibility/encode.mjs`'s
 *  `encodeGeneration` return shape. */
export interface GenerationMeta {
  rowCount: number;
  curatedTotal: number;
  aggregatedTotal: number;
  curatedProviderCount: number;
  providerCount: number;
  capNames: string[];
  /** Every distinct capability mask present in this generation, flattened:
   *  `CAPABILITY_MASK_WORDS` Uint32 words per mask, back to back (see
   *  `capability-mask.ts`). */
  distinctMasks: number[];
  providers: ProviderTableEntry[];
  /** Distinct capability strings this generation encoded (`capNames.length`),
   *  exported as `ci_sab_candidate_index_distinct_capabilities` so the
   *  headroom against `MAX_CAPABILITIES` is visible in Prometheus rather
   *  than only discoverable when a rebuild fails. */
  distinctCapabilities: number;
  /** Bytes actually written into the metadata / id string blobs, for the
   *  `_metadata_blob_used_bytes` gauge (capacity is a separate gauge). */
  metadataBlobUsedBytes: number;
  idBlobUsedBytes: number;
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerRebuiltMessage {
  type: 'rebuilt';
  gen: 0 | 1;
  meta: GenerationMeta;
  buildMs: number;
  /** Where this generation's rows were sourced from — surfaced for
   *  observability (the manager logs a warning the first time a generation
   *  is built from the Postgres fallback instead of the Redis fleet-wide
   *  snapshot, mirroring `model-catalog-service.ts`'s own fallback-path
   *  logging convention). */
  source: 'redis' | 'postgres';
}

/** Label value for `ci_sab_candidate_index_build_failures_total{reason}`:
 *  `capacity` = a fixed schema bound was exceeded (operator action: raise
 *  the env override or widen the schema), `fetch` = the catalog could not
 *  be read from Redis or Postgres, `other` = anything else. */
export type RebuildFailureReason = 'capacity' | 'fetch' | 'other';

export interface WorkerRebuildFailedMessage {
  type: 'rebuild-failed';
  error: string;
  reason: RebuildFailureReason;
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerRebuiltMessage
  | WorkerRebuildFailedMessage;

export interface MainToWorkerRebuildMessage {
  type: 'rebuild';
}

export type MainToWorkerMessage = MainToWorkerRebuildMessage;

/** Data passed to the worker at construction time (`new Worker(path, {
 *  workerData })`) — the three SharedArrayBuffers it will write into.
 *  SharedArrayBuffer is one of the few object types `workerData` can carry
 *  by real reference (no structured-clone copy) both at spawn time and
 *  across a respawn, which is what makes crash-respawn cheap: the manager
 *  allocates these ONCE and keeps handing the same three buffers to every
 *  worker instance it spawns, so a crash never orphans the main thread's own
 *  already-wrapped views. */
export interface SabWorkerData {
  bufferA: SharedArrayBuffer;
  bufferB: SharedArrayBuffer;
  control: SharedArrayBuffer;
  /** Runtime DATABASE_URL resolved on the main thread (see
   *  worker-database-url.ts for why the worker must not read process.env). */
  databaseUrl: string;
}
