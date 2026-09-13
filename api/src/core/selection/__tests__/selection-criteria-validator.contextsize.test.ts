// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the 10M-context input gate (2026-07-05):
 *  - contextSize up to 10M validates WITHOUT warning;
 *  - above 10M warns but the value is PRESERVED — the old code dropped
 *    sanitized.contextSize on the warning branch, silently disabling the
 *    `contextWindow >= contextSize` selection gate for huge requests (bug).
 */
import { describe, it, expect } from 'vitest';
import { validateSelectionCriteria } from '../selection-criteria-validator';
import type { SelectionCriteria } from '../dynamic-model-selector';
import { estimateContextSize } from '@/core/orchestration/context-size-estimator';
import type { ChatRequest, Tool } from '@/types';

const base: SelectionCriteria = {
  taskType: 'general',
  complexity: 'medium',
  contextSize: 1000,
} as SelectionCriteria;

describe('validateSelectionCriteria — contextSize (10M window)', () => {
  it('accepts a 10M-token contextSize without warnings', () => {
    const r = validateSelectionCriteria({ ...base, contextSize: 10_000_000 });
    expect(r.valid).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(r.sanitized?.contextSize).toBe(10_000_000);
  });

  it('BUG FIX: above 10M it warns but PRESERVES the value (never drops the gate)', () => {
    const r = validateSelectionCriteria({ ...base, contextSize: 12_345_678 });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('very large'))).toBe(true);
    expect(r.sanitized?.contextSize).toBe(12_345_678); // was: undefined (dropped)
  });

  it('still rejects negative/NaN', () => {
    expect(validateSelectionCriteria({ ...base, contextSize: -1 }).valid).toBe(false);
    expect(validateSelectionCriteria({ ...base, contextSize: Number('x') }).valid).toBe(false);
  });

  it('LOTE AW: a tool-heavy request feeds the hard gate a LARGER, now-correct contextSize (previously request.tools was never counted)', () => {
    const bigTool: Tool = {
      type: 'function',
      function: {
        name: 'run_query',
        description: 'Run a complex analytical query'.repeat(20),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [`field_${i}`, { type: 'string' }])
          ),
        },
      },
    };
    const withoutTools: ChatRequest = { messages: [{ role: 'user', content: 'run this' }] };
    const withTools: ChatRequest = { ...withoutTools, tools: [bigTool] };

    const sizeWithoutTools = estimateContextSize(withoutTools);
    const sizeWithTools = estimateContextSize(withTools);
    expect(sizeWithTools).toBeGreaterThan(sizeWithoutTools);

    // Both sizes still validate cleanly and are PRESERVED through the gate —
    // this is what a real model-selection call feeds into
    // SelectionCriteria.contextSize (dynamic-model-selector.ts's hard
    // `contextWindow >= contextSize` filter).
    const validated = validateSelectionCriteria({ ...base, contextSize: sizeWithTools });
    expect(validated.valid).toBe(true);
    expect(validated.sanitized?.contextSize).toBe(sizeWithTools);
  });
});
