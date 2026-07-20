// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-basic.test.ts — MVP 6A
 *
 * Smoke tests on the simplest possible inputs.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — empty / minimal input', () => {
  it('empty text input → factual / low / standard', () => {
    const { profile } = profileTask({ requestId: 'r-empty' });
    expect(profile.taskType).toBe('factual');
    expect(profile.complexity).toBe('low');
    expect(profile.riskLevel).toBe('low');
    expect(profile.privacyMode).toBe('standard');
  });

  it('chat capability is always required', () => {
    const { profile } = profileTask({ requestId: 'r-1', text: 'hi' });
    expect(profile.requiredCapabilities).toContain('chat');
  });

  it('text modality is always present', () => {
    const { profile } = profileTask({ requestId: 'r-1', text: 'hello' });
    expect(profile.modalities).toContain('text');
  });

  it('confidenceNeeded falls within [0, 1]', () => {
    const { profile } = profileTask({ requestId: 'r-1' });
    expect(profile.confidenceNeeded).toBeGreaterThanOrEqual(0);
    expect(profile.confidenceNeeded).toBeLessThanOrEqual(1);
  });
});

describe('profileTask — explicit output format JSON', () => {
  it('explicitOutputFormat=json → structured_generation + json_mode required', () => {
    const { profile } = profileTask({
      requestId: 'r-json',
      explicitOutputFormat: 'json',
    });
    expect(profile.taskType).toBe('structured_generation');
    expect(profile.requiredCapabilities).toContain('json_mode');
    expect(profile.outputFormatRequirements).toContain('json');
  });
});

describe('profileTask — basic factual question', () => {
  it('factual question text → factual taskType', () => {
    const { profile } = profileTask({
      requestId: 'r-fact',
      text: 'What is the capital of France?',
    });
    expect(profile.taskType).toBe('factual');
  });
});

describe('profileTask — reasons surface key derivations', () => {
  it('reasons array contains task_type, complexity, risk markers', () => {
    const { reasons } = profileTask({
      requestId: 'r-1',
      text: 'analyze this',
    });
    expect(reasons.join(' ')).toContain('task_type:');
    expect(reasons.join(' ')).toContain('complexity:');
    expect(reasons.join(' ')).toContain('risk:');
  });
});
