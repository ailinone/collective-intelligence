// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Threads Service
 * Manages conversation threads and runs
 * 
 * NO HARDCODED MODELS - Dynamic selection per run
 * REAL IMPLEMENTATION - Persists threads, messages, and runs in database
 */

import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import { toPrismaJsonValue, toPrismaNullableJsonValue } from '@/services/assistants-service-helpers';
import { threadRunQueueService } from '@/services/thread-run-queue-service';
import type {
  CreateThreadRequest,
  ModifyThreadRequest,
  GetThreadRequest,
  DeleteThreadRequest,
  CreateMessageRequest,
  ListMessagesRequest,
  CreateRunRequest,
  ListRunsRequest,
  GetRunRequest,
  GetMessageRequest,
  ModifyMessageRequest,
  DeleteMessageRequest,
  SubmitToolOutputsRequest,
  CancelRunRequest,
  ListRunStepsRequest,
  GetRunStepRequest,
  Thread,
  ThreadMessage,
  ThreadRun,
  ThreadRunStep,
  DeleteThreadResponse,
  ListMessagesResponse,
  ListRunsResponse,
  DeleteMessageResponse,
  ListRunStepsResponse,
} from '@/types/threads';

const log = logger.child({ service: 'threads' });

export class ThreadsService {
  /**
   * Create thread
   * REAL IMPLEMENTATION - Persists in database
   */
  async createThread(options: CreateThreadRequest): Promise<Thread> {
    const { messages, metadata, userContext, requestId } = options;
    
    const threadId = `thread_${nanoid(24)}`;
    // DB-generated createdAt is the source of truth; no local stamp needed.

    log.info({ requestId, threadId, messageCount: messages?.length || 0 }, 'Creating thread');

    try {
      // Create thread record in database
      const thread = await prisma.thread.create({
        data: {
          id: threadId,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          metadata: metadata || {},
        },
      });

      // If messages provided, create message records
      if (messages && messages.length > 0) {
        const messagePromises = messages.map((msg) => {
          const messageId = `msg_${nanoid(24)}`;
          const contentArray = Array.isArray(msg.content) 
            ? msg.content 
            : [{ type: 'text' as const, text: typeof msg.content === 'string' ? msg.content : '' }];
          
          // Build metadata including tool_call_id and name for 'tool' role
          const messageMetadata: Record<string, string> = { ...(msg.metadata || {}) };
          if (msg.role === 'tool' && msg.tool_call_id) {
            messageMetadata.tool_call_id = msg.tool_call_id;
          }
          if (msg.role === 'tool' && msg.name) {
            messageMetadata.tool_name = msg.name;
          }
          
          return prisma.threadMessage.create({
            data: {
              id: messageId,
              threadId: threadId,
              role: msg.role,
              content: contentArray as Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>,
              fileIds: msg.file_ids || [],
              metadata: messageMetadata,
            },
          });
        });

        await Promise.all(messagePromises);
        log.info({ requestId, threadId, messageCount: messages.length }, 'Thread created with messages');
      }

      return {
        id: thread.id,
        object: 'thread',
        created_at: Math.floor(thread.createdAt.getTime() / 1000),
        metadata: thread.metadata as Record<string, string>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'Create thread failed');
      throw error;
    }
  }

  /**
   * Get thread
   * REAL IMPLEMENTATION - Queries from database
   */
  async getThread(options: GetThreadRequest): Promise<Thread> {
    const { threadId, userContext, requestId } = options;

    log.info({ requestId, threadId }, 'Getting thread');

    try {
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      return {
        id: thread.id,
        object: 'thread',
        created_at: Math.floor(thread.createdAt.getTime() / 1000),
        metadata: thread.metadata as Record<string, string>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'Get thread failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * Modify thread
   * REAL IMPLEMENTATION - Updates database
   */
  async modifyThread(options: ModifyThreadRequest): Promise<Thread> {
    const { threadId, metadata, userContext, requestId } = options;

    log.info({ requestId, threadId }, 'Modifying thread');

    try {
      // Get thread from database
      const existing = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!existing) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Update metadata
      const thread = await prisma.thread.update({
        where: { id: threadId },
        data: {
          metadata: metadata || {},
        },
      });

      log.info({ requestId, threadId }, 'Thread updated in database');

      return {
        id: thread.id,
        object: 'thread',
        created_at: Math.floor(thread.createdAt.getTime() / 1000),
        metadata: thread.metadata as Record<string, string>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'Modify thread failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * Delete thread
   * REAL IMPLEMENTATION - Deletes from database (cascade deletes messages and runs)
   */
  async deleteThread(options: DeleteThreadRequest): Promise<DeleteThreadResponse> {
    const { threadId, userContext, requestId } = options;

    log.info({ requestId, threadId }, 'Deleting thread');

    try {
      // Check if thread exists
      const existing = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!existing) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Delete thread from database (cascade will delete messages and runs)
      await prisma.thread.delete({
        where: { id: threadId },
      });

      log.info({ requestId, threadId }, 'Thread deleted from database');

      return { id: threadId, object: 'thread.deleted', deleted: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'Delete thread failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * Create message in thread
   * REAL IMPLEMENTATION - Persists in database
   */
  async createMessage(options: CreateMessageRequest): Promise<ThreadMessage> {
    const { threadId, role, content, file_ids, metadata, tool_call_id, name, userContext, requestId } = options;

    const messageId = `msg_${nanoid(24)}`;
    // DB-generated createdAt is the source of truth; no local stamp needed.

    log.info({ requestId, threadId, messageId, role }, 'Creating message');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Validate that tool_call_id and name are provided when role is 'tool'
      if (role === 'tool') {
        if (!tool_call_id) {
          throw new Error('tool_call_id is required when role is "tool"');
        }
        if (!name) {
          throw new Error('name is required when role is "tool"');
        }
      }

      // Normalize content to array format compatible with ThreadMessage['content']
      let contentArray: ThreadMessage['content'];
      
      if (Array.isArray(content)) {
        contentArray = content.map(item => {
          if (typeof item === 'string') {
            return { type: 'text' as const, text: { value: item } };
          }
          if (item.type === 'text') {
            if (typeof item.text === 'string') {
              return { type: 'text' as const, text: { value: item.text } };
            }
            return { type: 'text' as const, text: { value: '' } };
          }
          if (item.type === 'image_url') {
            return {
              type: 'image_url' as const,
              image_url: {
                url: item.image_url?.url || '',
                detail: item.image_url?.detail,
              },
            };
          }
          return { type: 'text' as const, text: { value: '' } };
        });
      } else {
        contentArray = [{ type: 'text' as const, text: { value: content as string } }];
      }

      // Build metadata including tool_call_id and name for 'tool' role
      const messageMetadata: Record<string, string> = { ...(metadata || {}) };
      if (role === 'tool' && tool_call_id) {
        messageMetadata.tool_call_id = tool_call_id;
      }
      if (role === 'tool' && name) {
        messageMetadata.tool_name = name;
      }

      // Create message record in database
      const message = await prisma.threadMessage.create({
        data: {
          id: messageId,
          threadId: threadId,
          role: role,
          content: contentArray as Array<{ type: string; text?: { value: string }; image_url?: { url: string; detail?: string } }>,
          fileIds: file_ids || [],
          metadata: messageMetadata,
        },
      });

      log.info({ requestId, threadId, messageId }, 'Message created in database');

      // Extract tool_call_id and name from metadata if present (for 'tool' role)
      const metadataObj = message.metadata as Record<string, string>;
      const toolCallId = metadataObj.tool_call_id;
      const toolName = metadataObj.tool_name;

      return {
        id: message.id,
        object: 'thread.message',
        created_at: Math.floor(message.createdAt.getTime() / 1000),
        thread_id: message.threadId,
        role: message.role as ThreadMessage['role'],
        content: message.content as ThreadMessage['content'],
        assistant_id: message.assistantId || undefined,
        run_id: message.runId || undefined,
        file_ids: message.fileIds,
        metadata: metadataObj,
        tool_call_id: toolCallId,
        name: toolName,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, messageId, error: errorMessage }, 'Create message failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * List messages in thread
   * REAL IMPLEMENTATION - Queries from database
   */
  async listMessages(options: ListMessagesRequest): Promise<ListMessagesResponse> {
    const { threadId, limit = 20, order = 'desc', after, before, run_id, userContext, requestId } = options;

    log.info({ requestId, threadId, limit, order, after, before, run_id }, 'Listing messages');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Build where clause
      const where: {
        threadId: string;
        runId?: string | null;
        id?: { gt?: string; lt?: string };
      } = {
        threadId: threadId,
      };

      if (run_id) {
        where.runId = run_id;
      }

      if (after) {
        where.id = { gt: after };
      }

      if (before) {
        where.id = { lt: before };
      }

      // Query messages from database
      const messages = await prisma.threadMessage.findMany({
        where,
        take: limit + 1, // Get one extra to check has_more
        orderBy: order === 'desc' ? { createdAt: 'desc' } : { createdAt: 'asc' },
      });

      const has_more = messages.length > limit;
      const returnMessages = has_more ? messages.slice(0, limit) : messages;

      return {
        messages: returnMessages.map((msg) => {
          const metadataObj = msg.metadata as Record<string, string>;
          const toolCallId = metadataObj.tool_call_id;
          const toolName = metadataObj.tool_name;

          return {
            id: msg.id,
            object: 'thread.message',
            created_at: Math.floor(msg.createdAt.getTime() / 1000),
            thread_id: msg.threadId,
            role: msg.role as ThreadMessage['role'],
            content: msg.content as ThreadMessage['content'],
            assistant_id: msg.assistantId || undefined,
            run_id: msg.runId || undefined,
            file_ids: msg.fileIds,
            metadata: metadataObj,
            tool_call_id: toolCallId,
            name: toolName,
          };
        }),
        has_more,
        first_id: returnMessages.length > 0 ? returnMessages[0].id : undefined,
        last_id: returnMessages.length > 0 ? returnMessages[returnMessages.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'List messages failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * Create run in thread
   * REAL IMPLEMENTATION - Persists in database, execution via OrchestrationEngine
   * Runs are enqueued and processed asynchronously by thread-run-worker which uses OrchestrationEngine
   */
  async createRun(options: CreateRunRequest): Promise<ThreadRun> {
    const { 
      threadId, 
      assistant_id, 
      model, 
      instructions, 
      tools, 
      file_ids, 
      metadata,
      temperature,
      top_p,
      max_prompt_tokens,
      max_completion_tokens,
      truncation_strategy,
      response_format,
      userContext,
      requestId 
    } = options;

    const runId = `run_${nanoid(24)}`;
    // Local stamp used here only to compute expiresAt; the canonical
    // createdAt comes from the DB row.
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + 3600; // 1 hour from now

    log.info({ requestId, threadId, runId, assistant_id, model }, 'Creating run');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Create run record in database
      const run = await prisma.threadRun.create({
        data: {
          id: runId,
          threadId: threadId,
          assistantId: assistant_id,
          status: 'queued',
          model: model || 'auto',
          instructions: instructions || null,
          tools: tools ? toPrismaJsonValue(tools) : toPrismaJsonValue([]),
          toolResources: toPrismaNullableJsonValue(null),
          metadata: metadata || {},
          temperature: temperature || null,
          topP: top_p || null,
          maxPromptTokens: max_prompt_tokens || null,
          maxCompletionTokens: max_completion_tokens || null,
          truncationStrategy: truncation_strategy ? toPrismaNullableJsonValue(truncation_strategy) : toPrismaNullableJsonValue(null),
          responseFormat: response_format ? toPrismaNullableJsonValue(typeof response_format === 'string' ? { type: response_format } : response_format) : toPrismaNullableJsonValue(null),
          parallelToolCalls: true,
          stream: false,
          expiresAt: new Date(expiresAt * 1000),
          fileIds: file_ids || [],
        },
      });

      log.info({ requestId, threadId, runId }, 'Run created in database');

      // Enqueue run for asynchronous processing via BullMQ worker
      if (threadRunQueueService.isAvailable()) {
        try {
          // Calculate priority based on organization tier (lower = higher priority)
          const priority = 1000; // Default priority, can be adjusted based on org tier
          
          await threadRunQueueService.enqueue({
            runId,
            threadId,
            assistantId: assistant_id,
            organizationId: userContext.organizationId,
            userId: userContext.userId,
            model: model || undefined,
            instructions: instructions || undefined,
            tools: tools || undefined,
            temperature: temperature || undefined,
            topP: top_p || undefined,
            maxCompletionTokens: max_completion_tokens || undefined,
            priority,
            queuedAt: Date.now(),
          });
          
          log.info({ requestId, threadId, runId }, 'Run enqueued for async processing');
        } catch (enqueueError) {
          log.error(
            { requestId, threadId, runId, error: getErrorMessage(enqueueError) },
            'Failed to enqueue run - will remain in queued status'
          );
        }
      } else {
        log.warn(
          { requestId, threadId, runId },
          'Queue not available - run will remain in queued status until manually processed'
        );
      }

      return {
        id: run.id,
        object: 'thread.run',
        created_at: Math.floor(run.createdAt.getTime() / 1000),
        thread_id: run.threadId,
        assistant_id: run.assistantId,
        status: run.status as ThreadRun['status'],
        expires_at: run.expiresAt ? Math.floor(run.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600, // Default to 1 hour if null
        started_at: run.startedAt ? Math.floor(run.startedAt.getTime() / 1000) : null,
        cancelled_at: run.cancelledAt ? Math.floor(run.cancelledAt.getTime() / 1000) : null,
        failed_at: run.failedAt ? Math.floor(run.failedAt.getTime() / 1000) : null,
        completed_at: run.completedAt ? Math.floor(run.completedAt.getTime() / 1000) : null,
        model: run.model || 'auto',
        instructions: run.instructions || '',
        tools: (run.tools as Array<{ type: 'function' | 'file_search' | 'code_interpreter'; function?: { name: string; description: string; parameters: Record<string, unknown> } }>) || [],
        file_ids: run.fileIds,
        metadata: run.metadata as Record<string, string>,
        temperature: run.temperature || undefined,
        top_p: run.topP || undefined,
        max_prompt_tokens: run.maxPromptTokens || undefined,
        max_completion_tokens: run.maxCompletionTokens || undefined,
        required_action: run.requiredAction as ThreadRun['required_action'] || undefined,
        last_error: run.lastError as ThreadRun['last_error'] || undefined,
        usage: run.usage as ThreadRun['usage'] || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, error: errorMessage }, 'Create run failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * List runs in thread
   * REAL IMPLEMENTATION - Queries from database
   */
  async listRuns(options: ListRunsRequest): Promise<ListRunsResponse> {
    const { threadId, limit = 20, order = 'desc', after, before, userContext, requestId } = options;

    log.info({ requestId, threadId, limit, order, after, before }, 'Listing runs');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Build where clause
      const where: {
        threadId: string;
        id?: { gt?: string; lt?: string };
      } = {
        threadId: threadId,
      };

      if (after) {
        where.id = { gt: after };
      }

      if (before) {
        where.id = { lt: before };
      }

      // Query runs from database
      const runs = await prisma.threadRun.findMany({
        where,
        take: limit + 1, // Get one extra to check has_more
        orderBy: order === 'desc' ? { createdAt: 'desc' } : { createdAt: 'asc' },
      });

      const has_more = runs.length > limit;
      const returnRuns = has_more ? runs.slice(0, limit) : runs;

      return {
        runs: returnRuns.map((run) => ({
          id: run.id,
          object: 'thread.run',
          created_at: Math.floor(run.createdAt.getTime() / 1000),
          thread_id: run.threadId,
          assistant_id: run.assistantId,
          status: run.status as ThreadRun['status'],
          expires_at: run.expiresAt ? Math.floor(run.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600,
          started_at: run.startedAt ? Math.floor(run.startedAt.getTime() / 1000) : null,
          cancelled_at: run.cancelledAt ? Math.floor(run.cancelledAt.getTime() / 1000) : null,
          failed_at: run.failedAt ? Math.floor(run.failedAt.getTime() / 1000) : null,
          completed_at: run.completedAt ? Math.floor(run.completedAt.getTime() / 1000) : null,
          model: run.model || 'auto',
          instructions: run.instructions || '',
          tools: (run.tools as Array<{ type: 'function' | 'file_search' | 'code_interpreter'; function?: { name: string; description: string; parameters: Record<string, unknown> } }>) || [],
          file_ids: run.fileIds,
          metadata: run.metadata as Record<string, string>,
          temperature: run.temperature || undefined,
          top_p: run.topP || undefined,
          max_prompt_tokens: run.maxPromptTokens || undefined,
          max_completion_tokens: run.maxCompletionTokens || undefined,
          required_action: run.requiredAction as ThreadRun['required_action'] || undefined,
          last_error: run.lastError as ThreadRun['last_error'] || undefined,
          usage: run.usage as ThreadRun['usage'] || undefined,
        })),
        has_more,
        first_id: returnRuns.length > 0 ? returnRuns[0].id : undefined,
        last_id: returnRuns.length > 0 ? returnRuns[returnRuns.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, error: errorMessage }, 'List runs failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Thread ${threadId} not found`);
      }
      throw error;
    }
  }

  /**
   * Get run
   * REAL IMPLEMENTATION - Queries from database
   */
  async getRun(options: GetRunRequest): Promise<ThreadRun> {
    const { threadId, runId, userContext, requestId } = options;

    log.info({ requestId, threadId, runId }, 'Getting run');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Get run
      const run = await prisma.threadRun.findFirst({
        where: {
          id: runId,
          threadId: threadId,
        },
      });

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      return {
        id: run.id,
        object: 'thread.run',
        created_at: Math.floor(run.createdAt.getTime() / 1000),
        thread_id: run.threadId,
        assistant_id: run.assistantId,
        status: run.status as ThreadRun['status'],
        expires_at: run.expiresAt ? Math.floor(run.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600,
        started_at: run.startedAt ? Math.floor(run.startedAt.getTime() / 1000) : null,
        cancelled_at: run.cancelledAt ? Math.floor(run.cancelledAt.getTime() / 1000) : null,
        failed_at: run.failedAt ? Math.floor(run.failedAt.getTime() / 1000) : null,
        completed_at: run.completedAt ? Math.floor(run.completedAt.getTime() / 1000) : null,
        model: run.model || 'auto',
        instructions: run.instructions || '',
        tools: (run.tools as Array<{ type: 'function' | 'file_search' | 'code_interpreter'; function?: { name: string; description: string; parameters: Record<string, unknown> } }>) || [],
        file_ids: run.fileIds,
        metadata: run.metadata as Record<string, string>,
        temperature: run.temperature || undefined,
        top_p: run.topP || undefined,
        max_prompt_tokens: run.maxPromptTokens || undefined,
        max_completion_tokens: run.maxCompletionTokens || undefined,
        required_action: run.requiredAction as ThreadRun['required_action'] || undefined,
        last_error: run.lastError as ThreadRun['last_error'] || undefined,
        usage: run.usage as ThreadRun['usage'] || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, error: errorMessage }, 'Get run failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Run ${runId} not found`);
      }
      throw error;
    }
  }

  /**
   * Get message
   * REAL IMPLEMENTATION - Queries from database
   */
  async getMessage(options: GetMessageRequest): Promise<ThreadMessage> {
    const { threadId, messageId, userContext, requestId } = options;

    log.info({ requestId, threadId, messageId }, 'Getting message');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Get message
      const message = await prisma.threadMessage.findFirst({
        where: {
          id: messageId,
          threadId: threadId,
        },
      });

      if (!message) {
        throw new Error(`Message ${messageId} not found`);
      }

      const metadataObj = message.metadata as Record<string, string>;
      const toolCallId = metadataObj.tool_call_id;
      const toolName = metadataObj.tool_name;

      return {
        id: message.id,
        object: 'thread.message',
        created_at: Math.floor(message.createdAt.getTime() / 1000),
        thread_id: message.threadId,
        role: message.role as ThreadMessage['role'],
        content: message.content as ThreadMessage['content'],
        assistant_id: message.assistantId || undefined,
        run_id: message.runId || undefined,
        file_ids: message.fileIds,
        metadata: metadataObj,
        tool_call_id: toolCallId,
        name: toolName,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, messageId, error: errorMessage }, 'Get message failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Message ${messageId} not found`);
      }
      throw error;
    }
  }

  /**
   * Modify message
   * REAL IMPLEMENTATION - Updates database
   */
  async modifyMessage(options: ModifyMessageRequest): Promise<ThreadMessage> {
    const { threadId, messageId, metadata, userContext, requestId } = options;

    log.info({ requestId, threadId, messageId }, 'Modifying message');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Get existing message
      const existing = await prisma.threadMessage.findFirst({
        where: {
          id: messageId,
          threadId: threadId,
        },
      });

      if (!existing) {
        throw new Error(`Message ${messageId} not found`);
      }

      // Update message metadata
      const updated = await prisma.threadMessage.update({
        where: { id: messageId },
        data: {
          metadata: metadata ? toPrismaJsonValue(metadata) : undefined,
        },
      });

      log.info({ requestId, threadId, messageId }, 'Message modified');

      const metadataObj = updated.metadata as Record<string, string>;
      const toolCallId = metadataObj.tool_call_id;
      const toolName = metadataObj.tool_name;

      return {
        id: updated.id,
        object: 'thread.message',
        created_at: Math.floor(updated.createdAt.getTime() / 1000),
        thread_id: updated.threadId,
        role: updated.role as ThreadMessage['role'],
        content: updated.content as ThreadMessage['content'],
        assistant_id: updated.assistantId || undefined,
        run_id: updated.runId || undefined,
        file_ids: updated.fileIds,
        metadata: metadataObj,
        tool_call_id: toolCallId,
        name: toolName,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, messageId, error: errorMessage }, 'Modify message failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Message ${messageId} not found`);
      }
      throw error;
    }
  }

  /**
   * Delete message
   * REAL IMPLEMENTATION - Deletes from database
   */
  async deleteMessage(options: DeleteMessageRequest): Promise<DeleteMessageResponse> {
    const { threadId, messageId, userContext, requestId } = options;

    log.info({ requestId, threadId, messageId }, 'Deleting message');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Check if message exists
      const existing = await prisma.threadMessage.findFirst({
        where: {
          id: messageId,
          threadId: threadId,
        },
      });

      if (!existing) {
        throw new Error(`Message ${messageId} not found`);
      }

      // Delete message
      await prisma.threadMessage.delete({
        where: { id: messageId },
      });

      log.info({ requestId, threadId, messageId }, 'Message deleted');

      return { id: messageId, object: 'thread.message.deleted', deleted: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, messageId, error: errorMessage }, 'Delete message failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Message ${messageId} not found`);
      }
      throw error;
    }
  }

  /**
   * Submit tool outputs for a run in requires_action status
   * REAL IMPLEMENTATION - Adds tool output messages and continues run execution
   */
  async submitToolOutputs(options: SubmitToolOutputsRequest): Promise<ThreadRun> {
    const { threadId, runId, tool_outputs, userContext, requestId } = options;

    log.info({ requestId, threadId, runId, toolOutputCount: tool_outputs.length }, 'Submitting tool outputs');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Get run and verify it's in requires_action status
      const run = await prisma.threadRun.findFirst({
        where: {
          id: runId,
          threadId: threadId,
        },
      });

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      if (run.status !== 'requires_action') {
        throw new Error(`Run ${runId} is not in requires_action status. Current status: ${run.status}`);
      }

      // Verify required_action exists and has tool_calls
      const requiredAction = run.requiredAction as ThreadRun['required_action'];
      if (!requiredAction || requiredAction.type !== 'submit_tool_outputs' || !requiredAction.submit_tool_outputs) {
        throw new Error(`Run ${runId} does not require tool outputs`);
      }

      const expectedToolCalls = requiredAction.submit_tool_outputs.tool_calls;
      const providedToolCallIds = new Set(tool_outputs.map((to) => to.tool_call_id));

      // Validate all tool calls have outputs
      for (const expectedCall of expectedToolCalls) {
        if (!providedToolCallIds.has(expectedCall.id)) {
          throw new Error(`Tool call ${expectedCall.id} missing output`);
        }
      }

      // Create tool output messages in thread
      // Use 'tool' role as per OpenAI API specification
      const toolOutputMessages = tool_outputs.map((toolOutput) => {
        const toolCall = expectedToolCalls.find((tc) => tc.id === toolOutput.tool_call_id);
        const outputText = toolOutput.error 
          ? `Error: ${toolOutput.error}`
          : toolOutput.output || '';

        return {
          role: 'tool' as const,
          content: outputText,
          tool_call_id: toolOutput.tool_call_id,
          name: toolCall?.function?.name || 'unknown',
        };
      });

      // Add tool output messages to thread
      const messagePromises = toolOutputMessages.map((msg) => {
        const messageId = `msg_${nanoid(24)}`;
        return prisma.threadMessage.create({
          data: {
            id: messageId,
            threadId: threadId,
            runId: runId,
            role: msg.role,
            content: [{ type: 'text' as const, text: { value: msg.content } }],
            fileIds: [],
            metadata: {
              tool_call_id: msg.tool_call_id,
              tool_name: msg.name,
            },
          },
        });
      });

      await Promise.all(messagePromises);
      log.info({ requestId, threadId, runId, messageCount: toolOutputMessages.length }, 'Tool output messages added to thread');

      // Update run status back to queued and clear required_action
      const updatedRun = await prisma.threadRun.update({
        where: { id: runId },
        data: {
          status: 'queued',
          requiredAction: toPrismaNullableJsonValue(null),
        },
      });

      log.info({ requestId, threadId, runId }, 'Run updated to queued, ready to continue');

      // Re-enqueue run for continued processing
      if (threadRunQueueService.isAvailable()) {
        try {
          const assistant = await prisma.assistant.findUnique({
            where: { id: run.assistantId },
          });

          if (!assistant) {
            throw new Error(`Assistant ${run.assistantId} not found`);
          }

          const tools = run.tools as ThreadRun['tools'];
          const priority = 1000;

          await threadRunQueueService.enqueue({
            runId,
            threadId,
            assistantId: run.assistantId,
            organizationId: userContext.organizationId,
            userId: userContext.userId,
            model: run.model || undefined,
            instructions: run.instructions || undefined,
            tools: tools || undefined,
            temperature: run.temperature ?? undefined,
            topP: run.topP ?? undefined,
            maxCompletionTokens: run.maxCompletionTokens ?? undefined,
            priority,
            queuedAt: Date.now(),
          });

          log.info({ requestId, threadId, runId }, 'Run re-enqueued for continued processing');
        } catch (enqueueError) {
          log.error(
            { requestId, threadId, runId, error: getErrorMessage(enqueueError) },
            'Failed to re-enqueue run - will remain in queued status'
          );
        }
      } else {
        log.warn(
          { requestId, threadId, runId },
          'Queue not available - run will remain in queued status until manually processed'
        );
      }

      return {
        id: updatedRun.id,
        object: 'thread.run',
        created_at: Math.floor(updatedRun.createdAt.getTime() / 1000),
        thread_id: updatedRun.threadId,
        assistant_id: updatedRun.assistantId,
        status: updatedRun.status as ThreadRun['status'],
        expires_at: updatedRun.expiresAt ? Math.floor(updatedRun.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600,
        started_at: updatedRun.startedAt ? Math.floor(updatedRun.startedAt.getTime() / 1000) : null,
        cancelled_at: updatedRun.cancelledAt ? Math.floor(updatedRun.cancelledAt.getTime() / 1000) : null,
        failed_at: updatedRun.failedAt ? Math.floor(updatedRun.failedAt.getTime() / 1000) : null,
        completed_at: updatedRun.completedAt ? Math.floor(updatedRun.completedAt.getTime() / 1000) : null,
        model: updatedRun.model || 'auto',
        instructions: updatedRun.instructions || '',
        tools: (updatedRun.tools as ThreadRun['tools']) || [],
        file_ids: updatedRun.fileIds,
        metadata: updatedRun.metadata as Record<string, string>,
        temperature: updatedRun.temperature || undefined,
        top_p: updatedRun.topP || undefined,
        max_prompt_tokens: updatedRun.maxPromptTokens || undefined,
        max_completion_tokens: updatedRun.maxCompletionTokens || undefined,
        required_action: undefined,
        last_error: updatedRun.lastError as ThreadRun['last_error'] || undefined,
        usage: updatedRun.usage as ThreadRun['usage'] || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, error: errorMessage }, 'Submit tool outputs failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Cancel a run
   * REAL IMPLEMENTATION - Updates status and removes from queue if applicable
   */
  async cancelRun(options: CancelRunRequest): Promise<ThreadRun> {
    const { threadId, runId, userContext, requestId } = options;

    log.info({ requestId, threadId, runId }, 'Cancelling run');

    try {
      // Verify thread exists
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Get run
      const run = await prisma.threadRun.findFirst({
        where: {
          id: runId,
          threadId: threadId,
        },
      });

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      // Check if run can be cancelled
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') {
        throw new Error(`Run ${runId} cannot be cancelled. Current status: ${run.status}`);
      }

      // Try to remove from queue if it's still queued
      if (threadRunQueueService.isAvailable()) {
        try {
          const job = await threadRunQueueService.getJob(runId);
          if (job) {
            await job.remove();
            log.info({ requestId, threadId, runId }, 'Run removed from queue');
          }
        } catch (queueError) {
          log.warn(
            { requestId, threadId, runId, error: getErrorMessage(queueError) },
            'Failed to remove run from queue (may already be processing)'
          );
        }
      }

      // Update run status to cancelled
      const cancelledAt = new Date();
      const updatedRun = await prisma.threadRun.update({
        where: { id: runId },
        data: {
          status: 'cancelled',
          cancelledAt,
        },
      });

      log.info({ requestId, threadId, runId }, 'Run cancelled');

      return {
        id: updatedRun.id,
        object: 'thread.run',
        created_at: Math.floor(updatedRun.createdAt.getTime() / 1000),
        thread_id: updatedRun.threadId,
        assistant_id: updatedRun.assistantId,
        status: updatedRun.status as ThreadRun['status'],
        expires_at: updatedRun.expiresAt ? Math.floor(updatedRun.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600,
        started_at: updatedRun.startedAt ? Math.floor(updatedRun.startedAt.getTime() / 1000) : null,
        cancelled_at: updatedRun.cancelledAt ? Math.floor(updatedRun.cancelledAt.getTime() / 1000) : null,
        failed_at: updatedRun.failedAt ? Math.floor(updatedRun.failedAt.getTime() / 1000) : null,
        completed_at: updatedRun.completedAt ? Math.floor(updatedRun.completedAt.getTime() / 1000) : null,
        model: updatedRun.model || 'auto',
        instructions: updatedRun.instructions || '',
        tools: (updatedRun.tools as ThreadRun['tools']) || [],
        file_ids: updatedRun.fileIds,
        metadata: updatedRun.metadata as Record<string, string>,
        temperature: updatedRun.temperature || undefined,
        top_p: updatedRun.topP || undefined,
        max_prompt_tokens: updatedRun.maxPromptTokens || undefined,
        max_completion_tokens: updatedRun.maxCompletionTokens || undefined,
        required_action: updatedRun.requiredAction as ThreadRun['required_action'] || undefined,
        last_error: updatedRun.lastError as ThreadRun['last_error'] || undefined,
        usage: updatedRun.usage as ThreadRun['usage'] || undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, error: errorMessage }, 'Cancel run failed');
      
      if (errorMessage.includes('not found') || errorMessage.includes('cannot be cancelled')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * List steps for a run
   * REAL IMPLEMENTATION - Queries from database
   */
  async listRunSteps(options: ListRunStepsRequest): Promise<ListRunStepsResponse> {
    const { threadId, runId, limit = 20, order = 'desc', after, before, userContext, requestId } = options;

    log.info({ requestId, threadId, runId, limit, order }, 'Listing run steps');

    try {
      // Verify thread and run exist and belong to organization
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
        include: {
          runs: {
            where: { id: runId },
            take: 1,
          },
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      if (thread.runs.length === 0) {
        throw new Error(`Run ${runId} not found in thread ${threadId}`);
      }

      // Build query
      const where: { runId: string; createdAt?: { gt?: Date; lt?: Date } } = { runId };

      if (after) {
        const afterStep = await prisma.threadRunStep.findUnique({ where: { id: after } });
        if (afterStep) {
          where.createdAt = { gt: afterStep.createdAt };
        }
      }

      if (before) {
        const beforeStep = await prisma.threadRunStep.findUnique({ where: { id: before } });
        if (beforeStep) {
          where.createdAt = where.createdAt 
            ? { ...where.createdAt, lt: beforeStep.createdAt }
            : { lt: beforeStep.createdAt };
        }
      }

      const steps = await prisma.threadRunStep.findMany({
        where,
        orderBy: { createdAt: order },
        take: limit + 1, // Fetch one extra to check if there are more
      });

      const has_more = steps.length > limit;
      const returnSteps = has_more ? steps.slice(0, limit) : steps;

      return {
        steps: returnSteps.map((step) => this.formatRunStep(step)),
        has_more,
        first_id: returnSteps.length > 0 ? returnSteps[0].id : undefined,
        last_id: returnSteps.length > 0 ? returnSteps[returnSteps.length - 1].id : undefined,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, error: errorMessage }, 'List run steps failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Get a specific run step
   * REAL IMPLEMENTATION - Queries from database
   */
  async getRunStep(options: GetRunStepRequest): Promise<ThreadRunStep> {
    const { threadId, runId, stepId, userContext, requestId } = options;

    log.info({ requestId, threadId, runId, stepId }, 'Getting run step');

    try {
      // Verify thread and run exist and belong to organization
      const thread = await prisma.thread.findFirst({
        where: {
          id: threadId,
          organizationId: userContext.organizationId,
        },
        include: {
          runs: {
            where: { id: runId },
            take: 1,
          },
        },
      });

      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      if (thread.runs.length === 0) {
        throw new Error(`Run ${runId} not found in thread ${threadId}`);
      }

      // Get step
      const step = await prisma.threadRunStep.findFirst({
        where: {
          id: stepId,
          runId: runId,
        },
      });

      if (!step) {
        throw new Error(`Step ${stepId} not found in run ${runId}`);
      }

      return this.formatRunStep(step);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, threadId, runId, stepId, error: errorMessage }, 'Get run step failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Format Prisma ThreadRunStep to API ThreadRunStep type
   */
  private formatRunStep(step: {
    id: string;
    runId: string;
    type: string;
    status: string;
    stepDetails: unknown;
    createdAt: Date;
    completedAt: Date | null;
    failedAt: Date | null;
    cancelledAt: Date | null;
    expiresAt: Date | null;
    metadata: unknown;
  }): ThreadRunStep {
    const stepDetails = step.stepDetails as ThreadRunStep['step_details'];
    const metadata = step.metadata as Record<string, string>;

    return {
      id: step.id,
      object: 'thread.run.step',
      created_at: Math.floor(step.createdAt.getTime() / 1000),
      run_id: step.runId,
      type: step.type as ThreadRunStep['type'],
      status: step.status as ThreadRunStep['status'],
      step_details: stepDetails,
      completed_at: step.completedAt ? Math.floor(step.completedAt.getTime() / 1000) : null,
      failed_at: step.failedAt ? Math.floor(step.failedAt.getTime() / 1000) : null,
      cancelled_at: step.cancelledAt ? Math.floor(step.cancelledAt.getTime() / 1000) : null,
      expired_at: step.expiresAt ? Math.floor(step.expiresAt.getTime() / 1000) : null,
      metadata,
      last_error: null,
    };
  }
}
