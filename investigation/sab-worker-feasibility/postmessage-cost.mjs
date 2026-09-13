// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Isolates the cost of postMessage()-ing the full 111,666-row plain-object
// array TO the worker — this is the cost the main thread pays if the worker
// does NOT have its own DB/Redis client and instead receives fetched rows
// via message passing from the main thread (a real, easy-to-reach-for
// implementation choice). structured-clone serialization of the object
// graph happens SYNCHRONOUSLY on the sending side before postMessage()
// returns — if this is expensive, it reintroduces main-thread blocking on
// every refresh cycle even though the ENCODE itself moved to the worker.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildRealisticCatalogRecords } from './fixture.mjs';

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
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const worker = new Worker(workerPath);
  await waitForMessage(worker, 'ready');

  for (let i = 0; i < 3; i++) {
    const rebuiltP = waitForMessage(worker, 'rebuilt');
    const t0 = performance.now();
    worker.postMessage({ type: 'rebuild', models }); // synchronous structured-clone serialization happens INSIDE this call, on the main thread
    const postMessageMs = performance.now() - t0; // time the main thread was blocked doing serialization
    const rebuilt = await rebuiltP;
    console.log(
      `run ${i}: postMessage() call itself blocked the main thread for ${postMessageMs.toFixed(2)}ms (serializing ${models.length} objects) | worker-side encode took ${rebuilt.buildMs.toFixed(2)}ms (off main thread)`
    );
  }
  await worker.terminate();
}

main();
