// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#751 — REAL-SOCKET functional proof for the client-disconnect guard.
 *
 * Why this file exists: the inject/EventEmitter-based tests
 * (client-disconnect-guard.test.ts) are blind to the failure mode that
 * shipped to prod (§24 evidence, requestId Da7JX49FSsUUkrcz7eEnU) — there,
 * `request.raw` 'close' fired at message completion on Node v24, so no
 * synthetic emit could tell the difference between "client died mid-stream"
 * and "request message completed". Only a real server + a real client socket
 * that is destroyed mid-response reproduces the actual event ordering.
 *
 * Scenario 1: a real http server starts an SSE response, the client destroys
 * its socket mid-stream, and the guard must fire (fired + signal.aborted).
 * Scenario 2: the response ends normally and the guard must NOT fire.
 */
import { describe, it, expect } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  attachClientDisconnectGuard,
  type ClientDisconnectGuard,
} from '../client-disconnect-guard';

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server did not report an ephemeral port'));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // closeAllConnections: the mid-stream test's server socket dies with the
    // client, but be defensive about keep-alive sockets so close() resolves.
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} — condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('attachClientDisconnectGuard (real http server + real client socket)', () => {
  it(
    'FIRES when a real client destroys its socket mid-response (the §24 prod regression)',
    async () => {
      let resolveGuard: (guard: ClientDisconnectGuard) => void = () => undefined;
      const guardPromise = new Promise<ClientDisconnectGuard>((resolve) => {
        resolveGuard = resolve;
      });

      const server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          // Swallow write errors on the torn-down socket; the unit under test
          // is the guard, not the response plumbing.
          res.on('error', () => {
            /* socket destroyed by the client mid-stream */
          });
          resolveGuard(attachClientDisconnectGuard(req, res));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: first-chunk\n\n');
          // Deliberately NEVER res.end() — the stream is mid-flight when the
          // client dies, exactly like a collective consensus stream.
        }
      );

      const port = await listenOnEphemeralPort(server);
      try {
        // agent: false — one-off agent, no keep-alive socket lingering.
        const clientReq = request({
          host: '127.0.0.1',
          port,
          path: '/',
          agent: false,
        });
        const firstChunkReceived = new Promise<void>((resolve, reject) => {
          clientReq.on('error', reject);
          clientReq.on('response', (clientRes) => {
            clientRes.once('data', () => resolve());
          });
        });
        clientReq.end();
        await firstChunkReceived;

        const guard = await guardPromise;
        expect(guard.fired).toBe(false);

        // Kill the client socket mid-response.
        clientReq.destroy();

        await waitFor(() => guard.fired, 5000, 'guard.fired after client destroy');
        expect(guard.fired).toBe(true);
        expect(guard.signal.aborted).toBe(true);
      } finally {
        await closeServer(server);
      }
    },
    20000
  );

  it(
    'does NOT fire on a normal end-of-response (no false positive on real sockets)',
    async () => {
      let resolveGuard: (guard: ClientDisconnectGuard) => void = () => undefined;
      const guardPromise = new Promise<ClientDisconnectGuard>((resolve) => {
        resolveGuard = resolve;
      });

      const server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          resolveGuard(attachClientDisconnectGuard(req, res));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: first-chunk\n\n');
          res.end(); // normal completion — writableEnded true before close
        }
      );

      const port = await listenOnEphemeralPort(server);
      try {
        const clientReq = request({
          host: '127.0.0.1',
          port,
          path: '/',
          agent: false,
        });
        const responseFullyRead = new Promise<void>((resolve, reject) => {
          clientReq.on('error', reject);
          clientReq.on('response', (clientRes) => {
            clientRes.on('data', () => undefined);
            clientRes.once('end', () => resolve());
          });
        });
        clientReq.end();
        await responseFullyRead;

        const guard = await guardPromise;

        // ServerResponse 'close' fires (after 'end') on the normal path too —
        // give it a beat to prove the writableEnded discrimination holds.
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(guard.fired).toBe(false);
        expect(guard.signal.aborted).toBe(false);
      } finally {
        await closeServer(server);
      }
    },
    20000
  );
});
