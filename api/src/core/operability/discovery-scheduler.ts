// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DiscoveryScheduler — periodic + on-demand runs of the
 * ProviderDiscoveryService.
 *
 * Phase 1.5+3 wiring:
 *   - Reads the configured providers from a resolver function
 *     (the resolver is plugged in at startup so the scheduler stays
 *     decoupled from the catalog/registry implementation)
 *   - Builds probe callbacks via `buildProbeCallbacksMap`
 *   - Runs discovery
 *   - Rebuilds the OperationalCandidatePool from the snapshot
 *
 * Design choices:
 *   - Single setInterval, jittered ±10% to avoid synchronized stampedes
 *     across multiple instances
 *   - First run starts after a configurable delay (default 5s) — gives
 *     boot-time secrets/registry init time to settle
 *   - Failures don't break the scheduler — logged + retry on next tick
 *   - On-demand `triggerNow()` returns the snapshot for callers that
 *     need it synchronously (e.g., readiness validators)
 */

import { logger } from '@/utils/logger';
import {
  buildProbeCallbacksMap,
  type BuildProbeCallbacksInput,
} from './adapter-probe-callbacks';
import {
  runProviderDiscovery,
  type ConfiguredProvider,
  type DiscoveryConfig,
} from './discovery-service';
import type { ProviderDiscoverySnapshot } from './types';
import {
  getOperationalCandidatePool,
} from './operational-candidate-pool';

const log = logger.child({ component: 'discovery-scheduler' });

// ─── Config ────────────────────────────────────────────────────────────────

export interface DiscoveryScheduleConfig {
  /** Interval between discovery runs in ms. Default: 5min. */
  intervalMs?: number;
  /** Delay before the first run in ms. Default: 5s. */
  initialDelayMs?: number;
  /** Discovery config passed to runProviderDiscovery. */
  discoveryConfig?: Omit<DiscoveryConfig, 'probeCallbacks'>;
  /**
   * Resolver that returns the current list of configured providers.
   * Called at every tick — the result can change between runs (e.g., a
   * provider was added to the catalog).
   */
  resolveProviders: () => ConfiguredProvider[] | Promise<ConfiguredProvider[]>;
  /**
   * Optional resolver for probe callback inputs. If not provided, the
   * scheduler infers from the providers list (uses providerId +
   * integrationClass + apiKeyEnvVar). Override when you want
   * provider-specific baseUrl or modelListPath.
   */
  resolveProbeInputs?: () => BuildProbeCallbacksInput[] | Promise<BuildProbeCallbacksInput[]>;
  /**
   * Optional fallback model list for providers where discovery doesn't
   * enumerate (e.g., native-anthropic). Map providerId → models.
   */
  resolveFallbackModels?: () => Record<string, ReadonlyArray<{ modelId: string; family?: string; contextWindow?: number }>> | Promise<Record<string, ReadonlyArray<{ modelId: string; family?: string; contextWindow?: number }>>>;
  /**
   * Optional resolver for integration classes per provider, used by the
   * pool's tier classification.
   */
  resolveIntegrationClasses?: () => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Hook fired AFTER the OperationalCandidatePool has been rebuilt
   * with the latest snapshot. Used to chain the embedding pipeline
   * (Phase 4.2): rebuilt pool → re-embed candidates → SemanticIndex
   * stays fresh.
   *
   * Hook errors are logged but don't fail the tick.
   */
  onPoolRebuilt?: (snapshot: ProviderDiscoverySnapshot) => void | Promise<void>;
}

// ─── Scheduler ────────────────────────────────────────────────────────────

class DiscoveryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSnapshot: ProviderDiscoverySnapshot | null = null;
  private currentTick: Promise<ProviderDiscoverySnapshot | null> | null = null;
  private config: DiscoveryScheduleConfig | null = null;

  start(config: DiscoveryScheduleConfig): void {
    if (this.running) {
      log.warn('DiscoveryScheduler.start called while already running — ignoring');
      return;
    }
    this.config = config;
    this.running = true;

    const initialDelay = config.initialDelayMs ?? 5_000;
    const interval = config.intervalMs ?? 5 * 60 * 1000;

    log.info({ initialDelay, interval }, 'DiscoveryScheduler started');

    setTimeout(() => {
      void this.tick();
      // Setup the recurring timer with jitter.
      const jitter = () => interval * (0.9 + Math.random() * 0.2);
      const reschedule = () => {
        this.timer = setTimeout(async () => {
          await this.tick();
          if (this.running) reschedule();
        }, jitter());
      };
      reschedule();
    }, initialDelay);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('DiscoveryScheduler stopped');
  }

  /**
   * Trigger a discovery run immediately. If a tick is already in
   * progress, returns the same promise (no concurrent runs).
   */
  async triggerNow(): Promise<ProviderDiscoverySnapshot | null> {
    if (this.currentTick) return this.currentTick;
    return this.tick();
  }

  getLastSnapshot(): ProviderDiscoverySnapshot | null {
    return this.lastSnapshot;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async tick(): Promise<ProviderDiscoverySnapshot | null> {
    if (this.currentTick) return this.currentTick;
    if (!this.config) {
      log.warn('Tick called before start — skipping');
      return null;
    }

    const config = this.config;
    this.currentTick = (async () => {
      try {
        const providers = await config.resolveProviders();
        if (providers.length === 0) {
          log.warn('Discovery tick: no providers configured');
          return null;
        }

        const probeInputs = config.resolveProbeInputs
          ? await config.resolveProbeInputs()
          : providers.map((p) => ({
              providerId: p.providerId,
              integrationClass: p.integrationClass,
            }));

        const probeCallbacks = buildProbeCallbacksMap(probeInputs);

        const snapshot = await runProviderDiscovery(providers, {
          ...config.discoveryConfig,
          probeCallbacks,
        });

        // Rebuild operational candidate pool
        const integrationClasses = config.resolveIntegrationClasses
          ? await config.resolveIntegrationClasses()
          : Object.fromEntries(
              providers.map((p) => [p.providerId, p.integrationClass ?? '']),
            );
        const fallbackModels = config.resolveFallbackModels
          ? await config.resolveFallbackModels()
          : {};

        getOperationalCandidatePool().rebuild({
          snapshot,
          integrationClassByProvider: integrationClasses,
          fallbackModelsByProvider: fallbackModels,
        });

        // Fire onPoolRebuilt hook (e.g., embedding pipeline rebuild)
        if (config.onPoolRebuilt) {
          try {
            await config.onPoolRebuilt(snapshot);
          } catch (err) {
            log.warn({ err: String(err) }, 'onPoolRebuilt hook threw — continuing');
          }
        }

        this.lastSnapshot = snapshot;
        log.info(
          {
            totalConfigured: snapshot.totalConfigured,
            totalAvailable: snapshot.totalAvailable,
            totalUnavailable: snapshot.totalUnavailable,
            durationMs: snapshot.durationMs,
            poolSize: getOperationalCandidatePool().size(),
          },
          'Discovery tick completed',
        );
        return snapshot;
      } catch (err) {
        log.error({ err: String(err) }, 'Discovery tick failed — will retry on next tick');
        return null;
      } finally {
        this.currentTick = null;
      }
    })();

    return this.currentTick;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: DiscoveryScheduler | null = null;

export function getDiscoveryScheduler(): DiscoveryScheduler {
  if (!instance) {
    instance = new DiscoveryScheduler();
  }
  return instance;
}

export function resetDiscoveryShedulerForTesting(): void {
  if (instance) instance.stop();
  instance = null;
}

export type { DiscoveryScheduler };
