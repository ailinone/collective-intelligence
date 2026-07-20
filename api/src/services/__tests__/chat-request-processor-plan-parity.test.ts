// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P — End-to-end parity gate tests on chat-request-processor.
 *
 * Pins:
 *   - Dry-run response carries `executionPlanId` + `planFingerprint`
 *   - `executionParityCheck=true` + matching `approvedPlanFingerprint`
 *     succeeds without provider call
 *   - `executionParityCheck=true` + mismatched fingerprint throws
 *     `PLAN_EXECUTION_PARITY_FAILED` (409) and never calls provider
 *   - `requirePlanFingerprintMatch=true` without `approvedPlanFingerprint`
 *     throws explicit refusal
 *   - planned-vs-would-execute IDs are surfaced in the parity response
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { ChatRequest } from '@/types';

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

const PROVIDER_CALL_SENTINEL = vi.fn(() => {
  throw new Error('PROVIDER_CALL_DETECTED — parity-check path must NOT reach providers');
});

const ORIG_FETCH = globalThis.fetch;
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  PROVIDER_CALL_SENTINEL.mockClear();
  globalThis.fetch = PROVIDER_CALL_SENTINEL as unknown as typeof globalThis.fetch;
  // Mock the model repository so the dry-run gate has a usable pool.
  vi.doMock('@/services/model-repository', () => ({
    getModelRepository: () => ({
      searchModels: async (criteria: { limit?: number }) => {
        const judgeEligibleStub = {
          id: 'fixture-judge',
          provider: 'fixture-prov-judge',
          providerId: 'fixture-prov-judge',
          name: 'fixture-judge',
          capabilities: [
            'chat',
            'text_generation',
            'json_mode',
            'function_calling',
            'instruction_following',
          ],
          contextWindow: 64_000,
          maxOutputTokens: 4096,
          inputCostPer1k: 0.0001,
          outputCostPer1k: 0.0003,
          performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.95 },
          status: 'active',
          balanceStatus: 'has-credits',
        };
        const synthEligibleStub = {
          id: 'fixture-synth',
          provider: 'fixture-prov-synth',
          providerId: 'fixture-prov-synth',
          name: 'fixture-synth',
          capabilities: ['chat', 'text_generation', 'instruction_following', 'reasoning'],
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          inputCostPer1k: 0.001,
          outputCostPer1k: 0.003,
          performance: { latencyMs: 1500, throughput: 100, quality: 0.92, reliability: 0.95 },
          status: 'active',
          balanceStatus: 'has-credits',
        };
        const participantStub = (id: string, providerId: string) => ({
          id,
          provider: providerId,
          providerId,
          name: id,
          capabilities: ['chat', 'text_generation'],
          contextWindow: 8000,
          maxOutputTokens: 4096,
          inputCostPer1k: 0.0005,
          outputCostPer1k: 0.0015,
          performance: { latencyMs: 800, throughput: 80, quality: 0.85, reliability: 0.92 },
          status: 'active',
          balanceStatus: 'has-credits',
        });
        const out = [
          participantStub('p-a', 'prov-a'),
          participantStub('p-b', 'prov-b'),
          participantStub('p-c', 'prov-c'),
          judgeEligibleStub,
          synthEligibleStub,
        ];
        return out.slice(0, criteria.limit ?? out.length);
      },
    }),
  }));
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
  vi.doUnmock('@/services/model-repository');
});

const baseChatRequest: ChatRequest = {
  model: 'auto',
  strategy: 'consensus',
  messages: [{ role: 'user', content: 'parity probe' }],
};

describe('applyDryRunFailClosedGate — executionPlanId + planFingerprint on dry-run response', () => {
  it('attaches executionPlanId + planFingerprint to the dry-run response', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    const result = await applyDryRunFailClosedGate({
      chatRequest: {
        ...baseChatRequest,
        // @ts-expect-error eval is additive
        eval: { dryRun: true, planOnly: true, maxJudgeCostUsd: 0.10, requireStrictPlanExecution: true },
      } as ChatRequest,
      requestId: 'rid-p1',
      log: makeLog(),
    });
    expect(result.kind).toBe('short_circuit');
    if (result.kind === 'short_circuit') {
      const meta = (result.response.ailin_metadata ?? {}) as Record<string, unknown>;
      expect(typeof meta.executionPlanId).toBe('string');
      expect((meta.executionPlanId as string).length).toBeGreaterThan(10);
      expect(typeof meta.planFingerprint).toBe('string');
      expect((meta.planFingerprint as string)).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.planSource).toBe('dry_run');
      expect(meta.plannerVersion).toBeDefined();
      expect(meta.registryScope).toBe('full_system_registry');
      expect(meta.probeScope).toBe('auxiliary');
      expect(meta.roleSpecificRetrieval).toBe(true);
    }
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });
});

describe('applyDryRunFailClosedGate — executionParityCheck', () => {
  it('passes when approvedPlanFingerprint matches the recomputed fingerprint', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');

    // First call: dry-run to capture fingerprint.
    const drr = await applyDryRunFailClosedGate({
      chatRequest: {
        ...baseChatRequest,
        // @ts-expect-error
        eval: { dryRun: true, planOnly: true, requireStrictPlanExecution: true },
      } as ChatRequest,
      requestId: 'rid-p2-dryrun',
      log: makeLog(),
    });
    expect(drr.kind).toBe('short_circuit');
    if (drr.kind !== 'short_circuit') return;
    const drrMeta = drr.response.ailin_metadata as Record<string, unknown>;
    const approvedFingerprint = drrMeta.planFingerprint as string;
    const approvedPlanId = drrMeta.executionPlanId as string;

    // Second call: executionParityCheck with the captured fingerprint.
    const parity = await applyDryRunFailClosedGate({
      chatRequest: {
        ...baseChatRequest,
        // @ts-expect-error
        eval: {
          dryRun: true,
          planOnly: false,
          executionParityCheck: true,
          approvedPlanFingerprint: approvedFingerprint,
          approvedExecutionPlanId: approvedPlanId,
          requirePlanFingerprintMatch: true,
          requireStrictPlanExecution: true,
        },
      } as ChatRequest,
      requestId: 'rid-p2-parity',
      log: makeLog(),
    });
    expect(parity.kind).toBe('short_circuit');
    if (parity.kind === 'short_circuit') {
      const meta = parity.response.ailin_metadata as Record<string, unknown>;
      expect(meta.executionParityCheck).toBe(true);
      expect(meta.planFingerprintMatched).toBe(true);
      expect(meta.approvedPlanFingerprint).toBe(approvedFingerprint);
      expect(meta.wouldExecutePlanFingerprint).toBe(approvedFingerprint);
      expect(meta.plannedJudgeModelId).toBe('fixture-judge');
      expect(meta.wouldExecuteJudgeModelId).toBe('fixture-judge');
      expect(meta.plannedSynthesizerModelId).toBe('fixture-synth');
      expect(meta.wouldExecuteSynthesizerModelId).toBe('fixture-synth');
      expect(parity.response.id).toMatch(/^chatcmpl-parity-/);
      expect(parity.response.usage?.total_tokens).toBe(0);
    }
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('throws PLAN_EXECUTION_PARITY_FAILED (409) when fingerprint mismatches', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          ...baseChatRequest,
          // @ts-expect-error
          eval: {
            dryRun: true,
            planOnly: false,
            executionParityCheck: true,
            approvedPlanFingerprint: 'definitely-not-the-real-hash',
            approvedExecutionPlanId: 'invalid',
            requirePlanFingerprintMatch: true,
          },
        } as ChatRequest,
        requestId: 'rid-p3-parity-mismatch',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_EXECUTION_PARITY_FAILED',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });

  it('throws 422 when requirePlanFingerprintMatch=true but no approvedPlanFingerprint provided', async () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    const { applyDryRunFailClosedGate } = await import('../chat-request-processor');
    await expect(
      applyDryRunFailClosedGate({
        chatRequest: {
          ...baseChatRequest,
          // @ts-expect-error
          eval: {
            dryRun: true,
            planOnly: false,
            executionParityCheck: true,
            requirePlanFingerprintMatch: true,
            // NOTE: no approvedPlanFingerprint
          },
        } as ChatRequest,
        requestId: 'rid-p4-no-approved',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      billable_execution_blocked: true,
    });
    expect(PROVIDER_CALL_SENTINEL).not.toHaveBeenCalled();
  });
});
