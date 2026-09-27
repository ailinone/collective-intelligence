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
// here would hit the TDZ — see capability-attribute-store.test.ts for the
// same pattern already used in this codebase).
const { writeCapabilityAttributeRecordMock } = vi.hoisted(() => ({
  writeCapabilityAttributeRecordMock: vi.fn(),
}));
vi.mock('../capability-attribute-store', () => ({
  writeCapabilityAttributeRecord: writeCapabilityAttributeRecordMock,
}));

const { findDraftMock, autoPromoteIfAgreesMock } = vi.hoisted(() => ({
  findDraftMock: vi.fn(),
  autoPromoteIfAgreesMock: vi.fn(),
}));
vi.mock('../capability-attribute-draft-service', () => ({
  findUnpromotedDraft: findDraftMock,
  autoPromoteIfAgrees: autoPromoteIfAgreesMock,
}));

// New Task 9 dependency: the probe job now projects onto Model.metadata
// after a successful probe write. Mocked here since this file only tests
// the probe-job logic, not the projection itself (covered by its own test
// file, capability-attribute-projection.test.ts).
const { projectCapabilityAttributesToModelsMock } = vi.hoisted(() => ({
  projectCapabilityAttributesToModelsMock: vi.fn(),
}));
vi.mock('../capability-attribute-projection', () => ({
  projectCapabilityAttributesToModels: projectCapabilityAttributesToModelsMock,
}));

import { probeVideoDurationCeiling } from '../capability-probe-job';

beforeEach(() => {
  writeCapabilityAttributeRecordMock.mockReset();
  findDraftMock.mockReset();
  autoPromoteIfAgreesMock.mockReset();
  projectCapabilityAttributesToModelsMock.mockReset();
});

describe('probeVideoDurationCeiling', () => {
  it('reads a structured validation-error boundary and writes source: probed', async () => {
    const fakeAdapterCall = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'invalid_parameter',
        field: 'duration',
        message: 'duration must be <= 16',
      })
      .mockResolvedValueOnce({ ok: true });

    findDraftMock.mockResolvedValue(undefined);

    const result = await probeVideoDurationCeiling({
      providerId: 'fal-ai',
      modelId: 'some-model',
      candidateCeilings: [16, 8],
      callProvider: fakeAdapterCall,
    });

    expect(result.maxDurationSeconds).toBe(8);
    expect(writeCapabilityAttributeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'fal-ai',
        capability: 'video_generation',
        source: 'probed',
        attributes: expect.objectContaining({ maxDurationSeconds: 8 }),
      })
    );
  });

  it('checks for an agreeing llm_draft and auto-promotes it after a successful probe', async () => {
    const fakeAdapterCall = vi.fn().mockResolvedValueOnce({ ok: true });
    findDraftMock.mockResolvedValue({ id: 'draft-1', attributes: { maxDurationSeconds: 8 } });

    await probeVideoDurationCeiling({
      providerId: 'fal-ai',
      modelId: 'some-model',
      candidateCeilings: [8],
      callProvider: fakeAdapterCall,
    });

    expect(autoPromoteIfAgreesMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-1', probedValue: 8 })
    );
  });

  it('throws when every candidate ceiling fails for a reason other than the expected validation error', async () => {
    const fakeAdapterCall = vi.fn().mockRejectedValue(new Error('network timeout'));
    await expect(
      probeVideoDurationCeiling({
        providerId: 'fal-ai',
        modelId: 'some-model',
        candidateCeilings: [16],
        callProvider: fakeAdapterCall,
      })
    ).rejects.toThrow(/network timeout/);
    expect(writeCapabilityAttributeRecordMock).not.toHaveBeenCalled();
  });
});
