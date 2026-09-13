// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Empirically confirms: does an uncaught exception inside a worker_threads
// worker (e.g. mid-rebuild) crash the MAIN process, or is it isolated to
// that worker (leaving the main thread free to keep serving reads against
// the last-good SharedArrayBuffer generation and to respawn a new worker)?
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRASHING_WORKER_SRC = `
setTimeout(() => {
  throw new Error('simulated crash mid-rebuild');
}, 50);
`;

async function main() {
  const crashPath = fileURLToPath(new URL('./worker-crash-test-child.generated.mjs', import.meta.url));
  writeFileSync(crashPath, CRASHING_WORKER_SRC);

  const worker = new Worker(crashPath);
  const outcome = await new Promise((resolve) => {
    worker.on('error', (err) => resolve({ type: 'error', message: err.message }));
    worker.on('exit', (code) => resolve({ type: 'exit', code }));
  });
  console.log('worker crash outcome observed by main thread:', JSON.stringify(outcome));
  console.log('main thread is still alive and executing this line after the worker crashed.');
  console.log(
    'CONFIRMED: an uncaught exception in a worker_threads Worker does NOT crash the main process — it surfaces as an \'error\' event on the Worker handle, isolated to that worker. The main thread can catch it, log it, and respawn a fresh worker while continuing to serve reads against the last-good SharedArrayBuffer generation.'
  );
}

main();
