// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Real memory-footprint comparison. Run with --expose-gc for accurate heap
// deltas (same technique full-cache-index-benchmark.test.ts itself uses).
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildRealisticCatalogRecords } from './fixture.mjs';
import { buildCatalogIndices } from './current-map-approach.mjs';
import { computeLayout } from './schema.mjs';

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
  const models = buildRealisticCatalogRecords();

  global.gc?.();
  const beforeMap = process.memoryUsage().heapUsed;
  const mapIndices = buildCatalogIndices(models);
  global.gc?.();
  const afterMap = process.memoryUsage().heapUsed;
  console.log(`current in-process Map indices (byId+byProvider+byCapability) heap delta: ${((afterMap - beforeMap) / 1024 / 1024).toFixed(2)}MB${global.gc ? '' : ' (NOT GC-forced, run with --expose-gc for an accurate number)'}`);
  console.log(`  (byId.size=${mapIndices.byId.size}, byProvider.size=${mapIndices.byProvider.size}, byCapability.size=${mapIndices.byCapability.size})`);

  const { layout, totalBytes } = computeLayout();
  console.log(`\nSharedArrayBuffer per-generation size (fixed, computed from capacity.mjs constants): ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
  console.log(`  x2 generations (double buffer) = ${(totalBytes * 2 / 1024 / 1024).toFixed(2)}MB total resident, REGARDLESS of actual row count (capacity-based, not usage-based)`);
  console.log('  field-by-field byte breakdown:');
  for (const [name, spec] of Object.entries(layout)) {
    console.log(`    ${name.padEnd(24)} ${(spec.byteLength / 1024 / 1024).toFixed(3).padStart(8)}MB  (${spec.ctor.name}, capacity ${spec.length})`);
  }

  // Actual bytes USED at today's real row count, vs allocated capacity —
  // shows headroom cost vs a perfectly-sized allocation.
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const worker = new Worker(workerPath);
  await waitForMessage(worker, 'ready');
  const rebuiltP = waitForMessage(worker, 'rebuilt');
  worker.postMessage({ type: 'rebuild', models });
  const rebuilt = await rebuiltP;
  console.log(`\nAt today's real row count (${rebuilt.meta.rowCount} rows, ${rebuilt.meta.curatedTotal} curated, ${rebuilt.meta.aggregatedTotal} aggregated, ${rebuilt.meta.providerCount} providers):`);
  console.log(`  the fixed-capacity buffer is allocated for up to 200,000 models / 120,000 curated / 200,000 aggregated —`);
  console.log(`  i.e. ~${((rebuilt.meta.rowCount / 200_000) * 100).toFixed(0)}% of per-model-array capacity actually used today; the rest is real, resident, unused headroom (the cost of a fixed-layout design that must survive catalog growth without a resize).`);
  await worker.terminate();
}

main();
