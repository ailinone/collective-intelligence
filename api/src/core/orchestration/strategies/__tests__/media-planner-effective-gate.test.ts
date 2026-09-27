// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * resolveEffectiveMediaPlannerEnabled — combines the global MEDIA_PLANNER_ENABLED
 * env flag with the per-org canary allowlist (Section E of the 2026-09-23
 * MediaPlanner completion design).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockGlobalEnabled = false;

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      mediaPlanner: {
        ...actual.config.mediaPlanner,
        get enabled() {
          return mockGlobalEnabled;
        },
      },
    },
  };
});

const getMediaPlannerConfigForOrgMock = vi.fn();
vi.mock('@/core/coordination/collective-feature-flags', () => ({
  getMediaPlannerConfigForOrg: (...args: unknown[]) => getMediaPlannerConfigForOrgMock(...args),
}));

import { resolveEffectiveMediaPlannerEnabled } from '../media-planner-gate';

describe('resolveEffectiveMediaPlannerEnabled', () => {
  beforeEach(() => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockReset();
  });

  it('is enabled when the global flag is on, regardless of org config', async () => {
    mockGlobalEnabled = true;
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(true);
    expect(getMediaPlannerConfigForOrgMock).not.toHaveBeenCalled();
  });

  it('is enabled when the global flag is off but the org canary is on', async () => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockResolvedValue({ enabled: true });
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(true);
    expect(getMediaPlannerConfigForOrgMock).toHaveBeenCalledWith('org-1');
  });

  it('is disabled when both the global flag and the org canary are off', async () => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockResolvedValue({ enabled: false });
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(false);
  });

  it('is disabled when no organizationId is available and the global flag is off', async () => {
    mockGlobalEnabled = false;
    const result = await resolveEffectiveMediaPlannerEnabled(undefined);
    expect(result).toBe(false);
    expect(getMediaPlannerConfigForOrgMock).not.toHaveBeenCalled();
  });
});
