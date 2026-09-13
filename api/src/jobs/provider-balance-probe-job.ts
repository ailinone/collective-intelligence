// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Balance Probe Job — continuous balance monitoring.
 *
 * Strategy (see systems/docs/provider-balance-monitoring.md):
 *   - Scheduled hourly via BullMQ (register-scheduled-jobs.ts), NOT per
 *     /metrics scrape — balance endpoints are slow and some count against
 *     provider quotas. The gauge is served from in-process state between runs.
 *   - Probes run sequentially with a small delay + jitter to avoid bursting
 *     every provider's billing API at once.
 *   - Providers whose adapter does not implement checkBalance() (returns
 *     null) still emit credit_status=unknown so coverage gaps stay visible.
 *   - Optionally pushes the snapshot to Ailin Systems (durable history +
 *     operator portal) via SYSTEMS_OPERATIONS_URL + SYSTEMS_INGEST_API_KEY.
 *     Fire-and-forget: a Systems outage must never fail this job.
 */

import { METRIC_NAMES, incrementCounter, setGauge } from '@/core/operability/metrics';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'provider-balance-probe-job' });

/** Delay between individual provider probes (ms) to avoid rate-limit bursts. */
const INTER_PROBE_DELAY_MS = 500;
/** Upper bound of additional jitter per probe (ms). */
const INTER_PROBE_JITTER_MS = 500;

interface BalanceSnapshotEntry {
  provider: string;
  status: 'has_credits' | 'exhausted' | 'unknown' | 'error';
  hasCredits: boolean | null;
  balance: number | null;
  currency: string;
  checkedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeAdapter(
  name: string,
  adapter: { checkBalance(): Promise<{ hasCredits: boolean; balance?: number; currency?: string } | null> }
): Promise<BalanceSnapshotEntry> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await adapter.checkBalance();
    setGauge(METRIC_NAMES.PROVIDER_BALANCE_CHECKED_AT, Date.now() / 1000, { providerId: name });

    if (result === null) {
      incrementCounter(METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL, {
        providerId: name,
        status: 'unknown',
      });
      return { provider: name, status: 'unknown', hasCredits: null, balance: null, currency: 'USD', checkedAt };
    }

    incrementCounter(METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL, {
      providerId: name,
      status: result.hasCredits ? 'has_credits' : 'exhausted',
    });

    if (typeof result.balance === 'number' && Number.isFinite(result.balance)) {
      setGauge(METRIC_NAMES.PROVIDER_BALANCE, result.balance, {
        providerId: name,
        currency: result.currency || 'USD',
      });
    }

    return {
      provider: name,
      status: result.hasCredits ? 'has_credits' : 'exhausted',
      hasCredits: result.hasCredits,
      balance: typeof result.balance === 'number' ? result.balance : null,
      currency: result.currency || 'USD',
      checkedAt,
    };
  } catch (error) {
    incrementCounter(METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL, { providerId: name, status: 'error' });
    log.debug({ provider: name, error: String(error) }, 'balance probe threw');
    return { provider: name, status: 'error', hasCredits: null, balance: null, currency: 'USD', checkedAt };
  }
}

async function pushSnapshotToSystems(entries: BalanceSnapshotEntry[]): Promise<void> {
  const baseUrl = process.env.SYSTEMS_OPERATIONS_URL;
  const apiKey = process.env.SYSTEMS_INGEST_API_KEY;
  if (!baseUrl || !apiKey) return;

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/provider-balances`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ source_service: 'ci', balances: entries }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'systems balance push rejected');
    }
  } catch (error) {
    log.warn({ error: String(error) }, 'systems balance push failed (non-critical)');
  }
}

export async function runProviderBalanceProbeNow(): Promise<{ probed: number; snapshot: BalanceSnapshotEntry[] }> {
  const { getProviderRegistry } = await import('@/providers/provider-registry.js');
  const registry = getProviderRegistry();
  const adapters: Array<{
    adapterKey: string;
    checkBalance(): Promise<{ hasCredits: boolean; balance?: number; currency?: string } | null>;
  }> = registry.getAll();
  const snapshot: BalanceSnapshotEntry[] = [];

  for (const adapter of adapters) {
    const name = adapter.adapterKey || 'unknown';
    snapshot.push(await probeAdapter(name, adapter));
    await sleep(INTER_PROBE_DELAY_MS + Math.floor(Math.random() * INTER_PROBE_JITTER_MS));
  }

  log.info(
    {
      probed: snapshot.length,
      withBalance: snapshot.filter((e) => e.balance !== null).length,
      exhausted: snapshot.filter((e) => e.status === 'exhausted').length,
    },
    'provider balance probe cycle complete'
  );

  await pushSnapshotToSystems(snapshot);
  return { probed: snapshot.length, snapshot };
}
