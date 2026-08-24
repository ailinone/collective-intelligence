// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Quarantine revalidation worker (Workstream F, 2026-08-17).
 *
 * Background interval that re-probes QUARANTINED providers (auth_failed /
 * no_credits in the operability hub = AUTH_INVALID / AUTH_MISSING /
 * BILLING_EXHAUSTED / ACCOUNT_RESTRICTED in the typed taxonomy) OUT OF BAND
 * and restores them when the underlying condition heals (rotated secret,
 * re-filled balance, lifted suspension).
 *
 * Why this must exist: quarantine excludes a provider from every user
 * request, so organic traffic can never observe its recovery — without an
 * out-of-band probe, a healed provider stays quarantined until its 12h/6h
 * persisted TTL expires. Conversely `recordProbeResult('healthy')`
 * deliberately CANNOT clear auth_failed/no_credits (a list-models probe
 * proves neither inference auth nor billing), so restoration goes through
 * the stronger `recordRevalidationSuccess()` (adapter healthCheck = a real
 * minimal call) — see the hub for the trust ladder.
 *
 * Never logs secret material; probes use the adapter's own configured
 * credentials.
 */
import { logger } from '@/utils/logger';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { classifyProviderFailure, extractHttpStatusFromMessage } from './provider-failure-classification';

const log = logger.child({ component: 'quarantine-revalidation-worker' });

/** Default: revalidate every 15 minutes (env-tunable). */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** Per-adapter healthCheck budget. */
const DEFAULT_PROBE_TIMEOUT_MS = 15 * 1000;
/** Revalidate at most this many providers per tick (serial, bounded). */
const DEFAULT_MAX_PER_TICK = 10;

export interface HealthCheckLike {
  getName(): string;
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}

export interface RevalidationDeps {
  /** Returns the adapter for a quarantined provider key, or undefined. */
  readonly adapterLookup?: (providerKey: string) => HealthCheckLike | undefined;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxPerTick?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startQuarantineRevalidation(deps: RevalidationDeps = {}): void {
  if (timer) return;
  const intervalMs =
    deps.intervalMs ??
    (Number(process.env.QUARANTINE_REVALIDATION_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  timer = setInterval(() => {
    void runQuarantineRevalidationOnce(deps).catch((err) => {
      log.warn({ err: String(err) }, 'quarantine revalidation tick failed');
    });
  }, intervalMs);
  // Never hold the event loop open on its own.
  timer.unref?.();
  log.info({ intervalMs }, 'quarantine revalidation worker started');
}

export function stopQuarantineRevalidation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Default adapter lookup: the global provider registry, by adapter name. */
async function defaultAdapterLookup(providerKey: string): Promise<HealthCheckLike | undefined> {
  try {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const adapters = registry.getAll();
    return (
      adapters.find((a) => a.getName().toLowerCase() === providerKey) ??
      adapters.find((a) => a.getName().toLowerCase().replace(/-api$/, '') === providerKey)
    ) as HealthCheckLike | undefined;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        t = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * One revalidation pass. For each quarantined provider (bounded):
 *  - healthy healthCheck            → recordRevalidationSuccess (restores)
 *  - auth/billing failure response  → recordProbeResult (refreshes the
 *    quarantine signal so the persisted TTL does not silently expire while
 *    the provider is still broken)
 *  - timeout / inconclusive         → no state change
 */
export async function runQuarantineRevalidationOnce(
  deps: RevalidationDeps = {}
): Promise<{ restored: string[]; stillFailing: string[]; skipped: string[] }> {
  const hub = getProviderOperabilityHub();
  const quarantined = hub.getQuarantinedProviders();
  const max = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const restored: string[] = [];
  const stillFailing: string[] = [];
  const skipped: string[] = [];

  for (const key of quarantined.slice(0, max)) {
    // Route-level keys ("hub:family") are not adapter-addressable — skip.
    if (key.includes(':')) {
      skipped.push(key);
      continue;
    }
    let adapter: HealthCheckLike | undefined;
    if (deps.adapterLookup) {
      adapter = deps.adapterLookup(key);
    } else {
      adapter = await defaultAdapterLookup(key);
    }
    if (!adapter) {
      skipped.push(key);
      continue;
    }
    try {
      const result = await withTimeout(adapter.healthCheck(), probeTimeoutMs);
      if (result === 'timeout') {
        skipped.push(key);
        continue;
      }
      if (result.healthy) {
        hub.recordRevalidationSuccess(key);
        restored.push(key);
        continue;
      }
      const message = result.error ?? '';
      const status = extractHttpStatusFromMessage(message);
      const { state } = classifyProviderFailure({ httpStatus: status, message });
      if (state === 'AUTH_INVALID' || state === 'AUTH_MISSING') {
        hub.recordProbeResult(key, 'auth_failed', `revalidation: ${state.toLowerCase()}`);
        stillFailing.push(key);
      } else if (state === 'BILLING_EXHAUSTED') {
        hub.recordProbeResult(key, 'insufficient_credit', 'revalidation: billing exhausted');
        stillFailing.push(key);
      } else {
        // Inconclusive (rate limit / transient / unknown) — leave state as-is.
        skipped.push(key);
      }
    } catch (err) {
      log.debug({ provider: key, err: String(err) }, 'quarantine revalidation probe threw');
      skipped.push(key);
    }
  }

  if (restored.length > 0 || stillFailing.length > 0) {
    log.info(
      { quarantined: quarantined.length, restored, stillFailing, skipped: skipped.length },
      'quarantine revalidation pass complete'
    );
  }
  return { restored, stillFailing, skipped };
}
