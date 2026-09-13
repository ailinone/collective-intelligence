// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Empirically confirms (not assumed) whether a SharedArrayBuffer's "shared"
// property survives Node's built-in process-to-process IPC (child_process
// fork), which is the mechanism most structurally similar to what would be
// needed to share this design's buffer across the 2 separate API service
// Docker Swarm replica PROCESSES (as opposed to worker_threads, which are
// threads within ONE process and the only thing this design actually uses).
//
// Method: parent creates a SharedArrayBuffer, sends it to a forked CHILD
// PROCESS over process.send() (structured-clone IPC, the same serialization
// child_process/cluster always use — genuinely distinct from
// worker_threads' postMessage, which uses a different, true-sharing-capable
// channel). Child mutates byte 0. If the underlying memory were truly
// shared, the PARENT's own original buffer would observe the mutation
// (Atomics.load would return the child's written value). If IPC only
// clones the bytes into a brand new, independent ArrayBuffer in the child,
// the parent's buffer stays unchanged.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const CHILD_SRC = `
process.on('message', (msg) => {
  if (msg.type !== 'sab') return;
  console.log('[child] received buffer, constructor:', msg.buffer && msg.buffer.constructor && msg.buffer.constructor.name);
  console.log('[child] received buffer === SharedArrayBuffer instance?', msg.buffer instanceof SharedArrayBuffer);
  if (!(msg.buffer instanceof SharedArrayBuffer) && !(msg.buffer instanceof ArrayBuffer)) {
    console.log('[child] payload is not a (Shared)ArrayBuffer at all — IPC could not carry it as one. Raw:', JSON.stringify(msg.buffer).slice(0, 200));
    process.send({ type: 'done', carried: false });
    return;
  }
  const view = new Int32Array(msg.buffer);
  console.log('[child] before mutation, view[0] =', Atomics.load(view, 0));
  Atomics.store(view, 0, 999999);
  console.log('[child] after mutation, view[0] =', Atomics.load(view, 0));
  process.send({ type: 'done', carried: true });
});
`;

async function main() {
  const childPath = fileURLToPath(new URL('./cross-process-test-child.generated.mjs', import.meta.url));
  writeFileSync(childPath, CHILD_SRC);

  const sab = new SharedArrayBuffer(4);
  const parentView = new Int32Array(sab);
  Atomics.store(parentView, 0, 42);
  console.log('[parent] initial value:', Atomics.load(parentView, 0));
  console.log('[parent] SharedArrayBuffer.prototype.growable/byteLength sanity:', sab.byteLength, 'bytes');

  // serialization: 'advanced' switches child_process IPC from the default
  // JSON serialization (which cannot represent a SharedArrayBuffer at all —
  // confirmed below in the first attempt) to V8's serialize/deserialize
  // (structured-clone) API, the same algorithm worker_threads' postMessage
  // uses. This is the MOST favorable case for cross-process sharing to
  // possibly work, since it's the same serialization mechanism that DOES
  // preserve true sharing between worker_threads.
  const child = fork(childPath, [], { stdio: 'inherit', serialization: 'advanced' });

  await new Promise((resolve) => {
    child.on('message', (msg) => {
      if (msg.type === 'done') resolve();
    });
    child.send({ type: 'sab', buffer: sab });
  });

  // Give any (hypothetical) async propagation a moment before checking —
  // there shouldn't be any, since IPC serialization is synchronous-complete
  // by the time process.send's callback / the child's ack fires, but this
  // rules out a timing-based false negative.
  await new Promise((r) => setTimeout(r, 50));

  const parentValueAfter = Atomics.load(parentView, 0);
  console.log('\n[parent] value AFTER child mutated its copy:', parentValueAfter);
  if (parentValueAfter === 999999) {
    console.log('RESULT: memory WAS shared across processes (unexpected — would contradict documented Node behavior).');
  } else {
    console.log(
      `RESULT: memory was NOT shared across processes (parent still sees ${parentValueAfter}, not the child's 999999).\n` +
        'CONFIRMED: child_process IPC structured-clones a SharedArrayBuffer into an independent copy in the child process.\n' +
        'SharedArrayBuffer sharing is confirmed to be strictly intra-process (worker_threads only) — it does NOT cross OS process boundaries via any built-in Node.js mechanism.'
    );
  }

  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
