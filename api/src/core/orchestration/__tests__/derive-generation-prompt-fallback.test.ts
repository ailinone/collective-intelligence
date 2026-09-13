// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * derive-generation-prompt-fallback.test.ts — LOTE AS finding #2/#3
 * (2026-09-06)
 *
 * `deriveGenerationPromptFallback` fires when the triage LLM omits
 * `generationPrompt` for a media/file-generation stage. Before this fix it
 * only tried `stage.taskContext` (documented OPTIONAL in
 * TRIAGE_SYSTEM_PROMPT) then `accumulatedContext` (empty for the common
 * single/first-stage case) — so a validly-omitted `task_context` on a
 * first-stage plan fell straight through to the fully generic placeholder,
 * silently discarding the user's actual request. The fix adds a third tier:
 * the ORIGINAL user request text, always tried before the generic
 * placeholder.
 *
 * Per the diagnosis (re-confirmed against `parseResponse`/`buildStageFromValidated`
 * in triage-service.ts — no retry loop exists anywhere in the triage path),
 * `generation_prompt` is deliberately NOT made schema-required: a Zod
 * rejection here would discard the ENTIRE triage decision (intent,
 * complexity, every correctly-classified stage) to heuristic fallback over
 * one missing string, which is strictly worse. This fallback chain plus the
 * `TRIAGE_GENERATION_PROMPT_MISSING` observability counter
 * (triage-service.ts's `buildStageFromValidated`) is the chosen remediation.
 */
import { describe, it, expect } from 'vitest';
import { deriveGenerationPromptFallback } from '@/core/orchestration/orchestration-engine';
import type { TriageStage } from '@/types';

function stage(overrides: Partial<TriageStage> = {}): TriageStage {
  return {
    name: 'video_generation',
    strategy: 'single',
    modelRoles: [],
    requiredCapabilities: ['video_generation'],
    maxTokens: 1024,
    ...overrides,
  };
}

describe('deriveGenerationPromptFallback', () => {
  it('prefers stage.taskContext when present', () => {
    expect(deriveGenerationPromptFallback(stage({ taskContext: 'A sunset over mountains' }), '', 'ignored')).toBe(
      'A sunset over mountains'
    );
  });

  it('falls back to accumulatedContext next', () => {
    expect(deriveGenerationPromptFallback(stage(), 'prior stage output', 'ignored')).toBe(
      'prior stage output'
    );
  });

  it('falls back to the ORIGINAL user request text when task_context/accumulatedContext are both empty (the regression: previously lost)', () => {
    expect(
      deriveGenerationPromptFallback(
        stage(),
        '',
        'Generate a 30-second 4K video with audio and soundtrack.'
      )
    ).toBe('Generate a 30-second 4K video with audio and soundtrack.');
  });

  it('only uses the generic placeholder when every real source is empty or the sentinel "Unknown task"', () => {
    expect(deriveGenerationPromptFallback(stage(), '', 'Unknown task')).toBe(
      'Generate content for stage "video_generation"'
    );
    expect(deriveGenerationPromptFallback(stage(), '', '')).toBe(
      'Generate content for stage "video_generation"'
    );
  });

  it('respects priority order: taskContext > accumulatedContext > original request > generic placeholder', () => {
    expect(
      deriveGenerationPromptFallback(
        stage({ taskContext: 'task context wins' }),
        'accumulated context',
        'original request'
      )
    ).toBe('task context wins');
    expect(deriveGenerationPromptFallback(stage(), 'accumulated context', 'original request')).toBe(
      'accumulated context'
    );
  });
});
