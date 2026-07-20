// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { SemanticCache } from '@/core/cache/semantic-cache';

describe('SemanticCache', () => {
  it('uses a full-text hash cache key to avoid prefix collisions', () => {
    const semanticCache = new SemanticCache({ enabled: false });
    const prefix = 'A'.repeat(100);
    const requestOne = `${prefix}-prompt-1`;
    const requestTwo = `${prefix}-prompt-2`;

    // Document previous collision risk (old cache key used text.substring(0, 100)).
    expect(requestOne.substring(0, 100)).toBe(requestTwo.substring(0, 100));

    const keyOne = (semanticCache as any).getEmbeddingCacheKey(requestOne);
    const keyTwo = (semanticCache as any).getEmbeddingCacheKey(requestTwo);

    expect(keyOne).not.toBe(keyTwo);
  });
});
