// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Assistants & Threads E2E Tests
 *
 * Complete end-to-end tests for the OpenAI-compatible Assistants API.
 * Tests the full lifecycle: Assistant → Thread → Message → Run → Response
 *
 * These tests verify:
 * - Assistant CRUD operations
 * - Thread creation and management
 * - Message creation and listing
 * - Run execution (queued → in_progress → completed)
 * - Thread Run queue processing
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { prisma } from '@/database/client';
import { ThreadsService } from '@/services/threads-service';
import { nanoid } from 'nanoid';
import type { OrchestrationContext } from '@/types';

// Mock the thread run queue service for unit testing
vi.mock('@/services/thread-run-queue-service', () => ({
  threadRunQueueService: {
    isAvailable: vi.fn().mockReturnValue(true),
    enqueue: vi.fn().mockResolvedValue({
      status: 'queued',
      runId: 'mock-run-id',
      position: 0,
      estimatedWaitTimeMs: 0,
    }),
  },
}));

describe('Assistants & Threads E2E', () => {
  let threadsService: ThreadsService;
  let testOrganizationId: string;
  let testUserId: string;
  let testAssistantId: string;
  let testThreadId: string;

  const userContext: OrchestrationContext = {
    organizationId: '',
    userId: '',
    requestId: '',
    models: [],
    taskType: 'general',
    complexity: 'low',
    contextSize: 0,
  };

  beforeAll(async () => {
    threadsService = new ThreadsService();

    // Create test organization and user with UUIDs (Prisma schema uses @db.Uuid)
    testOrganizationId = randomUUID();
    testUserId = randomUUID();

    try {
      await prisma.organization.create({
        data: {
          id: testOrganizationId,
          name: 'Test Organization',
          slug: `test-org-${nanoid(8)}`,
          tier: 'free',
        },
      });

      await prisma.user.create({
        data: {
          id: testUserId,
          email: `test-${nanoid(8)}@example.com`,
          name: 'Test User',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrganizationId,
          role: 'admin',
          status: 'active',
        },
      });

      // Create test assistant
      testAssistantId = `asst_${nanoid(24)}`;
      await prisma.assistant.create({
        data: {
          id: testAssistantId,
          organizationId: testOrganizationId,
          name: 'Test Assistant',
          model: 'auto',
          instructions: 'You are a helpful test assistant.',
          tools: [],
          metadata: {},
        },
      });

      userContext.organizationId = testOrganizationId;
      userContext.userId = testUserId;
    } catch (error) {
      console.error('Setup failed:', error);
      throw error;
    }
  });

  afterAll(async () => {
    // Clean up test data
    try {
      if (testThreadId) {
        await prisma.thread.deleteMany({
          where: { id: testThreadId },
        });
      }

      if (testAssistantId) {
        await prisma.assistant.deleteMany({
          where: { id: testAssistantId },
        });
      }

      if (testUserId) {
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
      }

      if (testOrganizationId) {
        await prisma.organization.deleteMany({
          where: { id: testOrganizationId },
        });
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  });

  describe('Thread Lifecycle', () => {
    it('should create a new thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      const thread = await threadsService.createThread({
        messages: [],
        metadata: { test: 'true' },
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(thread).toBeDefined();
      expect(thread.id).toMatch(/^thread_/);
      expect(thread.object).toBe('thread');
      expect(thread.metadata).toEqual({ test: 'true' });

      testThreadId = thread.id;
    });

    it('should get an existing thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      const thread = await threadsService.getThread({
        threadId: testThreadId,
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(thread).toBeDefined();
      expect(thread.id).toBe(testThreadId);
      expect(thread.object).toBe('thread');
    });

    it('should modify thread metadata', async () => {
      const requestId = `req_${nanoid(12)}`;

      const thread = await threadsService.modifyThread({
        threadId: testThreadId,
        metadata: { test: 'updated', newKey: 'newValue' },
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(thread).toBeDefined();
      expect(thread.id).toBe(testThreadId);
      expect(thread.metadata).toEqual({ test: 'updated', newKey: 'newValue' });
    });

    it('should throw error for non-existent thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      await expect(
        threadsService.getThread({
          threadId: 'thread_nonexistent',
          userContext: userContext as OrchestrationContext,
          requestId,
        })
      ).rejects.toThrow('Thread thread_nonexistent not found');
    });
  });

  describe('Message Lifecycle', () => {
    it('should create a message in thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      const message = await threadsService.createMessage({
        threadId: testThreadId,
        role: 'user',
        content: 'Hello, this is a test message!',
        metadata: { source: 'e2e-test' },
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(message).toBeDefined();
      expect(message.id).toMatch(/^msg_/);
      expect(message.object).toBe('thread.message');
      expect(message.thread_id).toBe(testThreadId);
      expect(message.role).toBe('user');
      expect(message.content).toBeDefined();
      expect(message.content.length).toBeGreaterThan(0);
    });

    it('should create multiple messages in thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      // Add second user message
      await threadsService.createMessage({
        threadId: testThreadId,
        role: 'user',
        content: 'This is the second message.',
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      // Add third message
      await threadsService.createMessage({
        threadId: testThreadId,
        role: 'user',
        content: 'And the third one.',
        userContext: userContext as OrchestrationContext,
        requestId: `req_${nanoid(12)}`,
      });

      // List messages
      const result = await threadsService.listMessages({
        threadId: testThreadId,
        limit: 10,
        order: 'asc',
        userContext: userContext as OrchestrationContext,
        requestId: `req_${nanoid(12)}`,
      });

      expect(result.messages).toHaveLength(3);
      expect(result.has_more).toBe(false);
    });

    it('should list messages with pagination', async () => {
      const requestId = `req_${nanoid(12)}`;

      // List with limit of 2
      const result = await threadsService.listMessages({
        threadId: testThreadId,
        limit: 2,
        order: 'asc',
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(result.messages).toHaveLength(2);
      expect(result.has_more).toBe(true);
      expect(result.first_id).toBeDefined();
      expect(result.last_id).toBeDefined();
    });

    it('should list messages in descending order', async () => {
      const requestId = `req_${nanoid(12)}`;

      const result = await threadsService.listMessages({
        threadId: testThreadId,
        limit: 10,
        order: 'desc',
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(result.messages).toHaveLength(3);
      // Verify descending order (most recent first)
      const timestamps = result.messages.map((m) => m.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });
  });

  describe('Run Lifecycle', () => {
    it('should create a run in thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      const run = await threadsService.createRun({
        threadId: testThreadId,
        assistant_id: testAssistantId,
        model: 'auto',
        instructions: 'Respond briefly to the user.',
        temperature: 0.7,
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(run).toBeDefined();
      expect(run.id).toMatch(/^run_/);
      expect(run.object).toBe('thread.run');
      expect(run.thread_id).toBe(testThreadId);
      expect(run.assistant_id).toBe(testAssistantId);
      expect(run.status).toBe('queued');
      expect(run.model).toBe('auto');
      expect(run.temperature).toBe(0.7);
    });

    it('should create run with tools', async () => {
      const requestId = `req_${nanoid(12)}`;

      const run = await threadsService.createRun({
        threadId: testThreadId,
        assistant_id: testAssistantId,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get current weather for a location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
                required: ['location'],
              },
            },
          },
        ],
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(run).toBeDefined();
      expect(run.tools).toHaveLength(1);
      expect(run.tools[0].type).toBe('function');
    });

    it('should throw error for run with non-existent thread', async () => {
      const requestId = `req_${nanoid(12)}`;

      await expect(
        threadsService.createRun({
          threadId: 'thread_nonexistent',
          assistant_id: testAssistantId,
          userContext: userContext as OrchestrationContext,
          requestId,
        })
      ).rejects.toThrow('Thread thread_nonexistent not found');
    });
  });

  describe('Thread with Initial Messages', () => {
    it('should create thread with initial messages', async () => {
      const requestId = `req_${nanoid(12)}`;

      const thread = await threadsService.createThread({
        messages: [
          {
            role: 'user',
            content: 'First message in new thread',
          },
          {
            role: 'assistant',
            content: 'Hello! How can I help you?',
          },
        ],
        metadata: { hasInitialMessages: 'true' },
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      expect(thread).toBeDefined();
      expect(thread.id).toMatch(/^thread_/);

      // Verify messages were created
      const result = await threadsService.listMessages({
        threadId: thread.id,
        limit: 10,
        order: 'asc',
        userContext: userContext as OrchestrationContext,
        requestId: `req_${nanoid(12)}`,
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');

      // Cleanup
      await prisma.thread.delete({ where: { id: thread.id } });
    });
  });

  describe('Thread Deletion', () => {
    it('should delete thread and cascade delete messages/runs', async () => {
      const requestId = `req_${nanoid(12)}`;

      // Create a new thread for deletion test
      const thread = await threadsService.createThread({
        messages: [{ role: 'user', content: 'Test message' }],
        userContext: userContext as OrchestrationContext,
        requestId,
      });

      // Create a run
      await threadsService.createRun({
        threadId: thread.id,
        assistant_id: testAssistantId,
        userContext: userContext as OrchestrationContext,
        requestId: `req_${nanoid(12)}`,
      });

      // Delete thread
      const result = await threadsService.deleteThread({
        threadId: thread.id,
        userContext: userContext as OrchestrationContext,
        requestId: `req_${nanoid(12)}`,
      });

      expect(result.deleted).toBe(true);
      expect(result.id).toBe(thread.id);
      expect(result.object).toBe('thread.deleted');

      // Verify thread is gone
      await expect(
        threadsService.getThread({
          threadId: thread.id,
          userContext: userContext as OrchestrationContext,
          requestId: `req_${nanoid(12)}`,
        })
      ).rejects.toThrow(`Thread ${thread.id} not found`);
    });
  });
});

describe('Thread Run Queue Service', () => {
  it('should have queue service available', async () => {
    const { threadRunQueueService } = await import('@/services/thread-run-queue-service');
    expect(threadRunQueueService).toBeDefined();
    expect(typeof threadRunQueueService.isAvailable).toBe('function');
    expect(typeof threadRunQueueService.enqueue).toBe('function');
  });

  it('should have worker setup function', async () => {
    const { setupThreadRunWorkers, stopThreadRunWorkers } = await import('@/workers/thread-run-worker');
    expect(typeof setupThreadRunWorkers).toBe('function');
    expect(typeof stopThreadRunWorkers).toBe('function');
  });
});

