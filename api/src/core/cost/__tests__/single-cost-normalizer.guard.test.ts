// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Guard test for the DUP #3 cleanup (model-cost normalizer de-duplication).
 *
 * History: there were TWO model-cost normalizers exporting `normalizeCost`:
 *   - `@/services/cost-normalization-service`  (LIVE — wired into base-strategy)
 *   - `@/core/cost/cost-normalizer`            (DEAD — only a test imported it)
 *
 * The dead module (and its `cost-types.ts`) were deleted. This test pins the
 * invariant so the duplicate cannot silently come back:
 *   1. The live service exports a single `normalizeCost` (the canonical one).
 *   2. The dead path `@/core/cost/cost-normalizer` no longer resolves.
 */

import { describe, expect, it } from 'vitest';
import * as costNormalizationService from '@/services/cost-normalization-service';

describe('single model-cost normalizer (DUP #3 guard)', () => {
  it('exposes exactly one canonical normalizeCost from the live service', () => {
    expect(typeof costNormalizationService.normalizeCost).toBe('function');
    expect(typeof costNormalizationService.effectiveCostForSorting).toBe('function');
  });

  it('the dead @/core/cost/cost-normalizer path no longer resolves', async () => {
    await expect(
      // @ts-expect-error — module intentionally deleted; import must fail.
      import('@/core/cost/cost-normalizer'),
    ).rejects.toThrow();
  });

  it('the dead @/core/cost/cost-types path no longer resolves', async () => {
    await expect(
      // @ts-expect-error — module intentionally deleted; import must fail.
      import('@/core/cost/cost-types'),
    ).rejects.toThrow();
  });
});
