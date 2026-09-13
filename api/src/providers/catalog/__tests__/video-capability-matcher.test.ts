// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * video-capability-matcher — LOTE AS (2026-09-06).
 *
 * Covers the fail-open/fail-closed contract: a candidate whose DECLARED
 * attributes conflict with the request is excluded; a candidate with no
 * declared attributes for that field (or an unparseable value on either
 * side) is NEVER excluded on that basis alone.
 */
import { describe, expect, it } from 'vitest';
import {
  canSatisfyVideoAttributes,
  normalizeRatio,
  resolutionTier,
  type VideoAttributeRequest,
} from '../video-capability-matcher';
import type { VideoCapabilityAttributes } from '../provider-catalog.types';

describe('resolutionTier', () => {
  it('orders labeled tiers correctly', () => {
    expect(resolutionTier('480p')).toBeLessThan(resolutionTier('720p')!);
    expect(resolutionTier('720p')).toBeLessThan(resolutionTier('1080p')!);
    expect(resolutionTier('1080p')).toBeLessThan(resolutionTier('4K')!);
    expect(resolutionTier('4k')).toBe(resolutionTier('2160p'));
  });

  it('parses raw pixel dimensions using the short side', () => {
    expect(resolutionTier('3840x2160')).toBe(resolutionTier('4K'));
    expect(resolutionTier('1280x720')).toBe(resolutionTier('720p'));
    expect(resolutionTier('1584x672')).toBeLessThan(resolutionTier('720p')!);
  });

  it('returns null for an unparseable value', () => {
    expect(resolutionTier('ultra-hd-plus')).toBeNull();
    expect(resolutionTier('')).toBeNull();
  });
});

describe('normalizeRatio', () => {
  it('treats a labeled ratio and an equivalent pixel-dimension string as equal', () => {
    const label = normalizeRatio('16:9');
    const pixels = normalizeRatio('1280:720');
    expect(label).not.toBe('wildcard');
    expect(pixels).not.toBe('wildcard');
    expect(Math.abs((label as number) - (pixels as number))).toBeLessThan(0.001);
  });

  it('treats adaptive/auto as a wildcard', () => {
    expect(normalizeRatio('adaptive')).toBe('wildcard');
    expect(normalizeRatio('AUTO')).toBe('wildcard');
  });

  it('returns null for an unparseable value', () => {
    expect(normalizeRatio('square-ish')).toBeNull();
  });
});

describe('canSatisfyVideoAttributes', () => {
  it('never rejects when the catalog declares no attributes at all', () => {
    const request: VideoAttributeRequest = {
      durationSeconds: 999,
      resolution: '8K',
      aspectRatio: '2:1',
      audioRequested: true,
    };
    expect(canSatisfyVideoAttributes(undefined, request)).toBe(true);
  });

  it('rejects a duration above a declared maxDurationSeconds', () => {
    const attrs: VideoCapabilityAttributes = { maxDurationSeconds: 10 };
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 30 })).toBe(false);
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 5 })).toBe(true);
  });

  it('does NOT reject on duration when the candidate declares no duration limits', () => {
    const attrs: VideoCapabilityAttributes = { maxResolution: '4K' };
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 999 })).toBe(true);
  });

  it('rejects a duration above the largest allowedDurationsSeconds (exact-set vendors)', () => {
    const attrs: VideoCapabilityAttributes = { allowedDurationsSeconds: [5, 10] };
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 30 })).toBe(false);
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 10 })).toBe(true);
  });

  it('rejects a duration below a declared minDurationSeconds', () => {
    const attrs: VideoCapabilityAttributes = { minDurationSeconds: 2 };
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 1 })).toBe(false);
    expect(canSatisfyVideoAttributes(attrs, { durationSeconds: 2 })).toBe(true);
  });

  it('rejects a resolution above a declared maxResolution ceiling', () => {
    const attrs: VideoCapabilityAttributes = { maxResolution: '720p' };
    expect(canSatisfyVideoAttributes(attrs, { resolution: '4K' })).toBe(false);
    expect(canSatisfyVideoAttributes(attrs, { resolution: '480p' })).toBe(true);
  });

  it('does NOT reject resolution when the candidate declares no maxResolution', () => {
    const attrs: VideoCapabilityAttributes = { maxDurationSeconds: 10 };
    expect(canSatisfyVideoAttributes(attrs, { resolution: '8K' })).toBe(true);
  });

  it('does NOT reject when the requested resolution string is unparseable', () => {
    const attrs: VideoCapabilityAttributes = { maxResolution: '720p' };
    expect(canSatisfyVideoAttributes(attrs, { resolution: 'super-duper-hd' })).toBe(true);
  });

  it('rejects an aspect ratio not in a declared closed set', () => {
    const attrs: VideoCapabilityAttributes = { supportedAspectRatios: ['16:9', '1:1'] };
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '21:9' })).toBe(false);
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '16:9' })).toBe(true);
  });

  it('matches an equivalent pixel-dimension aspect ratio against a labeled request', () => {
    const attrs: VideoCapabilityAttributes = { supportedAspectRatios: ['1280:720', '720:1280'] };
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '16:9' })).toBe(true);
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '1:1' })).toBe(false);
  });

  it('an "adaptive"/"auto" entry in supportedAspectRatios matches any request', () => {
    const attrs: VideoCapabilityAttributes = { supportedAspectRatios: ['adaptive'] };
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '9:16' })).toBe(true);
  });

  it('does NOT reject aspect ratio when the candidate declares no supportedAspectRatios', () => {
    const attrs: VideoCapabilityAttributes = { maxDurationSeconds: 10 };
    expect(canSatisfyVideoAttributes(attrs, { aspectRatio: '2:1' })).toBe(true);
  });

  it('rejects a soundtrack request when nativeAudioSupport is explicitly false', () => {
    const attrs: VideoCapabilityAttributes = { nativeAudioSupport: false };
    expect(canSatisfyVideoAttributes(attrs, { audioRequested: true })).toBe(false);
  });

  it('does NOT reject a soundtrack request when nativeAudioSupport is undeclared (unknown, not "no")', () => {
    const attrs: VideoCapabilityAttributes = { maxDurationSeconds: 10 };
    expect(canSatisfyVideoAttributes(attrs, { audioRequested: true })).toBe(true);
  });

  it('never rejects on audio when a soundtrack was not requested, even if unsupported', () => {
    const attrs: VideoCapabilityAttributes = { nativeAudioSupport: false };
    expect(canSatisfyVideoAttributes(attrs, { audioRequested: false })).toBe(true);
    expect(canSatisfyVideoAttributes(attrs, {})).toBe(true);
  });

  it('composes multiple constraints — a candidate must satisfy all of them', () => {
    const attrs: VideoCapabilityAttributes = {
      maxDurationSeconds: 10,
      maxResolution: '1080p',
      supportedAspectRatios: ['16:9'],
      nativeAudioSupport: true,
    };
    expect(
      canSatisfyVideoAttributes(attrs, {
        durationSeconds: 5,
        resolution: '720p',
        aspectRatio: '16:9',
        audioRequested: true,
      })
    ).toBe(true);
    expect(
      canSatisfyVideoAttributes(attrs, {
        durationSeconds: 5,
        resolution: '4K', // conflicts
        aspectRatio: '16:9',
        audioRequested: true,
      })
    ).toBe(false);
  });
});
