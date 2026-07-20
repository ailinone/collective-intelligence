// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Camada 1a — persisted operability overlay.
 *
 * The hub is otherwise in-memory and resets to "unknown" on every restart,
 * which is the root of the canary's "0 distinct healthy providers" right after a
 * deploy. The overlay lets a restarted process remember the last-known state —
 * WITHOUT pinning anything (runtime always wins; the overlay expires per-state).
 */
import { describe, it, expect } from 'vitest';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';

const hub = getProviderOperabilityHub();
const future = (): number => Date.now() + 60_000;
const past = (): number => Date.now() - 1_000;

describe('operability hub — persisted overlay (Camada 1a)', () => {
  it('supplies the last-known state when there are no runtime events', () => {
    hub.setPersistedOverlayForTesting('p1a-healthy', 'healthy', 'operational', future());
    const r = hub.getProviderState('p1a-healthy');
    expect(r.operabilityState).toBe('healthy');
    expect(r.operabilityReasonCode).toBe('persisted_operational');
  });

  it('remembers no_credits across a simulated restart (overlay rehydrated)', () => {
    hub.setPersistedOverlayForTesting('p1a-credits', 'no_credits', 'runtime_credit_error', future());
    const r = hub.getProviderState('p1a-credits');
    expect(r.operabilityState).toBe('no_credits');
    expect(r.balanceStatus).toBe('no_credits');
  });

  it('expired overlay falls through to unknown (proven operability must be re-proven)', () => {
    hub.setPersistedOverlayForTesting('p1a-expired', 'auth_failed', 'runtime_auth_error', past());
    expect(hub.getProviderState('p1a-expired').operabilityState).toBe('unknown');
  });

  it('a fresh runtime event takes precedence over the overlay', () => {
    hub.setPersistedOverlayForTesting('p1a-runtime', 'auth_failed', 'runtime_auth_error', future());
    hub.recordExecution('p1a-runtime', true, 200); // live success must win
    expect(hub.getProviderState('p1a-runtime').operabilityState).toBe('healthy');
  });

  it('no overlay + no events still yields unknown (unchanged baseline)', () => {
    expect(hub.getProviderState('p1a-never-seen').operabilityState).toBe('unknown');
  });

  it('startPersistence is idempotent and unref-safe (no throw)', () => {
    expect(() => { hub.startPersistence(999_999); hub.startPersistence(999_999); hub.stopPersistence(); }).not.toThrow();
  });
});

describe('operability hub — probe→hub bridge (Camada 1b)', () => {
  it('healthy probe → healthy state', () => {
    hub.recordProbeResult('p1b-ok', 'healthy');
    expect(hub.getProviderState('p1b-ok').operabilityState).toBe('healthy');
  });

  it('auth_failed probe → auth_failed state', () => {
    hub.recordProbeResult('p1b-auth', 'auth_failed', 'invalid key');
    expect(hub.getProviderState('p1b-auth').operabilityState).toBe('auth_failed');
  });

  it('insufficient_credit probe → no_credits state', () => {
    hub.recordProbeResult('p1b-credit', 'insufficient_credit', 'balance exhausted');
    const r = hub.getProviderState('p1b-credit');
    expect(r.operabilityState).toBe('no_credits');
    expect(r.balanceStatus).toBe('no_credits');
  });

  it('unknown probe is a no-op (never masks absence of data)', () => {
    hub.recordProbeResult('p1b-unknown', 'unknown');
    expect(hub.getProviderState('p1b-unknown').operabilityState).toBe('unknown');
  });

  // Note: probe events carry the same weight as execution events, so a later
  // runtime signal overrides a probe at realistic (seconds-apart) timing. We do
  // not unit-test that here because synchronous same-millisecond recording ties
  // the timestamps — an artifact of the test harness, not a production behaviour.
});

describe('operability hub — credit-error classification (2026-06-29)', () => {
  it('classifies Anthropic-style HTTP 400 "credit balance is too low" as no_credits', () => {
    // Anthropic signals credit exhaustion with HTTP 400 (not 402/403). A
    // status-only gate misclassified it as unknown → the provider was re-picked
    // every cold start. The message path must catch it.
    hub.recordExecution(
      'cred-anthropic-400',
      false,
      400,
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    );
    expect(hub.getProviderState('cred-anthropic-400').operabilityState).toBe('no_credits');
  });

  it('still classifies the classic HTTP 402 insufficient-balance as no_credits', () => {
    hub.recordExecution('cred-402', false, 402, 'insufficient balance, please top up');
    expect(hub.getProviderState('cred-402').operabilityState).toBe('no_credits');
  });

  it('does NOT misclassify a generic HTTP 400 as a credit error', () => {
    hub.recordExecution('cred-generic-400', false, 400, 'bad request: invalid parameter "foo"');
    expect(hub.getProviderState('cred-generic-400').operabilityState).not.toBe('no_credits');
  });
});
