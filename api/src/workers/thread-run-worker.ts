// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Thread Run Worker
 *
 * Processes Thread Runs from the BullMQ queue.
 * Implements the full Assistants API run execution flow.
 *
 * Execution Flow:
 *   1. Update run status to 'in_progress'
 *   2. Fetch thread messages as context
 *   3. Build chat request with assistant instructions
 *   4. Execute via OrchestrationEngine
 *   5. Handle tool calls if required
 *   6. Add assistant response to thread
 *   7. Update run status to 'completed' or 'failed'
 */

import type { Job } from 'bullmq';
import { narrowAs } from '@/utils/type-guards';
import type { ThreadRunJobData } from '@/services/thread-run-queue-service';
import type { ThreadRun, ThreadMessage } from '@/types/threads';
import type { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ChatRequest, ChatMessage } from '@/types';
import { threadRunQueueService } from '@/services/thread-run-queue-service';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';

/**
 * Process a single thread run job
 */
async function processThreadRun(
  job: Job<ThreadRunJobData>,
  orchestrationEngine: OrchestrationEngine
): Promise<ThreadRun> {
  const {
    runId,
    threadId,
    assistantId,
    organizationId,
    userId,
    model,
    instructions,
    tools,
    temperature,
    topP,
    maxCompletionTokens,
  } = job.data;

  const log = logger.child({
    component: 'thread-run-worker',
    jobId: job.id,
    runId,
    threadId,
  });

  log.info('Processing thread run');

  const startedAt = new Date();

  try {
    // 1. Update run status to 'in_progress'
    await prisma.threadRun.update({
      where: { id: runId },
      data: {
        status: 'in_progress',
        startedAt,
      },
    });

    // 2. Fetch assistant details
    const assistant = await prisma.assistant.findUnique({
      where: { id: assistantId },
    });

    if (!assistant) {
      throw new Error(`Assistant ${assistantId} not found`);
    }

    // 3. Fetch thread messages as context — the LAST 100 (most recent),
    //    then restored to chronological order for the model.
    //    BUG FIX: this previously used `orderBy createdAt ASC + take 100`,
    //    which returns the OLDEST 100 messages. On any thread longer than 100
    //    messages the run operated on ancient history and never saw the recent
    //    turns — the opposite of the "last 100" the comment claimed. Fetching
    //    DESC + take then reversing gives the correct recent window. The
    //    (threadId, createdAt) index already serves both directions, so this
    //    is a correctness fix with no added query cost.
    const recentMessagesDesc = await prisma.threadMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const threadMessages = recentMessagesDesc.reverse();

    // 4. Build chat messages from thread history
    const chatMessages: ChatMessage[] = [];

    // Add system message with assistant instructions
    const systemInstructions = instructions || assistant.instructions || '';
    if (systemInstructions) {
      chatMessages.push({
        role: 'system',
        content: systemInstructions,
      });
    }

    // Add thread messages
    for (const msg of threadMessages) {
      const content = msg.content as ThreadMessage['content'];
      const textContent = content
        .filter((c): c is { type: 'text'; text: { value: string } } => c.type === 'text' && !!c.text?.value)
        .map((c) => c.text.value)
        .join('\n');

      if (textContent || msg.role === 'tool') {
        const chatMsg: ChatMessage = {
          role: msg.role as ChatMessage['role'],
          content: textContent || '',
        };

        // Add tool_call_id and name for 'tool' role
        if (msg.role === 'tool') {
          const metadata = msg.metadata as Record<string, string>;
          if (metadata.tool_call_id) {
            chatMsg.tool_call_id = metadata.tool_call_id;
          }
          if (metadata.tool_name) {
            chatMsg.name = metadata.tool_name;
          }
        }

        chatMessages.push(chatMsg);
      }
    }

    if (chatMessages.length === 0 || (chatMessages.length === 1 && chatMessages[0].role === 'system')) {
      throw new Error('No messages in thread to process');
    }

    // 5. Build chat request
    const chatRequest: ChatRequest = {
      model: model || assistant.model || 'auto',
      messages: chatMessages,
      temperature: temperature ?? assistant.temperature ?? undefined,
      top_p: topP ?? assistant.topP ?? undefined,
      max_tokens: maxCompletionTokens ?? undefined,
      stream: false,
    };

    // Add tools if available
    if (tools && tools.length > 0) {
      const functionTools = tools
        .filter((t): t is { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } =>
          t.type === 'function' && !!t.function
        )
        .map((t) => ({
          type: 'function' as const,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        }));

      if (functionTools.length > 0) {
        chatRequest.tools = functionTools;
      }
    }

    log.info(
      {
        messageCount: chatMessages.length,
        model: chatRequest.model,
        hasTools: !!chatRequest.tools,
      },
      'Executing chat request via orchestration engine'
    );

    // 6. Execute via OrchestrationEngine
    const result = await orchestrationEngine.execute(
      chatRequest,
      organizationId,
      userId
    );

    // 7. Extract response content
    const responseContent = result.finalResponse.choices[0]?.message?.content || '';
    const responseContentStr = typeof responseContent === 'string' 
      ? responseContent 
      : JSON.stringify(responseContent);

    // Check for tool calls
    const toolCalls = result.finalResponse.choices[0]?.message?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Run requires action - tool outputs needed
      log.info({ toolCallCount: toolCalls.length }, 'Run requires action - tool calls detected');

      const requiredAction = {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
      };

      const updatedRun = await prisma.threadRun.update({
        where: { id: runId },
        data: {
          status: 'requires_action',
          requiredAction,
          usage: result.finalResponse.usage ? (JSON.parse(JSON.stringify(result.finalResponse.usage)) as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      });

      return formatThreadRun(updatedRun);
    }

    // 8. Add assistant response to thread
    const messageId = `msg_${nanoid(24)}`;
    await prisma.threadMessage.create({
      data: {
        id: messageId,
        threadId,
        runId,
        assistantId,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: { value: responseContentStr },
          },
        ],
        fileIds: [],
        metadata: {},
      },
    });

    log.info({ messageId }, 'Assistant response added to thread');

    // 9. Update run status to 'completed'
    const completedAt = new Date();
    const updatedRun = await prisma.threadRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        completedAt,
        usage: result.finalResponse.usage
          ? narrowAs<Prisma.InputJsonValue>(JSON.parse(JSON.stringify(result.finalResponse.usage)))
          : Prisma.DbNull,
      },
    });

    log.info(
      {
        durationMs: completedAt.getTime() - startedAt.getTime(),
        tokensUsed: result.finalResponse.usage?.total_tokens,
        cost: result.totalCost,
      },
      'Thread run completed successfully'
    );

    return formatThreadRun(updatedRun);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Thread run failed');

    // Update run status to 'failed'
    const failedAt = new Date();
    const updatedRun = await prisma.threadRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        failedAt,
        lastError: {
          code: 'execution_failed',
          message: errorMessage,
        },
      },
    });

    return formatThreadRun(updatedRun);
  }
}

/**
 * Format Prisma ThreadRun to API ThreadRun type
 */
function formatThreadRun(run: {
  id: string;
  threadId: string;
  assistantId: string;
  status: string;
  model: string | null;
  instructions: string | null;
  tools: unknown;
  metadata: unknown;
  temperature: number | null;
  topP: number | null;
  maxPromptTokens: number | null;
  maxCompletionTokens: number | null;
  fileIds: string[];
  usage: unknown;
  startedAt: Date | null;
  expiresAt: Date | null;
  cancelledAt: Date | null;
  failedAt: Date | null;
  completedAt: Date | null;
  requiredAction: unknown;
  lastError: unknown;
  createdAt: Date;
}): ThreadRun {
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
    tools: (run.tools as ThreadRun['tools']) || [],
    file_ids: run.fileIds,
    metadata: run.metadata as Record<string, string>,
    temperature: run.temperature ?? undefined,
    top_p: run.topP ?? undefined,
    max_prompt_tokens: run.maxPromptTokens ?? undefined,
    max_completion_tokens: run.maxCompletionTokens ?? undefined,
    required_action: run.requiredAction as ThreadRun['required_action'],
    last_error: run.lastError as ThreadRun['last_error'],
    usage: run.usage as ThreadRun['usage'],
  };
}

/**
 * Setup thread run workers
 */
export async function setupThreadRunWorkers(
  orchestrationEngine: OrchestrationEngine
): Promise<void> {
  await threadRunQueueService.startWorkers(async (job: Job<ThreadRunJobData>) => {
    return processThreadRun(job, orchestrationEngine);
  });
}

/**
 * Stop thread run workers
 */
export async function stopThreadRunWorkers(): Promise<void> {
  await threadRunQueueService.stopWorkers();
}

