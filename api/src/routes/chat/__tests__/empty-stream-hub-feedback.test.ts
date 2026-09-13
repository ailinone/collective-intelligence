// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Empty-stream hub-feedback guard (2026-09-06 production incident).
 *
 * Root cause: `chat-routes.ts`'s single-model SSE streaming loop recorded a
 * hub SUCCESS for ANY provider stream that completed without throwing —
 * even one that delivered zero content and no tool call. `isRouteHot()`
 * (provider-operability-hub.ts) only compares `lastSuccessAt` to
 * `lastFailureAt`, so that false success kept a degenerate route "hot",
 * and the hot-first candidate reorder in this same file put the SAME
 * broken route back at the front of the fallback chain for every
 * subsequent `model=auto` request.
 *
 * Reproduced live: a route that streamed exactly 2 chunks with no visible
 * content "succeeded" once, then won attempt #1 again for the user's next
 * four requests in a row (a retry of the same plain-text question, then two
 * unrelated image/video-generation prompts) — each one surfacing the same
 * empty/garbled output, because nothing ever told the hub the route was bad.
 *
 * Two layers are pinned here:
 *   1. `hasMeaningfulStreamedOutput` (the extracted pure predicate) — direct
 *      unit tests over the exact signals the streaming loop accumulates.
 *   2. A source-wiring check (matching this file's established convention,
 *      see streaming-function-calling-chain-wiring.test.ts) that the
 *      predicate actually gates the `recordRouteExecution` call, so a
 *      future refactor cannot silently go back to unconditional `true`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasMeaningfulStreamedOutput } from '../chat-routes';

describe('hasMeaningfulStreamedOutput (pure predicate)', () => {
  it('is false for a stream with no content and no tool calls (the incident shape)', () => {
    expect(hasMeaningfulStreamedOutput(0, false)).toBe(false);
  });

  it('is true when any content was accumulated', () => {
    expect(hasMeaningfulStreamedOutput(1, false)).toBe(true);
    expect(hasMeaningfulStreamedOutput('Step'.length, false)).toBe(true);
  });

  it('is true when a tool call was delivered even with zero content', () => {
    // A well-formed tool-only completion legitimately has empty `content`
    // (see the client-tool-call-passthrough contract) — must not be
    // penalized as "empty" just because no prose was streamed.
    expect(hasMeaningfulStreamedOutput(0, true)).toBe(true);
  });

  it('is true when both content and tool calls are present', () => {
    expect(hasMeaningfulStreamedOutput(42, true)).toBe(true);
  });
});

describe('empty-stream hub-feedback wiring contract (chat-routes.ts)', () => {
  const routesSource = readFileSync(join(__dirname, '..', 'chat-routes.ts'), 'utf8');

  it('accumulates content length and tool-call presence across every streamed chunk', () => {
    expect(routesSource).toMatch(/let totalContentLength = 0;/);
    expect(routesSource).toMatch(/let sawToolCalls = false;/);
    expect(routesSource).toMatch(
      /for \(const streamedChoice of chunk\.choices \?\? \[\]\)/
    );
  });

  it('gates the post-stream recordRouteExecution call on hasMeaningfulStreamedOutput, not a hardcoded true', () => {
    expect(routesSource).toMatch(
      /const hadMeaningfulOutput = hasMeaningfulStreamedOutput\(totalContentLength, sawToolCalls\);/
    );
    // The old unconditional-success call must be gone, not just shadowed —
    // recordRouteExecution's third argument now has to be the computed
    // variable, never the literal `true`.
    expect(routesSource).not.toMatch(
      /getProviderOperabilityHub\(\)\.recordRouteExecution\(\s*candidate\.adapter\.getName\(\),\s*candidate\.model\.id,\s*true\s*\)/
    );
    expect(routesSource).toMatch(
      /getProviderOperabilityHub\(\)\.recordRouteExecution\(\s*candidate\.adapter\.getName\(\),\s*candidate\.model\.id,\s*hadMeaningfulOutput,/
    );
  });

  it('records a diagnosable failure reason instead of silently degrading', () => {
    expect(routesSource).toMatch(/empty streaming output \(no content, no tool calls\)/);
    expect(routesSource).toMatch(
      /Streaming completed with no content and no tool calls — recording as a hub failure/
    );
  });
});
