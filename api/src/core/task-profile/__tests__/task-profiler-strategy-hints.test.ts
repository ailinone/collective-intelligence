// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-strategy-hints.test.ts — MVP 6A
 *
 * Strategy hints by complexity / risk / privacy / cost / output combos.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — strategy hints', () => {
  it('low complexity + low risk → single_best', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'tell me a joke',
    });
    expect(profile.strategyHints).toContain('single_best');
  });

  it('costSensitivity=high → cost_cascade', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'simple greeting',
      explicitCostSensitivity: 'high',
    });
    expect(profile.strategyHints).toContain('cost_cascade');
  });

  it('high complexity → quality_cascade + critique_repair', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write code with reasoning',
      approximateInputTokens: 6000,
    });
    expect(profile.complexity).toBe('high');
    expect(profile.strategyHints).toContain('quality_cascade');
    expect(profile.strategyHints).toContain('critique_repair');
  });

  it('extreme complexity → expert_panel + critique_repair + parallel_diverse', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'use an agent to plan across multiple documents',
    });
    expect(profile.complexity).toBe('extreme');
    expect(profile.strategyHints).toContain('expert_panel');
    expect(profile.strategyHints).toContain('critique_repair');
    expect(profile.strategyHints).toContain('parallel_diverse');
  });

  it('high risk → consensus + expert_panel', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'review this legal contract',
    });
    expect(profile.strategyHints).toContain('consensus');
    expect(profile.strategyHints).toContain('expert_panel');
  });

  it('structured_generation → single_best + quality_cascade', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitOutputFormat: 'json',
    });
    expect(profile.taskType).toBe('structured_generation');
    expect(profile.strategyHints).toContain('single_best');
    expect(profile.strategyHints).toContain('quality_cascade');
  });

  it('hints are deterministically sorted', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'analyze this legal contract step by step',
    });
    const sorted = [...profile.strategyHints].sort();
    expect(profile.strategyHints).toEqual(sorted);
  });

  it('hints array is never empty (single_best as fallback)', () => {
    const { profile } = profileTask({ requestId: 'r-empty' });
    expect(profile.strategyHints.length).toBeGreaterThan(0);
  });

  it('local_preferred mode adds local_first hint', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'confidential analysis',
    });
    expect(profile.strategyHints).toContain('local_first');
  });
});
