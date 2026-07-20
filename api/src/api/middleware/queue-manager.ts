// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Queue Manager Middleware
 *
 * Decides whether to process request immediately or queue it
 * Critical for handling 10,000+ req/s peaks
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { requestQueueService } from '@/services/request-queue-service';
import { logger } from '@/utils/logger';
import type { OrchestrationContext, ChatRequest } from '@/types';
import { config } from '@/config';
import { recordSecurityEvent } from '@/services/security-audit-service';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

export interface QueueContext {
  shouldQueue: boolean;
  load: number;
  tier: 'enterprise' | 'pro' | 'free';
  reason?: string;
}

/**
 * Queue manager middleware
 *
 * Attaches queue decision to request context
 * Actual handlers can use this to decide immediate vs queued processing
 */
export async function queueManagerMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ component: 'queue-manager' });

  try {
    // Resolve tenant context (requires prior requireTenantContext)
    const extendedRequest = request as ExtendedFastifyRequest;
    const tenantContext = extendedRequest.tenantContext;

    // Check if request should be queued
    const decision = await requestQueueService.shouldQueue();

    if (!tenantContext || !tenantContext.organizationId) {
      throw new Error('Tenant context missing');
    }

    const tier = (tenantContext.tier as 'enterprise' | 'pro' | 'free') ?? 'free';

    // Attach to request context
    extendedRequest.queueContext = {
      shouldQueue: decision.queue,
      load: decision.load,
      tier,
      reason: decision.reason,
    };

    if (decision.queue) {
      log.debug(
        {
          load: decision.load,
          tier,
          reason: decision.reason,
        },
        'System under load - queueing recommended'
      );
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Tenant context missing')) {
      log.warn(
        { path: request.url },
        'Queue manager invoked without tenant context; denying request'
      );

      await recordSecurityEvent({
        eventType: 'tenant_context_missing',
        severity: 'warning',
        message: 'Queue manager denied request due to missing tenant context.',
        organizationId: undefined,
        userId: undefined,
        metadata: {
          path: request.url,
          method: request.method,
        },
      });

      reply.status(403).send({
        error: {
          code: 'tenant_context_required',
          message: 'Tenant context is required to evaluate queue strategy.',
        },
      });
      return;
    }

    log.error({ error: errorMessage }, 'Queue manager middleware error');
    reply.status(500).send({
      error: {
        code: 'queue_manager_error',
        message: 'Unable to evaluate queueing strategy at this time.',
      },
    });
  }
}

/**
 * Helper to enqueue request if needed
 */
export interface QueuedResponse {
  status: 'queued';
  message: string;
  queueId: string;
  position: number;
  estimatedWaitTimeMs: number;
  priority: number;
  tier: string;
  systemLoad: number;
  reason?: string;
  pollAfterMs: number;
  statusUrl: string;
  expiresAt: number;
}

export async function enqueueIfNeeded(
  request: FastifyRequest,
  requestId: string,
  chatRequest: ChatRequest,
  context?: OrchestrationContext
): Promise<{ queued: boolean; response?: QueuedResponse }> {
  const extendedRequest = request as ExtendedFastifyRequest;
  const queueContext = extendedRequest.queueContext;

  if (!queueContext || !queueContext.shouldQueue) {
    // Process immediately
    return { queued: false };
  }

  // Enqueue request
  const tenantContext = extendedRequest.tenantContext;
  
  if (!tenantContext) {
    const err: Error & { code?: string } = new Error('Tenant context required for queueing');
    err.code = 'TENANT_CONTEXT_REQUIRED';
    throw err;
  }

  const orgId = tenantContext.organizationId;
  const userId = tenantContext.userId;

  const queuedResponse = await requestQueueService.enqueue(
    requestId,
    orgId,
    userId,
    chatRequest,
    context,
    queueContext.tier
  );

  // Return queued response
  return {
    queued: true,
    response: {
      status: 'queued',
      message: 'Request queued due to high system load',
      queueId: queuedResponse.queueId,
      position: queuedResponse.position,
      estimatedWaitTimeMs: queuedResponse.estimatedWaitTimeMs,
      priority: queuedResponse.priority,
      tier: queueContext.tier,
      systemLoad: queueContext.load,
      reason: queueContext.reason,
      pollAfterMs: config.queue.pollIntervalMs,
      statusUrl: `/v1/queue/status/${queuedResponse.queueId}`,
      expiresAt: Date.now() + config.queue.statusTtlSeconds * 1000,
    },
  };
}
