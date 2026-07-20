// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-complexity.test.ts — MVP 6A
 *
 * Complexity inference from tokens + signals + attachments.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — complexity inference', () => {
  it('short factual input → low complexity', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'What is 2 + 2?',
      approximateInputTokens: 100,
    });
    expect(profile.complexity).toBe('low');
  });

  it('moderate input → medium complexity', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Provide a moderate-length response with three paragraphs.',
      approximateInputTokens: 1500,
    });
    expect(profile.complexity).toBe('medium');
  });

  it('long input → high complexity', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 10_000,
    });
    expect(profile.complexity).toBe('high');
  });

  it('agentic + multi-document → extreme complexity', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Use an agent to plan across multiple documents and execute',
    });
    expect(profile.complexity).toBe('extreme');
  });

  it('multi-document text signal alone → extreme', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Analyze multiple-files for inconsistencies',
    });
    expect(profile.complexity).toBe('extreme');
  });

  it('very large input (above high threshold) → extreme', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 200_000,
    });
    expect(profile.complexity).toBe('extreme');
  });

  it('code task signal pushes complexity to high', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write code that implements a quicksort',
      approximateInputTokens: 200,
    });
    expect(profile.complexity).toBe('high');
  });

  it('many attachments push toward extreme', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 6_000,
      attachments: [
        { kind: 'document', approximateTokens: 1000 },
        { kind: 'document', approximateTokens: 1000 },
        { kind: 'document', approximateTokens: 1000 },
        { kind: 'document', approximateTokens: 1000 },
      ],
    });
    expect(profile.complexity).toBe('extreme');
  });

  it('single document attachment → at least medium', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      attachments: [{ kind: 'document', approximateTokens: 50 }],
    });
    expect(['medium', 'high', 'extreme']).toContain(profile.complexity);
  });

  it('analysis signal on short text → at least medium', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'analyze this',
      approximateInputTokens: 50,
    });
    expect(['medium', 'high']).toContain(profile.complexity);
  });
});
