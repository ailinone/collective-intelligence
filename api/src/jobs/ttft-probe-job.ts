// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TTFT Probe Job (P0.8, 2026-08-18)
 *
 * WHY: the TTFT tracker is in-memory per replica, so every deploy starts it
 * EMPTY. With no history, the cost cascade's envelope selection falls back to
 * pure cost order and rung 1 goes to the cheapest route — measured at 4-5s
 * TTFT in production. Learning "which cheap-tier routes are fast" from user
 * traffic was tried (explore-when-slow) and reverted: when no in-envelope
 * route is fast, every request re-explores an untried (often dead) route and
 * the cascade burns its whole ladder (observed 60s requests).
 *
 * THIS job explores OUT-OF-BAND instead: every tick it fires a handful of
 * minimal (max_tokens=1) chat completions at untracked cheap-tier routes and
 * records the elapsed time into the same tracker the cascade reads. User
 * traffic always rides the known-best route; the exploration cost (fractions
 * of a cent on economy models) is paid by the system, not by a user's
 * request.
 *
 * Convergence: once CI_TTFT_PROBE_FAST_ROUTES_NEEDED (default 5) routes have
 * a success sample with EWMA <= COLLECTIVE_TTFT_EXPLORE_ABOVE_MS (default
 * 1500ms) and errorRate < 0.5, the tick is a no-op. Routes that fail record a
 * failure (feeding the route-error demotion) and are never re-probed unless
 * they later serve real traffic.
 *
 * Safety: probes are bounded per tick (CI_TTFT_PROBE_PER_TICK, default 3),
 * each with a hard timeout (CI_TTFT_PROBE_TIMEOUT_MS, default 5000).
 * Quarantined providers (auth_failed / no_credits in the operability hub)
 * are never probed.
 */

import { logger } from '@/utils/logger';
import { getTtftTracker, type TtftStats } from '@/core/selection/ttft-tracker';
import type { Model } from '@/types';

const log = logger.child({ component: 'ttft-probe-job', job: 'ttft-probe' });

const DEFAULT_ENVELOPE_CAP_USD = 0.001;
const DEFAULT_FAST_TARGET_MS = 1500;
const DEFAULT_FAST_ROUTES_NEEDED = 5;
// P0.8 (2026-08-19): 3 -> 8. The prober is how fast paid routes (aiml, groq,
// cerebras, ...) become KNOWN so the envelope's TTFT-first ranking can elect
// them over cold-start HF serverless routes. At 3/tick with ~40 in-envelope
// providers, a full cheapest-per-provider cycle took ~13 minutes; 8/tick cuts
// that below 5 minutes after every deploy/tracker reset.
const DEFAULT_PER_TICK = 8;
const DEFAULT_TIMEOUT_MS = 5000;

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function avgCostPer1k(m: Model): number {
  const raw = (Number(m.inputCostPer1k) + Number(m.outputCostPer1k)) / 2;
  return Number.isFinite(raw) && raw > 0 ? raw : Number.MAX_SAFE_INTEGER;
}

export interface TtftProbeResult {
  skipped?: string;
  probed: number;
  succeeded: number;
  failed: number;
  fastRoutes: number;
  durationMs: number;
}

export function isTtftProbeEnabled(): boolean {
  return process.env.CI_TTFT_PROBE_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// In-process poller (NOT a BullMQ cron).
//
// The TTFT tracker is in-memory PER REPLICA, so each API replica must seed
// its OWN tracker. A BullMQ repeatable job executes on exactly one worker —
// which in this deployment is the separate ci_worker process (QUEUE_RUN_
// WORKERS_IN_API=false), seeding a tracker the chat-serving API never reads.
// A per-replica setInterval in the API process is the correct mechanism
// (same pattern as broadcast-poller-runner). If a future change moves the
// tracker to shared storage (Redis), revisit this and go back to BullMQ.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

export function startTtftProbePoller(): void {
  if (!isTtftProbeEnabled()) {
    log.info('TTFT probe poller disabled via CI_TTFT_PROBE_ENABLED=false');
    return;
  }
  if (pollTimer) return;
  // First tick shortly after boot (post-listen): deploys reset the tracker,
  // and rung-1 selection needs fast routes ASAP.
  const firstTick = setTimeout(() => {
    tick().catch(() => {});
  }, 5_000);
  firstTick.unref?.();
  pollTimer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  log.info({ intervalMs: POLL_INTERVAL_MS }, 'TTFT probe poller started');
}

async function tick(): Promise<void> {
  if (pollInFlight) return; // a slow probe batch must not pile up
  pollInFlight = true;
  try {
    await runTtftProbeNow();
  } catch (err) {
    log.warn({ err }, 'TTFT probe tick failed');
  } finally {
    pollInFlight = false;
  }
}

function countFastRoutes(stats: TtftStats[], fastTargetMs: number): number {
  return stats.filter((s) => s.samples > 0 && s.ewmaMs <= fastTargetMs && s.errorRate < 0.5)
    .length;
}

export async function runTtftProbeNow(): Promise<TtftProbeResult> {
  const startedAt = Date.now();
  const tracker = getTtftTracker();
  const fastTargetMs = envNum('COLLECTIVE_TTFT_EXPLORE_ABOVE_MS', DEFAULT_FAST_TARGET_MS);
  const fastRoutesNeeded = envNum('CI_TTFT_PROBE_FAST_ROUTES_NEEDED', DEFAULT_FAST_ROUTES_NEEDED);
  const perTick = envNum('CI_TTFT_PROBE_PER_TICK', DEFAULT_PER_TICK);
  const timeoutMs = envNum('CI_TTFT_PROBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const envelopeCapUsd = envNum(
    'COLLECTIVE_TTFT_ENVELOPE_CAP_USD',
    DEFAULT_ENVELOPE_CAP_USD
  );

  const result: TtftProbeResult = {
    probed: 0,
    succeeded: 0,
    failed: 0,
    fastRoutes: countFastRoutes(tracker.allStats(), fastTargetMs),
    durationMs: 0,
  };

  if (!isTtftProbeEnabled()) {
    result.skipped = 'disabled';
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Converged: enough known-fast routes for the envelope to select from —
  // no synthetic traffic needed.
  if (result.fastRoutes >= fastRoutesNeeded) {
    result.skipped = 'converged';
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const [{ getAllCatalogModels }, { getProviderRegistry }, { getProviderOperabilityHub }] =
    await Promise.all([
      import('@/services/model-catalog-service'),
      import('@/providers/provider-registry'),
      import('@/core/provider-operability-hub'),
    ]);

  const models = await getAllCatalogModels();
  const operabilityHub = getProviderOperabilityHub();

  // Cheap-tier, active, chat-capable, non-quarantined, never-sampled routes,
  // cheapest first — mirroring the cascade's envelope eligibility.
  const candidates = models
    .filter((m) => {
      if (m.status !== 'active') return false;
      if (!m.capabilities?.includes('chat')) return false;
      if (avgCostPer1k(m) > envelopeCapUsd) return false;
      const state = operabilityHub.getProviderState(m.provider).operabilityState;
      if (state === 'auth_failed' || state === 'no_credits') return false;
      // Never-sampled only: failures count as knowledge too (dead route).
      return tracker.attemptCount(m.provider, m.id) === 0;
    })
    .sort((a, b) => avgCostPer1k(a) - avgCostPer1k(b));

  // Provider-diversified pick: at most one probe per provider per tick, so a
  // single dead provider cannot consume the whole tick budget.
  const picked: Model[] = [];
  const seenProviders = new Set<string>();
  for (const m of candidates) {
    if (picked.length >= perTick) break;
    const providerKey = m.provider.toLowerCase();
    if (seenProviders.has(providerKey)) continue;
    seenProviders.add(providerKey);
    picked.push(m);
  }

  if (picked.length === 0) {
    result.skipped = 'no_untracked_candidates';
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const registry = getProviderRegistry();

  await Promise.all(
    picked.map(async (m) => {
      const resolved = await registry.findModel(m.id, m.provider).catch(() => null);
      const adapter = resolved?.adapter;
      if (!adapter) {
        // No adapter → no route to probe; count as failure so we never retry.
        tracker.recordFailure(m.provider, m.id);
        result.failed++;
        return;
      }
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        await adapter.chatCompletion({
          model: m.id,
          messages: [{ role: 'user', content: 'oi' }],
          max_tokens: 1,
        } as never);
        clearTimeout(timer);
        tracker.recordFirstChunk(m.provider, m.id, Date.now() - t0);
        result.succeeded++;
      } catch {
        clearTimeout(timer);
        tracker.recordFailure(m.provider, m.id);
        result.failed++;
      }
    })
  );

  result.probed = picked.length;
  result.fastRoutes = countFastRoutes(tracker.allStats(), fastTargetMs);
  result.durationMs = Date.now() - startedAt;
  log.debug(
    { probed: result.probed, succeeded: result.succeeded, failed: result.failed, fastRoutes: result.fastRoutes },
    'TTFT probe tick'
  );
  return result;
}
