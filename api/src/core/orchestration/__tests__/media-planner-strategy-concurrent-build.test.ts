// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `OrchestrationEngine.getMediaPlannerStrategy()` memoizes the in-flight
 * PROMISE, not just the resolved value (orchestration-engine.ts). The method
 * became `async` when Section C/D wiring added a real `await
 * Promise.all([buildMediaCritics(...), buildDocumentCritics(...)])` inside
 * it, and `getOrchestrationEngine()` returns a process-wide singleton — so
 * two concurrent chat requests can both reach the `if (!this.x)` guard
 * before the first build resolves. Caching only the resolved
 * `MediaPlannerStrategy` left that check-then-set race open: every
 * concurrent caller would pass the guard and independently re-run
 * judge-model resolution and reconstruct every media/pdf service. This file
 * proves the fix — one in-flight build shared across concurrent callers —
 * and that a failed build doesn't poison the singleton forever.
 *
 * `config.mediaPlanner.judgeEnabled` must be true for the awaited
 * `Promise.all([buildMediaCritics(...), buildDocumentCritics(...)])` branch
 * to run at all -- otherwise `buildMediaPlannerStrategy()` never awaits
 * anything and resolves synchronously, which would make this file's whole
 * premise (two concurrent callers racing an in-flight build) impossible to
 * exercise. A sibling file (routes/capabilities/__tests__/media-plan-execute-
 * critics-wiring.test.ts) sets `process.env.MEDIA_PLANNER_JUDGE_ENABLED`
 * before its imports and relies on `@/config`'s module-level `deepFreeze`
 * capturing that value -- that only works under whatever transform/isolation
 * that file's vitest config gives it. Under vitest.orchestration.config.ts
 * (which owns this directory), `@/config` is empirically still evaluated
 * before this file's own top-level statements run (verified directly: a
 * `console.log(config.mediaPlanner.judgeEnabled)` right after setting the
 * env var here printed `false`), so the env-var-before-import trick does not
 * transfer. Mock `@/config` directly instead -- immune to import/evaluation
 * ordering by construction, since vi.mock() factories are what vitest's
 * module loader consults instead of ever evaluating the real module body.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { MediaPlannerStrategy } from '@/core/orchestration/strategies/media-planner-strategy';
import type { ProviderRegistry } from '@/providers/provider-registry';

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      mediaPlanner: { ...actual.config.mediaPlanner, judgeEnabled: true },
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let mediaGate = deferred<{
  critics: [];
  qualityJudgingUnavailableReason?: string;
  imageEditJudge?: undefined;
}>();
const buildMediaCriticsMock = vi.fn(() => mediaGate.promise);
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));

let documentGate = deferred<{ critics: [] }>();
const buildDocumentCriticsMock = vi.fn(() => documentGate.promise);
vi.mock('@/core/orchestration/strategies/document-critics-factory', () => ({
  buildDocumentCritics: (...args: unknown[]) => buildDocumentCriticsMock(...args),
}));

function makeEngine(): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as unknown as ProviderRegistry,
    enableTriaging: false,
  });
}

function getStrategy(engine: OrchestrationEngine): Promise<MediaPlannerStrategy> {
  return (
    engine as unknown as { getMediaPlannerStrategy: () => Promise<MediaPlannerStrategy> }
  ).getMediaPlannerStrategy();
}

describe('OrchestrationEngine.getMediaPlannerStrategy — concurrent build memoization', () => {
  it('shares one in-flight build across concurrent callers instead of racing separate builds', async () => {
    const engine = makeEngine();

    const firstCall = getStrategy(engine);
    const secondCall = getStrategy(engine);

    // Both callers are in flight before either judge factory resolves --
    // exactly the race a check-then-set-across-an-await used to lose.
    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(buildDocumentCriticsMock).toHaveBeenCalledTimes(1);

    mediaGate.resolve({ critics: [], qualityJudgingUnavailableReason: undefined, imageEditJudge: undefined });
    documentGate.resolve({ critics: [] });

    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(MediaPlannerStrategy);
    // Still exactly one build after both callers resolved -- the second
    // caller was served from the shared in-flight promise, not a fresh build.
    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(buildDocumentCriticsMock).toHaveBeenCalledTimes(1);
  });

  it('lets a later call retry after a failed build instead of caching the rejection forever', async () => {
    const engine = makeEngine();
    mediaGate = deferred();
    documentGate = deferred();

    const failingCall = getStrategy(engine);
    mediaGate.reject(new Error('judge catalog unavailable'));
    documentGate.resolve({ critics: [] });
    await expect(failingCall).rejects.toThrow('judge catalog unavailable');

    // A later call must get a FRESH build, not the poisoned rejected promise.
    mediaGate = deferred();
    documentGate = deferred();
    const retryCall = getStrategy(engine);
    mediaGate.resolve({ critics: [], qualityJudgingUnavailableReason: undefined, imageEditJudge: undefined });
    documentGate.resolve({ critics: [] });

    const strategy = await retryCall;
    expect(strategy).toBeInstanceOf(MediaPlannerStrategy);
  });
});
