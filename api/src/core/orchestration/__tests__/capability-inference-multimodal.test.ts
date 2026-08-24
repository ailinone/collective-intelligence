// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multimodal content handling in inferCapabilities (2026-08-19 vision-chat
 * outage regression). The orchestration engine used to JSON.stringify content
 * arrays before calling this function, which disabled image_url detection and
 * let strategies route image requests to text-only models.
 */
import { describe, it, expect } from 'vitest';
import { inferCapabilities } from '../capability-inference';

const IMG = 'data:image/png;base64,AAAA';

function multimodal(text: string) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: IMG } },
      ] as Array<Record<string, unknown>>,
    },
  ];
}

describe('inferCapabilities — multimodal content', () => {
  it('adds vision when an image_url part is present', () => {
    const result = inferCapabilities(multimodal('What is in this picture?'));
    expect(result.requiredCapabilities).toContain('vision');
  });

  it('extracts text ONLY from text parts (no data-URL pollution of estimates)', () => {
    const result = inferCapabilities(multimodal('Translate this screenshot to Portuguese'));
    // Translation keyword must still be detectable from the text part…
    expect(result.requiredCapabilities).toContain('multilingual');
    // …and the base64 payload must not leak into keyword scoring context
    expect(result.contextNeeds).not.toEqual('very_long');
  });

  it('keeps plain string content behavior unchanged', () => {
    const result = inferCapabilities([{ role: 'user', content: 'Say OK' }]);
    expect(result.requiredCapabilities).not.toContain('vision');
    expect(result.taskType).toBe('general');
  });

  it('ignores non-image multimodal parts for vision detection', () => {
    const result = inferCapabilities([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'audio', audio: { url: 'x' } },
        ] as Array<Record<string, unknown>>,
      },
    ]);
    expect(result.requiredCapabilities).not.toContain('vision');
  });
});
