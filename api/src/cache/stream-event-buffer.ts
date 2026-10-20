// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Stream event buffer (CI-CHAT-0003, R3) — replay support for streamed runs.
 *
 * When ENABLE_STREAM_RESUME is on, the chat-completions streaming relay
 * annotates every SSE chunk with `ailin_metadata.{run_id, seq, ts}` and
 * buffers the exact wire frame here (Redis list per run, TTL 15min, bounded
 * length). If the consumer's connection dies mid-stream it can GET
 * /v1/runs/:runId/events?since=seq and resume from its last seen sequence
 * number instead of losing everything emitted after the drop.
 *
 * Wire frames are stored POST-branding as complete `data: {...}\n\n` strings
 * so replay is byte-identical to what the original connection delivered and
 * the endpoint can write them without re-serializing.
 *
 * All functions fail open: a Redis outage degrades to no-replay (the live
 * stream itself is unaffected) — never to a failed request.
 */

import type { ChatResponse } from '@/types';
import { getRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';

const log = logger.child({ component: 'stream-event-buffer' });

/** Eva-parity retention: long enough to survive a mid-generation reconnect,
 * short enough that abandoned buffers self-clean. */
export const STREAM_EVENT_TTL_SECONDS = 15 * 60;

/** Upper bound per run — a long collective run emits ~10³ frames, not 10⁴;
 * the cap exists so a pathological producer can't grow the list unbounded. */
export const MAX_EVENTS_PER_RUN = 2000;

function keyFor(runId: string): string {
  return `stream:${runId}`;
}

/**
 * CI-CHAT-0003 — additive correlation envelope on a streamed chunk.
 * Adds fields, never renames: consumers that ignore `ailin_metadata` are
 * unaffected; consumers that read specific types are unaffected (these are
 * extra keys on the same union variants).
 */
export function annotateStreamChunk(
  chunk: ChatResponse,
  runId: string,
  seq: number
): ChatResponse {
  const meta = {
    ...((chunk.ailin_metadata ?? {}) as Record<string, unknown>),
    run_id: runId,
    seq,
    ts: new Date().toISOString(),
  };
  return { ...chunk, ailin_metadata: narrowAs<ChatResponse['ailin_metadata']>(meta) };
}

/** Buffer one wire frame (`data: {...}\n\n`). Fire-and-forget safe. */
export async function bufferStreamEvent(runId: string, seq: number, wireFrame: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = keyFor(runId);
    await redis
      .pipeline()
      .rpush(key, wireFrame)
      .ltrim(key, -MAX_EVENTS_PER_RUN, -1)
      .expire(key, STREAM_EVENT_TTL_SECONDS)
      .exec();
  } catch (err) {
    log.warn(
      { err, runId, seq },
      'stream-event-buffer: redis write failed; replay for this run will be partial (fail-open)'
    );
  }
}

/**
 * Wire frames with `ailin_metadata.seq > sinceSeq`, in emission order.
 * Returns [] (never throws) when the run is unknown/expired or Redis is down.
 */
export async function readStreamEvents(runId: string, sinceSeq: number): Promise<string[]> {
  try {
    const redis = getRedisClient();
    const raw = await redis.lrange(keyFor(runId), 0, -1);
    return raw.filter((wire) => {
      try {
        const payload = JSON.parse(wire.replace(/^data: /, '').trim()) as {
          ailin_metadata?: { seq?: unknown };
        };
        const seq = payload?.ailin_metadata?.seq;
        return typeof seq === 'number' && seq > sinceSeq;
      } catch {
        return false;
      }
    });
  } catch (err) {
    log.warn({ err, runId }, 'stream-event-buffer: redis read failed; replay unavailable (fail-open)');
    return [];
  }
}
