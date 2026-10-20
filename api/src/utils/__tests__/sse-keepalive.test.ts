// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * sse-keepalive.test.ts — unit coverage for the streaming media-generation
 * gate's heartbeat (2026-09-30 incident follow-up). The gate runs the whole
 * non-streaming generation pipeline before its single response chunk exists
 * (49.6s observed in production), and without bytes on the wire,
 * line-oriented intermediaries (Cloudflare ~100s → 524) declare the
 * connection dead. `: keepalive` SSE comments keep every hop warm while
 * being ignored by every consumer in the chain (verified: chat's
 * stream_chunks_handler and the browser parser skip non-`data:` lines).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startSSEKeepalive, setupSSEHeaders, buildMediaProgressChunk } from '../sse';

afterEach(() => {
  vi.useRealTimers();
});

describe('startSSEKeepalive', () => {
  it('writes an SSE comment line on every interval tick', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const raw = { write: (chunk: string) => (writes.push(chunk), true) };

    startSSEKeepalive(raw, 15_000);
    expect(writes).toHaveLength(0); // nothing before the first tick

    vi.advanceTimersByTime(15_000);
    expect(writes).toEqual([': keepalive\n\n']);

    vi.advanceTimersByTime(45_000); // three more ticks
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => w === ': keepalive\n\n')).toBe(true);
  });

  it('stop() halts the heartbeat', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const raw = { write: (chunk: string) => (writes.push(chunk), true) };

    const stop = startSSEKeepalive(raw, 15_000);
    vi.advanceTimersByTime(15_000);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(1); // no further ticks after stop
  });

  it('never emits anything parseable as a data frame (comment prefix)', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const raw = { write: (chunk: string) => (writes.push(chunk), true) };
    const stop = startSSEKeepalive(raw, 1);
    vi.advanceTimersByTime(5);
    stop();
    // The `:` prefix is what every SSE consumer treats as a comment to
    // ignore — a bare `keepalive` would be dropped differently (or worse,
    // parsed) by line-based relays.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((line) => line.startsWith(': '))).toBe(true);
  });
});

describe('startSSEKeepalive onTick + buildMediaProgressChunk', () => {
  it('runs onTick on every interval tick (progress frames ride the keepalive)', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const ticks = vi.fn();
    const raw = { write: (chunk: string) => (writes.push(chunk), true) };
    const stop = startSSEKeepalive(raw, 15_000, ticks);
    vi.advanceTimersByTime(45_000);
    stop();
    expect(ticks).toHaveBeenCalledTimes(3); // t=15s, 30s, 45s — not at t=0
  });

  it('progress chunk matches the strategies\' AilinProgressMetadata contract', () => {
    const chunk = buildMediaProgressChunk('image', 30, 'ailin-auto');
    expect(chunk.ailin_metadata).toEqual({
      type: 'progress',
      message: 'Generating image',
      step: 30,
      total: 0,
    });
    // Unknown consumers must render nothing from it.
    expect(chunk.choices[0].delta?.content).toBe('');
    const line = `data: ${JSON.stringify(chunk)}\n\n`;
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(1_000); // stays tiny
  });
});

describe('setupSSEHeaders — headersSent guard', () => {
  it('is a no-op when headers were already committed (early keepalive path)', () => {
    const writeHead = vi.fn();
    const reply = {
      getHeaders: () => ({}),
      raw: { headersSent: true, writeHead },
    } as never;
    setupSSEHeaders(reply);
    expect(writeHead).not.toHaveBeenCalled(); // would ERR_HTTP_HEADERS_SENT
  });

  it('commits 200 + SSE headers when not yet sent', () => {
    const writeHead = vi.fn();
    const reply = {
      getHeaders: () => ({ 'X-Queued': 'merged' }),
      raw: { headersSent: false, writeHead },
    } as never;
    setupSSEHeaders(reply);
    expect(writeHead).toHaveBeenCalledTimes(1);
    const [status, headers] = writeHead.mock.calls[0];
    expect(status).toBe(200);
    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['X-Queued']).toBe('merged');
  });
});
