// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence


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
