// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * heuristic-media-intent-safety-net.test.ts — LOTE AS finding #4 (2026-09-06)
 *
 * Regression coverage for the silent-fallback-to-plain-chat reliability bug:
 * when a real triage LLM call fails (timeout/429, unparseable output, no
 * triage-capable model resolved), `TriagingService.triage()` falls back to
 * `runHeuristics()`. Before this fix, an obvious media-generation request
 * that the PRIMARY capability-inference regexes did not catch produced
 * `requiredCapabilities: []`, confidence 0.3, and a generic
 * "Heuristic triage fallback" reason indistinguishable from ordinary chat —
 * the request silently became a plain chat turn with zero media output and
 * no visible error.
 *
 * `detectHeuristicMediaIntent` is the broad, deliberately looser safety net
 * that now runs INSIDE the heuristic path only (never the primary path,
 * where a false positive would hijack an ordinary chat turn).
 */
import { describe, it, expect } from 'vitest';
import { TriagingService, detectHeuristicMediaIntent } from '@/core/orchestration/triage-service';
import type { ChatRequest, OrchestrationContext, TriageDecision } from '@/types';

describe('detectHeuristicMediaIntent (pure function)', () => {
  it('detects pt-BR video-generation intent', () => {
    expect(detectHeuristicMediaIntent('Gere um vídeo de 30 segundos em 4K com áudio e trilha sonora.')).toBe(
      'video_generation'
    );
  });

  it('detects en video-generation intent — the exact live-test phrasing from the grounding', () => {
    expect(detectHeuristicMediaIntent('Generate a 30-second 4K video with audio and soundtrack.')).toBe(
      'video_generation'
    );
  });

  it('detects en image-generation intent', () => {
    expect(detectHeuristicMediaIntent('Please create an image of a sunset')).toBe('image_generation');
  });

  it('detects pt-BR audio/soundtrack intent', () => {
    expect(detectHeuristicMediaIntent('componha uma trilha sonora triste')).toBe('audio_generation');
  });

  it('detects a generic document/report request as file_generation', () => {
    expect(detectHeuristicMediaIntent('crie um relatório de vendas do trimestre')).toBe('file_generation');
  });

  it('requires a verb, not just a bare noun', () => {
    expect(detectHeuristicMediaIntent('what is a video codec')).toBeUndefined();
  });

  it('leaves ordinary chat requests undetected', () => {
    expect(detectHeuristicMediaIntent('what is the weather like today')).toBeUndefined();
  });
});

/**
 * `runHeuristics` is private — this is the exact same "structural stub +
 * cast" pattern already used by
 * `triage-prompt-capability-consistency.test.ts` for `buildPrompt`, which
 * documents that these helpers touch neither the provider registry nor
 * config beyond reading them off `this`.
 */
type RunHeuristics = (request: ChatRequest, context: OrchestrationContext) => TriageDecision;

function runHeuristics(request: ChatRequest, context: OrchestrationContext): TriageDecision {
  const service = new TriagingService({} as never, { temperature: 0.1, maxTokens: 2048 });
  return (service as unknown as { runHeuristics: RunHeuristics }).runHeuristics(request, context);
}

function contextWithoutCapabilityInference(): OrchestrationContext {
  return {
    organizationId: 'org-test',
    requestId: 'req-test',
    models: [],
    taskType: 'general',
    contextSize: 0,
    // Deliberately no `capabilityInference` — simulates the primary,
    // precision-tuned regex path (capability-inference.ts) finding nothing,
    // which is exactly the false-negative case the broad safety net exists
    // to catch.
  };
}

function userMessage(content: string): ChatRequest {
  return { messages: [{ role: 'user', content }] };
}

describe('runHeuristics — broad media-intent safety net (triage() fallback path)', () => {
  it('en: an obvious video-generation request gets a real requiredCapabilities array, not empty', () => {
    const request = userMessage('Generate a 30-second 4K video with audio and soundtrack.');
    const decision = runHeuristics(request, contextWithoutCapabilityInference());

    // The stage-level `requiredCapabilities` is what
    // `detectMediaGenerationModality` in orchestration-engine.ts actually
    // reads to route a stage into the real media-generation path — this is
    // the field that was empty before the fix.
    expect(decision.executionPlan?.stages?.[0]?.requiredCapabilities).toEqual(['video_generation']);
    expect(decision.executionPlan?.stages?.[0]?.generationPrompt).toContain('30-second 4K video');
  });

  it('pt-BR: an obvious video-generation request gets a real requiredCapabilities array, not empty', () => {
    const request = userMessage('Gere um vídeo de 30 segundos em 4K com áudio e trilha sonora.');
    const decision = runHeuristics(request, contextWithoutCapabilityInference());

    expect(decision.executionPlan?.stages?.[0]?.requiredCapabilities).toEqual(['video_generation']);
  });

  it('marks the decision as a heuristic/degraded decision via `source`, never confused with a confident LLM decision', () => {
    const request = userMessage('Gere um vídeo de 30 segundos em 4K com áudio e trilha sonora.');
    const decision = runHeuristics(request, contextWithoutCapabilityInference());

    expect(decision.source).toBe('heuristic');
    expect(decision.reason).toMatch(/heuristic/i);
    expect(decision.reason).toMatch(/broad safety net/i);
    expect(decision.reason).toContain('video_generation');
  });

  it('en: still fires when phrased with "create" instead of "generate"', () => {
    const request = userMessage('Please create a short video of a cat playing piano, with sound.');
    const decision = runHeuristics(request, contextWithoutCapabilityInference());
    expect(decision.executionPlan?.stages?.[0]?.requiredCapabilities).toEqual(['video_generation']);
  });

  it('an ordinary chat request keeps requiredCapabilities empty and a generic (not media) reason', () => {
    const request = userMessage('What is the capital of France?');
    const decision = runHeuristics(request, contextWithoutCapabilityInference());

    expect(decision.executionPlan?.requiredCapabilities).toEqual([]);
    expect(decision.source).toBe('heuristic');
    expect(decision.reason).toBe('Heuristic triage fallback');
    expect(decision.reason).not.toMatch(/media/i);
  });

  it('the PRIMARY capability-inference signal still wins over the broad net when both are present, and is labelled distinctly', () => {
    const context: OrchestrationContext = {
      ...contextWithoutCapabilityInference(),
      capabilityInference: {
        requiredCapabilities: ['image_generation'],
        confidence: 0.9,
        matchedPatterns: [],
      } as unknown as OrchestrationContext['capabilityInference'],
    };
    // Body text would ALSO match the broad video net, but the primary signal
    // (image_generation) must win and use the higher-confidence, non-"broad
    // safety net" reason string.
    const request = userMessage('Generate a video thumbnail image for my channel');
    const decision = runHeuristics(request, context);

    expect(decision.executionPlan?.requiredCapabilities).toEqual(['image_generation']);
    expect(decision.reason).toContain('media generation detected: image_generation');
    expect(decision.reason).not.toMatch(/broad safety net/i);
  });
});
