// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Where the outbound normalizer is NOT installed, and why.
 *
 * `/v1/extended-thinking` and `/v1/ultra-thinking` are the one part of this
 * gateway where a <thinking> block is the product, not a leak: their system
 * prompt MANDATES the tags and the route parses them back off
 * `result.finalResponse` to build `thinkingBlocks` and `thinking_tokens`.
 *
 * `REASONING_TAGS` includes 'thinking', and the strip is leading-anchored — which
 * is exactly the shape those responses have. So installing the normalizer on
 * `OrchestrationEngine.execute()` (the tempting single choke point, since it is
 * the common ancestor of every buffered path) would silently empty both
 * endpoints: no error, no failed test, just `thinkingBlocks: []` forever.
 *
 * The normalizer is therefore installed at the four OpenAI-shaped boundaries
 * instead. This test pins that decision in place, because the next person to see
 * four call sites doing the same thing will reasonably want to hoist them into
 * the shared ancestor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const CALL = /normalizeOutboundResponse\s*\(/;

describe('outbound normalizer placement', () => {
  it.each([
    ['services/chat-request-processor.ts'],
    ['routes/responses/responses-routes.ts'],
    ['workers/thread-run-worker.ts'],
    ['services/capability-execution-service.ts'],
  ])('is installed at the OpenAI-shaped boundary %s', (rel) => {
    expect(CALL.test(read(rel)), `${rel} should call normalizeOutboundResponse`).toBe(true);
  });

  it.each([
    ['core/orchestration/orchestration-engine.ts'],
    ['routes/extended-thinking/extended-thinking-routes.ts'],
  ])(
    'is NOT installed at %s — it would strip the <thinking> blocks that are the product',
    (rel) => {
      expect(
        CALL.test(read(rel)),
        `${rel} must NOT call normalizeOutboundResponse: extended-thinking mandates <thinking> ` +
          `tags in its system prompt and parses them off finalResponse. Hooking here empties ` +
          `thinkingBlocks silently. Hook the four OpenAI-shaped boundaries instead.`
      ).toBe(false);
    }
  );

  it('still treats <thinking> as strippable everywhere it IS installed', async () => {
    // Guards the other half: the exclusion above is load-bearing precisely
    // because 'thinking' is in the strip set. If someone removed it from
    // REASONING_TAGS, the exclusion would look like dead paranoia.
    const { REASONING_TAGS, stripLeakedReasoning } =
      await import('@/utils/outbound-content-normalizer');
    expect(REASONING_TAGS).toContain('thinking');
    expect(stripLeakedReasoning('<thinking>trace</thinking>391').text).toBe('391');
  });
});
