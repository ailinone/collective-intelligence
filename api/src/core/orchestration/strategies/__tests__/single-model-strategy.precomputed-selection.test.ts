// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SingleModelStrategy.selectBestModel() — precomputedModelSelection reuse.
 *
 * LOTE AW (2026-09) audit finding: `context.precomputedModelSelection`
 * (types/index.ts) was originally built for speculative parallel selection
 * (resolveSpeculativeSingleSelection in orchestration-engine.ts) and is
 * ALSO the exact injection point session affinity's read hook
 * (services/session-affinity-service.ts + buildContext()) uses to reuse a
 * prior turn's pinned model. `selectBestModel()`'s reuse branch
 * (single-model-strategy.ts:~374-387) had ZERO test coverage before this —
 * grepped the whole test tree for `precomputedModelSelection`, zero hits.
 *
 * These tests exercise the REAL `selectBestModel()`/`planStreaming()`
 * implementation (not a scripted override, unlike
 * single-model-strategy-streaming.test.ts, which replaces selectBestModel
 * entirely and so never touches this branch).
 */
import { describe, it, expect, vi } from 'vitest';
import { SingleModelStrategy } from '../single-model-strategy';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

// Proves the reuse branch NEVER reaches DynamicModelSelector: if it did,
// this throws and the test fails loudly instead of silently passing.
vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => {
    throw new Error('selectBestModel should have short-circuited on precomputedModelSelection');
  },
}));

const model = (id: string): Model =>
  ({ id, name: id, provider: 'test-provider', contextWindow: 100_000 }) as Model;

const adapter = { getName: () => 'test-provider' } as unknown as ProviderAdapter;

const req: ChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

/** Exposes the protected selectBestModel() for direct invocation (mirrors
 *  the ScriptedSingleModelStrategy pattern in the streaming test file). */
class TestableSingleModelStrategy extends SingleModelStrategy {
  public callSelectBestModel(
    request: ChatRequest,
    context: OrchestrationContext,
    excludedModelIds?: Set<string>
  ) {
    return this.selectBestModel(request, context, excludedModelIds);
  }
}

describe('SingleModelStrategy.selectBestModel — precomputedModelSelection reuse', () => {
  it('planStreaming() reuses precomputedModelSelection outright, without touching DynamicModelSelector', async () => {
    const pinned = { model: model('pinned-1'), adapter };
    const context = {
      requestId: 'r1',
      models: [],
      precomputedModelSelection: pinned,
    } as unknown as OrchestrationContext;

    const strategy = new SingleModelStrategy();
    const result = await strategy.planStreaming(req, context);

    expect(result).toBe(pinned); // same object reference — no re-resolution
  });

  it('reuse wins even over a DIFFERENT explicit request.model (documents existing precedence)', async () => {
    // Not exercised by session affinity's own read hook (which only ever
    // populates precomputedModelSelection when there is NO explicit user
    // pin — see buildContext()'s doc comment), but this is the real,
    // pre-existing precedence in selectBestModel(): the precomputed-
    // selection check runs BEFORE the user-specified-model branch.
    const pinned = { model: model('pinned-1'), adapter };
    const context = {
      requestId: 'r1',
      models: [model('other-explicit-model')],
      precomputedModelSelection: pinned,
    } as unknown as OrchestrationContext;

    const strategy = new TestableSingleModelStrategy();
    const explicitReq: ChatRequest = {
      messages: req.messages,
      model: 'other-explicit-model',
      user_specified_model: true,
    } as ChatRequest;

    const result = await strategy.callSelectBestModel(explicitReq, context, new Set());
    expect(result).toBe(pinned);
  });

  it('does NOT reuse precomputedModelSelection on a retry (excludedModelIds non-empty)', async () => {
    const pinned = { model: model('pinned-1'), adapter };
    const context = {
      requestId: 'r1',
      // Only the pinned model is in the pool, and it's excluded below —
      // local fallback scoring should find nothing and return null, NEVER
      // silently falling back to the (now-excluded) precomputed pin.
      models: [pinned.model],
      precomputedModelSelection: pinned,
    } as unknown as OrchestrationContext;

    const strategy = new TestableSingleModelStrategy();
    // Inject a getAdapterForModel so the local-fallback branch (reached once
    // the mocked selector call is skipped for lack of candidates) does not
    // throw for an unrelated reason.
    (strategy as unknown as { getAdapterForModel: unknown }).getAdapterForModel = async () => adapter;

    const result = await strategy.callSelectBestModel(
      req,
      context,
      new Set(['pinned-1'])
    );

    expect(result).toBeNull();
  });
});
