// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for `validateJWTSecret`'s entropy check.
 *
 * The check used to require all 16 hex symbols to appear in the secret
 * (`new Set(secret).size < 16`). For a genuinely random 64-char hex secret
 * (e.g. `openssl rand -hex 32`), that's a coupon-collector problem: each of
 * the 16 symbols has a (15/16)^64 ≈ 1.6% chance of never being drawn, so
 * across 16 symbols the odds that at least one is absent land around 25-26%
 * (union bound: 16 × (15/16)^64). The old check rejected roughly a quarter
 * of perfectly good secrets.
 *
 * The fix scales the minimum required unique-character count with secret
 * length instead of demanding the full alphabet. This suite locks:
 *   - Zero false rejections across 1000 random hex-64 secrets (the
 *     specific case that was failing ~26% of the time).
 *   - The check still rejects genuinely low-diversity/patterned secrets.
 */

import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { validateJWTSecret } from '../security';

describe('validateJWTSecret entropy check', () => {
  it('never rejects 1000 random 64-char hex secrets (openssl rand -hex 32 shape)', () => {
    const rejected: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars
      const result = validateJWTSecret(secret);
      if (!result.valid) {
        rejected.push(`${secret} (${result.reason})`);
      }
    }

    expect(rejected).toEqual([]);
  });

  it('accepts a real generateSecureJWTSecret() output', () => {
    const secret = crypto.randomBytes(32).toString('base64');
    expect(validateJWTSecret(secret).valid).toBe(true);
  });

  it('still rejects a single repeated character', () => {
    const result = validateJWTSecret('a'.repeat(64));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/low entropy/i);
  });

  it('still rejects a short cycling pattern (low character diversity)', () => {
    const result = validateJWTSecret('ab'.repeat(32)); // 64 chars, 2 unique
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/low entropy/i);
  });
});
