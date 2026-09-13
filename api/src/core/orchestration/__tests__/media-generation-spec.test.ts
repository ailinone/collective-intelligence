// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the deterministic media-generation spec extraction fallback
 * (Package A). Covers duration/resolution/aspect-ratio/audio extraction from
 * natural language, including the exact phrasings named in the audit ("30
 * second 4K video with a soundtrack", "1080p, 10s, no audio needed").
 *
 * Catalog-attribute COMPARISON is intentionally NOT tested here — that logic
 * lives in `@/providers/catalog/video-capability-matcher.ts` (already tested
 * in `video-capability-matcher.test.ts`) and is out of this module's scope;
 * see the module doc for why.
 */
import { describe, it, expect } from 'vitest';
import {
  extractAspectRatio,
  extractDurationSeconds,
  extractImageGenerationSpec,
  extractRequiresAudio,
  extractResolution,
  extractVideoGenerationSpec,
  hasVideoGenerationSpecFields,
  mergeVideoGenerationSpec,
} from '../media-generation-spec';

describe('extractDurationSeconds', () => {
  it('parses spelled-out seconds', () => {
    expect(extractDurationSeconds('generate a 30 second video')).toBe(30);
    expect(extractDurationSeconds('a 45-second clip')).toBe(45);
    expect(extractDurationSeconds('12 secs of footage')).toBe(12);
  });

  it('parses minutes and converts to seconds', () => {
    expect(extractDurationSeconds('a 2 minute video')).toBe(120);
    expect(extractDurationSeconds('1.5 minutes long')).toBe(90);
  });

  it('parses the bare shorthand form ("10s")', () => {
    // The exact phrasing from the audit's test cases.
    expect(extractDurationSeconds('1080p, 10s, no audio needed')).toBe(10);
  });

  it('does not misread round-decade references as a duration', () => {
    expect(extractDurationSeconds('make a video with 80s aesthetic')).toBeUndefined();
    expect(extractDurationSeconds('a synthwave video, very 90s vibe')).toBeUndefined();
  });

  it('still catches an explicit 80/90-second request despite the decade guard', () => {
    expect(extractDurationSeconds('an 80 second video')).toBe(80);
    expect(extractDurationSeconds('90-second clip')).toBe(90);
  });

  it('returns undefined when nothing plausible is present', () => {
    expect(extractDurationSeconds('a beautiful sunset over the mountains')).toBeUndefined();
  });
});

describe('extractResolution', () => {
  it('recognizes common resolution tokens', () => {
    // 'K' tokens are uppercase — matches the casing triage extraction uses
    // and byteplus-adapter.ts's case-sensitive RESOLUTIONS set requires, not
    // an arbitrary choice (see the module doc's "NOTE on scope").
    expect(extractResolution('a 4K video')).toBe('4K');
    expect(extractResolution('render in UHD')).toBe('4K');
    expect(extractResolution('1080p please')).toBe('1080p');
    expect(extractResolution('full HD video')).toBe('1080p');
    expect(extractResolution('720p clip')).toBe('720p');
    expect(extractResolution('480p is fine')).toBe('480p');
    expect(extractResolution('8K footage')).toBe('8K');
  });

  it('returns undefined when no resolution is mentioned', () => {
    expect(extractResolution('a video of a cat playing piano')).toBeUndefined();
  });
});

describe('extractAspectRatio', () => {
  it('recognizes explicit known ratios', () => {
    expect(extractAspectRatio('in 16:9')).toBe('16:9');
    expect(extractAspectRatio('vertical 9:16 format')).toBe('9:16');
  });

  it('does not false-positive on clock times or scores', () => {
    expect(extractAspectRatio('meet me at 10:30')).toBeUndefined();
    expect(extractAspectRatio('the match ended 2:1')).toBeUndefined();
  });

  it('maps descriptive words to ratios', () => {
    expect(extractAspectRatio('a vertical video for stories')).toBe('9:16');
    expect(extractAspectRatio('landscape orientation')).toBe('16:9');
    expect(extractAspectRatio('a square video')).toBe('1:1');
  });
});

describe('extractRequiresAudio', () => {
  it('detects an explicit audio/soundtrack request', () => {
    expect(extractRequiresAudio('a 30 second 4K video with a soundtrack')).toBe(true);
    expect(extractRequiresAudio('please add background music')).toBe(true);
    expect(extractRequiresAudio('audio track required')).toBe(true);
  });

  it('detects an explicit no-audio request', () => {
    expect(extractRequiresAudio('1080p, 10s, no audio needed')).toBe(false);
    expect(extractRequiresAudio('a silent video of clouds')).toBe(false);
    expect(extractRequiresAudio('without any sound')).toBe(false);
  });

  it('returns undefined when audio is never mentioned', () => {
    expect(extractRequiresAudio('a video of a cat playing piano')).toBeUndefined();
  });
});

describe('extractVideoGenerationSpec — composite', () => {
  it('extracts every field from the audit example phrasing', () => {
    const spec = extractVideoGenerationSpec('a 30 second 4K video with a soundtrack');
    expect(spec).toEqual({
      durationSeconds: 30,
      resolution: '4K',
      requiresAudio: true,
    });
  });

  it('extracts the second audit example phrasing', () => {
    const spec = extractVideoGenerationSpec('1080p, 10s, no audio needed');
    expect(spec).toEqual({
      durationSeconds: 10,
      resolution: '1080p',
      requiresAudio: false,
    });
  });

  it('returns an empty object for prompts with no checkable spec', () => {
    expect(extractVideoGenerationSpec('a dog running on a beach')).toEqual({});
    expect(
      hasVideoGenerationSpecFields(extractVideoGenerationSpec('a dog running on a beach'))
    ).toBe(false);
  });

  it('handles null/undefined/empty input without throwing', () => {
    expect(extractVideoGenerationSpec(undefined)).toEqual({});
    expect(extractVideoGenerationSpec(null)).toEqual({});
    expect(extractVideoGenerationSpec('')).toEqual({});
  });
});

describe('mergeVideoGenerationSpec', () => {
  it('lets explicit per-field values win over extracted ones', () => {
    const extracted = extractVideoGenerationSpec('a 30 second 4K video with a soundtrack');
    const merged = mergeVideoGenerationSpec({ durationSeconds: 15 }, extracted);
    expect(merged.durationSeconds).toBe(15);
    expect(merged.resolution).toBe('4K');
    expect(merged.requiresAudio).toBe(true);
  });

  it('falls back entirely to extracted values when nothing explicit is supplied', () => {
    const extracted = extractVideoGenerationSpec('a 30 second 4K video with a soundtrack');
    expect(mergeVideoGenerationSpec(undefined, extracted)).toEqual(extracted);
  });
});

describe('extractImageGenerationSpec', () => {
  it('maps a vertical/portrait request to the tall size', () => {
    expect(extractImageGenerationSpec('a vertical poster')).toEqual({ size: '1024x1792' });
  });

  it('maps a landscape request to the wide size', () => {
    expect(extractImageGenerationSpec('landscape banner image')).toEqual({ size: '1792x1024' });
  });

  it('maps a square request to the square size', () => {
    expect(extractImageGenerationSpec('a square photo of a cat')).toEqual({ size: '1024x1024' });
  });

  it('prioritizes an explicit small-size signal over a square aspect ratio', () => {
    // "icon" implies a small size regardless of the square aspect ratio also
    // implied by "square" — 256x256 (this codebase's smallest size) is a
    // reasonable, honest choice for an icon rather than a full 1024x1024.
    expect(extractImageGenerationSpec('a square icon')).toEqual({ size: '256x256' });
  });

  it('maps an explicit thumbnail request to the small size', () => {
    expect(extractImageGenerationSpec('generate a thumbnail of a rocket')).toEqual({
      size: '256x256',
    });
  });

  it('returns empty when no size signal is present', () => {
    expect(extractImageGenerationSpec('a photo of a mountain')).toEqual({});
  });
});
