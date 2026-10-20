// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wallet grant expiry sweeper — process-level lifecycle for the promotional
 * grant reclaim loop.
 *
 * Promotional grants (wallet_grants, minted by the billing campaign engine via
 * POST /v1/internal/wallet/grant) expire: the Terms promise non-transferable
 * credit with an end date, and the campaign budget must not stay on the books
 * forever. The wallet itself only allocates FROM unexpired grants at debit
 * time — reclaiming the unspent remainder from the balance is this sweep's
 * job (see BalanceStore.expireGrants for the per-org locking + idempotency
 * contract: safe against concurrent debits and against itself).
 *
 * Scheduling mirrors broadcast-poller-runner.ts: idempotent start/stop,
 * overlapping-tick guard, unref'd timers, and a tick that can never throw past
 * the timer callback. Until the campaign engine starts granting, every tick is
 * a single empty indexed scan — enabled by default, disable with
 * WALLET_GRANT_SWEEP_ENABLED=false.
 */

import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';

import { walletInstance } from './prepaid-wallet-gate';

const log = logger.child({ component: 'wallet-grant-expiry-sweeper' });

// Expiry is not latency-sensitive (nothing breaks while a grant sits expired
// but un-reclaimed — it just stays spendable a little longer); 60s keeps the
// worst-case over-credit window tiny without meaningfully touching the pool.
const SWEEP_INTERVAL_MS = Number(process.env.WALLET_GRANT_SWEEP_INTERVAL_MS ?? 60_000);

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;

async function sweepTick(): Promise<void> {
  if (isSweeping) return;
  isSweeping = true;
  try {
    const { grantsExpired, reclaimedUsd } = await walletInstance().expireGrants();
    if (grantsExpired > 0) {
      log.info({ grantsExpired, reclaimedUsd }, 'wallet grants expired');
    }
  } finally {
    isSweeping = false;
  }
}

/** Start the grant expiry sweep loop. Idempotent — a second call is a no-op. */
export function startWalletGrantSweeper(): void {
  if (sweepTimer) {
    log.debug('Wallet grant sweeper already running');
    return;
  }

  sweepTimer = setInterval(() => {
    sweepTick().catch((err) => {
      log.error({ err: serializeError(err) }, 'Wallet grant sweep tick error');
    });
  }, SWEEP_INTERVAL_MS);

  // The HTTP server owns process lifetime; do not hold the loop open.
  sweepTimer.unref?.();

  log.info({ sweepIntervalMs: SWEEP_INTERVAL_MS }, 'Wallet grant sweeper started');
}

/** Stop the sweep loop. Idempotent. */
export function stopWalletGrantSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    log.info('Wallet grant sweeper stopped');
  }
}
