// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.2 — ProviderProbeRegistry.
 *
 * Per-provider registration of non-billable probes. A probe is an
 * async function that hits a KNOWN-SAFE endpoint (list-models /
 * balance / health / account) and returns the live operability state.
 *
 * **Default registry is empty.** Adapters with verified non-billable
 * endpoints register their own probes via `registerProbe()`. The
 * audit service treats unregistered providers as
 * `probeSupported: false`, so they're never queried even in
 * `non_billable_probe` mode.
 *
 * Probe contract:
 *   - MUST NOT generate tokens
 *   - MUST NOT charge per call
 *   - MUST honor `timeoutMs`
 *   - MUST return within `latencyMs` budget (default 5s)
 *   - MUST set `billableRisk: 'none'` — anything else aborts the probe
 *
 * Adapters that don't have a safe endpoint MUST NOT register; the
 * audit will report `provider_probe_not_supported` for them.
 */
import type {
  ProbeBillableRisk,
  ProbeEndpointType,
  ProviderProbeMetadata,
  ProviderProbeResult,
} from './provider-credit-audit-types';

export interface ProbeInput {
  readonly providerId: string;
  readonly timeoutMs: number;
}

export interface ProviderProbe {
  readonly providerId: string;
  readonly endpointType: ProbeEndpointType;
  readonly billableRisk: ProbeBillableRisk;
  /** Probe function. MUST be non-billable. The registry refuses to
   *  invoke probes whose `billableRisk !== 'none'`. */
  readonly probe: (input: ProbeInput) => Promise<Omit<ProviderProbeResult, 'providerId' | 'endpointType' | 'billableRisk'>>;
}

export class ProviderProbeRegistry {
  private readonly probes = new Map<string, ProviderProbe>();

  register(probe: ProviderProbe): void {
    if (probe.billableRisk !== 'none') {
      throw new Error(
        `Refusing to register probe for ${probe.providerId}: billableRisk must be 'none', got '${probe.billableRisk}'`,
      );
    }
    this.probes.set(probe.providerId.toLowerCase(), probe);
  }

  getMetadata(providerId: string): ProviderProbeMetadata {
    const probe = this.probes.get(providerId.toLowerCase());
    if (!probe) {
      return {
        probeSupported: false,
        probeEndpointType: 'unknown',
        probeBillableRisk: 'unknown',
      };
    }
    return {
      probeSupported: true,
      probeEndpointType: probe.endpointType,
      probeBillableRisk: probe.billableRisk,
    };
  }

  async run(providerId: string, timeoutMs: number): Promise<ProviderProbeResult | undefined> {
    const probe = this.probes.get(providerId.toLowerCase());
    if (!probe) return undefined;
    if (probe.billableRisk !== 'none') return undefined; // defense in depth
    try {
      const inner = await probe.probe({ providerId, timeoutMs });
      return {
        ...inner,
        providerId,
        endpointType: probe.endpointType,
        billableRisk: probe.billableRisk,
      };
    } catch (err) {
      return {
        providerId,
        endpointType: probe.endpointType,
        billableRisk: probe.billableRisk,
        liveOperabilityState: 'unknown',
        observedAt: Date.now(),
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  listRegisteredProviders(): readonly string[] {
    return Array.from(this.probes.keys());
  }
}

/**
 * Pure reconciler: compares cached state with live probe and returns
 * the verdict. Critical: `cached_no_credits_but_live_has_credits` and
 * `cached_healthy_but_live_auth_failed` are marked `isCriticalStale`.
 */
export function reconcileProviderState(input: {
  readonly providerId: string;
  readonly cachedOperabilityState: string;
  readonly cachedBalanceStatus?: string;
  readonly probe?: ProviderProbeResult;
}): import('./provider-credit-audit-types').ProviderReconciliation {
  const { providerId, cachedOperabilityState, cachedBalanceStatus, probe } = input;
  if (!probe) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      verdict: 'provider_probe_not_supported',
      isCriticalStale: false,
    };
  }
  if (probe.error) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'provider_probe_error',
      isCriticalStale: false,
      notes: [probe.error.slice(0, 200)],
    };
  }
  const cachedNoCredits =
    cachedBalanceStatus === 'no_credits' || cachedOperabilityState === 'no_credits';
  const liveHasCredits = probe.liveBalanceStatus === 'has_credits';
  const liveNoCredits = probe.liveBalanceStatus === 'no_credits';

  if (cachedNoCredits && liveHasCredits) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'cached_no_credits_but_live_has_credits',
      isCriticalStale: true,
    };
  }
  if (cachedBalanceStatus === 'has_credits' && liveNoCredits) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'cached_has_credits_but_live_no_credits',
      isCriticalStale: false, // operator must refresh, but not unsafe
    };
  }
  if (cachedOperabilityState === 'unknown' && liveHasCredits) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'cached_unknown_but_live_has_credits',
      isCriticalStale: false,
    };
  }
  if (
    (cachedOperabilityState === 'healthy' || cachedOperabilityState === 'degraded') &&
    probe.liveOperabilityState === 'auth_failed'
  ) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'cached_healthy_but_live_auth_failed',
      isCriticalStale: true,
    };
  }
  if (
    cachedOperabilityState === 'rate_limited' &&
    (probe.liveRateState === 'ok' || probe.liveOperabilityState === 'healthy')
  ) {
    return {
      providerId,
      cachedState: cachedOperabilityState,
      liveState: probe.liveOperabilityState,
      verdict: 'cached_rate_limited_but_live_ok',
      isCriticalStale: false,
    };
  }
  return {
    providerId,
    cachedState: cachedOperabilityState,
    liveState: probe.liveOperabilityState,
    verdict: 'aligned',
    isCriticalStale: false,
  };
}
