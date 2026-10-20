// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI-CHAT-0003 (R3) — stream event buffer (Redis replay support).
 *
 * Contract: frames are stored as complete wire strings via a pipelined
 * RPUSH/LTRIM/EXPIRE (bounded + TTL'd); reads filter by
 * ailin_metadata.seq > since; every Redis failure fails OPEN (no-throw,
 * empty read) — a cache outage must never fail a live stream or a replay
 * request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const pipeline = {
    rpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn(async () => []),
  };
  // chainable pipeline
  pipeline.rpush.mockReturnThis();
  pipeline.ltrim.mockReturnThis();
  pipeline.expire.mockReturnThis();
  return {
    pipelineCmds: pipeline,
    lrange: vi.fn(async () => [] as string[]),
  };
});

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    pipeline: () => mocks.pipelineCmds,
    lrange: mocks.lrange,
  }),
}));

import {
  annotateStreamChunk,
  bufferStreamEvent,
  readStreamEvents,
  STREAM_EVENT_TTL_SECONDS,
  MAX_EVENTS_PER_RUN,
} from '../stream-event-buffer';

const frame = (seq: number, runId = 'run-1') =>
  `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    ailin_metadata: { run_id: runId, seq },
  })}\n\n`;

describe('bufferStreamEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pipelineCmds.rpush.mockClear();
    mocks.pipelineCmds.ltrim.mockClear();
    mocks.pipelineCmds.expire.mockClear();
    mocks.pipelineCmds.exec.mockImplementation(async () => []);
  });

  it('pipelines rpush + ltrim bound + expire ttl', async () => {
    await bufferStreamEvent('run-1', 3, frame(3));
    const p = mocks.pipelineCmds;
    expect(p.rpush).toHaveBeenCalledWith('stream:run-1', frame(3));
    expect(p.ltrim).toHaveBeenCalledWith('stream:run-1', -MAX_EVENTS_PER_RUN, -1);
    expect(p.expire).toHaveBeenCalledWith('stream:run-1', STREAM_EVENT_TTL_SECONDS);
    expect(p.exec).toHaveBeenCalledTimes(1);
  });

  it('fails open when redis errors', async () => {
    mocks.pipelineCmds.exec.mockRejectedValueOnce(new Error('redis down'));
    await expect(bufferStreamEvent('run-1', 1, frame(1))).resolves.toBeUndefined();
  });
});

describe('readStreamEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only frames with seq > since, in order', async () => {
    mocks.lrange.mockResolvedValueOnce([frame(1), frame(2), frame(3)]);
    const out = await readStreamEvents('run-1', 1);
    expect(out).toEqual([frame(2), frame(3)]);
  });

  it('drops unparseable frames instead of throwing', async () => {
    mocks.lrange.mockResolvedValueOnce(['data: {oops', frame(2)]);
    const out = await readStreamEvents('run-1', 0);
    expect(out).toEqual([frame(2)]);
  });

  it('returns empty on redis failure (fail open)', async () => {
    mocks.lrange.mockRejectedValueOnce(new Error('redis down'));
    await expect(readStreamEvents('run-1', 0)).resolves.toEqual([]);
  });
});

describe('annotateStreamChunk', () => {
  it('adds run_id/seq/ts without disturbing existing metadata fields', () => {
    const base = {
      id: 'c1',
      object: 'chat.completion.chunk' as const,
      ailin_metadata: { type: 'progress' as const, message: 'Generating image', step: 1, total: 0 },
      choices: [],
    };
    const out = annotateStreamChunk(base as never, 'run-9', 7);
    const meta = out.ailin_metadata as Record<string, unknown>;
    expect(meta['run_id']).toBe('run-9');
    expect(meta['seq']).toBe(7);
    expect(typeof meta['ts']).toBe('string');
    expect(meta['type']).toBe('progress');
    expect(meta['message']).toBe('Generating image');
    // original chunk untouched (returns a shallow clone)
    expect((base.ailin_metadata as Record<string, unknown>)['run_id']).toBeUndefined();
  });

  it('creates ailin_metadata when the chunk had none', () => {
    const out = annotateStreamChunk({ id: 'c2', object: 'chat.completion.chunk', choices: [] } as never, 'run-9', 1);
    const meta = out.ailin_metadata as Record<string, unknown>;
    expect(meta['run_id']).toBe('run-9');
    expect(meta['seq']).toBe(1);
  });
});
