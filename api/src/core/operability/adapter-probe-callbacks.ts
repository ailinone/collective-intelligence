// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adapter probe callbacks — pure functions that the discovery service
 * invokes to check credentials, credit balance, and enumerate models.
 *
 * Design choice (Phase 1.5): probes are PURE FUNCTIONS that take
 * `{ apiKey, baseUrl, providerId, timeoutMs }` and return a result.
 * They do NOT instantiate provider adapters — that would create a
 * circular dependency (adapters depend on registry which depends on
 * discovery snapshot). Instead, the probe knows the integration shape
 * (oai-compat, native-anthropic, etc.) and makes a direct HTTP call.
 *
 * This keeps discovery cheap (no adapter init), correct (no
 * accidental side effects from adapter constructors), and parallel-safe.
 *
 * NOT included here:
 *   - probeCredential beyond env check (env_only path is in
 *     discovery-service). Active credential validation requires a
 *     low-cost auth endpoint, which most providers DO NOT have. We
 *     defer that to runtime — the first chat completion attempt
 *     validates auth.
 */

import {
  type DiscoveredModel,
  type ProviderErrorClass,
} from './types';
import type { ProviderProbeCallbacks } from './discovery-service';

// ─── Per-provider balance endpoints ───────────────────────────────────────

/**
 * Endpoints known to expose a per-account balance.
 * These match the legacy `getProviderBalanceEndpoint()` table in
 * `openai-compatible-hub-adapter.ts:791`. Centralizing here so the
 * discovery probe + the runtime balance check share one source of truth.
 */
const BALANCE_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  poe: 'https://api.poe.com/usage/current_balance',
  aiml: 'https://api.aimlapi.com/v1/billing/balance',
  cometapi: 'https://api.cometapi.com/api/user/self',
  ai302: 'https://api.302.ai/dashboard/balance',
  aihubmix: 'https://aihubmix.com/api/user/self',
  nanogpt: 'https://nano-gpt.com/api/balance',
  edenai: 'https://api.edenai.run/v2/user/balance',
  novita: 'https://api.novita.ai/v3/billing/balance',
  routeway: 'https://api.routeway.ai/v1/credits',
  openrouter: 'https://openrouter.ai/api/v1/auth/key',
});

interface BalanceParseResult {
  hasCredits: boolean;
  balanceUsd?: number;
  reason?: string;
}

/**
 * Parses a balance response body. Each provider returns a slightly
 * different shape — we look for the most common fields and accept
 * anything resembling a numeric balance.
 *
 * Returns null when the shape is unrecognizable (let caller treat as
 * unknown rather than as exhausted).
 */
function parseBalanceBody(data: unknown): BalanceParseResult | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  // Common nested shapes
  const candidates: (number | undefined)[] = [
    typeof d.balance === 'number' ? d.balance : undefined,
    typeof d.credits === 'number' ? d.credits : undefined,
    typeof d.credit === 'number' ? d.credit : undefined,
    typeof d.amount === 'number' ? d.amount : undefined,
    typeof d.total_granted === 'number' ? d.total_granted : undefined,
  ];

  // OpenRouter shape
  const dataField = d.data;
  if (typeof dataField === 'object' && dataField !== null) {
    const f = dataField as Record<string, unknown>;
    if (typeof f.limit_remaining === 'number') candidates.push(f.limit_remaining);
    if (typeof f.usage === 'number' && typeof f.limit === 'number') {
      candidates.push(f.limit - f.usage);
    }
  }

  // AiHubMix / CometAPI shape: { quota: 1000, used_quota: 950 }
  if (typeof d.quota === 'number' && typeof d.used_quota === 'number') {
    candidates.push(d.quota - d.used_quota);
  }

  for (const v of candidates) {
    if (v !== undefined) {
      return {
        hasCredits: v > 0,
        balanceUsd: v,
        reason: v > 0 ? undefined : `balance=${v}`,
      };
    }
  }
  return null;
}

// ─── Probe implementations ────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeCreditViaBalanceEndpoint(input: {
  providerId: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<{
  status: 'has_credits' | 'exhausted' | 'unknown';
  balanceUsd?: number;
  reason?: string;
}> {
  const url = BALANCE_ENDPOINTS[input.providerId.toLowerCase()];
  if (!url) return { status: 'unknown', reason: 'no_endpoint_configured' };

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: input.timeoutMs,
    });

    // Auth issues → not a credit answer; let credential probe handle it
    if (resp.status === 401 || resp.status === 403) {
      return { status: 'unknown', reason: `auth_status_${resp.status}` };
    }
    if (!resp.ok) {
      return { status: 'unknown', reason: `http_${resp.status}` };
    }

    const data: unknown = await resp.json().catch(() => null);
    const parsed = parseBalanceBody(data);
    if (!parsed) return { status: 'unknown', reason: 'unparseable_balance' };

    return {
      status: parsed.hasCredits ? 'has_credits' : 'exhausted',
      balanceUsd: parsed.balanceUsd,
      reason: parsed.reason,
    };
  } catch (err) {
    return {
      status: 'unknown',
      reason: `probe_error: ${String(err).slice(0, 100)}`,
    };
  }
}

async function listModelsViaOAICompat(input: {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  modelListPath?: string;
}): Promise<readonly DiscoveredModel[]> {
  const path = input.modelListPath ?? '/v1/models';
  const url = input.baseUrl.replace(/\/$/, '') + path;

  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeoutMs: input.timeoutMs,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} on ${path}`);
  }

  const body: unknown = await resp.json();
  if (typeof body !== 'object' || body === null) {
    throw new Error('list_models_response_not_object');
  }

  // OAI-compatible shape: { object: 'list', data: [{ id, ... }, ...] }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('list_models_response_no_data_array');
  }

  const models: DiscoveredModel[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string') continue;
    models.push({
      modelId: e.id,
      family: typeof e.owned_by === 'string' ? e.owned_by : undefined,
      contextWindow:
        typeof e.context_window === 'number'
          ? e.context_window
          : typeof e.context_length === 'number'
            ? e.context_length
            : undefined,
      capabilities:
        Array.isArray(e.capabilities)
          ? e.capabilities.filter((c): c is string => typeof c === 'string')
          : undefined,
    });
  }
  return models;
}

// ─── Factory: buildProbeCallbacks ────────────────────────────────────────

export interface BuildProbeCallbacksInput {
  providerId: string;
  integrationClass?: string;
  baseUrl?: string;
  /**
   * Optional: provider-specific list-models path. Defaults to '/v1/models'.
   */
  modelListPath?: string;
}

/**
 * Builds the default `ProviderProbeCallbacks` for a provider given its
 * integration class. Operators can override individual callbacks before
 * passing the result to `runProviderDiscovery({ probeCallbacks })`.
 *
 * Provides:
 *  - probeCredit: when the provider is in `BALANCE_ENDPOINTS`
 *  - listModels: when integration class supports OAI-compat /v1/models
 *  - probeCredential: NOT provided — env-only check covers most cases,
 *    and active probe requires an auth endpoint we don't always have.
 */
export function buildProbeCallbacks(input: BuildProbeCallbacksInput): ProviderProbeCallbacks {
  const callbacks: ProviderProbeCallbacks = {};
  const integration = (input.integrationClass ?? '').toLowerCase();
  const supportsOAIModelsList =
    integration === 'oai-compat-pure'
    || integration === 'native-openai'
    || integration === 'self-hosted-oai-compat'
    || integration === 'aggregator-with-billing';

  if (BALANCE_ENDPOINTS[input.providerId.toLowerCase()]) {
    callbacks.probeCredit = (probeInput: { providerId: string; apiKey: string; timeoutMs: number }) =>
      probeCreditViaBalanceEndpoint({
        providerId: input.providerId,
        apiKey: probeInput.apiKey,
        timeoutMs: probeInput.timeoutMs,
      });
  }

  if (supportsOAIModelsList && input.baseUrl) {
    const baseUrl = input.baseUrl;
    const modelListPath = input.modelListPath;
    callbacks.listModels = (probeInput: { providerId: string; apiKey: string; timeoutMs: number }) =>
      listModelsViaOAICompat({
        providerId: input.providerId,
        apiKey: probeInput.apiKey,
        baseUrl,
        modelListPath,
        timeoutMs: probeInput.timeoutMs,
      });
  }

  return callbacks;
}

/**
 * Convenience: build the callbacks map for a list of providers, ready to
 * pass to `runProviderDiscovery({ probeCallbacks })`.
 */
export function buildProbeCallbacksMap(
  providers: readonly BuildProbeCallbacksInput[],
): Record<string, ProviderProbeCallbacks> {
  const out: Record<string, ProviderProbeCallbacks> = {};
  for (const p of providers) {
    out[p.providerId] = buildProbeCallbacks(p);
  }
  return out;
}

// ─── Map adapter-style errors to ProviderErrorClass ───────────────────────

/**
 * Helper for callers that catch probe errors and want to attach an
 * error class to the discovery result without re-running classification.
 */
export function inferProbeErrorClass(err: unknown): ProviderErrorClass {
  const msg = String(err).toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized')) return 'auth_failed';
  if (msg.includes('403') || msg.includes('forbidden')) return 'auth_failed';
  if (msg.includes('402')) return 'insufficient_credit';
  if (msg.includes('429') || msg.includes('rate')) return 'rate_limited';
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('eai_again')) return 'provider_timeout';
  if (msg.includes('404')) return 'endpoint_not_found';
  return 'unknown_error';
}
