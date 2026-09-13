// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * mergeArtifacts() — PR1 of the media/document generation + collective
 * orchestration plan (pure additive plumbing, see base-strategy.ts).
 *
 * `mergeArtifacts()` flattens every `.artifacts` array found across a list of
 * `ModelExecution`s into one array, preserving order, with no deduplication.
 * Nothing populates `ModelExecution.artifacts` in production yet and no
 * strategy calls this yet — these tests lock the flattening contract ahead of
 * that wiring (PR2/PR3).
 *
 * Placed directly under core/orchestration/ (not __tests__/), matching
 * base-strategy-quality-score.test.ts and base-strategy-feedback-quality.test.ts:
 * `src/core/orchestration/__tests__/**` is excluded from vitest.ci.config.ts
 * (those suites need the orchestration-specific mocks in
 * vitest.orchestration.config.ts) but this is a hermetic pure-function unit
 * test with no such dependency.
 */

import { describe, it, expect } from 'vitest';
import { mergeArtifacts } from '@/core/orchestration/base-strategy';
import type { ArtifactRef, ChatRequest, ChatResponse, ModelExecution } from '@/types';
import type { ToolResult } from '@/services/advanced-tool-execution-service';

const req = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hi' }],
} as ChatRequest;

function mkResponse(): ChatResponse {
  return {
    id: 'r',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  } as ChatResponse;
}

/** Minimal valid ModelExecution, with an optional `.artifacts` override. */
function mkExecution(artifacts?: ArtifactRef[]): ModelExecution {
  return {
    modelId: 'm',
    modelName: 'm',
    role: 'primary',
    request: req,
    response: mkResponse(),
    cost: 0,
    durationMs: 1,
    success: true,
    artifacts,
  } as ModelExecution;
}

function mkArtifact(url: string): ArtifactRef {
  return { type: 'image', url };
}

describe('mergeArtifacts()', () => {
  it('returns [] for an empty execution list', () => {
    expect(mergeArtifacts([])).toEqual([]);
  });

  it('returns [] when no execution carries an .artifacts field', () => {
    const executions = [mkExecution(undefined), mkExecution(undefined)];
    expect(mergeArtifacts(executions)).toEqual([]);
  });

  it('flattens .artifacts from executions that carry them, preserving order', () => {
    const a1 = mkArtifact('https://example.com/a1.png');
    const a2 = mkArtifact('https://example.com/a2.png');
    const a3 = mkArtifact('https://example.com/a3.png');
    const executions = [mkExecution([a1, a2]), mkExecution([a3])];
    expect(mergeArtifacts(executions)).toEqual([a1, a2, a3]);
  });

  it('mixes executions with and without .artifacts — only present ones contribute, original order preserved', () => {
    const a1 = mkArtifact('https://example.com/a1.png');
    const a2 = mkArtifact('https://example.com/a2.png');
    const a3 = mkArtifact('https://example.com/a3.png');
    const executions = [
      mkExecution(undefined),
      mkExecution([a1]),
      mkExecution(undefined),
      mkExecution([a2, a3]),
      mkExecution(undefined),
    ];
    expect(mergeArtifacts(executions)).toEqual([a1, a2, a3]);
  });

  it('does not mutate the input executions or their .artifacts arrays', () => {
    const a1 = mkArtifact('https://example.com/a1.png');
    const execution = mkExecution([a1]);
    const originalArtifacts = execution.artifacts;
    mergeArtifacts([execution]);
    expect(execution.artifacts).toBe(originalArtifacts);
    expect(execution.artifacts).toEqual([a1]);
  });
});

describe('ArtifactRef / ToolResult.artifact structural compatibility', () => {
  it('a ToolResult.artifact value is assignable into an ArtifactRef[] without a cast (compile-time check)', () => {
    const toolResult: ToolResult = {
      tool_call_id: 'call_1',
      success: true,
      artifact: {
        type: 'image',
        url: 'https://example.com/generated.png',
        mimeType: 'image/png',
        meta: { seed: 42 },
      },
    };

    const refs: ArtifactRef[] = [];
    if (toolResult.artifact) {
      // No cast: if this line fails to compile, ToolResult.artifact and
      // ArtifactRef have drifted out of structural sync.
      refs.push(toolResult.artifact);
    }

    expect(refs).toEqual([
      {
        type: 'image',
        url: 'https://example.com/generated.png',
        mimeType: 'image/png',
        meta: { seed: 42 },
      },
    ]);
  });

  it('mergeArtifacts() accepts artifacts sourced directly from ToolResult.artifact', () => {
    const toolResult: ToolResult = {
      tool_call_id: 'call_2',
      success: true,
      artifact: { type: 'video', url: 'https://example.com/generated.mp4' },
    };

    const execution = mkExecution(toolResult.artifact ? [toolResult.artifact] : []);
    expect(mergeArtifacts([execution])).toEqual([
      { type: 'video', url: 'https://example.com/generated.mp4' },
    ]);
  });
});
