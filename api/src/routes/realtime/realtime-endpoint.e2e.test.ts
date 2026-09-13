// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * /v1/realtime — REAL WebSocket end-to-end.
 *
 * Unlike `realtime-client-factory.test.ts`, which unit-tests the selection
 * logic, this suite boots a real Fastify instance with `@fastify/websocket`,
 * registers the real `registerRealtimeRoutes`, opens a real `ws` client over a
 * real TCP socket, and exchanges real frames. It proves the endpoint IS a
 * functioning bidirectional WebSocket session and that the transport decision
 * reaches the client — not merely that a factory function returns the right
 * object.
 *
 * What is stubbed and why: authentication and the quota gates (this suite is
 * about the transport, not authorization), the model repository and provider
 * registry (no catalog or credentials in a unit run), and the composite client
 * (it would otherwise make loopback HTTP calls to /v1/chat/completions). The
 * WebSocket upgrade, the frame codec, the session state machine and the
 * factory are all the real implementations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const registryGet = vi.fn();
const findModelsByIdOrName = vi.fn();
const findModelsWithCapabilities = vi.fn();

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async (request: Record<string, unknown>) => {
    request.user = { userId: 'user-1', organizationId: 'org-1', email: 'a@b.c', roles: [] };
    request.userId = 'user-1';
    request.organizationId = 'org-1';
  },
}));

vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => undefined,
}));

vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => undefined,
}));

vi.mock('@/services/realtime-session-service', () => ({
  createRealtimeSession: vi.fn(),
}));

vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ generateEphemeralAccessToken: async () => 'internal-token' }),
}));

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    findModelsByIdOrName = findModelsByIdOrName;
    findModelsWithCapabilities = findModelsWithCapabilities;
  },
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ get: registryGet, getAll: () => [] }),
}));

/**
 * Stand-in for the composite pipeline. Real `AilinRealtimeClient.connect()`
 * would reach the STT/chat/TTS services over loopback HTTP; the route only
 * needs an object that connects and emits, and the `instanceof` branch in the
 * route is satisfied because this IS the class the module exports here.
 */
class FakeCompositeClient extends EventEmitter {
  connected = false;
  sentText: string[] = [];
  sentAudio: Buffer[] = [];

  async connect(): Promise<void> {
    this.connected = true;
  }
  sendText(text: string): void {
    this.sentText.push(text);
  }
  sendAudio(buffer: Buffer): void {
    this.sentAudio.push(buffer);
  }
  requestResponse(): void {
    this.emit('response.text.delta', { delta: 'ack' });
  }
  cancelResponse(): void {
    this.emit('response.cancelled', {});
  }
  disconnect(): void {
    this.connected = false;
  }
}

vi.mock('@/providers/ailin/ailin-realtime-client', () => ({
  AilinRealtimeClient: FakeCompositeClient,
}));

const { registerRealtimeRoutes } = await import('./realtime-routes');

let app: FastifyInstance;
let baseUrl: string;

/** Opens a client socket and collects every JSON frame the server sends. */
function openSession(query = ''): Promise<{
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  nextFrame: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}/v1/realtime${query}`);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      type: string;
      resolve: (frame: Record<string, unknown>) => void;
    }> = [];

    socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      const index = waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    });
    socket.on('error', reject);
    socket.on('open', () =>
      resolve({
        socket,
        frames,
        nextFrame: (type, timeoutMs = 5000) =>
          new Promise((resolveFrame, rejectFrame) => {
            const existing = frames.find((frame) => frame.type === type);
            if (existing) {
              resolveFrame(existing);
              return;
            }
            const timer = setTimeout(
              () =>
                rejectFrame(
                  new Error(
                    `timed out waiting for "${type}"; saw: ${frames.map((f) => f.type).join(', ')}`
                  )
                ),
              timeoutMs
            );
            waiters.push({
              type,
              resolve: (frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
              },
            });
          }),
      })
    );
  });
}

beforeAll(async () => {
  findModelsByIdOrName.mockResolvedValue([]);
  findModelsWithCapabilities.mockResolvedValue([]);
  registryGet.mockReturnValue(undefined);

  app = Fastify({ logger: false });
  await app.register(websocket);
  await app.register(async (instance) => {
    await registerRealtimeRoutes(instance);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('/v1/realtime — real WebSocket session', () => {
  it('completes the upgrade and greets the client', async () => {
    const session = await openSession();
    try {
      const opened = await session.nextFrame('connection.opened');
      expect(opened.connection_id).toBeTruthy();
    } finally {
      session.socket.close();
    }
  }, 20_000);

  it('serves the composite pipeline by default and SAYS so', async () => {
    const session = await openSession();
    try {
      await session.nextFrame('connection.opened');
      session.socket.send(JSON.stringify({ type: 'session.update', session: {} }));

      const updated = (await session.nextFrame('session.updated')) as {
        session: Record<string, unknown>;
      };

      // The client must be able to tell a composite text round-trip from a
      // native speech-to-speech session. Before this branch the response
      // carried no transport field at all.
      expect(updated.session.transport).toBe('composite');
      expect(updated.session.provider).toBe('ailin');
    } finally {
      session.socket.close();
    }
  }, 20_000);

  it('fails closed on transport=provider when no provider bridge resolves', async () => {
    const session = await openSession('?transport=provider');
    try {
      await session.nextFrame('connection.opened');
      session.socket.send(
        JSON.stringify({ type: 'session.update', session: { model: 'a-realtime-model' } })
      );

      const error = (await session.nextFrame('error')) as { error: Record<string, unknown> };

      // Downgrading to the composite here would answer a speech-to-speech
      // request with a text round-trip, silently.
      expect(error.error.type).toBe('no_realtime_transport');
      expect(error.error.transport).toBe('provider');
      expect(error.error.requested_model).toBe('a-realtime-model');
      expect(session.frames.some((frame) => frame.type === 'session.updated')).toBe(false);
    } finally {
      session.socket.close();
    }
  }, 20_000);

  it('honours transport on the session.update payload, not just the query string', async () => {
    const session = await openSession();
    try {
      await session.nextFrame('connection.opened');
      session.socket.send(
        JSON.stringify({
          type: 'session.update',
          session: { transport: 'provider', model: 'a-realtime-model' },
        })
      );

      const error = (await session.nextFrame('error')) as { error: Record<string, unknown> };
      expect(error.error.type).toBe('no_realtime_transport');
    } finally {
      session.socket.close();
    }
  }, 20_000);

  it('refuses to act before the session is configured', async () => {
    const session = await openSession();
    try {
      await session.nextFrame('connection.opened');
      session.socket.send(JSON.stringify({ type: 'response.create' }));

      const error = (await session.nextFrame('error')) as { error: Record<string, unknown> };
      expect(error.error.type).toBe('session_not_configured');
    } finally {
      session.socket.close();
    }
  }, 20_000);

  it('carries audio frames end to end once configured', async () => {
    const session = await openSession();
    try {
      await session.nextFrame('connection.opened');
      session.socket.send(JSON.stringify({ type: 'session.update', session: {} }));
      await session.nextFrame('session.updated');

      // Base64 audio in, then commit — the documented client event pair.
      session.socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: Buffer.from('pcm-bytes').toString('base64'),
        })
      );
      session.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

      // The composite stub answers `requestResponse()` with a delta, so a
      // frame arriving here proves the full path: client socket -> route
      // handler -> realtime client -> event forwarding -> client socket.
      const delta = (await session.nextFrame('response.text.delta')) as Record<string, unknown>;
      expect(delta.provider).toBe('ailin');
    } finally {
      session.socket.close();
    }
  }, 20_000);
});
