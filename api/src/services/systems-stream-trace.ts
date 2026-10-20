// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming-path trace emission.
 *
 * The collective SSE path (orchestrationEngine.executeStream) writes no
 * request_logs row, so the systems dashboard never saw those requests — and
 * those are the strategies the chat product uses. This mirrors the finished
 * orchestration to systems WITHOUT touching request_logs (the analytics that
 * read that table would change meaning if we started inserting there).
 *
 * Fire-and-forget by contract: never throws, never awaits, never re-queues.
 */
import { getCorrelationId } from '@/api/middleware/request-context';
import type { ChatRequest, OrchestrationResult } from '@/types';
import { pushOperationalTrace } from './systems-push';
import { buildSystemsTrace } from './systems-trace';

export function emitStreamTraceToSystems(
  result: OrchestrationResult,
  request: ChatRequest,
  context: { requestId: string; organizationId: string; userId?: string }
): void {
  try {
    if (!process.env.SYSTEMS_OPERATIONS_URL || !process.env.SYSTEMS_INGEST_API_KEY) return;
    const usage = result.finalResponse?.usage;
    pushOperationalTrace({
      requestId: context.requestId,
      endpoint: '/v1/chat/completions',
      status: 'success',
      strategy: result.strategyUsed,
      modelId: result.modelsUsed?.[0]?.modelId,
      provider: result.modelsUsed?.[0]?.provider,
      userId: context.userId,
      organizationId: context.organizationId,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      durationMs: result.totalDuration,
      costUsd: result.totalCost,
      trace: buildSystemsTrace(result, request, { correlationId: getCorrelationId() }),
    });
  } catch {
    // Telemetry only.
  }
}
