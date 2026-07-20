// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P2 — Real-branch fingerprint gate tests.
 *
 * Pins the structural invariant that `dryRun=false` consensus requests
 * cannot reach `orchestrationEngine.execute` (and thus any provider
 * call) unless the request body carries a matching `approvedPlanFingerprint`.
 *
 * Test surface uses `processChatRequest` end-to-end with a mocked
 * orchestrationEngine that THROWS on entry. The throw means: if any
 * test reaches `orchestrationEngine.execute`, the test fails — proving
 * the gate ran BEFORE provider call.
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

// Tripwire: any path that reaches `orchestrationEngine.execute` fails
// the test with this exact error.
const PROVIDER_DISPATCH_SENTINEL = vi.fn(() => {
  throw new Error('PROVIDER_DISPATCH_DETECTED — real-branch gate must NOT reach orchestrationEngine.execute');
});

const PROVIDER_FETCH_SENTINEL = vi.fn(() => {
  throw new Error('PROVIDER_FETCH_DETECTED — real-branch gate must NOT call fetch');
});

const ORIG_FETCH = globalThis.fetch;
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  PROVIDER_DISPATCH_SENTINEL.mockClear();
  PROVIDER_FETCH_SENTINEL.mockClear();
  globalThis.fetch = PROVIDER_FETCH_SENTINEL as unknown as typeof globalThis.fetch;
  // 01C.1B-J2-E-R2: reset the module cache so each test gets a fresh
  // `chat-request-processor` import that picks up THIS test's
  // `vi.doMock(...)` factory. Without this reset, the second `await
  // import(...)` returns the cached module from the first test, whose
  // closures bound to the previous mock — making the gate skip the
  // approved-plan check intermittently under singleFork.
  vi.resetModules();

  // Mock the model repository so role-specific pool builder + planner
  // run without hitting the real DB.
  vi.doMock('@/services/model-repository', () => {
    const judgeStub = {
      id: 'fixture-judge',
      provider: 'fixture-prov-judge',
      providerId: 'fixture-prov-judge',
      name: 'fixture-judge',
      capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling', 'instruction_following'],
      contextWindow: 64_000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.0001,
      outputCostPer1k: 0.0003,
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.95 },
      status: 'active',
      balanceStatus: 'has-credits',
    };
    const synthStub = {
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
    return {
      getModelRepository: () => ({
        searchModels: async () => [
          participantStub('p-a', 'prov-a'),
          participantStub('p-b', 'prov-b'),
          participantStub('p-c', 'prov-c'),
          judgeStub,
          synthStub,
        ],
      }),
    };
  });
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
  vi.doUnmock('@/services/model-repository');
});

function makeBaseRequest(): ChatRequest {
  return {
    model: 'auto',
    strategy: 'consensus',
    messages: [{ role: 'user', content: 'real-branch probe' }],
  };
}

function makeOrchestrationEngineStub(): {
  execute: typeof PROVIDER_DISPATCH_SENTINEL;
} {
  return {
    execute: PROVIDER_DISPATCH_SENTINEL,
  };
}

// 01C.1B-J1D-R3: tests in this file dynamic-import `chat-request-processor`
// per-case after `vi.resetModules()`. Cold import + planner setup is ~9s in
// isolation; under singleFork suite pressure (especially when other heavy
// orchestration tests run before) it can approach the default 10s vitest
// timeout. Per-test 60s timeout gives the dynamic import + planner enough
// headroom while still failing fast on real regressions.
const REAL_BRANCH_TEST_TIMEOUT_MS = 60_000;

describe('processChatRequest — dryRun=false consensus dynamic-plan gate', () => {
  it('throws APPROVED_PLAN_REQUIRED (422) when EVAL_REQUIRE_APPROVED_PLAN=true and no fingerprint payload', async () => {
    process.env.ENABLE_CONSENSUS_DYNAMIC_PLAN = 'true';
    process.env.EVAL_REQUIRE_APPROVED_PLAN = 'true';
    const { processChatRequest } = await import('../chat-request-processor');
    await expect(
      processChatRequest({
        chatRequest: {
          ...makeBaseRequest(),
          // @ts-expect-error eval is additive
          eval: { dynamicPlan: true, dryRun: false },
        } as ChatRequest,
        orchestrationEngine: makeOrchestrationEngineStub() as never,
        organizationId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        requestId: 'rid-real-1',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'APPROVED_PLAN_REQUIRED',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_DISPATCH_SENTINEL).not.toHaveBeenCalled();
    expect(PROVIDER_FETCH_SENTINEL).not.toHaveBeenCalled();
  }, REAL_BRANCH_TEST_TIMEOUT_MS);

  it('throws APPROVED_PLAN_REQUIRED when requirePlanFingerprintMatch=true and no fingerprint payload', async () => {
    process.env.ENABLE_CONSENSUS_DYNAMIC_PLAN = 'true';
    // env-level NOT set — body asks for the gate
    delete process.env.EVAL_REQUIRE_APPROVED_PLAN;
    const { processChatRequest } = await import('../chat-request-processor');
    await expect(
      processChatRequest({
        chatRequest: {
          ...makeBaseRequest(),
          // @ts-expect-error
          eval: {
            dynamicPlan: true,
            dryRun: false,
            requirePlanFingerprintMatch: true,
          },
        } as ChatRequest,
        orchestrationEngine: makeOrchestrationEngineStub() as never,
        organizationId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        requestId: 'rid-real-2',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'APPROVED_PLAN_REQUIRED',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_DISPATCH_SENTINEL).not.toHaveBeenCalled();
  }, REAL_BRANCH_TEST_TIMEOUT_MS);

  it('throws PLAN_EXECUTION_PARITY_FAILED (409) when the approved fingerprint is invalid', async () => {
    process.env.ENABLE_CONSENSUS_DYNAMIC_PLAN = 'true';
    process.env.EVAL_REQUIRE_APPROVED_PLAN = 'true';
    const { processChatRequest } = await import('../chat-request-processor');
    await expect(
      processChatRequest({
        chatRequest: {
          ...makeBaseRequest(),
          // @ts-expect-error
          eval: {
            dynamicPlan: true,
            dryRun: false,
            approvedExecutionPlanId: 'invalid-plan-id',
            approvedPlanFingerprint: 'definitely-not-the-real-hash',
            requirePlanFingerprintMatch: true,
          },
        } as ChatRequest,
        orchestrationEngine: makeOrchestrationEngineStub() as never,
        organizationId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        requestId: 'rid-real-3',
        log: makeLog(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_EXECUTION_PARITY_FAILED',
      billable_execution_blocked: true,
    });
    expect(PROVIDER_DISPATCH_SENTINEL).not.toHaveBeenCalled();
  }, REAL_BRANCH_TEST_TIMEOUT_MS);

  it('proceeds past the gate when the approved fingerprint matches (orchestrationEngine reached)', async () => {
    // This positive test confirms the gate ALLOWS execution past itself
    // when the fingerprint matches. The mocked orchestrationEngine throws
    // a SPECIFIC sentinel — we expect that error, NOT the gate's refusal.
    process.env.ENABLE_CONSENSUS_DYNAMIC_PLAN = 'true';
    process.env.EVAL_REQUIRE_APPROVED_PLAN = 'true';

    // Step 1: compute the fingerprint the gate WILL recompute by
    // calling the SAME builder + planner externally. We use the public
    // shared modules so the test exercises the real recipe.
    const { buildConsensusRoleSpecificCandidatePools } = await import(
      '@/core/orchestration/model-selection/role-specific-candidate-pool-builder'
    );
    const { ConsensusPlanDryRunService } = await import(
      '@/core/orchestration/strategies/consensus-plan-dry-run-service'
    );
    const { computePlanFingerprint } = await import(
      '@/core/orchestration/strategies/consensus-plan-fingerprint'
    );
    const { getModelRepository } = await import('@/services/model-repository');
    const pools = await buildConsensusRoleSpecificCandidatePools({
      repo: getModelRepository() as never,
      maxCostPer1kJudge: 0.01,
    });
    const planSvc = new ConsensusPlanDryRunService();
    const plan = await planSvc.plan({
      chatRequest: makeBaseRequest(),
      candidatePool: pools.sharedPool,
      context: { taskType: 'general' },
      roleSpecificCandidatePools: {
        participant: pools.participantPool,
        synthesizer: pools.synthesizerPool,
        judge: pools.judgePool,
        fallback: pools.fallbackPool,
      },
    });
    const approvedFingerprint = computePlanFingerprint(
      {
        plan,
        budget: {},
        strict: true,
        roleSpecificRetrieval: true,
      },
      { planSource: 'dry_run' },
    );

    // Step 2: invoke processChatRequest with matching fingerprint and
    // expect the orchestrationEngine.execute sentinel — which proves
    // the gate let it through.
    const { processChatRequest } = await import('../chat-request-processor');
    await expect(
      processChatRequest({
        chatRequest: {
          ...makeBaseRequest(),
          // @ts-expect-error
          eval: {
            dynamicPlan: true,
            dryRun: false,
            approvedExecutionPlanId: approvedFingerprint.executionPlanId,
            approvedPlanFingerprint: approvedFingerprint.planFingerprint,
            requirePlanFingerprintMatch: true,
            requireStrictPlanExecution: true,
          },
        } as ChatRequest,
        orchestrationEngine: makeOrchestrationEngineStub() as never,
        organizationId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        requestId: 'rid-real-4',
        log: makeLog(),
      }),
    ).rejects.toThrow('PROVIDER_DISPATCH_DETECTED');
    // Gate let it through → orchestrationEngine.execute was called
    expect(PROVIDER_DISPATCH_SENTINEL).toHaveBeenCalledTimes(1);
  }, REAL_BRANCH_TEST_TIMEOUT_MS);

  it('does NOT trigger the gate when dryRun=true (parity-check path handles those)', async () => {
    // When dryRun=true, the upstream `applyDryRunFailClosedGate` handles
    // the request and short-circuits. The real-branch gate should NOT
    // fire — that would double-validate fingerprint and reject legit
    // dry-runs.
    process.env.ENABLE_CONSENSUS_DYNAMIC_PLAN = 'true';
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    process.env.EVAL_REQUIRE_APPROVED_PLAN = 'true';
    const { processChatRequest } = await import('../chat-request-processor');
    const result = await processChatRequest({
      chatRequest: {
        ...makeBaseRequest(),
        // @ts-expect-error
        eval: { dynamicPlan: true, dryRun: true, planOnly: true },
      } as ChatRequest,
      orchestrationEngine: makeOrchestrationEngineStub() as never,
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      requestId: 'rid-real-5-dryrun',
      log: makeLog(),
    });
    expect(result.response.id).toMatch(/^chatcmpl-dryrun-/);
    expect(PROVIDER_DISPATCH_SENTINEL).not.toHaveBeenCalled();
  }, REAL_BRANCH_TEST_TIMEOUT_MS);
});
