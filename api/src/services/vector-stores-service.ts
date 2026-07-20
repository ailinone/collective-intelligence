// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vector Stores Service
 * Manages vector stores for RAG (Retrieval-Augmented Generation)
 * 
 * Features:
 * - Vector store creation and management
 * - File associations for vectorization
 * - Status tracking (in_progress, completed, expired)
 * - Expiration management
 * - Organization-scoped isolation
 * 
 * NO HARDCODED MODELS - All embedding models selected dynamically
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import { Prisma } from '@/generated/prisma/index.js';
import { toPrismaJsonValue } from './assistants-service-helpers';
import { FilesService } from './files-service';
import {
  VectorStoreIngestService,
  type SearchChunkHit,
} from './vector-store-ingest-service';
import type {
  CreateVectorStoreRequest,
  ModifyVectorStoreRequest,
  GetVectorStoreRequest,
  ListVectorStoresRequest,
  DeleteVectorStoreRequest,
  VectorStore,
  ListVectorStoresResponse,
  DeleteVectorStoreResponse,
  CreateVectorStoreFileRequest,
  GetVectorStoreFileRequest,
  ListVectorStoreFilesRequest,
  DeleteVectorStoreFileRequest,
  VectorStoreFile,
  ListVectorStoreFilesResponse,
  DeleteVectorStoreFileResponse,
  SearchVectorStoreRequest,
  SearchVectorStoreResponse,
} from '@/types/assistants';
import type { RequestUserContext } from '@/types';

const log = logger.child({ service: 'vector-stores' });

/**
 * Decode raw file bytes into searchable text. Plain-text and structured-text
 * content types (text/*, json, jsonl, csv, markdown, xml) decode as UTF-8.
 * Binary formats (pdf, images, audio) are not text-extractable here and yield
 * an empty string — the ingest then records 0 chunks rather than embedding
 * binary noise. (PDF/OCR extraction is a future extension.)
 */
function decodeTextContent(content: Buffer, contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  const isText =
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('csv') ||
    ct.includes('xml') ||
    ct.includes('markdown') ||
    ct.includes('yaml') ||
    ct === 'application/octet-stream' || // many uploaded .txt land here
    ct === '';
  if (!isText) return '';
  return content.toString('utf-8');
}

/**
 * Type-safe status validation helpers
 */
function isValidVectorStoreStatus(status: string): status is VectorStore['status'] {
  return status === 'expired' || status === 'in_progress' || status === 'completed';
}

function isValidVectorStoreFileStatus(status: string): status is VectorStoreFile['status'] {
  return status === 'in_progress' || status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class VectorStoresService {
  private readonly filesService: FilesService;
  private readonly ingestService: VectorStoreIngestService;

  /**
   * @param deps Optional dependency injection for tests (file content source +
   *   ingest/search engine). Production uses the real GCS-backed FilesService
   *   and the pgvector-backed VectorStoreIngestService.
   */
  constructor(deps?: {
    filesService?: FilesService;
    ingestService?: VectorStoreIngestService;
  }) {
    this.filesService = deps?.filesService ?? new FilesService();
    this.ingestService = deps?.ingestService ?? new VectorStoreIngestService();
  }

  /**
   * Create vector store
   * REAL IMPLEMENTATION - Persists in database
   */
  async createVectorStore(options: CreateVectorStoreRequest): Promise<VectorStore> {
    const { name, file_ids, expires_after, metadata, userContext, requestId } = options;

    const vectorStoreId = `vs_${nanoid(24)}`;
    // DB-generated createdAt is the source of truth.

    log.info({ requestId, vectorStoreId, name, fileCount: file_ids?.length || 0 }, 'Creating vector store');

    try {
      // Calculate expires_at if expires_after is provided
      let expiresAt: Date | null = null;
      if (expires_after) {
        const days = expires_after.days;
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);
      }

      // Create vector store. We don't bind the result; the surrounding
      // function returns a synthesized response from `vectorStoreId` etc.
      // (the DB row is observed via separate findFirst calls when needed).
      await prisma.vectorStore.create({
        data: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
          userId: userContext.userId || null,
          name: name || null,
          status: 'in_progress',
          expiresAfter: expires_after ? toPrismaJsonValue(expires_after) : Prisma.DbNull,
          expiresAt,
          lastActiveAt: new Date(),
          metadata: metadata || {},
        },
      });

      // Associate files if provided
      if (file_ids && file_ids.length > 0) {
        // Verify all files exist and belong to organization
        const files = await prisma.file.findMany({
          where: {
            id: { in: file_ids },
            organizationId: userContext.organizationId,
          },
        });

        if (files.length !== file_ids.length) {
          const foundIds = files.map((f) => f.id);
          const missingIds = file_ids.filter((id) => !foundIds.includes(id));
          throw new Error(`Files not found: ${missingIds.join(', ')}`);
        }

        // Create file associations
        const associations = file_ids.map((fileId) => ({
          id: `vsf_${nanoid(24)}`,
          vectorStoreId,
          fileId,
          status: 'in_progress',
        }));
        await prisma.vectorStoreFile.createMany({ data: associations });

        log.info({ requestId, vectorStoreId, fileCount: file_ids.length }, 'Vector store files associated');

        // Real ingest for each associated file (chunk + embed + persist) — in
        // the BACKGROUND. The store stays `in_progress` and flips to `completed`
        // when the batch finishes (per-file terminal status is persisted by
        // processFileIngest itself). Clients poll — the OpenAI-compatible
        // contract; awaiting the whole embedding pipeline inside POST
        // /v1/vector_stores blocked the response for the full batch duration.
        void (async () => {
          for (const assoc of associations) {
            await this.processFileIngest({
              vectorStoreId,
              vectorStoreFileId: assoc.id,
              fileId: assoc.fileId,
              userContext,
              requestId,
            });
          }
          await prisma.vectorStore.update({
            where: { id: vectorStoreId },
            data: { status: 'completed' },
          });
        })().catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error({ requestId, vectorStoreId, error: errorMessage }, 'Background store ingest batch crashed');
        });
      } else {
        // No files: nothing to process — instant completion, same as before.
        await prisma.vectorStore.update({
          where: { id: vectorStoreId },
          data: { status: 'completed' },
        });
      }

      const result = await prisma.vectorStore.findUnique({
        where: { id: vectorStoreId },
        include: {
          files: true,
        },
      });

      if (!result) {
        throw new Error('Failed to retrieve created vector store');
      }

      return this.formatVectorStore(result);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, error: errorMessage }, 'Create vector store failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Get vector store
   * REAL IMPLEMENTATION - Queries from database
   */
  async getVectorStore(options: GetVectorStoreRequest): Promise<VectorStore> {
    const { vectorStoreId, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId }, 'Getting vector store');

    try {
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
        include: {
          files: true,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      return this.formatVectorStore(vectorStore);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, error: errorMessage }, 'Get vector store failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * List vector stores
   * REAL IMPLEMENTATION - Queries from database
   */
  async listVectorStores(options: ListVectorStoresRequest): Promise<ListVectorStoresResponse> {
    const { limit = 20, order = 'desc', after, before, userContext, requestId } = options;

    log.info({ requestId, limit, order }, 'Listing vector stores');

    try {
      // Build query
      const where: { organizationId: string; createdAt?: { gt?: Date; lt?: Date } } = {
        organizationId: userContext.organizationId,
      };

      if (after) {
        const afterStore = await prisma.vectorStore.findUnique({ where: { id: after } });
        if (afterStore) {
          where.createdAt = { gt: afterStore.createdAt };
        }
      }

      if (before) {
        const beforeStore = await prisma.vectorStore.findUnique({ where: { id: before } });
        if (beforeStore) {
          where.createdAt = where.createdAt 
            ? { ...where.createdAt, lt: beforeStore.createdAt }
            : { lt: beforeStore.createdAt };
        }
      }

      const stores = await prisma.vectorStore.findMany({
        where,
        orderBy: { createdAt: order },
        take: limit + 1, // Fetch one extra to check if there are more
        include: {
          files: true,
        },
      });

      const has_more = stores.length > limit;
      const returnStores = has_more ? stores.slice(0, limit) : stores;

      return {
        object: 'list',
        data: returnStores.map((vs) => this.formatVectorStore(vs)),
        has_more,
        first_id: returnStores.length > 0 ? returnStores[0].id : undefined,
        last_id: returnStores.length > 0 ? returnStores[returnStores.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'List vector stores failed');
      throw error;
    }
  }

  /**
   * Modify vector store
   * REAL IMPLEMENTATION - Updates in database
   */
  async modifyVectorStore(options: ModifyVectorStoreRequest): Promise<VectorStore> {
    const { vectorStoreId, name, expires_after, metadata, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId }, 'Modifying vector store');

    try {
      // Verify vector store exists and belongs to organization
      const existing = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!existing) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Calculate expires_at if expires_after is provided
      let expiresAt: Date | null | undefined = undefined;
      if (expires_after !== null && expires_after !== undefined) {
        if (expires_after) {
          const days = expires_after.days;
          expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + days);
        } else {
          expiresAt = null;
        }
      }

      // Build update data
      const updateData: {
        name?: string | null;
        expiresAfter?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
        expiresAt?: Date | null;
        metadata?: Prisma.InputJsonValue;
        lastActiveAt?: Date;
      } = {};

      if (name !== undefined) {
        updateData.name = name;
      }

      if (expires_after !== undefined) {
        updateData.expiresAfter = expires_after ? toPrismaJsonValue(expires_after) : Prisma.DbNull;
        updateData.expiresAt = expiresAt;
      }

      if (metadata !== undefined) {
        updateData.metadata = toPrismaJsonValue(metadata);
        updateData.lastActiveAt = new Date();
      }

      // Update vector store
      const updated = await prisma.vectorStore.update({
        where: { id: vectorStoreId },
        data: updateData,
        include: {
          files: true,
        },
      });

      log.info({ requestId, vectorStoreId }, 'Vector store modified');

      return this.formatVectorStore(updated);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, error: errorMessage }, 'Modify vector store failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Delete vector store
   * REAL IMPLEMENTATION - Removes from database (cascade deletes files)
   */
  async deleteVectorStore(options: DeleteVectorStoreRequest): Promise<DeleteVectorStoreResponse> {
    const { vectorStoreId, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId }, 'Deleting vector store');

    try {
      // Verify vector store exists and belongs to organization
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Delete vector store (cascade will delete associated files)
      await prisma.vectorStore.delete({
        where: { id: vectorStoreId },
      });

      log.info({ requestId, vectorStoreId }, 'Vector store deleted');

      return {
        id: vectorStoreId,
        object: 'vector_store.deleted',
        deleted: true,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, error: errorMessage }, 'Delete vector store failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Create vector store file association
   * REAL IMPLEMENTATION - Persists in database
   */
  async createVectorStoreFile(options: CreateVectorStoreFileRequest): Promise<VectorStoreFile> {
    const { vectorStoreId, fileId, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId, fileId }, 'Creating vector store file association');

    try {
      // Verify vector store exists and belongs to organization
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Verify file exists and belongs to organization
      const file = await prisma.file.findFirst({
        where: {
          id: fileId,
          organizationId: userContext.organizationId,
        },
      });

      if (!file) {
        throw new Error(`File ${fileId} not found`);
      }

      // Check if association already exists
      const existing = await prisma.vectorStoreFile.findUnique({
        where: {
          vectorStoreId_fileId: {
            vectorStoreId,
            fileId,
          },
        },
      });

      if (existing) {
        return {
          id: existing.id,
          object: 'vector_store.file',
          created_at: Math.floor(existing.createdAt.getTime() / 1000),
          vector_store_id: existing.vectorStoreId,
          status: isValidVectorStoreFileStatus(existing.status) ? existing.status : 'in_progress',
        };
      }

      // Create association
      const vectorStoreFile = await prisma.vectorStoreFile.create({
        data: {
          id: `vsf_${nanoid(24)}`,
          vectorStoreId,
          fileId,
          status: 'in_progress',
        },
      });

      // Update vector store last_active_at
      await prisma.vectorStore.update({
        where: { id: vectorStoreId },
        data: { lastActiveAt: new Date() },
      });

      log.info({ requestId, vectorStoreId, fileId, vectorStoreFileId: vectorStoreFile.id }, 'Vector store file association created');

      // Real ingest: chunk + embed + persist vectors — in the BACKGROUND.
      // This pipeline (GCS download → chunking → embedding-provider calls →
      // pgvector writes) used to be awaited inside this HTTP request, blocking
      // the response for potentially tens of seconds on large files, while the
      // route schema already documented "Processing happens asynchronously".
      // processFileIngest persists the terminal status itself (in_progress →
      // completed/failed + lastError), so clients poll GET /vector_stores/:id/files
      // for the outcome — the OpenAI-compatible contract.
      void this.processFileIngest({
        vectorStoreId,
        vectorStoreFileId: vectorStoreFile.id,
        fileId,
        userContext,
        requestId,
      }).catch((error: unknown) => {
        // processFileIngest already records failures on the row; this catch only
        // guards against an unexpected throw outside its own error handling.
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ requestId, vectorStoreId, fileId, error: errorMessage }, 'Background file ingest crashed');
      });

      return {
        id: vectorStoreFile.id,
        object: 'vector_store.file',
        created_at: Math.floor(vectorStoreFile.createdAt.getTime() / 1000),
        vector_store_id: vectorStoreFile.vectorStoreId,
        status: 'in_progress',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, fileId, error: errorMessage }, 'Create vector store file failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Get vector store file association
   * REAL IMPLEMENTATION - Queries from database
   */
  async getVectorStoreFile(options: GetVectorStoreFileRequest): Promise<VectorStoreFile> {
    const { vectorStoreId, fileId, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId, fileId }, 'Getting vector store file association');

    try {
      // Verify vector store exists and belongs to organization
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Get association
      const vectorStoreFile = await prisma.vectorStoreFile.findUnique({
        where: {
          vectorStoreId_fileId: {
            vectorStoreId,
            fileId,
          },
        },
      });

      if (!vectorStoreFile) {
        throw new Error(`File ${fileId} not associated with vector store ${vectorStoreId}`);
      }

      return {
        id: vectorStoreFile.id,
        object: 'vector_store.file',
        created_at: Math.floor(vectorStoreFile.createdAt.getTime() / 1000),
        vector_store_id: vectorStoreFile.vectorStoreId,
          status: isValidVectorStoreFileStatus(vectorStoreFile.status) ? vectorStoreFile.status : 'in_progress',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, fileId, error: errorMessage }, 'Get vector store file failed');
      
      if (errorMessage.includes('not found') || errorMessage.includes('not associated')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * List vector store files
   * REAL IMPLEMENTATION - Queries from database
   */
  async listVectorStoreFiles(options: ListVectorStoreFilesRequest): Promise<ListVectorStoreFilesResponse> {
    const { vectorStoreId, limit = 20, order = 'desc', after, before, filter, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId, limit, order, filter }, 'Listing vector store files');

    try {
      // Verify vector store exists and belongs to organization
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Build query
      const where: { vectorStoreId: string; status?: string; createdAt?: { gt?: Date; lt?: Date } } = { vectorStoreId };

      if (filter) {
        where.status = filter;
      }

      if (after) {
        const afterFile = await prisma.vectorStoreFile.findUnique({ where: { id: after } });
        if (afterFile) {
          where.createdAt = { gt: afterFile.createdAt };
        }
      }

      if (before) {
        const beforeFile = await prisma.vectorStoreFile.findUnique({ where: { id: before } });
        if (beforeFile) {
          where.createdAt = where.createdAt 
            ? { ...where.createdAt, lt: beforeFile.createdAt }
            : { lt: beforeFile.createdAt };
        }
      }

      const files = await prisma.vectorStoreFile.findMany({
        where,
        orderBy: { createdAt: order },
        take: limit + 1, // Fetch one extra to check if there are more
      });

      const has_more = files.length > limit;
      const returnFiles = has_more ? files.slice(0, limit) : files;

      return {
        object: 'list',
        data: returnFiles.map((vsf) => ({
          id: vsf.id,
          object: 'vector_store.file' as const,
          created_at: Math.floor(vsf.createdAt.getTime() / 1000),
          vector_store_id: vsf.vectorStoreId,
          status: isValidVectorStoreFileStatus(vsf.status) ? vsf.status : 'in_progress',
        })),
        has_more,
        first_id: returnFiles.length > 0 ? returnFiles[0].id : undefined,
        last_id: returnFiles.length > 0 ? returnFiles[returnFiles.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, error: errorMessage }, 'List vector store files failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Delete vector store file association
   * REAL IMPLEMENTATION - Removes from database
   */
  async deleteVectorStoreFile(options: DeleteVectorStoreFileRequest): Promise<DeleteVectorStoreFileResponse> {
    const { vectorStoreId, fileId, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId, fileId }, 'Deleting vector store file association');

    try {
      // Verify vector store exists and belongs to organization
      const vectorStore = await prisma.vectorStore.findFirst({
        where: {
          id: vectorStoreId,
          organizationId: userContext.organizationId,
        },
      });

      if (!vectorStore) {
        throw new Error(`Vector store ${vectorStoreId} not found`);
      }

      // Get association to verify it exists
      const vectorStoreFile = await prisma.vectorStoreFile.findUnique({
        where: {
          vectorStoreId_fileId: {
            vectorStoreId,
            fileId,
          },
        },
      });

      if (!vectorStoreFile) {
        throw new Error(`File ${fileId} not associated with vector store ${vectorStoreId}`);
      }

      // Delete association
      await prisma.vectorStoreFile.delete({
        where: {
          id: vectorStoreFile.id,
        },
      });

      // Update vector store last_active_at
      await prisma.vectorStore.update({
        where: { id: vectorStoreId },
        data: { lastActiveAt: new Date() },
      });

      log.info({ requestId, vectorStoreId, fileId }, 'Vector store file association deleted');

      return {
        id: vectorStoreFile.id,
        object: 'vector_store.file.deleted',
        deleted: true,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, vectorStoreId, fileId, error: errorMessage }, 'Delete vector store file failed');
      
      if (errorMessage.includes('not found') || errorMessage.includes('not associated')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Process a single file association: fetch content, chunk + embed + persist
   * vectors, and update the association status to reflect the real outcome.
   *
   * Returns the final file status. Never throws — ingest failures are captured
   * on the association row (`status='failed'`, `last_error`) so the API stays
   * available even when one file can't be processed (e.g. binary content, a
   * transient embedder error).
   */
  private async processFileIngest(input: {
    vectorStoreId: string;
    vectorStoreFileId: string;
    fileId: string;
    userContext: RequestUserContext;
    requestId: string;
  }): Promise<VectorStoreFile['status']> {
    const { vectorStoreId, vectorStoreFileId, fileId, userContext, requestId } = input;
    try {
      const fileContent = await this.filesService.getFileContent({
        fileId,
        userContext,
        requestId,
      });

      const text = decodeTextContent(fileContent.content, fileContent.contentType);

      const result = await this.ingestService.ingestFile({
        vectorStoreId,
        vectorStoreFileId,
        fileId,
        organizationId: userContext.organizationId,
        content: text,
        metadata: { filename: fileContent.filename },
      });

      await prisma.vectorStoreFile.update({
        where: { id: vectorStoreFileId },
        data: {
          status: 'completed',
          chunkCount: result.chunksCreated,
          lastError: null,
        },
      });

      log.info(
        { requestId, vectorStoreId, fileId, vectorStoreFileId, chunks: result.chunksCreated },
        'Vector store file ingest completed',
      );
      return 'completed';
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error(
        { requestId, vectorStoreId, fileId, vectorStoreFileId, error: errorMessage },
        'Vector store file ingest failed',
      );
      // Best-effort status update; swallow secondary failure.
      try {
        await prisma.vectorStoreFile.update({
          where: { id: vectorStoreFileId },
          data: { status: 'failed', lastError: errorMessage.slice(0, 1000) },
        });
      } catch {
        // ignore — primary error already logged
      }
      return 'failed';
    }
  }

  /**
   * Semantic search over a vector store (F3/F1 §P4).
   *
   * Verifies the store belongs to the caller's organization (404 otherwise),
   * then embeds the query and runs a pgvector cosine kNN over the store's
   * chunks. Results are OpenAI-shaped (`object: 'vector_store.search_results'`).
   */
  async searchVectorStore(options: SearchVectorStoreRequest): Promise<SearchVectorStoreResponse> {
    const { vectorStoreId, query, top_k, file_ids, userContext, requestId } = options;

    log.info({ requestId, vectorStoreId, top_k }, 'Searching vector store');

    // Tenant isolation: store must belong to the caller's org.
    const vectorStore = await prisma.vectorStore.findFirst({
      where: {
        id: vectorStoreId,
        organizationId: userContext.organizationId,
      },
    });

    if (!vectorStore) {
      throw new Error(`Vector store ${vectorStoreId} not found`);
    }

    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('query is required and must be a non-empty string');
    }

    const hits: SearchChunkHit[] = await this.ingestService.search({
      vectorStoreId,
      organizationId: userContext.organizationId,
      query,
      topK: top_k,
      fileIds: file_ids,
    });

    // Touch last_active_at (search counts as activity for expiration anchoring).
    await prisma.vectorStore
      .update({ where: { id: vectorStoreId }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);

    return {
      object: 'vector_store.search_results',
      search_query: query,
      data: hits.map((hit) => ({
        file_id: hit.fileId,
        score: hit.score,
        content: [{ type: 'text', text: hit.content }],
        chunk_index: hit.chunkIndex,
        metadata:
          hit.metadata && typeof hit.metadata === 'object'
            ? (hit.metadata as Record<string, unknown>)
            : {},
      })),
      has_more: false,
      next_page: null,
    };
  }

  /**
   * Format Prisma VectorStore to API VectorStore type
   */
  private formatVectorStore(store: {
    id: string;
    name: string | null;
    status: string;
    expiresAfter: unknown;
    expiresAt: Date | null;
    lastActiveAt: Date | null;
    metadata: unknown;
    createdAt: Date;
    files: Array<{
      status: string;
    }>;
  }): VectorStore {
    // Type-safe conversion without 'as unknown as'
    const expiresAfter: VectorStore['expires_after'] | null = 
      store.expiresAfter && typeof store.expiresAfter === 'object' && 'anchor' in store.expiresAfter && 'days' in store.expiresAfter
        ? {
            anchor: store.expiresAfter.anchor === 'last_active_at' ? 'last_active_at' : 'last_active_at',
            days: typeof store.expiresAfter.days === 'number' ? store.expiresAfter.days : 1,
          }
        : null;
    
    const metadata: Record<string, string> = 
      store.metadata && typeof store.metadata === 'object' && !Array.isArray(store.metadata)
        ? Object.entries(store.metadata).reduce((acc, [key, value]) => {
            if (typeof key === 'string' && typeof value === 'string') {
              acc[key] = value;
            }
            return acc;
          }, {} as Record<string, string>)
        : {};

    // Calculate file counts
    const fileCounts = {
      in_progress: store.files.filter((f) => f.status === 'in_progress').length,
      completed: store.files.filter((f) => f.status === 'completed').length,
      failed: store.files.filter((f) => f.status === 'failed').length,
      cancelled: store.files.filter((f) => f.status === 'cancelled').length,
    };

    return {
      id: store.id,
      object: 'vector_store',
      created_at: Math.floor(store.createdAt.getTime() / 1000),
      name: store.name || undefined,
      file_counts: fileCounts,
      status: isValidVectorStoreStatus(store.status) ? store.status : 'in_progress',
      expires_after: expiresAfter || undefined,
      expires_at: store.expiresAt ? Math.floor(store.expiresAt.getTime() / 1000) : undefined,
      last_active_at: store.lastActiveAt ? Math.floor(store.lastActiveAt.getTime() / 1000) : undefined,
      metadata,
    };
  }
}

