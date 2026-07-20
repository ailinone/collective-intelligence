// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-R — Fail-closed gate tests for `eval.dryRun=true` /
 * `eval.planOnly=true`.
 *
 * These pin the structural invariant that any `dryRun` request either
 *   (a) short-circuits into the dry-run service (no provider call), or
 *   (b) throws an explicit refusal error with a stable code.
 *
 * The class of failure this guards against was observed in 01C.1B-D:
 * a request with `eval.strategy=consensus` and `eval.dryRun=true` but NO
 * top-level `strategy` was processed by the pre-01C.1B-R gate as
 * `shouldRunConsensusDryRun() → false`, then fell through to billable
 * orchestration (`single` strategy → anthropic). The new gate
 * (`applyDryRunFailClosedGate`) catches every precondition explicitly
 * BEFORE any orchestration setup runs and refuses to fall through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { ChatRequest } from '@/types';

// Lightweight logger stub — vitest spies on the calls.
function makeLog(): Logger {
  const noop = () => undefined;
  const log = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: () => log,
    level: 'info',
  };
  return log as unknown as Logger;
}

// Sentinel that surfaces any provider call attempt during these tests.
const PROVIDER_CALL_SENTINEL = vi.fn(() => {
  throw new Error('PROVIDER_CALL_DETECTED — dry-run path must NOT reach providers');
});

const ORIG_FETCH = globalThis.fetch;
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  PROVIDER_CALL_SENTINEL.mockClear();
  // Fail-fast on any outbound network call so we catch silent provider
  // dispatches even if they go through a non-fetch path that imports here.
  globalThis.fetch = (PROVIDER_CALL_SENTINEL as unknown) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  // Restore env to baseline so tests don't leak ENABLE_* flags into each other.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
});

describe('applyDryRunFailClosedGate — non-dry-run requests pass through', () => {
  it('returns { kind: continue } when eval.dryRun is absent and eval.planOnly is absent', async () => {
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    const result = await applyDryRunFailClosedGate({
      chatRequest: {
        model: 'auto',
        strategy: 'consensus',
        messages: [{ role: 'user', content: 'hello' }],
      } as ChatRequest,
      requestId: 'rid-1',
      log: makeLog(),
    });
    expect(result.kind).toBe('continue');
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('returns { kind: continue } when eval present but dryRun/planOnly are both false', async () => {
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    const result = await applyDryRunFailClosedGate({
      chatRequest: {
        model: 'auto',
        strategy: 'consensus',
        messages: [{ role: 'user', content: 'hello' }],
        // @ts-expect-error eval is an additive prop
        eval: { dryRun: false, planOnly: false, strategy: 'consensus' },
      } as ChatRequest,
      requestId: 'rid-2',
      log: makeLog(),
    });
    expect(result.kind).toBe('continue');
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('normalizes eval.strategy onto top-level when top-level absent and dryRun is also absent (no harm)', async () => {
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    const result = await applyDryRunFailClosedGate({
      chatRequest: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        // @ts-expect-error eval is an additive prop
        eval: { strategy: 'consensus' },
      } as ChatRequest,
      requestId: 'rid-3',
      log: makeLog(),
    });
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      expect(result.strategySource).toBe('eval_normalized');
      expect(result.normalizedRequest.strategy).toBe('consensus');
    }
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });
});

describe('applyDryRunFailClosedGate — dry-run preconditions', () => {
  it('throws DRY_RUN_STRATEGY_REQUIRED (422) when dryRun=true and no strategy anywhere', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hello' }],
          // @ts-expect-error eval is additive
          eval: { dryRun: true },
        } as ChatRequest,
        requestId: 'rid-4',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/strategy/i),
      statusCode: 422,
      code: 'DRY_RUN_STRATEGY_REQUIRED',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('throws DRY_RUN_UNSUPPORTED_FOR_REQUEST_SHAPE (422) when strategy is non-consensus', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          model: 'auto',
          strategy: 'parallel',
          messages: [{ role: 'user', content: 'hello' }],
          // @ts-expect-error
          eval: { dryRun: true },
        } as ChatRequest,
        requestId: 'rid-5',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'DRY_RUN_UNSUPPORTED_FOR_REQUEST_SHAPE',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('throws DRY_RUN_NOT_ENABLED_IN_RUNTIME (409) when ENABLE_CONSENSUS_PLAN_DRY_RUN is missing', async () => {
    delete process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN;
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          model: 'auto',
          strategy: 'consensus',
          messages: [{ role: 'user', content: 'hello' }],
          // @ts-expect-error
          eval: { dryRun: true },
        } as ChatRequest,
        requestId: 'rid-6',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DRY_RUN_NOT_ENABLED_IN_RUNTIME',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('throws DRY_RUN_NOT_ENABLED_IN_RUNTIME (409) when env value is not the literal string "true"', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = '1'; // truthy-but-not-"true"
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          model: 'auto',
          strategy: 'consensus',
          messages: [{ role: 'user', content: 'hello' }],
          // @ts-expect-error
          eval: { dryRun: true },
        } as ChatRequest,
        requestId: 'rid-7',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DRY_RUN_NOT_ENABLED_IN_RUNTIME',
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });
});

describe('applyDryRunFailClosedGate — body shape normalization', () => {
  it('promotes eval.strategy=consensus onto top-level when dryRun=true (catches 01C.1B-D regression)', async () => {
    // This is THE regression case from 01C.1B-D: payload had eval.strategy
    // but no top-level strategy. The old shouldRunConsensusDryRun returned
    // false because chatRequest.strategy was undefined, and the request
    // fell through to billable orchestration. The new gate normalizes and
    // short-circuits.
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');

    // Provide a tiny candidate pool via the model repository mock.
    vi.doMock('@/services/model-repository', () => ({
      getModelRepository: () => ({
        searchModels: async () => [
          {
            id: 'm1',
            provider: 'aihubmix',
            name: 'm1',
            capabilities: ['chat'],
            contextWindow: 32000,
            inputCostPer1k: 0.001,
            outputCostPer1k: 0.002,
            performance: { latencyMs: 200, throughput: 100, quality: 0.8, reliability: 0.95 },
          },
          {
            id: 'm2',
            provider: 'cometapi',
            name: 'm2',
            capabilities: ['chat'],
            contextWindow: 32000,
            inputCostPer1k: 0.001,
            outputCostPer1k: 0.002,
            performance: { latencyMs: 250, throughput: 100, quality: 0.78, reliability: 0.93 },
          },
          {
            id: 'm3',
            provider: 'openrouter',
            name: 'm3',
            capabilities: ['chat'],
            contextWindow: 32000,
            inputCostPer1k: 0.001,
            outputCostPer1k: 0.002,
            performance: { latencyMs: 300, throughput: 80, quality: 0.82, reliability: 0.92 },
          },
        ],
      }),
    }));

    try {
      const result = await applyDryRunFailClosedGate({
        chatRequest: {
          model: 'auto',
          // NOTE: NO top-level strategy
          messages: [{ role: 'user', content: 'hello' }],
          // @ts-expect-error
          eval: { strategy: 'consensus', dryRun: true, planOnly: true },
        } as ChatRequest,
        requestId: 'rid-8',
        log: makeLog(),
      });
      expect(result.kind).toBe('short_circuit');
      if (result.kind === 'short_circuit') {
        expect(result.strategySource).toBe('eval_normalized');
        expect(result.response.id).toMatch(/^chatcmpl-dryrun-/);
        expect(result.response.model).toBe('consensus-dry-run');
        // dry-run must report zero tokens / zero cost.
        expect(result.response.usage?.total_tokens).toBe(0);
        const meta = (result.response.ailin_metadata ?? {}) as Record<string, unknown>;
        expect(meta.dryRun).toBe(true);
        expect(meta.cost_usd).toBe(0);
        expect(meta.consensusPlan).toBeDefined();
      }
    } finally {
      vi.doUnmock('@/services/model-repository');
    }

    // PROVIDER_CALL_SENTINEL is fetch — must not have been called.
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });
});
