// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Gap 1 regression lock (2026-09): the non-streaming execute() path used to
 * wire a real Observer feed onto `context` ONLY inside its `else` branch
 * (this.config.enableFeedbackLoop === false). The `if (confidenceGateEnabled)`
 * branch — the DEFAULT production path, since ORCHESTRATION_ENABLE_FEEDBACK_LOOP
 * defaults to `!== 'false'` (index.ts) — never wired anything, so every
 * `emitObserverEvent()` call inside a strategy executed via that branch
 * silently hit BaseStrategy's built-in no-op feed. stream:false collective
 * requests under the default production config NEVER got real narration.
 *
 * The fix hoists a single `wireObserverFeed()` call ABOVE the
 * confidenceGateEnabled/else split so both branches share one real feed —
 * this file locks BOTH halves of that fix:
 *  (a) wireObserverFeed() itself actually produces a real (non-no-op) feed
 *      under default production config, and a no-op one when disabled.
 *  (b) the source no longer has the wiring living INSIDE either branch —
 *      there is exactly one call site, positioned before the split — so the
 *      bug (wiring living only in one branch) cannot silently return.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OrchestrationEngine } from '../orchestration-engine';
import { ObserverService, __resetObserverBackendCacheForTests } from '../observer/observer-service';
import type { ObserverFeed } from '../observer/observer-types';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, OrchestrationContext } from '@/types';

type FakeStrategyMetadata = {
  id: string;
  name: 'consensus';
  displayName: string;
  description: string;
  minModels: number;
  maxModels: number;
  estimatedCostMultiplier: number;
  estimatedQualityBoost: number;
  estimatedDurationMultiplier: number;
  suitableFor: never[];
};

type FakeStrategy = { getMetadata(): FakeStrategyMetadata };

type EngineInternals = {
  wireObserverFeed(
    request: ChatRequest,
    context: OrchestrationContext,
    strategy: FakeStrategy
  ): ObserverFeed;
};

function makeEngine(): EngineInternals {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as ProviderRegistry,
    defaultStrategy: 'auto',
    enableAutoSelection: true,
  }) as unknown as EngineInternals;
}

function makeStrategy(): FakeStrategy {
  return {
    getMetadata: () => ({
      id: 'consensus',
      name: 'consensus',
      displayName: 'Consensus Building',
      description: 'Multiple models vote on best approach.',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 3.5,
      estimatedQualityBoost: 0.25,
      estimatedDurationMultiplier: 1.3,
      suitableFor: [],
    }),
  };
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Explique consenso distribuído.' }],
    ...overrides,
  } as unknown as ChatRequest;
}

function makeContext(): OrchestrationContext {
  return {
    requestId: 'gap1-test',
    taskType: 'analysis',
    contextSize: 1000,
    models: [],
  } as unknown as OrchestrationContext;
}

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = readFileSync(join(__dirnameLocal, '..', 'orchestration-engine.ts'), 'utf8');

describe('Gap 1 fix — wireObserverFeed (non-streaming execute() path)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetObserverBackendCacheForTests();
    delete process.env.OBSERVER_DEFAULT_ENABLED;
    // Stub fetch so the background backend probe never touches the real
    // network — we assert on the SYNCHRONOUS behavior only and never await
    // this, but an unstubbed real fetch would leave a dangling network call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response)
    );
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('(a) wires a REAL (non-no-op) observer feed under default production config', () => {
    const engine = makeEngine();
    const context = makeContext();
    const request = makeRequest();

    const feed = engine.wireObserverFeed(request, context, makeStrategy());

    // The regression this pins: previously this whole method didn't exist in
    // the confidence-gate branch, so `context.observerFeed` stayed undefined
    // and every strategy call fell through to BaseStrategy's no-op fallback.
    expect(feed).toBeInstanceOf(ObserverService);
    expect(feed.isActive()).toBe(true);
    // Wired onto context — the same mechanism BaseStrategy.getObserverFeed()
    // reads from at runtime.
    expect((context as { observerFeed?: ObserverFeed }).observerFeed).toBe(feed);
  });

  it('(b) the zero-latency opening narration is already queued SYNCHRONOUSLY — no await needed', () => {
    const engine = makeEngine();
    const context = makeContext();
    const request = makeRequest();

    const t0 = Date.now();
    const feed = engine.wireObserverFeed(request, context, makeStrategy());
    const elapsedMs = Date.now() - t0;
    const narrations = feed.getNarrations(); // read with NO await in between

    expect(elapsedMs).toBeLessThan(50); // nowhere near the LLM narrator's multi-second floor
    expect(narrations).toHaveLength(1);
    expect(narrations[0].durationMs).toBe(0);
    expect(narrations[0].narration).toContain('Consensus Building');
  });

  it('honors enable_observer:false (per-request opt-out) — returns a no-op feed', () => {
    const engine = makeEngine();
    const context = makeContext();
    const request = makeRequest({ ailin_constraints: { enable_observer: false } } as Partial<ChatRequest>);

    const feed = engine.wireObserverFeed(request, context, makeStrategy());

    expect(feed).not.toBeInstanceOf(ObserverService);
    expect(feed.isActive()).toBe(false);
    expect(feed.getNarrations()).toHaveLength(0);
  });

  it('honors OBSERVER_DEFAULT_ENABLED=false (global kill-switch) — returns a no-op feed', () => {
    process.env.OBSERVER_DEFAULT_ENABLED = 'false';
    const engine = makeEngine();
    const context = makeContext();
    const request = makeRequest();

    const feed = engine.wireObserverFeed(request, context, makeStrategy());

    expect(feed).not.toBeInstanceOf(ObserverService);
    expect(feed.isActive()).toBe(false);
  });
});

describe('Gap 1 fix — structural pin (wiring hoisted above the branch split)', () => {
  it('wireObserverFeed() is defined exactly once and INVOKED exactly once in orchestration-engine.ts', () => {
    const defCount = (ENGINE_SOURCE.match(/private wireObserverFeed\(/g) ?? []).length;
    // Match the actual invocation statement, not prose mentions of the method
    // name in doc comments (this file's own JSDoc references
    // `this.wireObserverFeed()` twice in prose — a bare `/this\.wireObserverFeed\(/`
    // regex would double-count those and mask a real regression).
    const callCount = (
      ENGINE_SOURCE.match(/const observerFeed = this\.wireObserverFeed\(/g) ?? []
    ).length;
    expect(defCount).toBe(1);
    // Exactly ONE call site: if a future change duplicated the call back into
    // both the confidenceGateEnabled branch AND the else branch, this fails —
    // that duplication is exactly the shape of bug this fix eliminates.
    expect(callCount).toBe(1);
  });

  it('the single wireObserverFeed() call sits BEFORE the confidenceGateEnabled branch split, not inside it', () => {
    const callIdx = ENGINE_SOURCE.indexOf('const observerFeed = this.wireObserverFeed(');
    // Match the real branch statement (opening brace directly followed by a
    // line break, tolerating \r\n) — NOT this file's own doc-comment prose a
    // few lines above the real method, which spells the same words but as
    // `{...} else {...}` (no line break right after the brace) and would
    // otherwise be found first.
    const branchMatch = /if \(confidenceGateEnabled\) \{\r?\n/.exec(ENGINE_SOURCE);
    expect(callIdx).toBeGreaterThan(-1);
    expect(branchMatch).not.toBeNull();
    const branchIdx = branchMatch ? branchMatch.index : -1;
    expect(callIdx).toBeLessThan(branchIdx);
  });

  it('the non-streaming execute() path instantiates ObserverService in exactly one place (no per-branch duplication)', () => {
    // Two legitimate sites remain in the whole file: this shared non-streaming
    // helper, and executeStream()'s own separate streaming-path wiring (which
    // has different downstream behavior — interleaving/inline promotion — and
    // is intentionally not unified with this one). Three or more would mean a
    // branch grew its own copy again.
    const count = (ENGINE_SOURCE.match(/new ObserverService\(/g) ?? []).length;
    expect(count).toBe(2);
  });
});
