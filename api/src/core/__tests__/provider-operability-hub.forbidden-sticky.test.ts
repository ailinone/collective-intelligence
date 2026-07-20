// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * A non-credit 403 (a FORBIDDEN / IP ban — e.g. routeway returned a Cloudflare
 * "error 1006, the owner has banned your IP address" HTML page) must STICK as
 * auth_failed after the FIRST occurrence, so the selector stops re-picking the
 * banned route. Previously such a 403 classified as 'unknown' and only degraded
 * the route after ≥3 failures — the observed cascade kept re-selecting the ban.
 *
 * Credit-403s (with credit wording) must still classify as no_credits (the credit
 * path runs first and is unchanged).
 *
 * NOTE: the hub is a process singleton — each test uses a unique provider key.
 */
import { describe, expect, it } from 'vitest';
import { getProviderOperabilityHub } from '../provider-operability-hub';

describe('provider-operability-hub: non-credit 403 forbidden/ban sticks as auth_failed', () => {
  it('a single Cloudflare IP-ban 403 sticks as auth_failed', () => {
    const hub = getProviderOperabilityHub();
    const key = 'forbidden-403-ipban';
    hub.recordExecution(
      key,
      false,
      403,
      'routeway chat completion failed: HTTP 403 Access denied | Error 1006 | The owner of this website has banned your IP address',
    );
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
  });

  it('a bare 403 with no message still sticks as auth_failed (forbidden)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'forbidden-403-bare';
    hub.recordExecution(key, false, 403);
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
  });

  it('a credit-worded 403 still classifies as no_credits (credit path unchanged)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'forbidden-403-credit';
    hub.recordExecution(key, false, 403, 'HTTP 403: insufficient credit balance, please top up');
    expect(hub.getProviderState(key).operabilityState).toBe('no_credits');
  });

  it('a real execution success heals the ban (self-heals on recovery)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'forbidden-403-heal';
    hub.recordExecution(key, false, 403, 'access denied — banned');
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
    hub.recordExecution(key, true);
    hub.recordExecution(key, true);
    hub.recordExecution(key, true);
    expect(['recovering', 'healthy']).toContain(hub.getProviderState(key).operabilityState);
  });
});
