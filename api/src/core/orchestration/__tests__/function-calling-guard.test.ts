// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Behavioral contract for the function-calling routing guard
 * (2026-08-20 incident, request 91YJ-kZPPLHjodsSSKLkz — a tools request was
 * executed by registry-resolved models whose capabilities were
 * ["chat","text_generation","streaming"], i.e. no function_calling).
 *
 * Semantics locked here (operator-confirmed):
 *   - Function calling COUNTS only when explicitly declared — never inferred.
 *   - Re-validation REJECTS only an explicit, non-empty capability list that
 *     lacks function_calling. Missing/empty metadata = "unknown" = allowed,
 *     so providers that don't populate capabilities aren't blacklisted.
 */

import { describe, it, expect } from 'vitest';
import {
  requestRequiresFunctionCalling,
  hasDeclaredFunctionCalling,
  explicitlyLacksFunctionCalling,
} from '../function-calling-guard';

describe('requestRequiresFunctionCalling', () => {
  it('is true for a non-empty tools array', () => {
    expect(requestRequiresFunctionCalling([{ type: 'function' }])).toBe(true);
  });

  it('is false for empty tools, undefined, null, or non-array values', () => {
    expect(requestRequiresFunctionCalling([])).toBe(false);
    expect(requestRequiresFunctionCalling(undefined)).toBe(false);
    expect(requestRequiresFunctionCalling(null)).toBe(false);
    expect(requestRequiresFunctionCalling({ length: 1 })).toBe(false);
  });
});

describe('hasDeclaredFunctionCalling', () => {
  it('is true only when function_calling is explicitly declared', () => {
    expect(
      hasDeclaredFunctionCalling({ capabilities: ['chat', 'function_calling'] })
    ).toBe(true);
  });

  it('is false when declared without function_calling', () => {
    expect(
      hasDeclaredFunctionCalling({ capabilities: ['chat', 'text_generation', 'streaming'] })
    ).toBe(false);
  });

  it('is false when metadata is missing or empty (unknown != capable)', () => {
    expect(hasDeclaredFunctionCalling({ capabilities: undefined })).toBe(false);
    expect(hasDeclaredFunctionCalling({ capabilities: [] })).toBe(false);
  });
});

describe('explicitlyLacksFunctionCalling (re-validation predicate)', () => {
  it('rejects the incident shape: explicit capabilities without function_calling', () => {
    expect(
      explicitlyLacksFunctionCalling({
        capabilities: ['chat', 'text_generation', 'streaming'],
      })
    ).toBe(true);
  });

  it('accepts a model that declares function_calling', () => {
    expect(
      explicitlyLacksFunctionCalling({
        capabilities: ['chat', 'streaming', 'function_calling', 'tool_use'],
      })
    ).toBe(false);
  });

  it('accepts unknown metadata (missing or empty capabilities) — never empties the chain on ignorance', () => {
    expect(explicitlyLacksFunctionCalling({ capabilities: undefined })).toBe(false);
    expect(explicitlyLacksFunctionCalling({ capabilities: [] })).toBe(false);
  });
});
