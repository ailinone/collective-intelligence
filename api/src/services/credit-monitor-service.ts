// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proactive Credit Monitor Service
 *
 * Part of Full SOTA Provider Resolution (L4: Proactive Credit Monitoring).
 *
 * Instead of discovering credit exhaustion only when a request fails (402/403),
 * this service proactively polls provider balances every 5 minutes.
 *
 * When a credit state changes (has-credits → no-credits or vice versa),
 * it immediately invalidates the affected provider's models in selection caches.
 */

import { logger } from '@/utils/logger';

import { narrowAs } from '@/utils/type-guards';
const log = logger.child({ component: 'credit-monitor' });

// ─── Types ──────────────────────────────────────────────────────────────

export interface CreditState {
  providerId: string;
  hasCredits: boolean;
  balance?: number;
  currency?: string;
  lastCheckedAt: Date;
  checkSource: 'probe' | 'runtime-error' | 'startup';
  consecutiveErrors: number;
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: CreditMonitorService | null = null;

export function getCreditMonitorService(): CreditMonitorService {
  if (!instance) {
    instance = new CreditMonitorService();
  }
  return instance;
}

// ─── Service ────────────────────────────────────────────────────────────

export class CreditMonitorService {
  private creditStates = new Map<string, CreditState>();
  private probeIntervalHandle: NodeJS.Timeout | null = null;
  private probeIntervalMs = Number(process.env.CREDIT_PROBE_INTERVAL_MS || '300000'); // 5 min default
  private noCreditsSet = new Set<string>();

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Start periodic credit probes.
   */
  start(): void {
    if (this.probeIntervalHandle) return;

    this.probeIntervalHandle = setInterval(() => {
      this.probeAll().catch(err =>
        log.warn({ error: String(err) }, 'Credit probe cycle failed')
      );
    }, this.probeIntervalMs);
    this.probeIntervalHandle.unref();

    log.info(
      { intervalMs: this.probeIntervalMs },
      'Credit monitor started — probing provider balances periodically'
    );
  }

  /**
   * Stop periodic probes.
   */
  stop(): void {
    if (this.probeIntervalHandle) {
      clearInterval(this.probeIntervalHandle);
      this.probeIntervalHandle = null;
      log.info('Credit monitor stopped');
    }
  }

  /**
   * Handle a runtime credit error (402/403).
   * Immediately marks provider as no-credits and invalidates caches.
   */
  onCreditError(providerId: string): void {
    const normalized = providerId.toLowerCase();
    const existing = this.creditStates.get(normalized);

    this.creditStates.set(normalized, {
      providerId: normalized,
      hasCredits: false,
      lastCheckedAt: new Date(),
      checkSource: 'runtime-error',
      consecutiveErrors: (existing?.consecutiveErrors ?? 0) + 1,
    });

    this.noCreditsSet.add(normalized);

    // Also propagate to discovery service's balance status map
    this.propagateToDiscovery(normalized, false);

    log.warn(
      { provider: normalized, consecutiveErrors: (existing?.consecutiveErrors ?? 0) + 1 },
      'Provider marked as no-credits from runtime 402/403 error'
    );
  }

  /**
   * Get current credit state for a provider.
   */
  getState(providerId: string): CreditState | null {
    return this.creditStates.get(providerId.toLowerCase()) ?? null;
  }

  /**
   * Returns all providers currently known to have no credits.
   */
  getNoCreditsProviders(): ReadonlySet<string> {
    return this.noCreditsSet;
  }

  /**
   * Check if a specific provider has credits (based on last probe/runtime check).
   * Returns true if status is unknown (optimistic).
   */
  hasCredits(providerId: string): boolean {
    const state = this.creditStates.get(providerId.toLowerCase());
    if (!state) return true; // Unknown = optimistic
    return state.hasCredits;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /**
   * Probe all registered providers for balance.
   * Uses the provider registry's adapters to call checkBalance().
   */
  private async probeAll(): Promise<void> {
    const startTime = Date.now();

    try {
      const { getProviderRegistry } = await import('@/providers/provider-registry');
      const registry = getProviderRegistry();
      if (!registry) return;

      const providers = registry.getProviderNames();
      let checked = 0;
      let stateChanges = 0;

      for (const providerName of providers) {
        try {
          const adapter = registry.get(providerName);
          if (!adapter || typeof adapter.checkBalance !== 'function') continue;

          const result = await Promise.race([
            adapter.checkBalance(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)), // 5s timeout per provider
          ]);

          if (result === null) continue; // timeout

          const normalized = providerName.toLowerCase();
          const previous = this.creditStates.get(normalized);
          const hasCredits = result.hasCredits ?? true;

          this.creditStates.set(normalized, {
            providerId: normalized,
            hasCredits,
            balance: result.balance,
            currency: result.currency,
            lastCheckedAt: new Date(),
            checkSource: 'probe',
            consecutiveErrors: hasCredits ? 0 : (previous?.consecutiveErrors ?? 0),
          });

          // Detect state change
          if (previous && previous.hasCredits !== hasCredits) {
            stateChanges++;
            if (hasCredits) {
              this.noCreditsSet.delete(normalized);
              log.info({ provider: normalized, balance: result.balance }, 'Provider credit RESTORED');
            } else {
              this.noCreditsSet.add(normalized);
              log.warn({ provider: normalized }, 'Provider credit EXHAUSTED (detected by probe)');
            }
            this.propagateToDiscovery(normalized, hasCredits);
          } else if (!hasCredits) {
            this.noCreditsSet.add(normalized);
          } else {
            this.noCreditsSet.delete(normalized);
          }

          checked++;
        } catch {
          // Individual provider probe failed — non-critical, skip
        }
      }

      log.debug(
        { checked, stateChanges, durationMs: Date.now() - startTime },
        'Credit probe cycle completed'
      );
    } catch (err) {
      log.warn({ error: String(err) }, 'Credit probe cycle error');
    }
  }

  /**
   * Propagate credit state change to the discovery service's balance status map.
   */
  private async propagateToDiscovery(providerId: string, hasCredits: boolean): Promise<void> {
    try {
      const { getCentralModelDiscoveryService } = await import('@/services/central-model-discovery-service');
      const discovery = await getCentralModelDiscoveryService();
      if (hasCredits) {
        // Restore credit status in discovery service's balance map
        // This clears the no-credits mark so models become eligible again
        if (typeof (narrowAs<Record<string, unknown>>(discovery)).providerBalanceStatus === 'object') {
          const balanceMap = (narrowAs<{ providerBalanceStatus: Map<string, { hasCredits: boolean; balance?: number; currency?: string }> }>(discovery)).providerBalanceStatus;
          balanceMap.set(providerId, { hasCredits: true, balance: undefined, currency: undefined });
          log.info({ provider: providerId }, 'Credit restored — discovery balance status updated');
        } else {
          log.info({ provider: providerId }, 'Credit restored — discovery will update on next enrichment');
        }
      } else {
        if (typeof discovery.markProviderNoCredits === 'function') {
          discovery.markProviderNoCredits(providerId);
        }
      }
    } catch {
      // Discovery service not available — non-critical
    }
  }
}
