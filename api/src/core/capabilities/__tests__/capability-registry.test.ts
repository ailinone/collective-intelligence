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
});
