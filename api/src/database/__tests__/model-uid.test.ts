// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { computeModelUid, computeModelUidCandidate } from '@/database/model-uid';

describe('model-uid', () => {
  it('computeModelUid is the documented md5(provider:id)[0:25]', () => {
    // Pinned value: this must match the SQL formula
    // SUBSTRING(MD5(provider_id || ':' || id), 1, 25) used by the migration.
    expect(computeModelUid('openai', 'gpt-4o')).toBe('5efbd5633e102c39ff090f122');
    expect(computeModelUid('ai302', 'gpt-4o')).toBe('a68b07cbeba10e882ef8e1b99');
  });

  it('attempt 0 of computeModelUidCandidate is the canonical uid', () => {
    expect(computeModelUidCandidate('openai', 'gpt-4o', 0)).toBe(computeModelUid('openai', 'gpt-4o'));
  });

  it('later attempts are deterministic, distinct from each other and from the canonical uid, and fit the column', () => {
    const attempts = [0, 1, 2, 3].map((n) => computeModelUidCandidate('openai', 'gpt-4o', n));
    expect(new Set(attempts).size).toBe(4);
    expect(computeModelUidCandidate('openai', 'gpt-4o', 1)).toBe(attempts[1]);
    for (const uid of attempts) {
      expect(uid).toMatch(/^[0-9a-f]{25}$/);
      expect(uid.length).toBeLessThanOrEqual(32); // models.uid is VARCHAR(32)
    }
  });
});
