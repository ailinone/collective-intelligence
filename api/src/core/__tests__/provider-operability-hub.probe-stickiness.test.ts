// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * A discovery PROBE 'healthy' must NOT clear a runtime-observed no_credits/
 * auth_failed — only a REAL execution success may. This pins the fix for the
 * observed bug where the periodic ~5-min discovery sweep re-healed every
 * provider that had failed 402/403 at runtime (68/71 stamped healthy despite
 * failing), so the selector kept re-picking dead routes.
 *
 * NOTE: the hub is a process singleton — each test uses a unique provider key.
 */
import { describe, expect, it } from 'vitest';
import { getProviderOperabilityHub } from '../provider-operability-hub';

describe('provider-operability-hub: probe-healthy does not override runtime failures', () => {
  it('a runtime no_credits (402) is NOT cleared by a discovery probe healthy', () => {
    const hub = getProviderOperabilityHub();
    const key = 'probe-stickiness-no-credits';
    hub.recordExecution(key, false, 402, 'insufficient credit');
    expect(hub.getProviderState(key).operabilityState).toBe('no_credits');
    // The bug: a probe 'healthy' re-healed it. It must now be ignored.
    hub.recordProbeResult(key, 'healthy');
    expect(hub.getProviderState(key).operabilityState).toBe('no_credits');
  });

  it('a runtime auth_failed (401) is NOT cleared by a discovery probe healthy', () => {
    const hub = getProviderOperabilityHub();
    const key = 'probe-stickiness-auth-failed';
    hub.recordExecution(key, false, 401, 'unauthorized');
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
    hub.recordProbeResult(key, 'healthy');
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
  });

  it('a REAL execution success streak DOES clear a runtime no_credits (recovery via traffic)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'probe-stickiness-recovery';
    hub.recordExecution(key, false, 402, 'insufficient credit');
    expect(hub.getProviderState(key).operabilityState).toBe('no_credits');
    // Real executions (not probes) heal it — live traffic stays authoritative.
    hub.recordExecution(key, true);
    hub.recordExecution(key, true);
    hub.recordExecution(key, true);
    expect(['recovering', 'healthy']).toContain(hub.getProviderState(key).operabilityState);
  });

  it('a discovery probe healthy still marks a fresh (unknown) provider healthy', () => {
    const hub = getProviderOperabilityHub();
    const key = 'probe-stickiness-fresh';
    expect(hub.getProviderState(key).operabilityState).toBe('unknown');
    hub.recordProbeResult(key, 'healthy');
    expect(hub.getProviderState(key).operabilityState).toBe('healthy');
  });
});
