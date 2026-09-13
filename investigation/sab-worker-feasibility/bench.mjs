// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Real concurrent-load benchmark: N simulated concurrent requests via
// Promise.all, same N values as the sibling concurrent-load-benchmark task
// (1/10/50/100/300/500), measuring latency percentiles AND event-loop
// responsiveness via a continuous setImmediate probe (its own scheduling
// delay reveals event-loop contention — a macrotask cannot fire until every
// currently-queued microtask, including a Promise.all batch of synchronous
// CPU-bound .then() callbacks, has drained).
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildRealisticCatalogRecords } from './fixture.mjs';
import { buildCatalogIndices, getFullCacheFairCandidateModels } from './current-map-approach.mjs';
import { computeLayout, wrapViews } from './schema.mjs';
import { buildGenLookup, getCandidatesFromSharedIndex } from './reader.mjs';

const CRITERIA = { contextSize: 1000 };
const CURATED_TAKE = 400;
const AGGREGATED_TAKE = 300;
const MAX_PROVIDER_SHARE = 0.15;
const CONCURRENCY_LEVELS = [1, 10, 50, 100, 300, 500];

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

function stats(msArr) {
  const sorted = [...msArr].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function startEventLoopProbe() {
  let stop = false;
  const samples = [];
  function tick() {
    if (stop) return;
    const scheduledAt = performance.now();
    setImmediate(() => {
      samples.push(performance.now() - scheduledAt);
      tick();
    });
  }
  tick();
  return {
    stop: () => {
      stop = true;
    },
    samples,
  };
}

async function runConcurrentBatch(fn, n) {
  const promises = [];
  for (let i = 0; i < n; i++) {
    promises.push(
      Promise.resolve().then(() => {
        const start = performance.now();
        const result = fn();
        const ms = performance.now() - start;
        return { ms, len: result.models.length };
      })
    );
  }
  return Promise.all(promises);
}

async function benchApproach(label, fn) {
  console.log(`\n=== ${label} ===`);
  const rows = [];
  for (const n of CONCURRENCY_LEVELS) {
    const probe = startEventLoopProbe();
    await new Promise((r) => setImmediate(r)); // let one probe cycle establish baseline
    probe.samples.length = 0;
    const wallStart = performance.now();
    const results = await runConcurrentBatch(fn, n);
    const wallMs = performance.now() - wallStart;
    await new Promise((r) => setImmediate(r)); // flush the in-flight probe sample for this window
    probe.stop();

    const perCallMs = results.map((r) => r.ms);
    const s = stats(perCallMs);
    const maxEventLoopDelayMs = probe.samples.length > 0 ? Math.max(...probe.samples) : 0;
    rows.push({ n, wallMs, ...s, maxEventLoopDelayMs, resultLen: results[0]?.len ?? 0 });
    console.log(
      `N=${String(n).padStart(3)} wall=${wallMs.toFixed(1)}ms  min=${s.min.toFixed(3)} p50=${s.p50.toFixed(3)} p95=${s.p95.toFixed(3)} p99=${s.p99.toFixed(3)} max=${s.max.toFixed(3)}  | eventLoopMaxDelay=${maxEventLoopDelayMs.toFixed(1)}ms  results/call=${results[0]?.len}`
    );
  }
  return rows;
}

function waitForMessage(worker, type) {
  return new Promise((resolve) => {
    function onMsg(msg) {
      if (msg.type === type) {
        worker.off('message', onMsg);
        resolve(msg);
      }
    }
    worker.on('message', onMsg);
  });
}

async function main() {
  console.log('Building fixture (111,666 rows)...');
  const models = buildRealisticCatalogRecords();

  // ── Baseline: current in-process Map approach, index build cost ─────────
  console.log('\n--- Index build cost: buildCatalogIndices() on the MAIN thread (today\'s reality) ---');
  const buildTimes = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    buildCatalogIndices(models);
    buildTimes.push(performance.now() - t0);
  }
  console.log(`  5 runs: ${buildTimes.map((t) => t.toFixed(1)).join(', ')}ms (this is main-thread time — it IS the event loop during this window)`);

  const mapIndices = buildCatalogIndices(models);
  const mapFn = () => getFullCacheFairCandidateModels(mapIndices, CRITERIA, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);

  const mapRows = await benchApproach('Current in-process Map (per-request O(catalog) scan+sort)', mapFn);

  // ── SharedArrayBuffer + worker_threads approach ──────────────────────────
  console.log('\n--- Worker build cost: encodeGeneration() on a SEPARATE OS thread ---');
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const worker = new Worker(workerPath);
  const ready = await waitForMessage(worker, 'ready');
  const { layout } = computeLayout();
  const viewsA = wrapViews(ready.bufferA, layout);
  const viewsB = wrapViews(ready.bufferB, layout);
  const controlView = new Int32Array(ready.control);

  const rebuiltP = waitForMessage(worker, 'rebuilt');
  worker.postMessage({ type: 'rebuild', models });
  const rebuilt = await rebuiltP;
  console.log(`  worker encode: ${rebuilt.buildMs.toFixed(1)}ms (runs on worker's own OS thread, NOT the main thread's event loop)`);

  let activeViews = () => (Atomics.load(controlView, 0) === 0 ? viewsA : viewsB);
  let gen = buildGenLookup(rebuilt.meta);
  const sabFn = () => getCandidatesFromSharedIndex(activeViews(), gen, CRITERIA, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);

  const sabRows = await benchApproach('worker_threads + SharedArrayBuffer (precomputed ranking, direct shared-memory read)', sabFn);

  // ── The scenario the task specifically asks to prove: does a REBUILD in
  //    flight on the worker thread block main-thread SAB reads? ───────────
  console.log('\n--- Concurrent rebuild-in-flight test: 500 SAB reads WHILE the worker rebuilds ---');
  worker.on('message', (msg) => {
    if (msg.type === 'rebuilt') {
      gen = buildGenLookup(msg.meta);
    }
  });
  const probe = startEventLoopProbe();
  await new Promise((r) => setImmediate(r));
  probe.samples.length = 0;
  const rebuildDuringReadsStart = performance.now();
  worker.postMessage({ type: 'rebuild', models }); // fire-and-forget from main thread's perspective
  const readResults = await runConcurrentBatch(sabFn, 500);
  const rebuildDuringReadsMs = performance.now() - rebuildDuringReadsStart;
  await new Promise((r) => setImmediate(r));
  probe.stop();
  const readStats = stats(readResults.map((r) => r.ms));
  const maxDelay = probe.samples.length > 0 ? Math.max(...probe.samples) : 0;
  console.log(
    `  500 SAB reads completed in ${rebuildDuringReadsMs.toFixed(1)}ms wall (p50=${readStats.p50.toFixed(3)}ms p99=${readStats.p99.toFixed(3)}ms) while a full 111,666-row rebuild ran concurrently on the worker thread.`
  );
  console.log(`  event-loop max delay during this window: ${maxDelay.toFixed(1)}ms`);
  console.log(`  every read returned ${readResults[0]?.len} candidates (correctness sanity: ${readResults.every((r) => r.len > 0) ? 'all non-empty, OK' : 'SOME EMPTY — investigate'})`);

  await worker.terminate();

  console.log('\n\n=== SUMMARY TABLE (ms) ===');
  console.log('N    | Map wall | Map p50 | Map p99 | Map ELdelay || SAB wall | SAB p50 | SAB p99 | SAB ELdelay');
  for (let i = 0; i < CONCURRENCY_LEVELS.length; i++) {
    const m = mapRows[i];
    const s = sabRows[i];
    console.log(
      `${String(m.n).padStart(4)} | ${m.wallMs.toFixed(1).padStart(8)} | ${m.p50.toFixed(2).padStart(7)} | ${m.p99.toFixed(2).padStart(7)} | ${m.maxEventLoopDelayMs.toFixed(1).padStart(10)} || ${s.wallMs.toFixed(1).padStart(8)} | ${s.p50.toFixed(3).padStart(7)} | ${s.p99.toFixed(3).padStart(7)} | ${s.maxEventLoopDelayMs.toFixed(1).padStart(10)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
