// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit coverage for `ProviderOperabilityHubImpl.getKnownProviderSources()`.
 *
 * The method was added so the operability audit scripts
 * (run-provider-credit-audit / run-system-registry-parity-audit) can enumerate
 * the hub's LIVE provider universe via `Object.keys(...)`. These tests pin its
 * contract:
 *   - a provider becomes "known" once it has a recorded runtime event,
 *   - an active manual override also makes a key known (and is composed with
 *     runtime-event provenance), and
 *   - expired overrides do NOT keep a key known.
 *
 * NOTE: the hub is a process singleton, so each test uses unique provider keys
 * to stay isolated from sibling tests that may have recorded events.
 */
import { describe, expect, it } from 'vitest';
import { getProviderOperabilityHub } from '../provider-operability-hub';

describe('provider-operability-hub: getKnownProviderSources', () => {
  it('marks a provider known via runtime_events after an execution is recorded', () => {
    const hub = getProviderOperabilityHub();
    const key = 'known-sources-test-provider-a';

    expect(hub.getKnownProviderSources()[key]).toBeUndefined();

    hub.recordExecution(key, true);

    const sources = hub.getKnownProviderSources();
    // keys are lower-cased on record
    expect(sources[key].source).toBe('runtime_events');
    expect(typeof sources[key].addedAt).toBe('number');
    // Object.keys(...) — the shape the audit scripts consume — includes it
    expect(Object.keys(sources)).toContain(key);
  });

  it('marks a provider known via an active manual_override and composes provenance', () => {
    const hub = getProviderOperabilityHub();
    const overrideOnly = 'known-sources-test-override-only';
    const both = 'known-sources-test-both';

    // Active override, no runtime events.
    hub.setManualOverride(overrideOnly, 'auth_failed', 60_000);
    // Runtime event AND an active override → composed provenance.
    hub.recordExecution(both, false, 401, 'unauthorized');
    hub.setManualOverride(both, 'auth_failed', 60_000);

    const sources = hub.getKnownProviderSources();
    expect(sources[overrideOnly].source).toBe('manual_override');
    expect(sources[both].source).toBe('runtime_events+manual_override');
  });

  it('does NOT keep a key known once its manual override has expired', () => {
    const hub = getProviderOperabilityHub();
    const key = 'known-sources-test-expired-override';

    // ttl=0 → already expired by the time getKnownProviderSources() reads it.
    hub.setManualOverride(key, 'rate_limited', 0);

    expect(hub.getKnownProviderSources()[key]).toBeUndefined();
  });
});
