// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * composite-media-plan.test.ts — LOTE AT PR4 (2026-09-07)
 *
 * Coverage for PR4 of the 5-PR media-generation-delegation plan: composite
 * (multi-artifact) detection and the new parallel, deadline-bounded
 * execution pipeline.
 *
 * Three layers, matching the review's own scoping:
 *  1. `detectMediaGenerationModalities` (pure function, orchestration-engine.ts)
 *     — the plural counterpart of `detectMediaGenerationModality`.
 *  2. `TriagingService.runHeuristics` (triage-service.ts) — wiring composite
 *     detection into a real, structured plan instead of collapsing to the
 *     first-detected modality.
 *  3. `OrchestrationEngine.executeCompositeMediaPlan` — the real parallel
 *     pipeline: both artifacts succeed, one fails while the other succeeds
 *     (partial success), and the whole-pipeline deadline actually bounds
 *     wall-clock time (proven, not just asserted to exist).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  OrchestrationEngine,
  detectMediaGenerationModality,
  detectMediaGenerationModalities,
} from '@/core/orchestration/orchestration-engine';
import { TriagingService } from '@/core/orchestration/triage-service';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type {
  ChatRequest,
  OrchestrationContext,
  TriageDecision,
  TriageExecutionPlan,
} from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';

// ─────────────────────────────────────────────────────────────────────────
// Layer 1: detectMediaGenerationModalities (pure function)
// ─────────────────────────────────────────────────────────────────────────

describe('detectMediaGenerationModalities', () => {
  it('detects 2 distinct modalities from one requiredCapabilities array (image + video)', () => {
    const result = detectMediaGenerationModalities(['image_generation', 'video_generation']);
    expect(result).toEqual(new Set(['image', 'video']));
  });

  it('detects all 4 modalities when every capability tag is present', () => {
    const result = detectMediaGenerationModalities([
      'image_generation',
      'video_generation',
      'audio_generation',
      'csv_generation',
    ]);
    expect(result).toEqual(new Set(['image', 'video', 'audio', 'file']));
  });

  it('still returns a single-element set for a single-modality array — no regression', () => {
    expect(detectMediaGenerationModalities(['image_generation'])).toEqual(new Set(['image']));
    expect(detectMediaGenerationModalities(['video_generation'])).toEqual(new Set(['video']));
    expect(detectMediaGenerationModalities(['pdf_generation'])).toEqual(new Set(['file']));
  });

  it('returns an empty set for a plain chat capability list', () => {
    expect(detectMediaGenerationModalities(['chat', 'reasoning'])).toEqual(new Set());
  });

  it('two DIFFERENT file-format tags still collapse to ONE "file" modality (not 2)', () => {
    // Granularity decision: modality is the deliverable ARTIFACT TYPE, not
    // the specific tag — a plan asking for both csv and pdf is still one
    // "file" stage's worth of detection at this layer (the concrete format
    // is resolved separately by detectFileGenerationFormat per stage).
    const result = detectMediaGenerationModalities(['csv_generation', 'pdf_generation']);
    expect(result).toEqual(new Set(['file']));
  });

  it('does not change detectMediaGenerationModality (the existing single-value function) at all', () => {
    // Regression guard for PR #484's streaming redirect gate, which calls
    // the singular function directly — this must keep returning the exact
    // same first-match value it always has.
    expect(detectMediaGenerationModality(['image_generation', 'video_generation'])).toBe('image');
    expect(detectMediaGenerationModality(['video_generation', 'audio_generation'])).toBe('video');
    expect(detectMediaGenerationModality([])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2: TriagingService.runHeuristics — composite plan construction
// ─────────────────────────────────────────────────────────────────────────

type RunHeuristics = (request: ChatRequest, context: OrchestrationContext) => TriageDecision;

function runHeuristics(request: ChatRequest, context: OrchestrationContext): TriageDecision {
  const service = new TriagingService({} as never, { temperature: 0.1, maxTokens: 2048 });
  return (service as unknown as { runHeuristics: RunHeuristics }).runHeuristics(request, context);
}

function userMessage(content: string): ChatRequest {
  return { messages: [{ role: 'user', content }] };
}

function contextWithInferredCapabilities(caps: string[]): OrchestrationContext {
  return {
    organizationId: 'org-test',
    requestId: 'req-test',
    models: [],
    taskType: 'general',
    contextSize: 0,
    capabilityInference: {
      requiredCapabilities: caps,
      confidence: 0.9,
      matchedPatterns: [],
    } as unknown as OrchestrationContext['capabilityInference'],
  };
}

describe('TriagingService.runHeuristics — composite multi-artifact plan', () => {
  it('builds ONE stage per distinct modality when capability-inference tagged 2+ (image + video)', () => {
    const context = contextWithInferredCapabilities(['image_generation', 'video_generation']);
    const request = userMessage('Generate an image of a rocket and a video of it launching.');
    const decision = runHeuristics(request, context);

    expect(decision.executionPlan?.compositeMediaModalities).toEqual(['image', 'video']);
    expect(decision.executionPlan?.stages).toHaveLength(2);
    const modalitiesInStages = decision.executionPlan?.stages.map((s) =>
      detectMediaGenerationModality(s.requiredCapabilities)
    );
    expect(modalitiesInStages).toEqual(['image', 'video']);
    // Every stage carries its own self-contained generation prompt — no
    // stage should be left without one, since these run independently/in
    // parallel with no shared accumulatedContext.
    for (const stage of decision.executionPlan?.stages ?? []) {
      expect(stage.generationPrompt).toBeTruthy();
    }
  });

  it('a SINGLE detected modality still produces exactly ONE stage and no compositeMediaModalities — no regression', () => {
    const context = contextWithInferredCapabilities(['image_generation']);
    const request = userMessage('Generate an image of a sunset.');
    const decision = runHeuristics(request, context);

    expect(decision.executionPlan?.compositeMediaModalities).toBeUndefined();
    expect(decision.executionPlan?.stages).toHaveLength(1);
    expect(decision.executionPlan?.stages[0].requiredCapabilities).toEqual(['image_generation']);
  });

  it('two tags of the SAME modality (audio_generation + text_to_speech) still resolve to ONE audio stage, not composite', () => {
    const context = contextWithInferredCapabilities(['audio_generation', 'text_to_speech']);
    const request = userMessage('Narrate this text and give me the audio.');
    const decision = runHeuristics(request, context);

    expect(decision.executionPlan?.compositeMediaModalities).toBeUndefined();
    expect(decision.executionPlan?.stages).toHaveLength(1);
  });

  it('labels the decision reason distinctly for a composite plan', () => {
    const context = contextWithInferredCapabilities(['image_generation', 'video_generation']);
    const request = userMessage('Generate an image and a video of a rocket launch.');
    const decision = runHeuristics(request, context);

    expect(decision.reason).toMatch(/composite media generation detected/i);
    expect(decision.reason).toContain('image');
    expect(decision.reason).toContain('video');
    expect(decision.source).toBe('heuristic');
  });

  it('an ordinary chat request (no media capabilities) is unaffected', () => {
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
    };
    const decision = runHeuristics(userMessage('What is the capital of France?'), context);
    expect(decision.executionPlan?.compositeMediaModalities).toBeUndefined();
    expect(decision.executionPlan?.stages).toHaveLength(1);
    expect(decision.executionPlan?.stages[0].name).toBe('main');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 3: OrchestrationEngine — isCompositeMediaPlan / executeCompositeMediaPlan
// ─────────────────────────────────────────────────────────────────────────

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

function baseRequest(): ChatRequest {
  return { messages: [{ role: 'user', content: 'make me an image and a video' }] };
}

function compositePlan(modalities: Array<'image' | 'video' | 'audio' | 'file'>): TriageExecutionPlan {
  const capOf: Record<'image' | 'video' | 'audio' | 'file', string> = {
    image: 'image_generation',
    video: 'video_generation',
    audio: 'audio_generation',
    file: 'csv_generation',
  };
  return {
    maxTokens: 4096,
    qualityTarget: 0.8,
    preferSpeed: false,
    requiredCapabilities: modalities.map((m) => capOf[m]),
    estimatedInputTokens: 100,
    strategy: 'single',
    modelCount: 1,
    requiresContinuation: false,
    compositeMediaModalities: modalities,
    stages: modalities.map((m) => ({
      name: `${m}_generation`,
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: [capOf[m]],
      maxTokens: 1024,
      generationPrompt: `Generate ${m} content`,
    })),
  };
}

type IsCompositeMediaPlan = (plan: TriageExecutionPlan) => boolean;
type ExecuteCompositeMediaPlan = (
  originalRequest: ChatRequest,
  context: OrchestrationContext,
  plan: TriageExecutionPlan,
  requestId: string
) => Promise<import('@/types').OrchestrationResult>;

function callIsCompositeMediaPlan(engine: OrchestrationEngine, plan: TriageExecutionPlan): boolean {
  return (engine as unknown as { isCompositeMediaPlan: IsCompositeMediaPlan }).isCompositeMediaPlan(
    plan
  );
}

function callExecuteCompositeMediaPlan(
  engine: OrchestrationEngine,
  request: ChatRequest,
  context: OrchestrationContext,
  plan: TriageExecutionPlan,
  requestId = 'req-composite-test'
): Promise<import('@/types').OrchestrationResult> {
  return (
    engine as unknown as { executeCompositeMediaPlan: ExecuteCompositeMediaPlan }
  ).executeCompositeMediaPlan(request, context, plan, requestId);
}

describe('OrchestrationEngine.isCompositeMediaPlan', () => {
  it('true for a plan with 2+ modalities where every stage is a media stage', () => {
    const engine = makeEngine();
    expect(callIsCompositeMediaPlan(engine, compositePlan(['image', 'video']))).toBe(true);
  });

  it('false when compositeMediaModalities is absent, even with 2+ stages', () => {
    const engine = makeEngine();
    const plan = compositePlan(['image', 'video']);
    delete plan.compositeMediaModalities;
    expect(callIsCompositeMediaPlan(engine, plan)).toBe(false);
  });

  it('false when a stage in the plan is NOT a media-generation stage (mixed pipeline)', () => {
    const engine = makeEngine();
    const plan = compositePlan(['image', 'video']);
    plan.stages.push({
      name: 'summarize',
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: [],
      maxTokens: 512,
    });
    expect(callIsCompositeMediaPlan(engine, plan)).toBe(false);
  });

  it('false for an ordinary single-stage plan', () => {
    const engine = makeEngine();
    expect(callIsCompositeMediaPlan(engine, compositePlan(['image']))).toBe(false);
  });
});

describe('OrchestrationEngine.executeCompositeMediaPlan — parallel execution + accounting', () => {
  it('(a) both independent artifact types succeed and both appear in the final response', async () => {
    const engine = makeEngine();
    const generateImage = vi.fn(async () => ({
      images: [{ url: 'https://example.com/image.png' }],
      provider: 'test-provider',
      model: 'test-image-model',
    }));
    const generateVideo = vi.fn(async () => ({
      videos: [{ url: 'https://example.com/video.mp4' }],
      provider: 'test-provider',
      model: 'test-video-model',
    }));
    const invoker = { generateImage, generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    const result = await callExecuteCompositeMediaPlan(
      engine,
      baseRequest(),
      context,
      compositePlan(['image', 'video'])
    );

    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateVideo).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts?.every((a) => !a.error)).toBe(true);
    const modalities = result.artifacts?.map((a) => a.modality).sort();
    expect(modalities).toEqual(['image', 'video']);
    expect(result.metadata.composite).toBe(true);
    expect(result.metadata.artifactsSucceeded).toBe(2);
    expect(result.metadata.artifactsFailed).toBe(0);
    expect(result.metadata.partialSuccess).toBe(false);
    expect(result.qualityScore).toBeUndefined(); // not degraded
    // Placeholder-text fix (2026-09-08): the composite response's visible
    // content is now real natural-language sentences per artifact, not a
    // "N succeeded, M failed" debug-report header.
    expect(result.finalResponse.choices[0].message.content).toMatch(
      /here is the image you requested/i
    );
    expect(result.finalResponse.choices[0].message.content).toMatch(
      /here is the video you requested/i
    );
  });

  it('(b) one failing artifact while the other succeeds produces a partial-success response with per-item status, not a total failure', async () => {
    const engine = makeEngine();
    const generateImage = vi.fn(async () => ({
      images: [{ url: 'https://example.com/image.png' }],
      provider: 'test-provider',
      model: 'test-image-model',
    }));
    const generateVideo = vi.fn(async () => {
      throw new Error('video provider is down');
    });
    const invoker = { generateImage, generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    const result = await callExecuteCompositeMediaPlan(
      engine,
      baseRequest(),
      context,
      compositePlan(['image', 'video'])
    );

    // Never throws — this IS the response, HTTP 200 all the way up (same
    // decision as chat-request-processor.ts's tool-call succeeded/failed
    // accounting: per-item status embedded in the result, no non-2xx path).
    expect(result.artifacts).toHaveLength(2);
    const imageArtifact = result.artifacts?.find((a) => a.modality === 'image');
    const videoArtifact = result.artifacts?.find((a) => a.modality === 'video');
    expect(imageArtifact?.error).toBeUndefined();
    expect(videoArtifact?.error).toContain('video provider is down');

    expect(result.metadata.artifactsSucceeded).toBe(1);
    expect(result.metadata.artifactsFailed).toBe(1);
    expect(result.metadata.partialSuccess).toBe(true);
    // Partial success is NOT the same as "all failed" — qualityScore must
    // NOT be zeroed out and `degraded` must not be set for a partial result.
    expect(result.qualityScore).toBeUndefined();
    expect(result.metadata.degraded).toBeUndefined();
    // Placeholder-text fix: natural success sentence for the artifact that
    // worked, a clear failure note (unchanged) for the one that didn't.
    expect(result.finalResponse.choices[0].message.content).toMatch(
      /here is the image you requested/i
    );
    expect(result.finalResponse.choices[0].message.content).toMatch(
      /video generation failed: video provider is down/i
    );
  });

  it('all artifacts failing is reported as degraded (HTTP 200 + qualityScore 0), matching executeMultiStagePlan\'s existing convention', async () => {
    const engine = makeEngine();
    const generateImage = vi.fn(async () => {
      throw new Error('image provider is down');
    });
    const generateVideo = vi.fn(async () => {
      throw new Error('video provider is down');
    });
    const invoker = { generateImage, generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    const result = await callExecuteCompositeMediaPlan(
      engine,
      baseRequest(),
      context,
      compositePlan(['image', 'video'])
    );

    expect(result.qualityScore).toBe(0);
    expect(result.metadata.degraded).toBe(true);
    expect(result.metadata.degraded_reason).toBe('composite_all_artifacts_failed');
    expect(result.metadata.partialSuccess).toBe(false);
  });

  it('(c) the whole-pipeline deadline actually bounds wall-clock time — proven, not just asserted', async () => {
    const engine = makeEngine();
    const generateImage = vi.fn(async () => ({
      images: [{ url: 'https://example.com/image.png' }],
      provider: 'test-provider',
      model: 'test-image-model',
    }));
    // Simulates a hung/very slow provider call — resolves long after any
    // reasonable deadline. If the composite pipeline actually waited for
    // this, the test itself would take >5s; the deadline must make it
    // return almost immediately instead.
    const generateVideo = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ videos: [{ url: 'https://example.com/late.mp4' }] }),
            5000
          );
        })
    );
    const invoker = { generateImage, generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    const previousDeadline = process.env.COMPOSITE_MEDIA_DEADLINE_MS;
    process.env.COMPOSITE_MEDIA_DEADLINE_MS = '150';
    try {
      const startedAt = Date.now();
      const result = await callExecuteCompositeMediaPlan(
        engine,
        baseRequest(),
        context,
        compositePlan(['image', 'video'])
      );
      const elapsedMs = Date.now() - startedAt;

      // The real straggler takes 5000ms — proving the deadline fired means
      // the call returned in a small fraction of that, bounded by the
      // configured 150ms deadline (generous margin for CI/test jitter).
      expect(elapsedMs).toBeLessThan(2000);

      const imageArtifact = result.artifacts?.find((a) => a.modality === 'image');
      const videoArtifact = result.artifacts?.find((a) => a.modality === 'video');
      expect(imageArtifact?.error).toBeUndefined();
      expect(videoArtifact?.error).toMatch(/deadline exceeded/i);
      expect(result.metadata.partialSuccess).toBe(true);
      expect(result.metadata.compositeDeadlineMs).toBe(150);
    } finally {
      if (previousDeadline === undefined) delete process.env.COMPOSITE_MEDIA_DEADLINE_MS;
      else process.env.COMPOSITE_MEDIA_DEADLINE_MS = previousDeadline;
    }
  }, 10000);
});
