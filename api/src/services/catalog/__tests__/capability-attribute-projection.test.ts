// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above the top of the file, so the mock
// functions they reference must be created via vi.hoisted (plain `const`
// here would hit the TDZ — see capability-attribute-store.test.ts,
// capability-probe-job.test.ts, and capability-attribute-draft-service.test.ts
// for the same pattern already used in this codebase).
const { findManyMock, updateMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
}));
vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

import { projectCapabilityAttributesToModels } from '../capability-attribute-projection';

beforeEach(() => {
  findManyMock.mockReset();
  updateMock.mockReset();
});

describe('projectCapabilityAttributesToModels', () => {
  it('updates metadata.capabilityAttributes for every Model row of that provider+capability, preserving other metadata', async () => {
    findManyMock.mockResolvedValue([
      {
        uid: 'uid-1',
        capabilities: ['video_generation'],
        metadata: { originalProvider: 'fal-ai', someOtherField: 42 },
      },
      {
        uid: 'uid-2',
        capabilities: ['chat'],
        metadata: {},
      },
    ]);

    await projectCapabilityAttributesToModels('fal-ai', 'video_generation', {
      maxDurationSeconds: 8,
      source: 'probed',
    });

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerId: 'fal-ai' } })
    );
    // Only the model that actually declares video_generation gets updated.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { uid: 'uid-1' },
      data: {
        metadata: {
          originalProvider: 'fal-ai',
          someOtherField: 42,
          capabilityAttributes: { video_generation: { maxDurationSeconds: 8, source: 'probed' } },
        },
      },
    });
  });

  it('is a no-op when no Model row declares the capability', async () => {
    findManyMock.mockResolvedValue([{ uid: 'uid-1', capabilities: ['chat'], metadata: {} }]);
    await projectCapabilityAttributesToModels('fal-ai', 'video_generation', { source: 'probed' });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
