// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-risk.test.ts — MVP 6A
 *
 * Risk inference from domain vocabulary.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — high risk domains', () => {
  it('legal text → high risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'review this legal contract for liability clauses',
    });
    expect(profile.riskLevel).toBe('high');
  });

  it('financial text → high risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'compute the tax implications of this invest decision',
    });
    expect(profile.riskLevel).toBe('high');
  });

  it('medical text → high risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'interpret this medical diagnosis for the patient',
    });
    expect(profile.riskLevel).toBe('high');
  });

  it('security text → high risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'find the vulnerability in this code',
    });
    expect(profile.riskLevel).toBe('high');
  });

  it('production text → high risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'this is being deployed to production tonight',
    });
    expect(profile.riskLevel).toBe('high');
  });
});

describe('profileTask — medium risk signals', () => {
  it('analysis without high-risk domain → medium risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'analyze this dataset for trends',
    });
    expect(profile.riskLevel).toBe('medium');
  });

  it('math task without legal/financial domain → medium risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'compute the integral of x^2',
    });
    expect(profile.riskLevel).toBe('medium');
  });

  it('reasoning task → medium risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'reason about which option is better and why',
    });
    expect(profile.riskLevel).toBe('medium');
  });

  it('code without security/production tag → medium risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write code to sort an array',
    });
    expect(profile.riskLevel).toBe('medium');
  });
});

describe('profileTask — low risk signals', () => {
  it('creative writing → low risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write a poem about the sea',
    });
    expect(profile.riskLevel).toBe('low');
  });

  it('factual question → low risk', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'What time is it in Tokyo?',
    });
    expect(profile.riskLevel).toBe('low');
  });
});

describe('profileTask — confidenceNeeded scales with risk', () => {
  it('high risk → confidenceNeeded >= 0.9', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'legal contract review',
    });
    expect(profile.confidenceNeeded).toBeGreaterThanOrEqual(0.9);
  });

  it('low risk → confidenceNeeded smaller', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write a haiku',
    });
    expect(profile.confidenceNeeded).toBeLessThan(0.9);
  });
});
