// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * generation-prompt-missing-observability.test.ts — LOTE AS finding #2
 * (2026-09-06)
 *
 * `buildStageFromValidated` counts (via `TRIAGE_GENERATION_PROMPT_MISSING`)
 * every time a REAL (LLM) triage response omits `generation_prompt` for a
 * generation-capability stage, despite the system prompt's "ALWAYS set
 * generation_prompt" rule. This is purely observational — it never rejects
 * the parse — so this test asserts the counter increments (giving operators
 * a real signal for how often the LLM violates its own rule) without
 * asserting anything about parse success/failure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TriagingService } from '@/core/orchestration/triage-service';
import { TriageStageSchema, type TriageStageRaw } from '@/core/orchestration/triage-schema';
import {
  getPromptMetric,
  PROMPT_METRIC_NAMES,
  resetPromptMetrics,
} from '@/core/orchestration/prompts/prompt-metrics';
import type { TriageStage } from '@/types';

type BuildStageFromValidated = (raw: TriageStageRaw) => TriageStage;

function buildStage(raw: unknown): TriageStage {
  const service = new TriagingService({} as never, { temperature: 0.1, maxTokens: 2048 });
  const parsed = TriageStageSchema.parse(raw);
  return (service as unknown as { buildStageFromValidated: BuildStageFromValidated }).buildStageFromValidated(
    parsed
  );
}

describe('buildStageFromValidated — generation_prompt missing observability', () => {
  beforeEach(() => {
    resetPromptMetrics();
  });

  it('increments TRIAGE_GENERATION_PROMPT_MISSING when a video_generation stage omits generation_prompt', () => {
    expect(getPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_GENERATION_PROMPT_MISSING)).toBe(0);

    buildStage({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
      // generation_prompt intentionally omitted
    });

    expect(getPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_GENERATION_PROMPT_MISSING)).toBe(1);
  });

  it('does NOT increment the counter when generation_prompt is present', () => {
    buildStage({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
      generation_prompt: 'A drone shot of a mountain range at sunrise.',
    });

    expect(getPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_GENERATION_PROMPT_MISSING)).toBe(0);
  });

  it('does NOT increment the counter for an ordinary chat stage (no generation capability)', () => {
    buildStage({
      name: 'main',
      required_capabilities: ['reasoning'],
    });

    expect(getPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_GENERATION_PROMPT_MISSING)).toBe(0);
  });

  it('still produces a usable stage even when generation_prompt is missing — the parse is never rejected over this', () => {
    const stage = buildStage({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
    });
    expect(stage.name).toBe('video_generation');
    expect(stage.requiredCapabilities).toEqual(['video_generation']);
    expect(stage.generationPrompt).toBeUndefined();
  });
});
