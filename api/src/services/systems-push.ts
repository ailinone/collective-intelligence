// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Systems push — mirrors request-log batches to Ailin Systems
 * (ailin.systems) for the operational dashboard.
 *
 * Contract (mirrors provider-balance-probe-job.ts's pushSnapshotToSystems):
 *   - Gated on SYSTEMS_OPERATIONS_URL + SYSTEMS_INGEST_API_KEY; without both,
 *     every call is a no-op (dev, or an operator disabling the pipe).
 *   - Fire-and-forget: NEVER throws, NEVER re-queues. Cost telemetry tolerates
 *     gaps; an outbox here would be overkill for dashboard-grade data.
 *   - Privacy: maps EXPLICIT fields only. The request/response/metadata blobs
 *     never leave this service, and systems' ingest rejects any payload whose
 *     key names normalize into its FORBIDDEN_KEYS set anyway (apikey, token,
 *     content, ...) — this mapping deliberately contains none.
 *
 * Target: POST {SYSTEMS_OPERATIONS_URL}/ingest/batch (ailin.one/systems#
 * "bulk ingest endpoint"), bearer SYSTEMS_INGEST_API_KEY, idempotent upsert
 * on (source_service, source_request_id).
 */

import { logger } from '@/utils/logger';
import { ipPseudonymHash, type RequestLogData } from './request-logger';
import type { SystemsPayload, SystemsStage, SystemsTrace } from './systems-trace';

const log = logger.child({ component: 'systems-push' });

/** Systems caps a batch at 500 items; chunk below the cap. */
const CHUNK_SIZE = 250;
/** Systems rejects bodies over 4 MiB; content-carrying items can be large, so chunk by size too. */
const CHUNK_MAX_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Wire format of one item in POST /ingest/batch. */
interface SystemsOperationalItem {
  source_request_id: string;
  operation: string;
  status: string;
  provider?: string;
  model?: string;
  strategy?: string;
  user_subject?: string;
  tenant_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  estimated_cost_usd?: number;
  error_type?: string;
  ip_address?: string;
  fingerprint_source?: string;
  completed_at?: string;
  environment?: string;
  /** Joins a chat message to this request: `chat:<chat_id>:<message_id>` (or the caller's X-Correlation-Id). */
  correlation_id?: string;
  /** Content-free processing stages (triage, selection, participants, verdicts, ...). */
  stages?: SystemsStage[];
  /** Sealed-content channel; present only when SYSTEMS_TRACE_CONTENT=true. See systems-trace.ts. */
  trace_payloads?: SystemsPayload[];
}

/**
 * Model IDs are "provider:model-name" database IDs (the same convention the
 * provider-health query reads via SPLIT_PART(model_id, ':', 1)); a plain name
 * (no colon) attributes to "unknown" rather than mislabeling the provider.
 */
export function splitProviderModel(modelId: string | undefined): { provider?: string; model?: string } {
  if (!modelId) return {};
  const colon = modelId.indexOf(':');
  if (colon <= 0) return { provider: 'unknown', model: modelId };
  return { provider: modelId.slice(0, colon), model: modelId.slice(colon + 1) };
}

/** "/v1/chat/completions" -> "chat.completions" (free-form facet on systems). */
function endpointToOperation(endpoint: string): string {
  return endpoint.replace(/^\/v1\//, '').replace(/^\//, '').replaceAll('/', '.') || 'unknown';
}

function toSystemsItem(entry: RequestLogData): SystemsOperationalItem | null {
  if (!entry.requestId) return null;
  // The adapter that ACTUALLY served wins when the orchestrator recorded it.
  // The main chat path writes metadata.selectedProvider (verified live: a
  // pinned "openai/gpt-5.4-nano" request was served by "cometapi"); the
  // single-streaming fallback writes metadata.provider. Model-id parsing is
  // the last resort — its "provider:" prefix is catalog taxonomy, NOT the
  // serving adapter, and plain names parse to "unknown".
  const servedProvider = [entry.metadata?.selectedProvider, entry.metadata?.provider].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  const { provider, model } = splitProviderModel(entry.primaryModelId ?? entry.modelsUsed?.[0]);
  return {
    source_request_id: entry.requestId,
    operation: endpointToOperation(entry.endpoint),
    status: entry.status,
    provider: servedProvider ?? provider,
    model,
    strategy: entry.strategyName,
    // API-key attribution first (stable, resolvable via the ApiKey table),
    // falling back to the end-user id when traffic is not key-authenticated.
    user_subject: entry.apiKeyId ? `apikey:${entry.apiKeyId}` : entry.userId ?? undefined,
    tenant_id: entry.organizationId,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    duration_ms: entry.durationMs,
    estimated_cost_usd: entry.costUsd,
    error_type: entry.errorCode,
    // Hashed BEFORE it leaves this process: the raw IP never persists in ci
    // nor crosses the wire; systems HMACs the hash again into ip_pseudonym.
    ip_address: entry.ipAddress ? ipPseudonymHash(entry.ipAddress) : undefined,
    completed_at: entry.completedAt,
    environment: process.env.NODE_ENV,
    ...traceFields(entry.systemsTrace),
  };
}

/** Optional trace fields; omitted entirely when there is nothing to send (keeps the legacy wire shape). */
function traceFields(trace: SystemsTrace | undefined): Partial<SystemsOperationalItem> {
  if (!trace) return {};
  return {
    ...(trace.correlationId ? { correlation_id: trace.correlationId } : {}),
    ...(trace.stages.length > 0 ? { stages: trace.stages } : {}),
    ...(trace.payloads && trace.payloads.length > 0 ? { trace_payloads: trace.payloads } : {}),
  };
}

/**
 * Push ONE operational item built outside the request logger — the collective
 * streaming path, which writes no request_logs row (and must not start to: the
 * analytics that read that table would change meaning). Fire-and-forget.
 */
export function pushOperationalTrace(item: {
  requestId: string;
  endpoint: string;
  status: string;
  strategy?: string;
  modelId?: string;
  provider?: string;
  userId?: string;
  organizationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  costUsd?: number;
  trace: SystemsTrace;
}): void {
  void (async () => {
    try {
      const baseUrl = process.env.SYSTEMS_OPERATIONS_URL;
      const apiKey = process.env.SYSTEMS_INGEST_API_KEY;
      if (!baseUrl || !apiKey || !item.requestId) return;
      const { provider, model } = splitProviderModel(item.modelId);
      await postItems(baseUrl, apiKey, [
        {
          source_request_id: item.requestId,
          operation: endpointToOperation(item.endpoint),
          status: item.status,
          provider: item.provider ?? provider,
          model,
          strategy: item.strategy,
          user_subject: item.userId,
          tenant_id: item.organizationId,
          input_tokens: item.inputTokens,
          output_tokens: item.outputTokens,
          duration_ms: item.durationMs,
          estimated_cost_usd: item.costUsd,
          completed_at: new Date().toISOString(),
          environment: process.env.NODE_ENV,
          ...traceFields(item.trace),
        },
      ]);
    } catch (error) {
      log.warn({ error: String(error) }, 'systems trace push failed (non-critical)');
    }
  })();
}

export async function pushOperationalRequestBatch(batch: RequestLogData[]): Promise<void> {
  const baseUrl = process.env.SYSTEMS_OPERATIONS_URL;
  const apiKey = process.env.SYSTEMS_INGEST_API_KEY;
  if (!baseUrl || !apiKey || batch.length === 0) return;

  const items = batch.map(toSystemsItem).filter((item): item is SystemsOperationalItem => item !== null);
  await postItems(baseUrl, apiKey, items);
}

// ── Anonymous (visitor) traffic — abuse monitoring ────────────────────────

/** Metadata an anonymous chat contributes to the systems dashboard. Messages
 *  and response text are NEVER part of this contract. */
export interface AnonymousOperationalInput {
  requestId: string;
  apiKeyId: string;
  visitorFingerprint: string;
  visitorIp?: string;
  modelRequested?: string;
  modelsServed?: string[];
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  errorCode?: string;
}

/** systems' ingest accepts received/running/success/error/timeout/cancelled;
 *  anything the anon path reports outside success/timeout is an error-ish
 *  outcome and lands as 'error' (error_type keeps the original code). */
function toAnonStatus(status: string | undefined): string {
  if (status === 'success' || status === 'timeout') return status;
  return 'error';
}

export function pushAnonymousChatOperational(input: AnonymousOperationalInput): void {
  void (async () => {
    const baseUrl = process.env.SYSTEMS_OPERATIONS_URL;
    const apiKey = process.env.SYSTEMS_INGEST_API_KEY;
    if (!baseUrl || !apiKey || !input.requestId) return;

    const { provider, model } = splitProviderModel(input.modelRequested ?? input.modelsServed?.[0]);
    await postItems(baseUrl, apiKey, [
      {
        // 'anon:' prefix keeps the upsert key disjoint from request_logs rows
        // (the guest-key traffic ALSO lands there attributed to its API key).
        source_request_id: `anon:${input.requestId}`,
        operation: 'anonymous.chat',
        status: toAnonStatus(input.status),
        provider,
        model,
        // Short stable prefix of the (already-hashed) fingerprint groups a
        // repeat visitor in the dashboard without exposing the full value.
        user_subject: `anon:${input.visitorFingerprint.slice(0, 12)}`,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        error_type: input.errorCode,
        // Systems HMAC-pseudonymizes both before storage; the IP is hashed
        // here first so the raw value never crosses the wire either.
        ip_address: input.visitorIp ? ipPseudonymHash(input.visitorIp) : undefined,
        fingerprint_source: input.visitorFingerprint,
        completed_at: new Date().toISOString(),
        environment: process.env.NODE_ENV,
      },
    ]);
  })();
}

/**
 * Split into chunks of at most CHUNK_SIZE items AND roughly CHUNK_MAX_BYTES.
 * A single oversized item (content-heavy) loses its content payloads rather
 * than failing the whole chunk; its metadata still reaches systems.
 */
export function chunkItems(items: SystemsOperationalItem[]): SystemsOperationalItem[][] {
  const chunks: SystemsOperationalItem[][] = [];
  let current: SystemsOperationalItem[] = [];
  let bytes = 0;
  for (const original of items) {
    let item = original;
    let size = JSON.stringify(item).length;
    if (size > CHUNK_MAX_BYTES && item.trace_payloads) {
      const { trace_payloads: _dropped, ...withoutContent } = item;
      item = withoutContent;
      size = JSON.stringify(item).length;
    }
    if (current.length > 0 && (current.length >= CHUNK_SIZE || bytes + size > CHUNK_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function postItems(baseUrl: string, apiKey: string, items: SystemsOperationalItem[]): Promise<void> {
  if (items.length === 0) return;
  const root = baseUrl.replace(/\/+$/, '');
  for (const chunk of chunkItems(items)) {
    try {
      const res = await fetch(`${root}/ingest/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ source_service: 'ci', requests: chunk }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn({ status: res.status, size: chunk.length }, 'systems usage push rejected');
      }
    } catch (error) {
      log.warn({ error: String(error), size: chunk.length }, 'systems usage push failed (non-critical)');
    }
  }
}
