// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-planner-gate — the cheap routing heuristic + native-collapse check
 * (LOTE AT, Part 2).
 */
import { describe, it, expect } from 'vitest';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import {
  evaluateMediaPlannerGate,
  findNativeCollapseModel,
  resolveMediaPlanRouting,
} from '../media-planner-gate';

function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 128000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: overrides.capabilities ?? ['chat', 'text_generation'],
    performance: overrides.performance ?? {
      latencyMs: 1000,
      throughput: 100,
      quality: 0.9,
      reliability: 0.95,
    },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    metadata: overrides.metadata,
  };
}

function makeRequest(text: string): ChatRequest {
  return { model: 'auto', messages: [{ role: 'user', content: text }] };
}

function makeContext(models: Model[] = [], overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: 'req-test',
    models,
    taskType: 'creative',
    contextSize: 1000,
    ...overrides,
  };
}

describe('evaluateMediaPlannerGate', () => {
  it('does not route a plain text request', () => {
    const result = evaluateMediaPlannerGate(makeRequest('Write me a short poem about the sea'), makeContext());
    expect(result.route).toBe(false);
  });

  it('routes when multiple media-generation-adjacent capabilities are named', () => {
    const result = evaluateMediaPlannerGate(
      makeRequest('Generate a video with a soundtrack playing in the background'),
      makeContext()
    );
    expect(result.route).toBe(true);
    expect(result.detectedCapabilities).toContain('video_generation');
  });

  it('routes on an explicit attribute constraint (duration + resolution) alongside a single media capability', () => {
    const result = evaluateMediaPlannerGate(
      makeRequest('Generate a 30 second 4k video of a sunrise'),
      makeContext()
    );
    expect(result.route).toBe(true);
    expect(result.detectedConstraints.durationSec?.minSec).toBe(30);
    expect(result.detectedConstraints.resolution).toEqual({ width: 3840, height: 2160 });
  });

  it('does not route a single media-generation capability with no attribute constraint', () => {
    const result = evaluateMediaPlannerGate(makeRequest('Generate an image of a cat'), makeContext());
    expect(result.route).toBe(false);
  });
});

describe('resolveMediaPlanRouting — flag-off is structurally unreachable', () => {
  it('returns a fixed disabled result and never evaluates the heuristic when enabled=false', () => {
    // This request WOULD route if the heuristic ran (multi-capability +
    // explicit constraints) — the point of this test is that flipping
    // enabled=false must short-circuit before any of that scanning happens.
    const request = makeRequest('Generate a 30 second 4k video with a soundtrack');
    const context = makeContext();

    const disabled = resolveMediaPlanRouting(request, context, false);
    expect(disabled).toEqual({
      route: false,
      reason: 'MEDIA_PLANNER_ENABLED is false',
      detectedCapabilities: [],
      detectedConstraints: {},
    });

    const enabled = resolveMediaPlanRouting(request, context, true);
    expect(enabled.route).toBe(true);
  });
});

describe('findNativeCollapseModel', () => {
  it('returns undefined when no constraints are given', () => {
    const models = [makeModel({ id: 'v1', capabilities: ['video_generation'] })];
    expect(findNativeCollapseModel(models, 'video_generation', undefined)).toBeUndefined();
  });

  it('returns undefined when no model exposes capabilityAttributes (LOTE AS not landed — fail open)', () => {
    const models = [makeModel({ id: 'v1', capabilities: ['video_generation'] })];
    const match = findNativeCollapseModel(models, 'video_generation', {
      requireAudioTrack: true,
      durationSec: { minSec: 30 },
    });
    expect(match).toBeUndefined();
  });

  it('short-circuits decomposition when a model natively satisfies every stated constraint', () => {
    const models = [
      makeModel({ id: 'plain-video', capabilities: ['video_generation'] }),
      makeModel({
        id: 'joint-audio-video',
        capabilities: ['video_generation'],
        metadata: {
          capabilityAttributes: {
            nativeAudioSupport: true,
            supportsJointAudioVideo: true,
            maxDurationSec: 60,
            maxResolution: { width: 3840, height: 2160 },
          },
        },
      }),
    ];
    const match = findNativeCollapseModel(models, 'video_generation', {
      requireAudioTrack: true,
      durationSec: { minSec: 30 },
      resolution: { width: 3840, height: 2160 },
    });
    expect(match?.model.id).toBe('joint-audio-video');
  });

  it('does not match a model whose native attributes fall short of a constraint', () => {
    const models = [
      makeModel({
        id: 'audio-but-short',
        capabilities: ['video_generation'],
        metadata: {
          capabilityAttributes: { nativeAudioSupport: true, maxDurationSec: 10 },
        },
      }),
    ];
    const match = findNativeCollapseModel(models, 'video_generation', {
      requireAudioTrack: true,
      durationSec: { minSec: 30 },
    });
    expect(match).toBeUndefined();
  });
});
