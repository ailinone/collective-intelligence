// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Files Service
 * Manages file uploads, storage, and retrieval
 * 
 * Features:
 * - GCS integration (Google Cloud Storage)
 * - Multi-format support (PDF, images, audio, video, text, JSONL, etc.)
 * - Automatic format validation
 * - Purpose-based organization
 * - Metadata tracking in database
 * 
 * NO HARDCODED - Bucket names and paths from environment
 */

import { logger } from '@/utils/logger';
import { Storage } from '@google-cloud/storage';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import type { RequestUserContext } from '@/types';
import * as path from 'path';
import * as crypto from 'crypto';
import { ResourceNotFoundError } from '@/utils/custom-errors';

const log = logger.child({ service: 'files' });
let sharedStorage: Storage | null = null;
let sharedBucketName = '';
let bucketMissingWarned = false;
let gcsInitFailedWarned = false;

function resolveBucketName(): string {
  return (process.env.GCS_FILES_BUCKET || process.env.GCS_BUCKET_NAME || '').trim();
}

function initializeSharedStorage(): void {
  const bucketName = resolveBucketName();

  if (!bucketName) {
    sharedStorage = null;
    sharedBucketName = '';
    if (!bucketMissingWarned) {
      log.warn('GCS_FILES_BUCKET not configured - file uploads will be disabled');
      bucketMissingWarned = true;
    }
    return;
  }

  if (sharedStorage && sharedBucketName === bucketName) {
    return;
  }

  try {
    sharedStorage = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
    });
    sharedBucketName = bucketName;
    bucketMissingWarned = false;
    gcsInitFailedWarned = false;
    log.info({ bucket: sharedBucketName }, 'GCS storage initialized');
  } catch (error) {
    sharedStorage = null;
    sharedBucketName = '';
    if (!gcsInitFailedWarned) {
      log.error({ error }, 'Failed to initialize GCS storage');
      gcsInitFailedWarned = true;
    }
  }
}

// ============================================
// Types
// ============================================

export interface FileUploadOptions {
  fileBuffer: Buffer;
  filename: string;
  purpose: string;
  userContext: RequestUserContext;
  requestId: string;
  idempotencyKey?: string;
}

export interface FileUploadResult {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: string;
  status_details?: string;
}

export interface FileListOptions {
  purpose?: string;
  limit: number;
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface FileListResult {
  files: Array<{
    id: string;
    object: string;
    bytes: number;
    created_at: number;
    filename: string;
    purpose: string;
    status: string;
  }>;
  has_more: boolean;
}

export interface FileGetOptions {
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface FileGetResult {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: string;
  status_details?: string;
}

export interface FileContentOptions {
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface FileContentResult {
  content: Buffer;
  filename: string;
  contentType: string;
}

export interface FileDeleteOptions {
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface FileDeleteResult {
  deleted: boolean;
}

// ============================================
// Files Service
// ============================================

export class FilesService {
  private storage: Storage | null = null;
  private bucketName: string;

  constructor() {
    initializeSharedStorage();
    this.storage = sharedStorage;
    this.bucketName = sharedBucketName;
  }

  /**
   * Upload file to GCS and save metadata to database
   */
  async uploadFile(options: FileUploadOptions): Promise<FileUploadResult> {
    const { fileBuffer, filename, purpose, userContext, requestId } = options;

    if (!this.storage || !this.bucketName) {
      throw new Error('File storage is not configured. Set GCS_FILES_BUCKET environment variable.');
    }

    const normalizedIdempotencyKey =
      typeof options.idempotencyKey === 'string' && options.idempotencyKey.trim().length > 0
        ? options.idempotencyKey.trim()
        : undefined;
    const fileId = normalizedIdempotencyKey
      ? this.buildIdempotentFileId(userContext.organizationId, purpose, normalizedIdempotencyKey)
      : `file-${nanoid(24)}`;
    const bytes = fileBuffer.length;
    const extension = path.extname(filename);
    const contentType = this.getContentType(extension);
    const createdAt = Math.floor(Date.now() / 1000);

    log.info({ requestId, fileId, filename, bytes, purpose }, 'Uploading file to GCS');

    try {
      if (normalizedIdempotencyKey) {
        const existingRecord = await prisma.file.findFirst({
          where: {
            id: fileId,
            organizationId: userContext.organizationId,
          },
        });

        if (existingRecord) {
          log.info({ requestId, fileId }, 'Returning existing idempotent file upload result');
          return {
            id: existingRecord.id,
            bytes: existingRecord.bytes,
            created_at: Math.floor(existingRecord.createdAt.getTime() / 1000),
            filename: existingRecord.filename,
            purpose: existingRecord.purpose,
            status: existingRecord.status,
            status_details: existingRecord.statusDetails || undefined,
          };
        }
      }

      // Generate GCS path: {organizationId}/{purpose}/{fileId}/{filename}
      const gcsPath = `${userContext.organizationId}/${purpose}/${fileId}/${filename}`;
      
      // Upload to GCS
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(gcsPath);

      await file.save(fileBuffer, {
        contentType,
        metadata: {
          purpose,
          fileId,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          uploadedAt: new Date().toISOString(),
        },
      });

      // NOTE: we deliberately do NOT generate a signed download URL here. It
      // was stored in `gcsUrl` but never read by any endpoint (content is
      // served by getFileContent → bucket.file(gcsPath).download(), and the
      // OpenAI Files contract exposes no URL), AND a v4 signed URL expires in
      // 1h so any stored value would be stale by read time. Worse, under
      // default application credentials the signer must call the IAM signBlob
      // API — a network round-trip on the upload hot path to produce dead data.
      // If a download URL is ever needed, generate it lazily (fresh) at the
      // point of use via `generateDownloadUrl(fileId)` below.

      log.info({ requestId, fileId, gcsPath }, 'File uploaded to GCS successfully');

      // Save metadata to database
      const fileRecord = await prisma.file.upsert({
        where: { id: fileId },
        create: {
          id: fileId,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          filename,
          purpose,
          bytes,
          contentType,
          gcsPath,
          gcsUrl: null, // generated lazily on demand — see generateDownloadUrl()
          status: 'uploaded',
          createdAt: new Date(createdAt * 1000),
        },
        update: {
          filename,
          purpose,
          bytes,
          contentType,
          gcsPath,
          gcsUrl: null,
          status: 'uploaded',
          statusDetails: null,
        },
      });

      log.info({ requestId, fileId }, 'File metadata saved to database');

      return {
        id: fileRecord.id,
        bytes: fileRecord.bytes,
        created_at: Math.floor(fileRecord.createdAt.getTime() / 1000),
        filename: fileRecord.filename,
        purpose: fileRecord.purpose,
        status: fileRecord.status,
        status_details: fileRecord.statusDetails || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, fileId, error: errorMessage }, 'File upload failed');
      throw error;
    }
  }

  /**
   * List files for organization
   */
  async listFiles(options: FileListOptions): Promise<FileListResult> {
    const { purpose, limit, after, before, userContext, requestId } = options;

    log.info({ requestId, purpose, limit }, 'Listing files');

    try {
      const where: {
        organizationId: string;
        purpose?: string;
        id?: { gt?: string; lt?: string };
      } = {
        organizationId: userContext.organizationId,
      };

      if (purpose) {
        where.purpose = purpose;
      }

      if (after) {
        where.id = { gt: after };
      }

      if (before) {
        where.id = { lt: before };
      }

      const files = await prisma.file.findMany({
        where,
        take: limit + 1, // Get one extra to check has_more
        orderBy: { createdAt: 'desc' },
      });

      const has_more = files.length > limit;
      const returnFiles = has_more ? files.slice(0, limit) : files;

      return {
        files: returnFiles.map(f => ({
          id: f.id,
          object: 'file',
          bytes: f.bytes,
          created_at: Math.floor(f.createdAt.getTime() / 1000),
          filename: f.filename,
          purpose: f.purpose,
          status: f.status,
        })),
        has_more,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'List files failed');
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getFile(options: FileGetOptions): Promise<FileGetResult> {
    const { fileId, userContext, requestId } = options;

    log.info({ requestId, fileId }, 'Getting file metadata');

    try {
      const file = await prisma.file.findFirst({
        where: {
          id: fileId,
          organizationId: userContext.organizationId,
        },
      });

      if (!file) {
        throw new ResourceNotFoundError('File', fileId);
      }

      return {
        id: file.id,
        bytes: file.bytes,
        created_at: Math.floor(file.createdAt.getTime() / 1000),
        filename: file.filename,
        purpose: file.purpose,
        status: file.status,
        status_details: file.statusDetails || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, fileId, error: errorMessage }, 'Get file failed');
      throw error;
    }
  }

  /**
   * Get file content from GCS
   */
  async getFileContent(options: FileContentOptions): Promise<FileContentResult> {
    const { fileId, userContext, requestId } = options;

    if (!this.storage || !this.bucketName) {
      throw new Error('File storage is not configured');
    }

    log.info({ requestId, fileId }, 'Getting file content');

    try {
      // Get file metadata from database
      const fileRecord = await prisma.file.findFirst({
        where: {
          id: fileId,
          organizationId: userContext.organizationId,
        },
      });

      if (!fileRecord) {
        throw new ResourceNotFoundError('File', fileId);
      }

      // Download from GCS
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(fileRecord.gcsPath);

      const [content] = await file.download();

      log.info({ requestId, fileId, size: content.length }, 'File content retrieved from GCS');

      return {
        content,
        filename: fileRecord.filename,
        contentType: fileRecord.contentType,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, fileId, error: errorMessage }, 'Get file content failed');
      throw error;
    }
  }

  /**
   * Generate a fresh, short-lived signed download URL for a file — ON DEMAND.
   * This is the lazy counterpart to the upload path, which no longer generates
   * (and stores stale) signed URLs. Callers that genuinely need a direct-to-GCS
   * download link (rather than streaming bytes via getFileContent) call this at
   * the moment of use, guaranteeing the URL is valid for its full lifetime.
   */
  async generateDownloadUrl(options: {
    fileId: string;
    userContext: RequestUserContext;
    expiresInMs?: number;
  }): Promise<string> {
    const { fileId, userContext, expiresInMs = 3600 * 1000 } = options;

    if (!this.storage || !this.bucketName) {
      throw new Error('File storage is not configured');
    }

    const fileRecord = await prisma.file.findFirst({
      where: { id: fileId, organizationId: userContext.organizationId },
    });
    if (!fileRecord) {
      throw new ResourceNotFoundError('File', fileId);
    }

    const bucket = this.storage.bucket(this.bucketName);
    const [signedUrl] = await bucket.file(fileRecord.gcsPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInMs,
    });
    return signedUrl;
  }

  /**
   * Delete file from GCS and database
   */
  async deleteFile(options: FileDeleteOptions): Promise<FileDeleteResult> {
    const { fileId, userContext, requestId } = options;

    if (!this.storage || !this.bucketName) {
      throw new Error('File storage is not configured');
    }

    log.info({ requestId, fileId }, 'Deleting file');

    try {
      // Get file metadata from database
      const fileRecord = await prisma.file.findFirst({
        where: {
          id: fileId,
          organizationId: userContext.organizationId,
        },
      });

      if (!fileRecord) {
        throw new ResourceNotFoundError('File', fileId);
      }

      // Delete from GCS
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(fileRecord.gcsPath);
      await file.delete();

      log.info({ requestId, fileId }, 'File deleted from GCS');

      // Delete metadata from database
      await prisma.file.delete({
        where: { id: fileId },
      });

      log.info({ requestId, fileId }, 'File metadata deleted from database');

      return {
        deleted: true,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, fileId, error: errorMessage }, 'Delete file failed');
      throw error;
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get content type from file extension
   */
  private getContentType(extension: string): string {
    const contentTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.jsonl': 'application/jsonl',
      '.csv': 'text/csv',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/opus',
      '.mp4': 'video/mp4',
      '.mpeg': 'video/mpeg',
      '.webm': 'video/webm',
    };
    return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
  }

  private buildIdempotentFileId(
    organizationId: string,
    purpose: string,
    idempotencyKey: string
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`${organizationId}:${purpose}:${idempotencyKey}`)
      .digest('hex')
      .slice(0, 24);
    return `file-${digest}`;
  }
}

