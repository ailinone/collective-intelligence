// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-1 diagnostic probe — behavioral contract.
 *
 * Mirrors `function-calling-probe.test.ts`'s hermeticity discipline: no real
 * Redis/DB/provider calls. `recordProbeAssertions` (probe-emitter.ts) is
 * mocked so these tests pin the PROBE's decisions (what gets classified,
 * what gets persisted, how streaming/liveness/budget are handled) without
 * depending on the assertion writer's own behavior (that module has its own
 * tests).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ChatResponse } from '@/types';

const recordProbeAssertions = vi.fn().mockResolvedValue('written');
vi.mock('@/capability/assertions/probe-emitter', () => ({
  recordProbeAssertions: (...args: unknown[]) => recordProbeAssertions(...args),
}));

const {
  runTier1DiagnosticProbe,
  resetTier1ProbeForTesting,
  getTier1ProbeStats,
} = await import('../tier1-diagnostic-probe');

function chunk(content: string): ChatResponse {
  return {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

/** A fake adapter whose `chatCompletionStream` yields the given chunks. */
function fakeStreamingAdapter(chunks: string[]): ProviderAdapter & { streamCalls: number } {
  const adapter = {
    streamCalls: 0,
    getName: () => 'probe-test',
    async *chatCompletionStream() {
      adapter.streamCalls++;
      for (const c of chunks) {
        yield chunk(c);
      }
    },
  };
  return adapter as unknown as ProviderAdapter & { streamCalls: number };
}

function fakeThrowingAdapter(message: string): ProviderAdapter {
  return {
    getName: () => 'probe-test',
    // eslint-disable-next-line require-yield
    async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> {
      throw new Error(message);
    },
  } as unknown as ProviderAdapter;
}

const GOOD_RESPONSE_SINGLE_CHUNK = `
### Step 1: Reasoning
1. First.
2. Second.
Answer: 4 hours.

### Step 2: Analysis
| Option | Best for | Weakness |
| --- | --- | --- |
| A | X | Y |

### Step 3: Code
\`\`\`python
def f(): return 1
\`\`\`

### Step 4: JSON summary
\`\`\`json
{"topic": "t", "difficulty": "low", "steps_used": 1}
\`\`\`

### Step 5: Translation
Translation: Il fait beau.

### Step 6: Refactor
Before:
\`\`\`python
x = 1
\`\`\`
After:
\`\`\`python
x = 1
\`\`\`

CONFIDENCE: high
`;

describe('Tier-1 diagnostic probe', () => {
  beforeEach(() => {
    resetTier1ProbeForTesting();
    recordProbeAssertions.mockClear();
  });

  it('confirms every structurally-confirmable capability from a single-chunk response and persists them', async () => {
    const adapter = fakeStreamingAdapter([GOOD_RESPONSE_SINGLE_CHUNK]);
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-a');

    expect(outcome.status).toBe('confirmed');
    expect(outcome.capabilitiesConfirmed).toEqual(
      expect.arrayContaining(['chat', 'reasoning', 'analysis', 'code_generation', 'json_mode', 'refactoring'])
    );
    // Single chunk → no transport evidence of real streaming.
    expect(outcome.capabilitiesConfirmed).not.toContain('streaming');
    // Translation is structurally ambiguous with no judge configured →
    // left unresolved, never guessed into a false positive.
    expect(outcome.capabilitiesAmbiguousUnresolved).toContain('translation');
    expect(outcome.capabilitiesConfirmed).not.toContain('translation');

    expect(recordProbeAssertions).toHaveBeenCalledTimes(1);
    const call = recordProbeAssertions.mock.calls[0][0];
    expect(call.providerId).toBe('probe-test');
    expect(call.modelId).toBe('model-a');
    expect(call.origin).toBe('tier1-diagnostic-probe@v1');
    expect(call.signals.map((s: { capability: string }) => s.capability)).toEqual(
      expect.arrayContaining(['chat', 'reasoning', 'analysis', 'code_generation', 'json_mode', 'refactoring'])
    );
  });

  it('confirms streaming when the response arrives across 2+ real chunks', async () => {
    const adapter = fakeStreamingAdapter([
      GOOD_RESPONSE_SINGLE_CHUNK.slice(0, 50),
      GOOD_RESPONSE_SINGLE_CHUNK.slice(50),
    ]);
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-b');

    expect(outcome.status).toBe('confirmed');
    expect(outcome.streamingChunkCount).toBe(2);
    expect(outcome.capabilitiesConfirmed).toContain('streaming');
  });

  it('confirms nothing for a response that demonstrates none of the eight capabilities — a valid, non-error outcome', async () => {
    const adapter = fakeStreamingAdapter(['sorry, I cannot help with that.']);
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-c');

    expect(outcome.status).toBe('confirmed');
    expect(outcome.capabilitiesConfirmed).toEqual([]);
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('classifies a billing/auth/timeout failure as provider-dead, not a capability verdict, and persists nothing', async () => {
    const adapter = fakeThrowingAdapter('HTTP 402 insufficient credits');
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-d');

    expect(outcome.status).toBe('provider-dead');
    expect(outcome.capabilitiesConfirmed).toEqual([]);
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('classifies an unrecognized failure as inconclusive', async () => {
    const adapter = fakeThrowingAdapter('some unexpected error shape');
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-e');

    expect(outcome.status).toBe('inconclusive');
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('resolves an ambiguous verdict via an injected judge client when enabled', async () => {
    const adapter = fakeStreamingAdapter([GOOD_RESPONSE_SINGLE_CHUNK]);
    const judgeClient = { judgeAmbiguousCapability: vi.fn().mockResolvedValue('confirmed') };

    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-f', {
      enabled: true,
      client: judgeClient,
    });

    expect(judgeClient.judgeAmbiguousCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'translation' })
    );
    expect(outcome.capabilitiesConfirmed).toContain('translation');
    expect(outcome.capabilitiesAmbiguousUnresolved).not.toContain('translation');
  });

  it('leaves an ambiguous verdict unresolved (never guesses) when the judge is enabled but rejects it', async () => {
    const adapter = fakeStreamingAdapter([GOOD_RESPONSE_SINGLE_CHUNK]);
    const judgeClient = { judgeAmbiguousCapability: vi.fn().mockResolvedValue('rejected') };

    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-g', {
      enabled: true,
      client: judgeClient,
    });

    expect(outcome.capabilitiesConfirmed).not.toContain('translation');
    expect(outcome.capabilitiesAmbiguousUnresolved).toContain('translation');
  });

  it('leaves ambiguous verdicts unresolved when no judge client is configured (safe default)', async () => {
    const adapter = fakeStreamingAdapter([GOOD_RESPONSE_SINGLE_CHUNK]);
    const outcome = await runTier1DiagnosticProbe(adapter, 'probe-test', 'model-h', {
      enabled: true,
      client: undefined,
    });

    expect(outcome.capabilitiesConfirmed).not.toContain('translation');
    expect(outcome.capabilitiesAmbiguousUnresolved).toContain('translation');
  });

  it('enforces the per-process probe budget', async () => {
    // The budget cap is read from process.env at MODULE LOAD time (mirrors
    // function-calling-probe.ts's own MAX_PROBES_PER_PROCESS), so exercising
    // a non-default value needs a fresh module instance loaded AFTER the env
    // var is set — vi.resetModules() + re-import, not just mutating
    // process.env against the already-imported module from the top of this
    // file.
    vi.resetModules();
    process.env.TIER1_PROBE_MAX_PROBES = '1';
    try {
      const fresh = await import('../tier1-diagnostic-probe');
      const adapter = fakeStreamingAdapter([GOOD_RESPONSE_SINGLE_CHUNK]);
      const first = await fresh.runTier1DiagnosticProbe(adapter, 'probe-test', 'model-i');
      const second = await fresh.runTier1DiagnosticProbe(adapter, 'probe-test', 'model-j');

      expect(first.status).toBe('confirmed');
      expect(second.status).toBe('budget-exhausted');
      expect(fresh.getTier1ProbeStats().started).toBe(1);
    } finally {
      delete process.env.TIER1_PROBE_MAX_PROBES;
      vi.resetModules();
    }
  });
});
