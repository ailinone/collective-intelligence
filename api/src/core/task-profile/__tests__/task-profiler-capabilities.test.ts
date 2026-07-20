// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-capabilities.test.ts — MVP 6A
 *
 * Capability inference from text + attachments + explicit hints.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — capability inference', () => {
  it('text mentioning JSON → json_mode required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Output a JSON object with three fields',
    });
    expect(profile.requiredCapabilities).toContain('json_mode');
  });

  it('text mentioning code → code required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'write code to compute the fibonacci sequence',
    });
    expect(profile.requiredCapabilities).toContain('code');
  });

  it('text mentioning math → math required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'solve this math equation step by step',
    });
    expect(profile.requiredCapabilities).toContain('math');
  });

  it('image attachment → vision required + image modality', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      attachments: [{ kind: 'image', approximateTokens: 100 }],
    });
    expect(profile.requiredCapabilities).toContain('vision');
    expect(profile.modalities).toContain('image');
  });

  it('audio attachment → audio_generation required + audio modality', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      attachments: [{ kind: 'audio', approximateTokens: 1000 }],
    });
    expect(profile.requiredCapabilities).toContain('audio_generation');
    expect(profile.modalities).toContain('audio');
  });

  it('long context input → long_context required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 60_000,
    });
    expect(profile.requiredCapabilities).toContain('long_context');
  });

  it('short context input → long_context NOT required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 100,
    });
    expect(profile.requiredCapabilities).not.toContain('long_context');
  });

  it('explicitToolUse=required → tools required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitToolUse: 'required',
    });
    expect(profile.requiredCapabilities).toContain('tools');
  });

  it('explicitToolUse=optional → tools desired (not required)', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitToolUse: 'optional',
    });
    expect(profile.requiredCapabilities).not.toContain('tools');
    expect(profile.desiredCapabilities).toContain('tools');
  });

  it('reasoning text → reasoning desired', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Reasoning: explain why the result follows',
    });
    expect(profile.desiredCapabilities).toContain('reasoning');
  });

  it('code attachment → code required even without text', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      attachments: [{ kind: 'code', approximateTokens: 500 }],
    });
    expect(profile.requiredCapabilities).toContain('code');
  });

  it('required + desired capabilities are deterministically sorted', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'Output JSON code that solves a math equation',
      attachments: [{ kind: 'image' }],
    });
    const sortedReq = [...profile.requiredCapabilities].sort();
    expect(profile.requiredCapabilities).toEqual(sortedReq);
  });

  it('outputFormatRequirements includes json when text mentions JSON', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'return JSON',
    });
    expect(profile.outputFormatRequirements).toContain('json');
  });

  it('outputFormatRequirements includes table when text mentions table', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'produce a markdown table',
    });
    expect(profile.outputFormatRequirements).toContain('table');
  });
});
