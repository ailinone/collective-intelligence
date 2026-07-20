// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import { computeDynamicFirstChunkTimeoutMs } from '@/routes/chat/streaming-first-chunk-timeout';

const STATIC_MS = 6000;
const FALLBACK_MS = 1800;

describe('computeDynamicFirstChunkTimeoutMs', () => {
  it('shortens the timeout when a hot candidate exists later in the queue', () => {
    const candidates = ['unknown', 'hot', 'unknown'];
    const ranks = new Map([
      ['unknown', 1],
      ['hot', 3],
    ]);
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 0, ranks, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(FALLBACK_MS);
  });

  it('keeps the static timeout when the current candidate is itself hot', () => {
    const candidates = ['hot', 'unknown'];
    const ranks = new Map([
      ['hot', 3],
      ['unknown', 1],
    ]);
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 0, ranks, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(STATIC_MS);
  });

  it('keeps the static timeout when no hot candidate exists anywhere in the queue (no safety net)', () => {
    const candidates = ['unknown', 'operable', 'proven-bad'];
    const ranks = new Map([
      ['unknown', 1],
      ['operable', 2],
      ['proven-bad', 0],
    ]);
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 0, ranks, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(STATIC_MS);
  });

  it('keeps the static timeout when a hot candidate exists but only BEFORE the current index', () => {
    const candidates = ['hot', 'unknown'];
    const ranks = new Map([
      ['hot', 3],
      ['unknown', 1],
    ]);
    // Index 1 = 'unknown'; the only hot candidate is behind it, not ahead.
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 1, ranks, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(STATIC_MS);
  });

  it('falls back to the static timeout when rank data is unavailable (reorder failed)', () => {
    const candidates = ['a', 'b'];
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 0, null, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(STATIC_MS);
  });

  it('treats a candidate missing from the rank map as unknown (rank 1), not hot', () => {
    const candidates = ['untracked', 'hot'];
    const ranks = new Map([['hot', 3]]);
    const result = computeDynamicFirstChunkTimeoutMs(candidates, 0, ranks, STATIC_MS, FALLBACK_MS);
    expect(result).toBe(FALLBACK_MS);
  });
});
