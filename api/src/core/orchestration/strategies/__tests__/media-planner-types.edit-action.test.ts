// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PlannerActionSchema — `edit` action kind (Section D).
 *
 * Additive coverage only. The existing `capability_call` / `generate` /
 * `final` members are already covered by `media-planner-strategy.test.ts`
 * and are NOT touched by this change — this file only proves the new
 * member parses correctly and rejects malformed input.
 */
import { describe, it, expect } from 'vitest';
import { PlannerActionSchema } from '../media-planner-types';

describe('PlannerActionSchema — edit action', () => {
  it('parses a minimal edit action (prompt only)', () => {
    const parsed = PlannerActionSchema.parse({
      kind: 'edit',
      prompt: 'make the sky more orange at sunset',
    });
    expect(parsed).toEqual({ kind: 'edit', prompt: 'make the sky more orange at sunset' });
  });

  it('parses an edit action with sourceArtifactIndex and constraints', () => {
    const parsed = PlannerActionSchema.parse({
      kind: 'edit',
      prompt: 'remove the background',
      sourceArtifactIndex: 0,
      constraints: {
        dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
        format: 'png',
      },
      reasoning: 'the user asked for a transparent background',
    });
    expect(parsed.kind).toBe('edit');
    if (parsed.kind === 'edit') {
      expect(parsed.sourceArtifactIndex).toBe(0);
      expect(parsed.constraints?.format).toBe('png');
    }
  });

  it('rejects an edit action missing "prompt"', () => {
    expect(() => PlannerActionSchema.parse({ kind: 'edit' })).toThrow();
  });

  it('rejects an edit action with a negative sourceArtifactIndex', () => {
    expect(() =>
      PlannerActionSchema.parse({ kind: 'edit', prompt: 'x', sourceArtifactIndex: -1 })
    ).toThrow();
  });

  it('still parses the existing three action kinds unmodified (regression guard)', () => {
    expect(PlannerActionSchema.parse({ kind: 'final', content: 'done', unmetConstraints: [] }).kind).toBe(
      'final'
    );
    expect(
      PlannerActionSchema.parse({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }).kind
    ).toBe('generate');
    expect(
      PlannerActionSchema.parse({ kind: 'capability_call', capability: 'pdf_understanding' }).kind
    ).toBe('capability_call');
  });
});
