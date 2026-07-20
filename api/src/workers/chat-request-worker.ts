// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Job } from 'bullmq';
import type { ChatRequest, ChatResponse } from '@/types';
import type { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { requestQueueService } from '@/services/request-queue-service';
import { processChatRequest } from '@/services/chat-request-processor';
import { logger } from '@/utils/logger';

interface ChatQueueJobData {
  requestId: string;
  organizationId: string;
  userId?: string;
  request: ChatRequest;
  priority: number;
  correlationId?: string; // G8 fix (ADR-005): propagated from HTTP request context
  queuedAt: number;
}

export async function setupChatRequestWorkers(
  orchestrationEngine: OrchestrationEngine
): Promise<void> {
  await requestQueueService.startWorkers(async (job: Job<ChatQueueJobData, ChatResponse>) => {
    const { requestId, organizationId, userId, request, correlationId } = job.data;
    const log = logger.child({
      component: 'chat-request-worker',
      jobId: job.id,
      requestId,
      organizationId,
      correlationId, // G8 fix: propagated for end-to-end tracing
    });

    log.info('Processing queued chat request');

    const { response } = await processChatRequest({
      chatRequest: request,
      orchestrationEngine,
      organizationId,
      userId,
      requestId,
      log,
    });

    log.info({ jobId: job.id }, 'Queued chat request processed successfully');

    return response;
  });
}
