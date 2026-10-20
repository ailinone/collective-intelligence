// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-invoker-store-artifact.test.ts — unit coverage for the invoker's
 * storeArtifact wiring (2026-09-30 media-delivery fix): uploadFile must
 * receive the caller's org/user context and the artifact bytes verbatim, and
 * the returned URL must be the freshly SIGNED download URL (not anything the
 * upload itself returns — FileUploadResult carries no URL by design; signing
 * happens lazily at the moment of use).
 */
import { describe, it, expect, vi } from 'vitest';
import { createCapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { OrchestrationContext } from '@/types';

const context: OrchestrationContext = {
  organizationId: 'org-store-test',
  userId: 'user-store-test',
  requestId: 'req-store-test',
  models: [],
  taskType: 'general',
  contextSize: 0,
};

describe('createCapabilityInvoker.storeArtifact', () => {
  it('uploads with the orchestration context and returns the lazily-signed URL', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const uploadFile = vi.fn(async () => ({ id: 'file-123' }));
    const generateDownloadUrl = vi.fn(async () => 'https://signed.example/file-123?sig=abc');

    const invoker = createCapabilityInvoker({
      filesService: { uploadFile, generateDownloadUrl },
      context,
    });

    const result = await invoker.storeArtifact({
      buffer: bytes,
      filename: 'generated-image-1.png',
    });

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith({
      fileBuffer: bytes,
      filename: 'generated-image-1.png',
      purpose: 'media_generation',
      userContext: context,
      requestId: 'req-store-test',
    });
    expect(generateDownloadUrl).toHaveBeenCalledWith({
      fileId: 'file-123',
      userContext: context,
      expiresInMs: 6 * 60 * 60 * 1000,
    });
    expect(result).toEqual({
      url: 'https://signed.example/file-123?sig=abc',
      fileId: 'file-123',
      expiresAt: expect.any(Number),
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws a explicit capability error when no files service was wired', async () => {
    const invoker = createCapabilityInvoker({ context });
    await expect(
      invoker.storeArtifact({ buffer: Buffer.from('x'), filename: 'a.bin' })
    ).rejects.toThrow(/artifact storage capability not available/i);
  });
});
