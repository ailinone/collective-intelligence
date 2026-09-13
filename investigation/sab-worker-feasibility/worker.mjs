// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// worker_threads worker that OWNS building/rebuilding the SharedArrayBuffer
// index. Runs on a real OS thread separate from the main thread (Node's
// worker_threads use actual libuv/OS threads, not cooperative scheduling —
// this is what makes the rebuild genuinely non-blocking for the main
// thread's own event loop, unlike today's buildCatalogIndices() which runs
// on whichever thread calls it, i.e. the main thread in the current
// architecture).
import { parentPort } from 'node:worker_threads';
import { computeLayout, wrapViews, CONTROL } from './schema.mjs';
import { encodeGeneration } from './encode.mjs';

const { layout, totalBytes } = computeLayout();

// Two double-buffer slots, allocated once for the lifetime of the process.
// A genuinely growable SharedArrayBuffer (Node 20+, `maxByteLength`) was
// considered and rejected for this design: growth only ever extends the
// END of the buffer, so it cannot help a fixed struct-of-arrays layout where
// every field needs to grow together — a fixed, generously-sized capacity
// (see capacity.mjs) is the simpler-correct choice, same trade-off the
// existing Postgres schema itself makes with its own fixed column widths.
const bufferA = new SharedArrayBuffer(totalBytes);
const bufferB = new SharedArrayBuffer(totalBytes);
const viewsA = wrapViews(bufferA, layout);
const viewsB = wrapViews(bufferB, layout);

const control = new SharedArrayBuffer(64 /* CONTROL_BYTES, inlined to avoid an extra import cycle */);
const controlView = new Int32Array(control);
Atomics.store(controlView, CONTROL.ACTIVE_GEN, -1); // no generation ready yet
Atomics.store(controlView, CONTROL.VERSION, 0);
Atomics.store(controlView, CONTROL.BUILDING_GEN, -1);

parentPort.postMessage({ type: 'ready', bufferA, bufferB, control, totalBytes });

parentPort.on('message', (msg) => {
  if (msg.type !== 'rebuild') return;
  const buildStart = performance.now();

  const activeGen = Atomics.load(controlView, CONTROL.ACTIVE_GEN);
  const targetGen = activeGen === 0 ? 1 : 0; // always write into the INACTIVE slot
  Atomics.store(controlView, CONTROL.BUILDING_GEN, targetGen);

  const targetViews = targetGen === 0 ? viewsA : viewsB;
  const meta = encodeGeneration(msg.models, targetViews);

  // Publish: all the plain (non-atomic) typed-array writes above must become
  // visible to the main thread's reads BEFORE it can observe the new
  // ACTIVE_GEN value. This Atomics.store is the release half of a
  // release/acquire pair — the main thread's corresponding Atomics.load
  // (reader is expected to use Atomics.load, not a cached JS variable, for
  // the generation flag itself) is the acquire half. This is the same
  // pattern used by every lock-free SPSC/double-buffer scheme in the
  // C++11/Rust memory models SharedArrayBuffer+Atomics is deliberately
  // modeled after (ECMA-262 Memory Model, "SharedDataBlock" + Atomics
  // ordering) — a plain non-atomic write is NOT guaranteed visible
  // cross-thread without such a paired atomic operation.
  Atomics.store(controlView, targetGen === 0 ? CONTROL.ROW_COUNT_0 : CONTROL.ROW_COUNT_1, meta.rowCount);
  Atomics.store(controlView, CONTROL.ACTIVE_GEN, targetGen);
  Atomics.add(controlView, CONTROL.VERSION, 1);
  Atomics.store(controlView, CONTROL.BUILDING_GEN, -1);

  const buildMs = performance.now() - buildStart;
  parentPort.postMessage({ type: 'rebuilt', gen: targetGen, meta, buildMs });
});
