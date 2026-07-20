// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast emit hook — the seam between the chat completion path and the
 * broadcast outbox (F1 / ADR-017).
 *
 * Why a separate module (not inline in chat-request-processor):
 *   - Keeps the processor free of broadcast-domain types and the feature-flag
 *     branch — the processor calls exactly one function and forgets.
 *   - Gives the emit a single, mockable surface so a unit test can assert
 *     "the completion path calls emit" without standing up the whole pipeline.
 *
 * Contract (load-bearing):
 *   - NEVER throws. A broadcast failure must not affect the user request.
 *   - NEVER awaits on the caller's critical path: `emitBroadcastTrace` returns
 *     synchronously (void) and does its staging on a detached microtask.
 *   - No-op unless `BROADCAST_FEATURE_ENABLED === 'true'`. The default build
 *     pays only a single env-var read per request.
 */

import type { ChatRequest, ChatResponse } from '@/types';
import type { ChatRequestWithMetadata } from '@/types/chat-request-extended';
import { config } from '@/config';
import { logger } from '@/utils/logger';

import { broadcastEmitter } from '@/broadcast/application/broadcast-emitter';

const log = logger.child({ component: 'broadcast-emit-hook' });

export interface BroadcastEmitHookArgs {
  chatRequest: ChatRequest | ChatRequestWithMetadata;
  chatResponse: ChatResponse;
  requestId: string;
  organizationId: string;
  userId?: string;
  startedAt: Date;
  endedAt: Date;
  /** Whether the response was streamed. Streaming envelopes are out of scope
   *  for Fase 1 — the streaming path does not call this hook yet. */
  streaming?: boolean;
}

/** True when the broadcast feature is enabled for this process. */
export function isBroadcastEnabled(): boolean {
  return process.env.BROADCAST_FEATURE_ENABLED === 'true';
}

function mapDeploymentEnvironment(): 'development' | 'staging' | 'production' {
  // config.env is development | production | test; the envelope schema has no
  // `test` bucket — collapse it onto development.
  return config.env === 'production' ? 'production' : 'development';
}

/**
 * Stage a chat completion as a broadcast trace envelope. Fire-and-forget:
 * returns immediately, swallows every error, and is a no-op when the feature
 * is disabled.
 */
export function emitBroadcastTrace(args: BroadcastEmitHookArgs): void {
  if (!isBroadcastEnabled()) return;

  // Detach from the caller. We intentionally do NOT return the promise — the
  // completion path must not be able to await (or be slowed by) the emit.
  void (async () => {
    try {
      await broadcastEmitter.emitChatCompletion({
        // The builder only reads optional fields (model/messages/strategy);
        // ChatRequestWithMetadata omits `model` but the builder coalesces a
        // missing model to 'unknown', so the cast is safe.
        chatRequest: args.chatRequest as ChatRequest,
        chatResponse: args.chatResponse,
        requestId: args.requestId,
        tenant: {
          organizationId: args.organizationId || null,
          userId: args.userId ?? null,
          // apiKeyId is not threaded through the processor params; the
          // envelope tenant block accepts null. Resolution scope defaults to
          // organization (the processor's primary tenant axis).
          apiKeyId: null,
          resolutionScope: 'organization',
        },
        startedAt: args.startedAt,
        endedAt: args.endedAt,
        deploymentEnvironment: mapDeploymentEnvironment(),
        serviceVersion: config.app?.version,
        streaming: args.streaming ?? false,
        status: 'ok',
        httpStatus: 200,
      });
    } catch (err) {
      // emitChatCompletion already swallows internally; this catch is belt-
      // and-suspenders against an unexpected synchronous throw before its own
      // try block.
      log.debug(
        { err: err instanceof Error ? err.message : String(err), requestId: args.requestId },
        'broadcast emit hook error — user request unaffected',
      );
    }
  })();
}
