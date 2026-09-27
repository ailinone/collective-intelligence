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
// here would hit the TDZ — see capability-attribute-store.test.ts and
// capability-probe-job.test.ts for the same pattern already used in this
// codebase).
const { findManyMock, updateMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
}));
vi.mock('@/database/client', () => ({
  prisma: {
    providerCapabilityAttributeRecord: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

// New Task 9 dependency: the draft service now projects onto Model.metadata
// after a successful promotion. Mocked here since this file is only testing
// the draft-service logic, not the projection itself (covered by its own
// test file, capability-attribute-projection.test.ts).
vi.mock('../capability-attribute-projection', () => ({
  projectCapabilityAttributesToModels: vi.fn(),
}));

import {
  findUnpromotedDraft,
  autoPromoteIfAgrees,
  promoteDraft,
} from '../capability-attribute-draft-service';

beforeEach(() => {
  findManyMock.mockReset();
  updateMock.mockReset();
});

describe('findUnpromotedDraft', () => {
  it('returns the most recent llm_draft row for a provider+capability', async () => {
    findManyMock.mockResolvedValue([
      { id: 'draft-1', source: 'llm_draft', attributes: { maxDurationSeconds: 8 } },
    ]);
    const result = await findUnpromotedDraft('fal-ai', 'video_generation');
    expect(result).toEqual({ id: 'draft-1', attributes: { maxDurationSeconds: 8 } });
  });

  it('returns undefined when there is no draft', async () => {
    findManyMock.mockResolvedValue([]);
    const result = await findUnpromotedDraft('fal-ai', 'video_generation');
    expect(result).toBeUndefined();
  });
});

describe('autoPromoteIfAgrees', () => {
  it('promotes (rewrites source to human) when the probed numeric value is within +/-10% of the draft', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-1',
      providerId: 'fal-ai',
      capability: 'video_generation',
      draftAttributes: { maxDurationSeconds: 8.5 },
      probedValue: 8,
      probedField: 'maxDurationSeconds',
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-1' },
        data: expect.objectContaining({
          source: 'human',
          promotionNote: expect.stringContaining('agreement-promoted'),
        }),
      })
    );
  });

  it('does NOT promote when the probed value is outside +/-10% of the draft', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-1',
      providerId: 'fal-ai',
      capability: 'video_generation',
      draftAttributes: { maxDurationSeconds: 20 },
      probedValue: 8,
      probedField: 'maxDurationSeconds',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('promotes on an exact match for an enum/boolean field', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-2',
      providerId: 'fal-ai',
      capability: 'video_generation',
      draftAttributes: { nativeAudioSupport: false },
      probedValue: false,
      probedField: 'nativeAudioSupport',
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-2' } })
    );
  });

  it('does NOT promote a boolean/enum field on a mismatch', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-2',
      providerId: 'fal-ai',
      capability: 'video_generation',
      draftAttributes: { nativeAudioSupport: true },
      probedValue: false,
      probedField: 'nativeAudioSupport',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('promoteDraft (manual admin promotion)', () => {
  it('rewrites source to human with a manual-promotion note', async () => {
    updateMock.mockResolvedValue({
      id: 'draft-3',
      providerId: 'fal-ai',
      capability: 'video_generation',
      attributes: { maxDurationSeconds: 8 },
    });
    await promoteDraft('draft-3');
    // Safety-guard fix-forward (Task 9, fixing a gap flagged in Task 8's
    // review): the `where` clause now also requires source: 'llm_draft' so
    // this can't accidentally promote a non-draft row.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-3', source: 'llm_draft' },
        data: expect.objectContaining({ source: 'human', promotionNote: 'manually promoted via admin endpoint' }),
      })
    );
  });
});
