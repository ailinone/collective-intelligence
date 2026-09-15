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
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { TierLevel } from '@/domain/value-objects/organization-tier';

export interface QueueContext {
  shouldQueue: boolean;
  load: number;
  tier: TierLevel;
  reason?: string;
}

const VALID_QUEUE_TIERS: ReadonlySet<string> = new Set(Object.values(TierLevel));

/**
 * Resolve the tenant's raw (untyped) `tier` string into a `TierLevel` the
 * queue's priority table actually has an entry for.
 *
 * `tenantContext.tier` is a plain `string` sourced ultimately from the
 * `Organization.tier` DB column — it is not guaranteed at the type level to
 * be one of the tiers this service knows how to prioritize. The previous
 * code did `tenantContext.tier as 'enterprise' | 'pro' | 'free'`, a cast
 * that (a) didn't even list every real TierLevel ('starter' was missing)
 * and (b) blindly trusted an arbitrary string, so any tier value the
 * priority table doesn't recognize flows into
 * `basePriorities[tier] + jitter` as `undefined + number`, i.e. `NaN` —
 * corrupting the BullMQ job priority. Validate against the real TierLevel
 * enum and fail closed to the lowest-priority tier (FREE) for anything
 * unrecognized, logging so the bad/unexpected value gets noticed.
 */
function resolveQueueTier(
  rawTier: string | undefined,
  log: { warn: (obj: unknown, msg: string) => void }
): TierLevel {
  if (rawTier && VALID_QUEUE_TIERS.has(rawTier)) {
    return rawTier as TierLevel;
  }
  if (rawTier) {
    log.warn({ tier: rawTier }, 'Unrecognized tenant tier for queue priority — defaulting to free');
  }
  return TierLevel.FREE;
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

    if (!tenantContext || !tenantContext.organizationId) {
      // Fail OPEN, not closed: queueing is a load-shedding optimization,
      // not an auth gate. Rejecting the request here would mean the
      // presence of this middleware in a route's preHandler chain can 403
      // a request that every OTHER auth/tenant check upstream already
      // allowed through — confirmed as a real regression (2026-09-08):
      // this exact throw+403 path is what fired the instant
      // chat-completions wired this middleware in for real load-shedding,
      // exposing dead logic that had never actually run before (the
      // middleware was previously imported but never registered). Leaving
      // `queueContext` unset makes `enqueueIfNeeded` take the same
      // `queued:false` branch it always took before this middleware
      // existed — correct, safe degradation, not a regression from
      // "before this fix" behavior.
      log.debug(
        { path: request.url },
        'Queue manager invoked without tenant context — skipping queue evaluation, request proceeds normally'
      );
      return;
    }

    // Check if request should be queued
    const decision = await requestQueueService.shouldQueue();

    const tier = resolveQueueTier(tenantContext.tier, log);

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
