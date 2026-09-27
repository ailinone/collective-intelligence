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
// here would hit the TDZ — see quota-service-user-scope.test.ts for the
// same pattern already used in this codebase).
const { findManyMock, createMock, updateMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    providerCapabilityAttributeRecord: {
      findMany: findManyMock,
      create: createMock,
      update: updateMock,
    },
  },
}));

vi.mock('@/providers/catalog/providers.catalog', () => ({
  PROVIDER_CATALOG: [
    {
      providerId: 'runwayml',
      capabilityAttributes: {
        video_generation: { maxDurationSeconds: 10, source: 'human' },
      },
    },
    { providerId: 'some-other-provider' },
  ],
}));

import {
  resolveCapabilityAttributes,
  writeCapabilityAttributeRecord,
} from '../capability-attribute-store';

beforeEach(() => {
  findManyMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
});

describe('resolveCapabilityAttributes', () => {
  it('returns the static catalog entry when one exists, without querying the DB', async () => {
    const result = await resolveCapabilityAttributes('runwayml', 'video_generation');
    expect(result).toEqual({ maxDurationSeconds: 10, source: 'human' });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('falls back to the highest-trust non-draft DB row when no static entry exists', async () => {
    findManyMock.mockResolvedValue([
      {
        source: 'llm_draft',
        attributes: { maxDurationSeconds: 8 },
        attributesVerifiedAt: null,
      },
      {
        source: 'probed',
        attributes: { maxDurationSeconds: 9 },
        attributesVerifiedAt: new Date('2026-09-01'),
      },
    ]);
    const result = await resolveCapabilityAttributes('some-other-provider', 'video_generation');
    expect(result).toEqual({
      maxDurationSeconds: 9,
      source: 'probed',
      attributesVerifiedAt: '2026-09-01',
    });
  });

  it('returns undefined when no static entry and no DB rows exist', async () => {
    findManyMock.mockResolvedValue([]);
    const result = await resolveCapabilityAttributes('unknown-provider', 'video_generation');
    expect(result).toBeUndefined();
  });
});

describe('writeCapabilityAttributeRecord', () => {
  it('creates a new row for a given provider+capability+source', async () => {
    createMock.mockResolvedValue({ id: 'new-id' });
    await writeCapabilityAttributeRecord({
      providerId: 'fal-ai',
      capability: 'video_generation',
      source: 'schema',
      attributes: { maxDurationSeconds: 12 },
      attributesVerifiedAt: '2026-09-23',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: 'fal-ai',
          capability: 'video_generation',
          source: 'schema',
        }),
      })
    );
  });
});
