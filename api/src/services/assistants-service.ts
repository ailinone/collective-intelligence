// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Assistants Service
 * Manages AI assistants with persistent state
 * 
 * NO HARDCODED MODELS - Dynamic selection based on assistant configuration
 * REAL IMPLEMENTATION - Persists assistants in database
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import {
  parseAssistantTools,
  parseToolResources,
  parseResponseFormat,
  parseMetadata,
  toPrismaJsonValue,
  toPrismaNullableJsonValue,
} from './assistants-service-helpers';
import type {
  CreateAssistantRequest,
  ModifyAssistantRequest,
  GetAssistantRequest,
  DeleteAssistantRequest,
  ListAssistantsRequest,
  Assistant,
  DeleteAssistantResponse,
  ListAssistantsResponse,
  CreateAssistantFileRequest,
  GetAssistantFileRequest,
  ListAssistantFilesRequest,
  DeleteAssistantFileRequest,
  AssistantFile,
  ListAssistantFilesResponse,
  DeleteAssistantFileResponse,
} from '@/types/assistants';

const log = logger.child({ service: 'assistants' });

export class AssistantsService {
  /**
   * Create assistant
   * REAL IMPLEMENTATION - Persists in database
   */
  async createAssistant(options: CreateAssistantRequest): Promise<Assistant> {
    const { name, description, model, instructions, tools, tool_resources, metadata, temperature, top_p, response_format, userContext, requestId } = options;
    
    const assistantId = `asst_${nanoid(24)}`;
    const _createdAt = Math.floor(Date.now() / 1000);

    log.info({ requestId, assistantId, model }, 'Creating assistant');

    try {
      // Persist assistant in database
      const assistant = await prisma.assistant.create({
        data: {
          id: assistantId,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          name: name || null,
          description: description || null,
          model: model || 'auto',
          instructions: instructions || null,
          tools: toPrismaJsonValue(tools || []),
          toolResources: toPrismaNullableJsonValue(tool_resources || null),
          metadata: toPrismaJsonValue(metadata || {}),
          temperature: temperature || null,
          topP: top_p || null,
          responseFormat: toPrismaNullableJsonValue(response_format || null),
        },
      });

      log.info({ requestId, assistantId }, 'Assistant created in database');

      return {
        id: assistant.id,
        object: 'assistant',
        created_at: Math.floor(assistant.createdAt.getTime() / 1000),
        name: assistant.name,
        description: assistant.description,
        model: assistant.model,
        instructions: assistant.instructions,
        tools: parseAssistantTools(assistant.tools),
        tool_resources: parseToolResources(assistant.toolResources),
        metadata: parseMetadata(assistant.metadata),
        temperature: assistant.temperature,
        top_p: assistant.topP,
        response_format: parseResponseFormat(assistant.responseFormat),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, error: errorMessage }, 'Create assistant failed');
      throw error;
    }
  }

  /**
   * Get assistant
   * REAL IMPLEMENTATION - Queries from database
   */
  async getAssistant(options: GetAssistantRequest): Promise<Assistant> {
    const { assistantId, userContext, requestId } = options;

    log.info({ requestId, assistantId }, 'Getting assistant');

    try {
      const assistant = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!assistant) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      return {
        id: assistant.id,
        object: 'assistant',
        created_at: Math.floor(assistant.createdAt.getTime() / 1000),
        name: assistant.name,
        description: assistant.description,
        model: assistant.model,
        instructions: assistant.instructions,
        tools: parseAssistantTools(assistant.tools),
        tool_resources: parseToolResources(assistant.toolResources),
        metadata: parseMetadata(assistant.metadata),
        temperature: assistant.temperature,
        top_p: assistant.topP,
        response_format: parseResponseFormat(assistant.responseFormat),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, error: errorMessage }, 'Get assistant failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Assistant ${assistantId} not found`);
      }
      throw error;
    }
  }

  /**
   * Modify assistant
   * REAL IMPLEMENTATION - Updates database
   */
  async modifyAssistant(options: ModifyAssistantRequest): Promise<Assistant> {
    const { assistantId, name, description, model, instructions, tools, tool_resources, metadata, temperature, top_p, response_format, userContext, requestId } = options;

    log.info({ requestId, assistantId }, 'Modifying assistant');

    try {
      // Get existing assistant first
      const existing = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!existing) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      // Update assistant in database
      const assistant = await prisma.assistant.update({
        where: { id: assistantId },
        data: {
          ...(name !== undefined && { name: name || null }),
          ...(description !== undefined && { description: description || null }),
          ...(model !== undefined && { model: model || 'auto' }),
          ...(instructions !== undefined && { instructions: instructions || null }),
          ...(tools !== undefined && { tools: toPrismaJsonValue(tools || []) }),
          ...(tool_resources !== undefined && { toolResources: toPrismaNullableJsonValue(tool_resources || null) }),
          ...(metadata !== undefined && { metadata: toPrismaJsonValue(metadata || {}) }),
          ...(temperature !== undefined && { temperature: temperature || null }),
          ...(top_p !== undefined && { topP: top_p || null }),
          ...(response_format !== undefined && { responseFormat: toPrismaNullableJsonValue(response_format || null) }),
        },
      });

      log.info({ requestId, assistantId }, 'Assistant updated in database');

      return {
        id: assistant.id,
        object: 'assistant',
        created_at: Math.floor(assistant.createdAt.getTime() / 1000),
        name: assistant.name,
        description: assistant.description,
        model: assistant.model,
        instructions: assistant.instructions,
        tools: parseAssistantTools(assistant.tools),
        tool_resources: parseToolResources(assistant.toolResources),
        metadata: parseMetadata(assistant.metadata),
        temperature: assistant.temperature,
        top_p: assistant.topP,
        response_format: parseResponseFormat(assistant.responseFormat),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, error: errorMessage }, 'Modify assistant failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Assistant ${assistantId} not found`);
      }
      throw error;
    }
  }

  /**
   * Delete assistant
   * REAL IMPLEMENTATION - Deletes from database
   */
  async deleteAssistant(options: DeleteAssistantRequest): Promise<DeleteAssistantResponse> {
    const { assistantId, userContext, requestId } = options;

    log.info({ requestId, assistantId }, 'Deleting assistant');

    try {
      // Check if assistant exists
      const existing = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!existing) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      // Delete assistant from database (cascade will delete threads, messages, runs)
      await prisma.assistant.delete({
        where: { id: assistantId },
      });

      log.info({ requestId, assistantId }, 'Assistant deleted from database');

      return { id: assistantId, object: 'assistant', deleted: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, error: errorMessage }, 'Delete assistant failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Assistant ${assistantId} not found`);
      }
      throw error;
    }
  }

  /**
   * List assistants
   * REAL IMPLEMENTATION - Queries from database
   */
  async listAssistants(options: ListAssistantsRequest): Promise<ListAssistantsResponse> {
    const { limit = 20, order, after, before, userContext, requestId } = options;

    log.info({ requestId, limit, order, after, before }, 'Listing assistants');

    try {
      const where: {
        organizationId: string;
        userId?: string;
        id?: { gt?: string; lt?: string };
      } = {
        organizationId: userContext.organizationId,
      };

      if (userContext.userId) {
        where.userId = userContext.userId;
      }

      if (after) {
        where.id = { gt: after };
      }

      if (before) {
        where.id = { lt: before };
      }

      const assistants = await prisma.assistant.findMany({
        where,
        take: limit + 1, // Get one extra to check has_more
        orderBy: order === 'desc' ? { createdAt: 'desc' } : { createdAt: 'asc' },
      });

      const has_more = assistants.length > limit;
      const returnAssistants = has_more ? assistants.slice(0, limit) : assistants;

      return {
        assistants: returnAssistants.map((assistant) => ({
          id: assistant.id,
          object: 'assistant',
          created_at: Math.floor(assistant.createdAt.getTime() / 1000),
          name: assistant.name,
          description: assistant.description,
          model: assistant.model,
          instructions: assistant.instructions,
          tools: parseAssistantTools(assistant.tools),
          tool_resources: parseToolResources(assistant.toolResources),
          metadata: parseMetadata(assistant.metadata),
          temperature: assistant.temperature,
          top_p: assistant.topP,
          response_format: parseResponseFormat(assistant.responseFormat),
        })),
        has_more,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'List assistants failed');
      throw error;
    }
  }

  /**
   * Create assistant file association
   * REAL IMPLEMENTATION - Persists in database
   */
  async createAssistantFile(options: CreateAssistantFileRequest): Promise<AssistantFile> {
    const { assistantId, fileId, userContext, requestId } = options;

    log.info({ requestId, assistantId, fileId }, 'Creating assistant file association');

    try {
      // Verify assistant exists and belongs to organization
      const assistant = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!assistant) {
        throw new Error(`Assistant ${assistantId} not found`);
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
      const existing = await prisma.assistantFile.findUnique({
        where: {
          assistantId_fileId: {
            assistantId,
            fileId,
          },
        },
      });

      if (existing) {
        return {
          id: existing.id,
          object: 'assistant.file',
          created_at: Math.floor(existing.createdAt.getTime() / 1000),
          assistant_id: existing.assistantId,
        };
      }

      // Create association
      const assistantFile = await prisma.assistantFile.create({
        data: {
          id: `asst_file_${nanoid(24)}`,
          assistantId,
          fileId,
        },
      });

      log.info({ requestId, assistantId, fileId, assistantFileId: assistantFile.id }, 'Assistant file association created');

      return {
        id: assistantFile.id,
        object: 'assistant.file',
        created_at: Math.floor(assistantFile.createdAt.getTime() / 1000),
        assistant_id: assistantFile.assistantId,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, fileId, error: errorMessage }, 'Create assistant file failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Get assistant file association
   * REAL IMPLEMENTATION - Queries from database
   */
  async getAssistantFile(options: GetAssistantFileRequest): Promise<AssistantFile> {
    const { assistantId, fileId, userContext, requestId } = options;

    log.info({ requestId, assistantId, fileId }, 'Getting assistant file association');

    try {
      // Verify assistant exists and belongs to organization
      const assistant = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!assistant) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      // Get association
      const assistantFile = await prisma.assistantFile.findUnique({
        where: {
          assistantId_fileId: {
            assistantId,
            fileId,
          },
        },
      });

      if (!assistantFile) {
        throw new Error(`File ${fileId} not associated with assistant ${assistantId}`);
      }

      return {
        id: assistantFile.id,
        object: 'assistant.file',
        created_at: Math.floor(assistantFile.createdAt.getTime() / 1000),
        assistant_id: assistantFile.assistantId,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, fileId, error: errorMessage }, 'Get assistant file failed');
      
      if (errorMessage.includes('not found') || errorMessage.includes('not associated')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * List assistant files
   * REAL IMPLEMENTATION - Queries from database
   */
  async listAssistantFiles(options: ListAssistantFilesRequest): Promise<ListAssistantFilesResponse> {
    const { assistantId, limit = 20, order = 'desc', after, before, userContext, requestId } = options;

    log.info({ requestId, assistantId, limit, order }, 'Listing assistant files');

    try {
      // Verify assistant exists and belongs to organization
      const assistant = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!assistant) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      // Build query
      const where: { assistantId: string; createdAt?: { gt?: Date; lt?: Date } } = { assistantId };

      if (after) {
        const afterFile = await prisma.assistantFile.findUnique({ where: { id: after } });
        if (afterFile) {
          where.createdAt = { gt: afterFile.createdAt };
        }
      }

      if (before) {
        const beforeFile = await prisma.assistantFile.findUnique({ where: { id: before } });
        if (beforeFile) {
          where.createdAt = where.createdAt 
            ? { ...where.createdAt, lt: beforeFile.createdAt }
            : { lt: beforeFile.createdAt };
        }
      }

      const files = await prisma.assistantFile.findMany({
        where,
        orderBy: { createdAt: order },
        take: limit + 1, // Fetch one extra to check if there are more
      });

      const has_more = files.length > limit;
      const returnFiles = has_more ? files.slice(0, limit) : files;

      return {
        object: 'list',
        data: returnFiles.map((af) => ({
          id: af.id,
          object: 'assistant.file' as const,
          created_at: Math.floor(af.createdAt.getTime() / 1000),
          assistant_id: af.assistantId,
        })),
        has_more,
        first_id: returnFiles.length > 0 ? returnFiles[0].id : undefined,
        last_id: returnFiles.length > 0 ? returnFiles[returnFiles.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, error: errorMessage }, 'List assistant files failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Delete assistant file association
   * REAL IMPLEMENTATION - Removes from database
   */
  async deleteAssistantFile(options: DeleteAssistantFileRequest): Promise<DeleteAssistantFileResponse> {
    const { assistantId, fileId, userContext, requestId } = options;

    log.info({ requestId, assistantId, fileId }, 'Deleting assistant file association');

    try {
      // Verify assistant exists and belongs to organization
      const assistant = await prisma.assistant.findFirst({
        where: {
          id: assistantId,
          organizationId: userContext.organizationId,
        },
      });

      if (!assistant) {
        throw new Error(`Assistant ${assistantId} not found`);
      }

      // Get association to verify it exists
      const assistantFile = await prisma.assistantFile.findUnique({
        where: {
          assistantId_fileId: {
            assistantId,
            fileId,
          },
        },
      });

      if (!assistantFile) {
        throw new Error(`File ${fileId} not associated with assistant ${assistantId}`);
      }

      // Delete association
      await prisma.assistantFile.delete({
        where: {
          id: assistantFile.id,
        },
      });

      log.info({ requestId, assistantId, fileId }, 'Assistant file association deleted');

      return {
        id: assistantFile.id,
        object: 'assistant.file.deleted',
        deleted: true,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, assistantId, fileId, error: errorMessage }, 'Delete assistant file failed');
      
      if (errorMessage.includes('not found') || errorMessage.includes('not associated')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }
}
