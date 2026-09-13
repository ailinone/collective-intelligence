// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { getCapabilityExecutionPlan } from '@/core/capabilities/capability-registry';

describe('capability-registry', () => {
  it('keeps video_generation executable with native adapter path', () => {
    const plan = getCapabilityExecutionPlan('video_generation');

    expect(plan).toBeDefined();
    expect(plan?.supportsExecute).toBe(true);
    expect(plan?.executionPath).toEqual(['native_adapter']);
  });

  it('registers music_generation with a native-adapter-only path (LOTE AX)', () => {
    const plan = getCapabilityExecutionPlan('music_generation');

    expect(plan).toBeDefined();
    expect(plan?.supportsExecute).toBe(true);
    // No `orchestration` fallback — a chat model cannot approximate a music
    // composition, same reasoning as video_generation above.
    expect(plan?.executionPath).toEqual(['native_adapter']);
    expect(plan?.aliases).toEqual(
      expect.arrayContaining(['music_generation', 'music', 'soundtrack_generation'])
    );
  });

  it('resolves the music aliases onto the canonical music_generation id', () => {
    expect(getCapabilityExecutionPlan('music')?.id).toBe('music_generation');
    expect(getCapabilityExecutionPlan('soundtrack_generation')?.id).toBe('music_generation');
  });
});
