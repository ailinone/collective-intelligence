// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Lazy function-calling probe (2026-08-21 follow-up to the dead-pool incident).
 *
 * WHY: with `chatRequest.tools` present, every selection layer hard-filters on
 * DECLARED `function_calling` metadata — but the capability is sparsely
 * populated across the ~106k-model catalog, so the eligible pool collapsed to
 * a handful of models that were mostly on dead providers
 * (empty_response_after_fallback, probes vqNTtcdCjN-TCWTcJZZ9g et al).
 *
 * DESIGN (operator-confirmed principles):
 *   - DECLARED `function_calling` remains the fast path (no probe).
 *   - DECLARED-WITHOUT-FC (explicit non-empty list lacking it) remains a VETO
 *     — the probe never overrides an explicit negative.
 *   - ABSENT/unknown metadata stops being a selection barrier: at the
 *     execution gate, one CHEAP, CACHED probe decides. The probe sends a
 *     minimal chat completion carrying one dummy tool; if the provider
 *     ACCEPTS the request shape, the model counts as FC-capable. An explicit
 *     "tools not supported" error marks it FC-incapable.
 *   - Billing/auth/network failures are NOT an FC verdict — they mean the
 *     provider is dead for other reasons (operability hub owns that) and the
 *     probe returns `null` (inconclusive → caller keeps the current
 *     permissive behavior for unknowns; never empty the chain over a probe).
 *
 * CACHE: Redis (global client, db 1) with a long TTL (default 7 days — tool
 * support is stable per model), an in-memory map in front of it, and
 * in-flight dedup so concurrent requests share one probe.
 */

import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'function-calling-probe' });

export type FunctionCallingVerdict = true | false | null | 'provider-dead';

const TTL_SECONDS = Number(process.env.FC_PROBE_TTL_SECONDS ?? 7 * 24 * 60 * 60);
const PROBE_TIMEOUT_MS = Number(process.env.FC_PROBE_TIMEOUT_MS ?? 10_000);
/** Max probes per process lifetime — a runaway must not mint provider calls. */
const MAX_PROBES_PER_PROCESS = Number(process.env.FC_PROBE_MAX_PROBES ?? 500);
/**
 * Short-lived negative cache for NON-FC verdicts (`null` / `provider-dead`).
 * These are not FC conclusions, so they must NOT get the long TTL — but
 * re-probing the same dead/inconclusive route on every selection of every
 * request costs 1-8s each (observed: togetherai/MiniMax-M1-80k probed 11+ times
 * in ~60s). A short memory-only TTL dedupes the burst without masking a
 * recovered provider for long.
 */
const NEGATIVE_TTL_MS = Number(process.env.FC_PROBE_NEGATIVE_TTL_MS ?? 10 * 60 * 1000);

const memoryCache = new Map<string, FunctionCallingVerdict>();
const negativeExpiry = new Map<string, number>();
const inFlight = new Map<string, Promise<FunctionCallingVerdict>>();
let probesStarted = 0;
let probeHits = 0;
let probeMisses = 0;

const keyFor = (provider: string, modelId: string): string =>
  `fc-probe:${provider.toLowerCase()}:${modelId.toLowerCase()}`;

/** Minimal single-tool payload — enough for the provider to accept or reject. */
const DUMMY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'ailin_fc_probe',
      description: 'capability probe',
      parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
    },
  },
];

/**
 * Error-message shapes that explicitly mean "tools are not supported".
 * Conservative: only unambiguous rejections count as FC=false.
 */
const TOOLS_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /tools?\s+(are\s+)?not\s+supported/,
  /does\s+not\s+support\s+(tools?|function\s+calling|tool\s+use)/,
  /tool\s+use\s+is\s+not\s+supported/,
  /function[_\s-]calling\s+is\s+not\s+supported/,
  /no\s+tool\s+support/,
  /tools?\s+not\s+available/,
];

/** Billing/auth/quota shapes — provider liveness, NOT an FC verdict. */
const PROVIDER_LIVENESS_PATTERNS: readonly RegExp[] = [
  /insufficient/i,
  /credit/i,
  /quota/i,
  /billing/i,
  /unauthorized/i,
  /api\s*key/i,
  /forbidden/i,
  /rate.?limit/i,
  /timeout/i,
  /timed?\s*out/i,
  /econnreset/i,
  /socket\s+hang\s+up/i,
  /network/i,
  /fetch\s+failed/i,
];

/**
 * Classify a probe error.
 *   false            — explicit tools-not-supported (FC verdict, cached)
 *   'provider-dead'  — billing/auth/quota/timeout/network: NOT an FC verdict,
 *                      but the candidate is UNEXECUTABLE right now — callers
 *                      skip it (recorded in the operability hub so ranking
 *                      learns) without caching any FC conclusion.
 *   null             — ambiguous; keep the pre-probe behavior.
 */
function classifyProbeError(message: string): FunctionCallingVerdict {
  const text = message.toLowerCase();
  if (TOOLS_UNSUPPORTED_PATTERNS.some((p) => p.test(text))) return false;
  if (PROVIDER_LIVENESS_PATTERNS.some((p) => p.test(text))) return 'provider-dead';
  return null;
}

async function readRedis(key: string): Promise<FunctionCallingVerdict | undefined> {
  try {
    const { getGlobalRedisClient } = await import('@/cache/redis-client');
    const raw = await getGlobalRedisClient().get(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  } catch {
    return undefined; // Redis down — probe is best-effort
  }
}

async function writeRedis(key: string, verdict: boolean): Promise<void> {
  try {
    const { getGlobalRedisClient } = await import('@/cache/redis-client');
    await getGlobalRedisClient().set(key, verdict ? '1' : '0', 'EX', TTL_SECONDS);
  } catch {
    /* best-effort */
  }
}

async function runProbe(
  adapter: ProviderAdapter,
  provider: string,
  modelId: string
): Promise<FunctionCallingVerdict> {
  probesStarted++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await adapter.chatCompletion(
      {
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        tools: DUMMY_TOOLS,
        max_tokens: 1,
        stream: false,
      },
      { signal: controller.signal }
    );
    // Provider accepted the tools-shaped request → FC-capable. Record the
    // SUCCESS in the operability hub so runtime-health ranking surfaces this
    // route (probe calls bypass the strategy execution path that normally
    // records route health).
    await recordRouteOutcome(provider, modelId, true);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const verdict = classifyProbeError(message);
    if (verdict === 'provider-dead') {
      // Feed the hub: ranking + dead-skip must learn that this route is
      // unexecutable NOW (not cached as an FC conclusion — billing can be
      // fixed and a later probe re-evaluates).
      await recordRouteOutcome(provider, modelId, false, message);
    }
    return verdict;
  } finally {
    clearTimeout(timer);
  }
}

async function recordRouteOutcome(
  provider: string,
  modelId: string,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  try {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    getProviderOperabilityHub().recordRouteExecution(
      provider,
      modelId,
      success,
      success ? 200 : undefined,
      errorMessage
    );
  } catch {
    /* hub unavailable — best-effort */
  }
}

/**
 * Get the (cached) function-calling verdict for a model whose metadata is
 * UNKNOWN. Never throws; `null` means inconclusive (caller keeps the current
 * permissive behavior — do NOT reject the candidate over a failed probe).
 */
export async function getFunctionCallingVerdict(
  adapter: ProviderAdapter,
  provider: string,
  modelId: string
): Promise<FunctionCallingVerdict> {
  const key = keyFor(provider, modelId);

  const mem = memoryCache.get(key);
  if (mem === true || mem === false) {
    probeHits++;
    return mem;
  }
  if (mem !== undefined) {
    // Negative verdict (null | 'provider-dead') — honor it only while the
    // short negative TTL is active, then re-probe.
    const expiresAt = negativeExpiry.get(key) ?? 0;
    if (Date.now() < expiresAt) {
      probeHits++;
      return mem;
    }
    memoryCache.delete(key);
    negativeExpiry.delete(key);
  }

  const remote = await readRedis(key);
  if (remote !== undefined) {
    probeHits++;
    memoryCache.set(key, remote);
    return remote;
  }

  // Budget guard: probing is bounded so a pathological loop can't mint calls.
  if (probesStarted >= MAX_PROBES_PER_PROCESS) {
    log.warn({ probesStarted }, 'FC probe budget exhausted — returning inconclusive');
    return null;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  probeMisses++;
  const p = runProbe(adapter, provider, modelId)
    .then((verdict): FunctionCallingVerdict => {
      if (verdict === true || verdict === false) {
        memoryCache.set(key, verdict);
        void writeRedis(key, verdict);
      } else {
        // null | 'provider-dead': short-lived memory-only negative cache.
        memoryCache.set(key, verdict);
        negativeExpiry.set(key, Date.now() + NEGATIVE_TTL_MS);
      }
      log.info(
        { provider, modelId, verdict, probesStarted, hits: probeHits, misses: probeMisses },
        'FC probe completed'
      );
      return verdict;
    })
    .catch((): FunctionCallingVerdict => null)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/** Test/metrics helper. */
export function getProbeStats(): { started: number; hits: number; misses: number } {
  return { started: probesStarted, hits: probeHits, misses: probeMisses };
}

/** Test helper — reset caches and counters. */
export function resetFunctionCallingProbeForTesting(): void {
  memoryCache.clear();
  negativeExpiry.clear();
  inFlight.clear();
  probesStarted = 0;
  probeHits = 0;
  probeMisses = 0;
}
