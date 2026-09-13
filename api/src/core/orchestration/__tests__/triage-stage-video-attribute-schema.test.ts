// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * triage-stage-video-attribute-schema.test.ts — LOTE AS finding #3
 * (2026-09-06)
 *
 * `TriageStageSchema` gained four additive, optional video-generation
 * attribute fields (duration/resolution/aspect_ratio/audio_requested). This
 * asserts they parse correctly, are additive (a stage that omits them still
 * parses to `undefined`, not a default), and that the top-level `.strict()`
 * `TriageResponseSchema` is untouched by this change — an unrelated unknown
 * top-level key must still fail loudly (T-Strict, Lote 3).
 */
import { describe, it, expect } from 'vitest';
import { TriageStageSchema, TriageResponseSchema } from '@/core/orchestration/triage-schema';

describe('TriageStageSchema — structured video attributes', () => {
  it('parses all four fields when present', () => {
    const parsed = TriageStageSchema.parse({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
      generation_prompt: 'A drone shot of a mountain range at sunrise.',
      duration: 30,
      resolution: '4K',
      aspect_ratio: '16:9',
      audio_requested: true,
    });
    expect(parsed.duration).toBe(30);
    expect(parsed.resolution).toBe('4K');
    expect(parsed.aspect_ratio).toBe('16:9');
    expect(parsed.audio_requested).toBe(true);
  });

  it('leaves them undefined (not a fabricated default) when the stage omits them', () => {
    const parsed = TriageStageSchema.parse({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
    });
    expect(parsed.duration).toBeUndefined();
    expect(parsed.resolution).toBeUndefined();
    expect(parsed.aspect_ratio).toBeUndefined();
    expect(parsed.audio_requested).toBeUndefined();
  });

  it('rejects a non-positive or absurdly long duration', () => {
    expect(() =>
      TriageStageSchema.parse({ name: 'x', required_capabilities: [], duration: 0 })
    ).toThrow();
    expect(() =>
      TriageStageSchema.parse({ name: 'x', required_capabilities: [], duration: -5 })
    ).toThrow();
    expect(() =>
      TriageStageSchema.parse({ name: 'x', required_capabilities: [], duration: 999_999 })
    ).toThrow();
  });

  it('allows audio_requested: false (explicit "no audio"), distinct from omitted', () => {
    const parsed = TriageStageSchema.parse({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
      audio_requested: false,
    });
    expect(parsed.audio_requested).toBe(false);
  });

  it('a stage-level unknown/experimental key is still stripped, not rejected (unaffected by this change)', () => {
    const parsed = TriageStageSchema.parse({
      name: 'video_generation',
      required_capabilities: ['video_generation'],
      some_future_experimental_field: 'whatever',
    });
    expect((parsed as Record<string, unknown>).some_future_experimental_field).toBeUndefined();
  });

  it('the top-level .strict() schema still rejects an unknown TOP-LEVEL key (untouched by this additive stage-level change)', () => {
    const result = TriageResponseSchema.safeParse({
      intent: 'general',
      this_is_not_a_real_top_level_field: true,
    });
    expect(result.success).toBe(false);
  });
});
