// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Context-window preflight audit (2026-09): SingleModelStrategy.selectBestModel()'s
 * user-specified-model branch used to return the pinned model with ZERO
 * comparison between the request's estimated context size and the model's
 * real catalog `contextWindow` — the entire hard-gate check the 'auto' path
 * already applies via dynamic-model-selector.ts's
 * `context_window >= contextSize` SQL filter. That gap meant every one of
 * the six agentic-coding-IDE integrations (Cursor, Cline, Zed, Claude Code,
 * Goose, Opencode) — which ALWAYS pin a concrete `model` id, never send
 * `model: "auto"` — got zero protection: a too-big request reached the
 * provider raw, which rejected it, surfacing as an unclassified 500.
 *
 * These tests exercise the REAL `selectBestModel()` implementation (mirrors
 * single-model-strategy.precomputed-selection.test.ts's approach) and prove:
 *   1. A pinned model that doesn't fit fails CLEANLY with
 *      ContextWindowExceededError (statusCode 400, code 'context_exceeded') —
 *      never a generic throw, never silent truncation, never a DIFFERENT
 *      model silently substituted for the one the caller asked for.
 *   2. A pinned model that DOES fit is completely unaffected (no regression).
 *   3. An unknown/zero contextWindow can't be used to fail a request closed
 *      on an unknowable fact (mirrors the session-affinity re-validation
 *      gate's `pinnedModel.contextWindow > 0` guard in
 *      orchestration-engine.ts).
 */
import { describe, it, expect } from 'vitest';
import { SingleModelStrategy } from '../single-model-strategy';
import { ContextWindowExceededError } from '@/utils/custom-errors';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

const model = (id: string, contextWindow: number): Model =>
  ({ id, name: id, provider: 'test-provider', contextWindow }) as Model;

const adapter = { getName: () => 'test-provider' } as unknown as ProviderAdapter;

/** Exposes the protected selectBestModel() for direct invocation (mirrors
 *  the TestableSingleModelStrategy pattern in the precomputed-selection
 *  test file). */
class TestableSingleModelStrategy extends SingleModelStrategy {
  public callSelectBestModel(
    request: ChatRequest,
    context: OrchestrationContext,
    excludedModelIds?: Set<string>
  ) {
    return this.selectBestModel(request, context, excludedModelIds);
  }
}

function buildStrategy(): TestableSingleModelStrategy {
  const strategy = new TestableSingleModelStrategy();
  (strategy as unknown as { getAdapterForModel: unknown }).getAdapterForModel = async () => adapter;
  return strategy;
}

describe('SingleModelStrategy.selectBestModel — context-window preflight (pinned model)', () => {
  it('fails closed with ContextWindowExceededError when the pinned model does not fit — never silently substitutes or truncates', async () => {
    // ~4 chars/token: 400,000 chars -> ~100,000 estimated tokens, well over
    // the pinned model's declared 8,000-token window.
    const tinyWindowModel = model('small-context-model', 8_000);
    const context = {
      requestId: 'r1',
      models: [tinyWindowModel, model('big-context-model', 200_000)],
    } as unknown as OrchestrationContext;

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
      model: 'small-context-model',
      user_specified_model: true,
    } as ChatRequest;

    const strategy = buildStrategy();

    let caught: unknown;
    try {
      await strategy.callSelectBestModel(request, context, new Set());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContextWindowExceededError);
    const err = caught as ContextWindowExceededError;
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('context_exceeded');
    // The message must name the ACTUAL pinned model, not a substitute —
    // proving the failure is about the caller's own choice, not a swap.
    expect(err.message).toContain('small-context-model');
  });

  it('does NOT throw and returns the pinned model when the request fits (no regression)', async () => {
    const roomyModel = model('roomy-model', 200_000);
    const context = {
      requestId: 'r2',
      models: [roomyModel],
    } as unknown as OrchestrationContext;

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'roomy-model',
      user_specified_model: true,
    } as ChatRequest;

    const strategy = buildStrategy();
    const result = await strategy.callSelectBestModel(request, context, new Set());

    expect(result).not.toBeNull();
    expect(result!.model.id).toBe('roomy-model');
  });

  it('does not fail-close on an unknown/zero contextWindow (unknowable fact, matches session-affinity guard)', async () => {
    const unknownWindowModel = model('unknown-window-model', 0);
    const context = {
      requestId: 'r3',
      models: [unknownWindowModel],
    } as unknown as OrchestrationContext;

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
      model: 'unknown-window-model',
      user_specified_model: true,
    } as ChatRequest;

    const strategy = buildStrategy();
    const result = await strategy.callSelectBestModel(request, context, new Set());

    expect(result).not.toBeNull();
    expect(result!.model.id).toBe('unknown-window-model');
  });
});
