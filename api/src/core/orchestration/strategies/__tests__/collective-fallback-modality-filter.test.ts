// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sequential/parallel strategy fallback — modality filter regression test.
 *
 * DB forensics on completed C3 experiments found `collective/dynamic` rows
 * (armId `collective::sequential`) whose fallback chain resolved to
 * VIDEO-GENERATION model IDs (kling/kling-3.0-4k, bytedance/seedance-2-mini,
 * google/veo-3.1, openai/sora-2, openai/sora-2-pro) for a TEXT benchmark
 * task — success=true, quality_score≈0, and the integrity guard's own
 * policyValidation flagged `fallback_depth_exceeded`.
 *
 * Root cause: context.models is intentionally unfiltered by modality (see
 * orchestration-engine.ts's "no pre-filtering" comment) — capability
 * filtering is expected to happen downstream. The primary
 * DynamicModelSelector path does that via its own chat-capability gate,
 * but when that path throws or returns no candidates, both
 * SequentialStrategy and ParallelStrategy fell through to a LOCAL fallback
 * branch that scored `context.models` directly with no capability check at
 * all — scoreAsAnalyzer/scoreAsExecutor/scoreModelForParallel rank purely
 * on contextWindow/latency/cost/quality, none of which exclude a
 * video/image/audio-only model.
 *
 * This test forces both strategies into that fallback branch (by making
 * the primary DynamicModelSelector path throw) with a model pool
 * containing the exact production video-model IDs mixed with legitimate
 * chat models, and asserts the video models never win a slot.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import { SequentialStrategy } from '../sequential-strategy';
import { ParallelStrategy } from '../parallel-strategy';
import { makeModel, makeContext } from './consensus-strategy.fixtures';

vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => {
    throw new Error('forced failure — test exercises the local fallback branch');
  },
}));

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function makeRequest(): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Summarize this document.' }],
  };
}

// Exact model IDs observed in the production DB rows for this bug.
const videoModels: Model[] = [
  makeModel({ id: 'kling/kling-3.0-4k', provider: 'kling', capabilities: ['video_generation'] }),
  makeModel({ id: 'bytedance/seedance-2-mini', provider: 'bytedance', capabilities: ['video_generation'] }),
];
const chatModels: Model[] = [
  makeModel({ id: 'chat-model-fast', provider: 'prov-fast', capabilities: ['chat', 'text_generation'] }),
  makeModel({ id: 'chat-model-quality', provider: 'prov-quality', capabilities: ['chat', 'text_generation'] }),
];

function wireGetAdapter(strategy: unknown): void {
  const anyStrat = strategy as Record<string, unknown>;
  anyStrat.log = silentLogger;
  anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
    getName: () => model.provider,
    chatCompletion: async () => { throw new Error('not called by selectModels'); },
    calculateCost: () => 0,
  }));
}

describe('SequentialStrategy fallback — modality filter', () => {
  it('never selects a video-generation model for analyzer or executor', async () => {
    const strategy = new SequentialStrategy();
    wireGetAdapter(strategy);

    const context: OrchestrationContext = makeContext([...videoModels, ...chatModels]);
    const selected = await (strategy as unknown as {
      selectModels: (r: ChatRequest, c: OrchestrationContext) => Promise<Array<{ model: Model }>>;
    }).selectModels(makeRequest(), context);

    const selectedIds = selected.map((s) => s.model.id);
    expect(selectedIds).not.toContain('kling/kling-3.0-4k');
    expect(selectedIds).not.toContain('bytedance/seedance-2-mini');
    // Sanity: the fallback still found real (chat-capable) candidates —
    // an empty result would trivially "pass" the assertions above without
    // actually proving the filter selected the right models.
    expect(selectedIds.length).toBeGreaterThan(0);
    for (const id of selectedIds) {
      expect(['chat-model-fast', 'chat-model-quality']).toContain(id);
    }
  });

  it('returns no selection when the pool is entirely non-chat models (no crash)', async () => {
    const strategy = new SequentialStrategy();
    wireGetAdapter(strategy);

    const context: OrchestrationContext = makeContext([...videoModels]);
    const selected = await (strategy as unknown as {
      selectModels: (r: ChatRequest, c: OrchestrationContext) => Promise<Array<{ model: Model }>>;
    }).selectModels(makeRequest(), context);

    expect(selected).toEqual([]);
  });
});

describe('ParallelStrategy fallback — modality filter', () => {
  it('never selects a video-generation model for either parallel slot', async () => {
    const strategy = new ParallelStrategy();
    wireGetAdapter(strategy);

    const context: OrchestrationContext = makeContext([...videoModels, ...chatModels]);
    const selected = await (strategy as unknown as {
      selectModels: (r: ChatRequest, c: OrchestrationContext, exclude?: readonly string[]) => Promise<Array<{ model: Model }>>;
    }).selectModels(makeRequest(), context);

    const selectedIds = selected.map((s) => s.model.id);
    expect(selectedIds).not.toContain('kling/kling-3.0-4k');
    expect(selectedIds).not.toContain('bytedance/seedance-2-mini');
    expect(selectedIds.length).toBeGreaterThan(0);
    for (const id of selectedIds) {
      expect(['chat-model-fast', 'chat-model-quality']).toContain(id);
    }
  });

  it('returns no selection when the pool is entirely non-chat models (no crash)', async () => {
    const strategy = new ParallelStrategy();
    wireGetAdapter(strategy);

    const context: OrchestrationContext = makeContext([...videoModels]);
    const selected = await (strategy as unknown as {
      selectModels: (r: ChatRequest, c: OrchestrationContext, exclude?: readonly string[]) => Promise<Array<{ model: Model }>>;
    }).selectModels(makeRequest(), context);

    expect(selected).toEqual([]);
  });
});
