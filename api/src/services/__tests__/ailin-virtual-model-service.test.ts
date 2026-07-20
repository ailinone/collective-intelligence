// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it } from 'vitest';
import {
  getAilinVirtualModelProfiles,
  resolveAilinVirtualModelAlias,
} from '@/services/ailin-virtual-model-service';

const ORIGINAL_VIRTUAL_PROFILES = process.env.AILIN_VIRTUAL_MODEL_PROFILES;
const ORIGINAL_AUTO_ALIASES = process.env.AILIN_AUTO_MODEL_ALIASES;

describe('ailin-virtual-model-service', () => {
  afterEach(() => {
    process.env.AILIN_VIRTUAL_MODEL_PROFILES = ORIGINAL_VIRTUAL_PROFILES;
    process.env.AILIN_AUTO_MODEL_ALIASES = ORIGINAL_AUTO_ALIASES;
  });

  it('resolves built-in alias to auto orchestration profile', () => {
    const resolved = resolveAilinVirtualModelAlias('ailin-best');
    expect(resolved).not.toBeNull();
    expect(resolved?.model).toBe('auto');
    expect(resolved?.strategy).toBe('quality-multipass');
    expect(resolved?.qualityTarget).toBe(0.95);
  });

  it('supports custom aliases from environment', () => {
    process.env.AILIN_VIRTUAL_MODEL_PROFILES = JSON.stringify([
      {
        id: 'ailin-research',
        strategy: 'consensus',
        qualityTarget: 0.92,
      },
    ]);

    const profiles = getAilinVirtualModelProfiles();
    expect(profiles.some((profile) => profile.id === 'ailin-research')).toBe(true);

    const resolved = resolveAilinVirtualModelAlias('ailin-research');
    expect(resolved?.model).toBe('auto');
    expect(resolved?.strategy).toBe('consensus');
    expect(resolved?.qualityTarget).toBe(0.92);
  });

  it('supports additional simple auto aliases from environment', () => {
    process.env.AILIN_AUTO_MODEL_ALIASES = 'ailin-smart,ailin-pro';
    const resolved = resolveAilinVirtualModelAlias('ailin-smart');
    expect(resolved).not.toBeNull();
    expect(resolved?.model).toBe('auto');
    expect(resolved?.strategy).toBe('auto');
  });
});
