// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaPlannerStrategy — `edit` action dispatch (Section D).
 *
 * Mirrors the mocking style of `media-planner-strategy.test.ts`
 * (capabilityDispatcher / mediaConsensusExecutor via constructor DI,
 * persistMediaPlanRun mocked at module level). No real provider, DB, or
 * network call anywhere in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AilinArtifact, ChatRequest, Model, OrchestrationContext } from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { CapabilityModeResult } from '@/routes/capabilities/capabilities-routes';
import type { ImageEditJudge } from '../media-planner-strategy';
import type { EvaluationResult } from '../evaluation/strategy-output-evaluator';

const persistMediaPlanRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../media-planner-repository', () => ({
  persistMediaPlanRun: (...args: unknown[]) => persistMediaPlanRunMock(...args),
}));

const imageSizeMock = vi.fn().mockReturnValue({ width: 1024, height: 1024, type: 'png' });
vi.mock('image-size', () => ({ imageSize: (...args: unknown[]) => imageSizeMock(...args) }));

const { MediaPlannerStrategy } = await import('../media-planner-strategy');

function makeRequest(text: string): ChatRequest {
  return { model: 'auto', messages: [{ role: 'user', content: text }] };
}

function makeInvoker(overrides: Partial<CapabilityInvoker> = {}): CapabilityInvoker {
  return {
    chat: vi.fn().mockRejectedValue(new Error('chat() not stubbed for this test')),
    transcribe: vi.fn().mockRejectedValue(new Error('not implemented')),
    synthesize: vi.fn().mockRejectedValue(new Error('not implemented')),
    translate: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateVideo: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateImage: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    ...overrides,
  };
}

function makeContext(
  models: Model[],
  invoker: CapabilityInvoker,
  overrides: Partial<OrchestrationContext> = {}
): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: 'req-test',
    models,
    taskType: 'creative',
    contextSize: 1000,
    invoker,
    ...overrides,
  };
}

function chatJson(value: unknown) {
  return {
    id: 'r',
    object: 'chat.completion' as const,
    created: 0,
    model: 'planner-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: JSON.stringify(value) },
        finish_reason: 'stop' as const,
        logprobs: null,
      },
    ],
  };
}

function makeEvaluationResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    scoringMode: 'mock',
    evaluatorId: 'test-image-edit-judge',
    score: 1,
    verdict: 'pass',
    structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
    ...overrides,
  };
}

const sourceImage: AilinArtifact = {
  modality: 'image',
  stage_name: 'seed',
  stage_index: 0,
  b64_json: Buffer.from('source image bytes').toString('base64'),
  mime_type: 'image/png',
};

beforeEach(() => {
  persistMediaPlanRunMock.mockClear();
  imageSizeMock.mockClear();
  imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
});

describe('MediaPlannerStrategy — edit action', () => {
  it('generate then edit: dispatches image_editing, gate passes, succeeds on first attempt', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    const editedB64 = Buffer.from('edited image bytes').toString('base64');
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: editedB64 }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, capabilityDispatcher });
    const result = await strategy.execute(makeRequest('generate a cat then make the sky orange'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(1);
    expect(capabilityDispatcher.mock.calls[0][0]).toMatchObject({ id: 'image_editing' });
    expect(capabilityDispatcher.mock.calls[0][1]).toMatchObject({
      prompt: 'make the sky orange',
      image_base64: sourceImage.b64_json,
    });
    expect(result.artifacts).toHaveLength(2); // seed image + edited image
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome.success).toBe(true);
  });

  it('no source artifact available → fails without calling the dispatcher', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: ['edit failed: no source image'] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);
    const capabilityDispatcher = vi.fn();

    const strategy = new MediaPlannerStrategy({ capabilityDispatcher });
    const result = await strategy.execute(makeRequest('edit my photo'), context);

    expect(capabilityDispatcher).not.toHaveBeenCalled();
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean } }>;
    expect(plan[0].outcome).toMatchObject({ type: 'edit_result', success: false });
  });

  it('gate fails on every attempt → retries up to maxEditAttempts then reports failure', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(
        chatJson({
          kind: 'edit',
          prompt: 'resize to 1024x1024 png',
          constraints: { dimensions: { width: 1024, height: 1024 }, format: 'png' },
        })
      )
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'could not verify the edit', unmetConstraints: ['1024x1024 png edit'] })
      );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    // Every attempt returns a WRONG format ('jpg' instead of the requested 'png').
    imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' });
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: Buffer.from('wrong format bytes').toString('base64') }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({
      mediaConsensusExecutor,
      capabilityDispatcher,
      maxTurns: 3,
    });
    const result = await strategy.execute(makeRequest('generate a cat then resize it'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(2); // default maxEditAttempts = 2
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean; attempts?: number } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome).toMatchObject({ success: false, attempts: 2 });
  });

  it('respects a maxEditAttempts override for deterministic tests', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(
        chatJson({ kind: 'edit', prompt: 'resize', constraints: { format: 'png' } })
      )
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };
    imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' }); // always wrong format
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({
      mediaConsensusExecutor,
      capabilityDispatcher,
      maxEditAttempts: 1,
    });
    await strategy.execute(makeRequest('generate a cat then resize it'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(1);
  });

  it('imageEditJudge rejects the first attempt, passes the second → retries and succeeds', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: Buffer.from('edited bytes').toString('base64') }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const imageEditJudge: ImageEditJudge = {
      evaluateImageEdit: vi
        .fn()
        .mockResolvedValueOnce(makeEvaluationResult({ verdict: 'fail', notes: 'sky is still blue' }))
        .mockResolvedValueOnce(makeEvaluationResult({ verdict: 'pass' })),
    };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, capabilityDispatcher, imageEditJudge });
    const result = await strategy.execute(makeRequest('generate a cat then make the sky orange'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(2);
    expect(imageEditJudge.evaluateImageEdit).toHaveBeenCalledTimes(2);
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean; attempts?: number } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome).toMatchObject({ success: true, attempts: 2 });
  });

  it('imageEditJudge passes on the first attempt → invoked once with the right instruction/artifacts', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    const editedB64 = Buffer.from('edited bytes').toString('base64');
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: editedB64 }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const imageEditJudge: ImageEditJudge = {
      evaluateImageEdit: vi.fn().mockResolvedValue(makeEvaluationResult({ verdict: 'pass' })),
    };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, capabilityDispatcher, imageEditJudge });
    const result = await strategy.execute(makeRequest('generate a cat then make the sky orange'), context);

    expect(imageEditJudge.evaluateImageEdit).toHaveBeenCalledTimes(1);
    expect(imageEditJudge.evaluateImageEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        editInstruction: 'make the sky orange',
        preArtifact: sourceImage,
        postArtifact: expect.objectContaining({ b64_json: editedB64 }),
      })
    );
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean; attempts?: number } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome).toMatchObject({ success: true, attempts: 1 });
  });

  it('capabilityDispatcher throwing is caught, retried, and reported in the failure summary', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'could not edit', unmetConstraints: ['edit failed: provider 500'] })
      );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    const capabilityDispatcher = vi.fn().mockRejectedValue(new Error('provider 500'));

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, capabilityDispatcher });
    const result = await strategy.execute(makeRequest('generate a cat then make the sky orange'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(2); // default maxEditAttempts = 2, every attempt throws
    const plan = result.metadata.plan as Array<{
      outcome: { type: string; success?: boolean; attempts?: number; summary?: string };
    }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome).toMatchObject({ success: false, attempts: 2 });
    expect(editTurn?.outcome.summary).toContain('edit call failed');
    expect(editTurn?.outcome.summary).toContain('provider 500');
  });
});
