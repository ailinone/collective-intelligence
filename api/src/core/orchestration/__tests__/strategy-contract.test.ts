// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  STRATEGY_INPUT_VALUES,
  canonicalizeStrategyInput,
  mapExecutionToCanonical,
  normalizeStrategyInput,
  resolveExecutionStrategy,
} from '../strategy-contract';

describe('strategy-contract', () => {
  it('normalizes aliases to canonical strategy names', () => {
    expect(canonicalizeStrategyInput('quality-multi-pass')).toBe('quality_multipass');
    expect(canonicalizeStrategyInput('quality-multipass')).toBe('quality_multipass');
  });

  it('maps canonical strategy to execution strategy', () => {
    expect(resolveExecutionStrategy('cost')).toBe('cost-cascade');
    expect(resolveExecutionStrategy('quality')).toBe('quality-multipass');
    expect(resolveExecutionStrategy('dynamic')).toBe('auto');
  });

  it('maps execution strategy back to canonical output contract', () => {
    expect(mapExecutionToCanonical('quality-multipass')).toBe('quality_multipass');
    expect(mapExecutionToCanonical('cost-cascade')).toBe('cost-cascade');
    expect(mapExecutionToCanonical('hybrid')).toBe('hybrid');
    expect(mapExecutionToCanonical('parallel')).toBe('parallel');
  });

  it('rejects unsupported strategy values', () => {
    expect(normalizeStrategyInput('unsupported-strategy')).toBeUndefined();
    expect(resolveExecutionStrategy('unsupported-strategy')).toBeUndefined();
  });

  it('exposes canonical values with compatibility aliases', () => {
    expect(STRATEGY_INPUT_VALUES).toContain('single');
    expect(STRATEGY_INPUT_VALUES).toContain('quality_multipass');
    expect(STRATEGY_INPUT_VALUES).toContain('quality-multi-pass');
    expect(STRATEGY_INPUT_VALUES).toContain('quality-multipass');
    expect(STRATEGY_INPUT_VALUES).toContain('consensus');
  });

  it('routes consensus strategy through contract', () => {
    expect(canonicalizeStrategyInput('consensus')).toBe('consensus');
    expect(resolveExecutionStrategy('consensus')).toBe('consensus');
    expect(mapExecutionToCanonical('consensus')).toBe('consensus');
  });
});

