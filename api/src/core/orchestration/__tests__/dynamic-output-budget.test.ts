// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  deriveModelMaxOutputTokens,
  resolveDynamicMaxTokens,
} from '../dynamic-output-budget';

describe('deriveModelMaxOutputTokens', () => {
  it('returns the model\'s declared maxOutputTokens (frontier: full length)', () => {
    expect(deriveModelMaxOutputTokens({ maxOutputTokens: 256000, contextWindow: 1_000_000 })).toBe(256000);
    expect(deriveModelMaxOutputTokens({ maxOutputTokens: 16384, contextWindow: 128000 })).toBe(16384);
  });

  it('falls back to half the context window when maxOutputTokens is unpopulated (0)', () => {
    expect(deriveModelMaxOutputTokens({ maxOutputTokens: 0, contextWindow: 128000 })).toBe(64000);
  });

  it('returns undefined when the model declares no capability at all', () => {
    expect(deriveModelMaxOutputTokens({ maxOutputTokens: 0, contextWindow: 0 })).toBeUndefined();
    expect(deriveModelMaxOutputTokens({})).toBeUndefined();
  });

  it('never derives a value below a sane floor from a tiny context window', () => {
    expect(deriveModelMaxOutputTokens({ maxOutputTokens: 0, contextWindow: 512 })).toBe(1024);
  });

  it('is NOT a static constant — different models get different ceilings', () => {
    const a = deriveModelMaxOutputTokens({ maxOutputTokens: 8192 });
    const b = deriveModelMaxOutputTokens({ maxOutputTokens: 131072 });
    expect(a).not.toBe(b);
  });
});

describe('resolveDynamicMaxTokens', () => {
  it('honors a positive explicit client value over the model capability', () => {
    expect(resolveDynamicMaxTokens(4096, { maxOutputTokens: 256000 })).toBe(4096);
  });

  it('derives from the model when the client set nothing', () => {
    expect(resolveDynamicMaxTokens(undefined, { maxOutputTokens: 65536 })).toBe(65536);
    expect(resolveDynamicMaxTokens(0, { maxOutputTokens: 65536 })).toBe(65536);
    expect(resolveDynamicMaxTokens(null, { maxOutputTokens: 65536 })).toBe(65536);
  });

  it('returns undefined when neither client nor model provides a ceiling', () => {
    expect(resolveDynamicMaxTokens(undefined, { maxOutputTokens: 0, contextWindow: 0 })).toBeUndefined();
  });
});
