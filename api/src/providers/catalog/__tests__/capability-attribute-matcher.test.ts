// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { canSatisfyCapabilityAttributes } from '../capability-attribute-matcher';

describe('canSatisfyCapabilityAttributes', () => {
  it('dispatches video_generation to the video matcher (rejects over-duration)', () => {
    const result = canSatisfyCapabilityAttributes(
      'video_generation',
      { maxDurationSeconds: 5, source: 'human' },
      { durationSeconds: 10 }
    );
    expect(result).toBe(false);
  });

  it('dispatches image_generation to the image matcher (rejects over-dimension)', () => {
    const result = canSatisfyCapabilityAttributes(
      'image_generation',
      { maxDimensions: '512x512', source: 'human' },
      { width: 1024, height: 1024 }
    );
    expect(result).toBe(false);
  });

  it('dispatches pdf_understanding to the document matcher (rejects over-pages)', () => {
    const result = canSatisfyCapabilityAttributes(
      'pdf_understanding',
      { maxPages: 50, source: 'human' },
      { pageCount: 100 }
    );
    expect(result).toBe(false);
  });

  it('excludes llm_draft-sourced attributes from matching — treated as absent (fail-open)', () => {
    const result = canSatisfyCapabilityAttributes(
      'video_generation',
      { maxDurationSeconds: 5, source: 'llm_draft' },
      { durationSeconds: 999 }
    );
    expect(result).toBe(true);
  });

  it('fails open for a capability with no matcher registered', () => {
    const result = canSatisfyCapabilityAttributes(
      'chat' as never,
      { source: 'human' } as never,
      {}
    );
    expect(result).toBe(true);
  });
});
