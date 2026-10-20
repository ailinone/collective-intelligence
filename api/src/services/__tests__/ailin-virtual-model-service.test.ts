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
  resolveTierCarrier,
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

describe('billed presets (profile.tier carrier)', () => {
  it('resolves ailin-consensus with the tier billing carrier (medium)', () => {
    const resolved = resolveAilinVirtualModelAlias('ailin-consensus');
    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).toBe('consensus');
    expect(resolved?.qualityTarget).toBe(0.9); // profile semantics unchanged
    expect(resolved?.tier).toBe('medium');
    expect(resolved?.tierRate?.inputPer1MUsd).toBeGreaterThan(0);
    expect(resolved?.tierRate?.outputPer1MUsd).toBeGreaterThan(0);
  });

  it('resolves ailin-best with the tier billing carrier (medium)', () => {
    const resolved = resolveAilinVirtualModelAlias('ailin-best');
    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).toBe('quality-multipass');
    expect(resolved?.qualityTarget).toBe(0.95);
    expect(resolved?.tier).toBe('medium');
    expect(resolved?.tierRate).toBeDefined();
  });

  it('leaves unbilled presets (ailin-auto) without the carrier', () => {
    const resolved = resolveAilinVirtualModelAlias('ailin-auto');
    expect(resolved).not.toBeNull();
    expect(resolved?.tier).toBeUndefined();
    expect(resolved?.tierRate).toBeUndefined();
  });

  it('accepts a valid tier on env profiles and ignores invalid ones', () => {
    process.env.AILIN_VIRTUAL_MODEL_PROFILES = JSON.stringify([
      { id: 'custom-billed', strategy: 'consensus', tier: 'large' },
      { id: 'custom-invalid-tier', strategy: 'consensus', tier: 'gargantuan' },
    ]);
    try {
      const billed = resolveAilinVirtualModelAlias('custom-billed');
      expect(billed?.tier).toBe('large');
      expect(billed?.tierRate).toBeDefined();

      const invalid = resolveAilinVirtualModelAlias('custom-invalid-tier');
      expect(invalid).not.toBeNull();
      expect(invalid?.tier).toBeUndefined();
    } finally {
      delete process.env.AILIN_VIRTUAL_MODEL_PROFILES;
    }
  });
});

describe('resolveTierCarrier (wallet coverage for non-chat routes)', () => {
  it('returns the carrier for a tiered composite cell', () => {
    const carrier = resolveTierCarrier('consensus:medium');
    expect(carrier).toEqual({
      ailin_tier: 'medium',
      ailin_tier_rate: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
    });
  });

  it('returns the carrier for a billed preset (ailin-consensus, tier medium)', () => {
    const carrier = resolveTierCarrier('ailin-consensus');
    expect(carrier).toEqual({
      ailin_tier: 'medium',
      ailin_tier_rate: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
    });
  });

  it('returns an empty object for unbilled presets, auto and raw provider ids', () => {
    expect(resolveTierCarrier('ailin-auto')).toEqual({});
    expect(resolveTierCarrier('auto')).toEqual({});
    expect(resolveTierCarrier('openai/gpt-4o')).toEqual({});
  });
});
