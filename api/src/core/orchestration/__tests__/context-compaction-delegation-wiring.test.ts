// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Long-context delegation wiring (2026-09-08 follow-up to LOTE AW).
 *
 * Audit finding: `pickDelegationModel()` (context-compaction-service.ts) was
 * fully implemented and unit-tested (context-compaction-service.test.ts —
 * "prefers a same-provider sibling with enough room", "falls back to any
 * operational model...", "returns null when nothing has enough room", "never
 * picks the current model itself") but never actually CALLED from
 * production code. Confirmed dead code: `git grep pickDelegationModel`
 * before this change returned only its own definition and its own unit
 * test.
 *
 * This wires it into `OrchestrationEngine.applyLongContextHandling()`
 * (extracted from buildContext()'s session-affinity-pin-reuse branch — the
 * REAL place client-side compaction already fires today, immediately after
 * a session-affinity cache hit re-validates a pinned model against its real
 * `contextWindow`). Per `pickDelegationModel`'s own doc comment, delegation
 * is the SECONDARY option: compaction (summarize everything older than the
 * kept-verbatim tail via a cheap model) runs first; delegation to a
 * larger-context sibling only fires when the request still doesn't fit the
 * pinned model even after that best-effort attempt.
 *
 * These tests exercise the REAL `ContextCompactionService` AND the REAL
 * `pickDelegationModel` together, invoked exactly as `buildContext()` invokes
 * them (only `providerRegistry.findModel` is faked) — proving the actual
 * wiring, not re-testing either unit in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationEngine } from '../orchestration-engine';
import * as contextCompactionService from '../context-compaction-service';
import { __resetContextCompactionServiceForTests } from '../context-compaction-service';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ProviderRegistry } from '@/providers/provider-registry';

const adapter = { getName: () => 'fake-adapter' } as unknown as ProviderAdapter;

function model(overrides: {
  id: string;
  provider: string;
  contextWindow: number;
  quality?: number;
  balanceStatus?: Model['balanceStatus'];
}): Model {
  return {
    id: overrides.id,
    name: overrides.id,
    provider: overrides.provider,
    contextWindow: overrides.contextWindow,
    performance: { quality: overrides.quality ?? 0.5 },
    balanceStatus: overrides.balanceStatus,
  } as Model;
}

/** Real char count, not a placeholder — sized so the post-compaction
 *  kept-verbatim tail (default keepTurns=6) alone reliably still exceeds a
 *  deliberately tiny pinned model's contextWindow, no matter what the
 *  (heuristic, since no triageService is wired here) summarizer produces
 *  for the older, folded turns. */
function bigTurn(role: 'user' | 'assistant', n: number): { role: 'user' | 'assistant'; content: string } {
  return { role, content: `turn-${n}-${'x'.repeat(2000)}` };
}

function smallTurn(role: 'user' | 'assistant', n: number): { role: 'user' | 'assistant'; content: string } {
  return { role, content: `turn-${n}` };
}

function requestWithTurns(
  turnCount: number,
  makeTurn: (role: 'user' | 'assistant', n: number) => { role: 'user' | 'assistant'; content: string }
): ChatRequest {
  const messages: ChatRequest['messages'] = [{ role: 'system', content: 'be helpful' }];
  for (let i = 0; i < turnCount; i++) {
    messages.push(makeTurn(i % 2 === 0 ? 'user' : 'assistant', i));
  }
  return { messages, stream: false };
}

function makeEngine(models: Model[]): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => models,
      findModel: async (modelId: string, preferredProvider?: string) => {
        const found = preferredProvider
          ? models.find((m) => m.id === modelId && m.provider === preferredProvider)
          : models.find((m) => m.id === modelId);
        return found ? { model: found, adapter } : null;
      },
      findModelByName: async () => null,
      getProviderNames: () => Array.from(new Set(models.map((m) => m.provider))),
    } as unknown as ProviderRegistry,
    enableTriaging: false,
  });
}

type ApplyLongContextHandlingParams = {
  request: ChatRequest;
  context: OrchestrationContext;
  resolved: { model: Model; adapter: ProviderAdapter };
  contextSize: number;
  pool: Model[];
  requestId: string;
  organizationId: string;
};
type ApplyLongContextHandling = (params: ApplyLongContextHandlingParams) => Promise<number>;

function callApplyLongContextHandling(
  engine: OrchestrationEngine,
  params: ApplyLongContextHandlingParams
): Promise<number> {
  return (
    engine as unknown as { applyLongContextHandling: ApplyLongContextHandling }
  ).applyLongContextHandling(params);
}

describe('OrchestrationEngine long-context delegation wiring', () => {
  let pickDelegationModelSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The compaction service is a process-wide singleton that only honors
    // the summarizer passed on its FIRST construction — reset it so each
    // test gets a fresh instance built with THIS test's engine (no
    // triageService wired here, so the heuristic bounded-truncation
    // fallback is used — deterministic, no network/LLM call).
    __resetContextCompactionServiceForTests();
    pickDelegationModelSpy = vi.spyOn(contextCompactionService, 'pickDelegationModel');
  });

  afterEach(() => {
    pickDelegationModelSpy.mockRestore();
    delete process.env.CONTEXT_COMPACTION_KEEP_TURNS;
  });

  it('delegates to a larger-context, same-provider sibling when compaction alone still does not fit the pinned model', async () => {
    const pinned = model({ id: 'pinned-small', provider: 'acme', contextWindow: 2_000 });
    const sameProviderBig = model({
      id: 'big-same',
      provider: 'acme',
      contextWindow: 200_000,
      quality: 0.9,
    });
    const otherProviderBig = model({
      id: 'big-other',
      provider: 'other',
      contextWindow: 300_000,
      quality: 0.99,
    });
    const pool = [pinned, sameProviderBig, otherProviderBig];

    const engine = makeEngine(pool);
    const request = requestWithTurns(12, bigTurn); // well over the default keepTurns=6
    const context = {
      requestId: 'r1',
      organizationId: 'org1',
    } as unknown as OrchestrationContext;

    const finalContextSize = await callApplyLongContextHandling(engine, {
      request,
      context,
      resolved: { model: pinned, adapter },
      contextSize: 999_999, // stale/high estimate that unconditionally clears the 0.75 shouldCompact gate
      pool,
      requestId: 'r1',
      organizationId: 'org1',
    });

    // Compaction (the PRIMARY mechanism) actually ran: 12 turns collapsed
    // down to system + summary + the 6-message kept-verbatim tail.
    expect(request.messages.length).toBe(8);
    expect(request.messages.some((m) => (m as { isCompactionSummary?: boolean }).isCompactionSummary)).toBe(
      true
    );

    // The REAL pickDelegationModel was actually invoked — proves the wiring
    // itself, not just its eventual outcome.
    expect(pickDelegationModelSpy).toHaveBeenCalledTimes(1);
    expect(pickDelegationModelSpy).toHaveBeenCalledWith(
      [pinned, sameProviderBig, otherProviderBig],
      pinned,
      expect.any(Number)
    );

    // ...and its result was actually USED: the context now points at the
    // delegated same-provider sibling, not the original pinned model.
    expect(context.precomputedModelSelection?.model.id).toBe('big-same');
    expect(context.preferredModelIds).toEqual(['big-same']);

    // The recomputed size is real (post-compaction), and it's still bigger
    // than the ORIGINAL pin's window — exactly why delegation had to fire.
    expect(finalContextSize).toBeGreaterThan(pinned.contextWindow);
  });

  it('does NOT delegate when compaction alone already makes the request fit the pinned model', async () => {
    const pinned = model({ id: 'pinned-roomy', provider: 'acme', contextWindow: 1_000 });
    const sameProviderBig = model({ id: 'big-same', provider: 'acme', contextWindow: 200_000 });
    const pool = [pinned, sameProviderBig];

    const engine = makeEngine(pool);
    // Small turns: post-compaction, tail + summary + system easily fit
    // inside a 1,000-token window.
    const request = requestWithTurns(10, smallTurn);
    const context = {
      requestId: 'r2',
      organizationId: 'org1',
    } as unknown as OrchestrationContext;

    await callApplyLongContextHandling(engine, {
      request,
      context,
      resolved: { model: pinned, adapter },
      // Deliberately stale/high estimate so shouldCompact's 0.75 gate still
      // trips (this only controls entry into the compaction attempt — the
      // decision to delegate is driven by the REAL recomputed size below).
      contextSize: 800,
      pool,
      requestId: 'r2',
      organizationId: 'org1',
    });

    expect(pickDelegationModelSpy).not.toHaveBeenCalled();
    // No delegation means the original resolved selection is left alone by
    // this method (the caller — buildContext() — already set it before
    // calling in).
    expect(context.precomputedModelSelection).toBeUndefined();
  });

  it('skips a larger sibling with no credits, delegating to the next-best usable candidate', async () => {
    const pinned = model({ id: 'pinned-small', provider: 'acme', contextWindow: 2_000 });
    const noCreditGiant = model({
      id: 'giant-no-credits',
      provider: 'acme',
      contextWindow: 1_000_000,
      quality: 0.99,
      balanceStatus: 'no-credits',
    });
    const usableSibling = model({
      id: 'big-same-usable',
      provider: 'acme',
      contextWindow: 200_000,
      quality: 0.8,
    });
    const pool = [pinned, noCreditGiant, usableSibling];

    const engine = makeEngine(pool);
    const request = requestWithTurns(12, bigTurn);
    const context = {
      requestId: 'r3',
      organizationId: 'org1',
    } as unknown as OrchestrationContext;

    await callApplyLongContextHandling(engine, {
      request,
      context,
      resolved: { model: pinned, adapter },
      contextSize: 999_999,
      pool,
      requestId: 'r3',
      organizationId: 'org1',
    });

    expect(context.precomputedModelSelection?.model.id).toBe('big-same-usable');
    expect(context.precomputedModelSelection?.model.id).not.toBe('giant-no-credits');
  });

  it('leaves the pinned model in place when nothing in the pool has enough room', async () => {
    const pinned = model({ id: 'pinned-small', provider: 'acme', contextWindow: 2_000 });
    const tooSmallSibling = model({ id: 'also-small', provider: 'acme', contextWindow: 2_500 });
    const pool = [pinned, tooSmallSibling];

    const engine = makeEngine(pool);
    const request = requestWithTurns(12, bigTurn);
    const context = {
      requestId: 'r4',
      organizationId: 'org1',
    } as unknown as OrchestrationContext;

    await callApplyLongContextHandling(engine, {
      request,
      context,
      resolved: { model: pinned, adapter },
      contextSize: 999_999,
      pool,
      requestId: 'r4',
      organizationId: 'org1',
    });

    expect(pickDelegationModelSpy).toHaveBeenCalledTimes(1);
    // pickDelegationModel correctly returned null (nothing fits) — no
    // fabricated selection, request proceeds against the original pin
    // (which will fail closed downstream via the provider's own
    // context-length rejection, classified by single-model-strategy.ts).
    expect(context.precomputedModelSelection).toBeUndefined();
  });
});
