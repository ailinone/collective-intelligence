// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the shared orchestration admission gate.
 *
 * The properties that matter most here are the SAFE ones: that the default
 * configuration cannot deny anything, that a database fault cannot turn into a
 * 500, and that a request with no tenant is passed through rather than blocked.
 * Those are what make wiring this into three live production routes a
 * non-regressive change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { checkQuotaMock, evaluateGovernanceMock, recordSecurityEventMock } = vi.hoisted(() => ({
  checkQuotaMock: vi.fn(),
  evaluateGovernanceMock: vi.fn(),
  recordSecurityEventMock: vi.fn(),
}));

vi.mock('@/services/quota-service', () => ({ checkQuota: checkQuotaMock }));
vi.mock('@/services/org-governance-service', () => ({
  evaluateGovernance: evaluateGovernanceMock,
}));
vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

const {
  evaluateOrchestrationGate,
  resolveGateMode,
  resolveMeteringMode,
  resolveUsageAccounting,
  DEFAULT_GATE_MODE,
  DEFAULT_METERING_MODE,
  __resetOrchestrationGateCaches,
} = await import('../orchestration-gate');

const ALLOWED_QUOTA = { allowed: true, remaining: { requests: 100 }, resetAt: '2026-09-01' };
const DENIED_QUOTA = {
  allowed: false,
  reason: 'Quota limits exceeded',
  remaining: { requests: -1 },
  resetAt: '2026-09-01',
};
const ALLOW_GOVERNANCE = { allowed: true };

function input(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    endpoint: '/v1/responses',
    requestId: 'req-1',
    model: 'gpt-4o',
    strategy: 'single',
    ...overrides,
  } as Parameters<typeof evaluateOrchestrationGate>[0];
}

describe('orchestration gate', () => {
  beforeEach(() => {
    checkQuotaMock.mockReset().mockResolvedValue(ALLOWED_QUOTA);
    evaluateGovernanceMock.mockReset().mockResolvedValue(ALLOW_GOVERNANCE);
    recordSecurityEventMock.mockReset().mockResolvedValue(undefined);
    vi.unstubAllEnvs();
    // The governance decision is cached per process for a short TTL. Every case
    // below reuses `org-1`, so without this a verdict leaks into the next test.
    __resetOrchestrationGateCaches();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetOrchestrationGateCaches();
  });

  // ── Mode resolution ────────────────────────────────────────────────────────

  describe('resolveGateMode', () => {
    it('defaults to shadow — the safe value, which cannot deny', () => {
      expect(DEFAULT_GATE_MODE).toBe('shadow');
      expect(resolveGateMode('/v1/responses')).toBe('shadow');
    });

    it('falls back to shadow for an unparseable mode rather than enforcing', () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'ENFORCE-ish typo');
      expect(resolveGateMode('/v1/responses')).toBe('shadow');
    });

    it('accepts off / shadow / enforce case-insensitively', () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'OFF');
      expect(resolveGateMode('/v1/responses')).toBe('off');
      vi.stubEnv('ORCHESTRATION_GATE_MODE', ' Enforce ');
      expect(resolveGateMode('/v1/responses')).toBe('enforce');
    });

    it('upgrades only the allowlisted endpoint to enforce (per-route rollout)', () => {
      vi.stubEnv('ORCHESTRATION_GATE_ENFORCE_ENDPOINTS', '/v1/chat/completions/ultra-thinking');
      expect(resolveGateMode('/v1/chat/completions/ultra-thinking')).toBe('enforce');
      expect(resolveGateMode('/v1/responses')).toBe('shadow');
    });

    it('tolerates whitespace and empty entries in the allowlist', () => {
      vi.stubEnv('ORCHESTRATION_GATE_ENFORCE_ENDPOINTS', ' /v1/responses , ,');
      expect(resolveGateMode('/v1/responses')).toBe('enforce');
    });

    it('supports * to enforce everywhere', () => {
      vi.stubEnv('ORCHESTRATION_GATE_ENFORCE_ENDPOINTS', '*');
      expect(resolveGateMode('/v1/chat/completions/extended-thinking')).toBe('enforce');
    });

    it('lets off win over the allowlist — off is the incident kill switch', () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'off');
      vi.stubEnv('ORCHESTRATION_GATE_ENFORCE_ENDPOINTS', '*');
      expect(resolveGateMode('/v1/responses')).toBe('off');
    });
  });

  // ── Flag-off no-op ─────────────────────────────────────────────────────────

  describe('mode=off is a true no-op', () => {
    it('allows without issuing any gate query at all', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'off');

      const result = await evaluateOrchestrationGate(input());

      expect(result).toEqual({ allowed: true });
      expect(checkQuotaMock).not.toHaveBeenCalled();
      expect(evaluateGovernanceMock).not.toHaveBeenCalled();
    });

    it('allows even when both gates would deny', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'off');
      checkQuotaMock.mockResolvedValue(DENIED_QUOTA);
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'policy_violation',
        message: 'blocked',
      });

      await expect(evaluateOrchestrationGate(input())).resolves.toEqual({ allowed: true });
    });
  });

  // ── Shadow mode ────────────────────────────────────────────────────────────

  describe('mode=shadow evaluates but never denies', () => {
    it('runs the gates and still allows a quota-denied request', async () => {
      checkQuotaMock.mockResolvedValue(DENIED_QUOTA);

      const result = await evaluateOrchestrationGate(input());

      expect(checkQuotaMock).toHaveBeenCalledTimes(1);
      expect(result.allowed).toBe(true);
      expect(result).toMatchObject({
        shadowDenial: { code: 'quota_exceeded', status: 429 },
      });
    });

    it('still allows a governance-denied request and reports the would-be code', async () => {
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'organization_budget_exceeded',
        message: 'over budget',
      });

      const result = await evaluateOrchestrationGate(input());

      expect(result.allowed).toBe(true);
      expect(result).toMatchObject({
        shadowDenial: { code: 'organization_budget_exceeded', status: 403 },
      });
    });

    it('writes no security-audit row for a request it lets through', async () => {
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'policy_violation',
        message: 'blocked model',
      });

      await evaluateOrchestrationGate(input());

      expect(recordSecurityEventMock).not.toHaveBeenCalled();
    });
  });

  // ── Enforce mode / rejection paths ─────────────────────────────────────────

  describe('mode=enforce rejection paths', () => {
    beforeEach(() => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'enforce');
    });

    it('returns the reference route 429 body verbatim on quota denial', async () => {
      checkQuotaMock.mockResolvedValue(DENIED_QUOTA);

      const result = await evaluateOrchestrationGate(input());

      expect(result).toEqual({
        allowed: false,
        status: 429,
        body: {
          error: {
            code: 'quota_exceeded',
            message: 'Quota limits exceeded',
            remaining: { requests: -1 },
            reset_at: '2026-09-01',
          },
        },
      });
    });

    it('falls back to a default message when the quota check gives no reason', async () => {
      checkQuotaMock.mockResolvedValue({ allowed: false });

      const result = await evaluateOrchestrationGate(input());

      expect(result).toMatchObject({
        status: 429,
        body: {
          error: { message: 'Organization quota exceeded for chat completions.' },
        },
      });
    });

    it('returns the reference route 403 body verbatim on governance denial', async () => {
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'organization_budget_exceeded',
        message: 'Organization monthly budget exceeded',
        details: { currentMonthlyCostUsd: 12, maxMonthlyCostUsd: 10 },
      });

      const result = await evaluateOrchestrationGate(input());

      expect(result).toEqual({
        allowed: false,
        status: 403,
        body: {
          error: {
            code: 'organization_budget_exceeded',
            message: 'Organization monthly budget exceeded',
            currentMonthlyCostUsd: 12,
            maxMonthlyCostUsd: 10,
          },
        },
      });
    });

    it('records the budget security event with the endpoint in metadata', async () => {
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'organization_budget_exceeded',
        message: 'over budget',
      });

      await evaluateOrchestrationGate(input({ endpoint: '/v1/responses' }));

      expect(recordSecurityEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'governance.budget.blocked',
          severity: 'warning',
          organizationId: 'org-1',
          userId: 'user-1',
          metadata: expect.objectContaining({
            endpoint: '/v1/responses',
            code: 'organization_budget_exceeded',
            requestedModel: 'gpt-4o',
            requestedStrategy: 'single',
          }),
        })
      );
    });

    it('maps a policy denial to the policy security event type', async () => {
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'policy_violation',
        message: 'model not allowed',
      });

      await evaluateOrchestrationGate(input());

      expect(recordSecurityEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'governance.policy.blocked' })
      );
    });

    it('applies quota BEFORE governance when both deny (pinned precedence)', async () => {
      checkQuotaMock.mockResolvedValue(DENIED_QUOTA);
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'policy_violation',
        message: 'also blocked',
      });

      const result = await evaluateOrchestrationGate(input());

      expect(result).toMatchObject({ status: 429 });
      expect(recordSecurityEventMock).not.toHaveBeenCalled();
    });

    it('allows when both gates allow', async () => {
      await expect(evaluateOrchestrationGate(input())).resolves.toEqual({ allowed: true });
    });
  });

  // ── Fail-open guarantees ───────────────────────────────────────────────────

  describe('fail-open guarantees', () => {
    it('allows when checkQuota throws — a DB hiccup must not become a 500', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'enforce');
      checkQuotaMock.mockRejectedValue(new Error('Prisma connection reset'));

      await expect(evaluateOrchestrationGate(input())).resolves.toEqual({ allowed: true });
    });

    it('still evaluates governance when the quota check throws', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'enforce');
      checkQuotaMock.mockRejectedValue(new Error('boom'));
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'policy_violation',
        message: 'blocked',
      });

      const result = await evaluateOrchestrationGate(input());

      expect(result).toMatchObject({ status: 403 });
    });

    it('allows immediately when there is no organization context', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'enforce');

      const result = await evaluateOrchestrationGate(input({ organizationId: '' }));

      expect(result).toEqual({ allowed: true });
      expect(checkQuotaMock).not.toHaveBeenCalled();
      expect(evaluateGovernanceMock).not.toHaveBeenCalled();
    });
  });

  // ── Gate selection ─────────────────────────────────────────────────────────

  describe('per-call gate selection', () => {
    it('runs both gates by default', async () => {
      await evaluateOrchestrationGate(input());

      expect(checkQuotaMock).toHaveBeenCalledWith(
        'org-1',
        {
          organizationId: 'org-1',
          userId: 'user-1',
          operation: { requests: 1 },
        },
        { createIfMissing: false }
      );
      expect(evaluateGovernanceMock).toHaveBeenCalledWith('org-1', {
        strategy: 'single',
        model: 'gpt-4o',
      });
    });

    it('NEVER lets the quota check create a row — a check must not write', async () => {
      // Shadow mode is sold as a no-op. It has to be one at the storage layer
      // too: `checkQuota`'s default path INSERTs a usage_quotas row when the org
      // has none, which on routes that never touched that table would
      // materialise quota rows for orgs that had none and race on the period
      // unique constraint.
      for (const mode of ['shadow', 'enforce']) {
        checkQuotaMock.mockClear();
        vi.stubEnv('ORCHESTRATION_GATE_MODE', mode);
        await evaluateOrchestrationGate(input());
        expect(checkQuotaMock.mock.calls[0]![2]).toEqual({ createIfMissing: false });
      }
    });

    it('skips a gate that is explicitly disabled', async () => {
      await evaluateOrchestrationGate(input({ gates: { governance: false } }));

      expect(checkQuotaMock).toHaveBeenCalledTimes(1);
      expect(evaluateGovernanceMock).not.toHaveBeenCalled();
    });

    it('cannot deny on a disabled gate', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'enforce');
      checkQuotaMock.mockResolvedValue(DENIED_QUOTA);

      const result = await evaluateOrchestrationGate(input({ gates: { quota: false } }));

      expect(result).toEqual({ allowed: true });
      expect(checkQuotaMock).not.toHaveBeenCalled();
    });
  });

  // ── Metering mode ──────────────────────────────────────────────────────────
  //
  // This is the lever that keeps a metering addition from becoming a rejection
  // change on a DIFFERENT, untouched, already-enforcing route. The default must
  // not move `usage_quotas`.

  describe('metering mode', () => {
    it('defaults to analytics — visibility without moving an enforced counter', () => {
      expect(DEFAULT_METERING_MODE).toBe('analytics');
      expect(resolveMeteringMode()).toBe('analytics');
      expect(resolveUsageAccounting()).toBe('analytics-only');
    });

    it('never emits `full` by default, in any gate mode', () => {
      // The important direction: no combination of the GATE flags can turn the
      // quota counter on. Promotion has to be explicit.
      for (const gateMode of ['shadow', 'enforce', 'off', 'nonsense', '']) {
        vi.stubEnv('ORCHESTRATION_GATE_MODE', gateMode);
        vi.stubEnv('ORCHESTRATION_GATE_ENFORCE_ENDPOINTS', '*');
        expect(resolveUsageAccounting()).not.toBe('full');
      }
    });

    it('promotes to full only on an explicit ORCHESTRATION_METERING_MODE=full', () => {
      vi.stubEnv('ORCHESTRATION_METERING_MODE', 'full');
      expect(resolveMeteringMode()).toBe('full');
      expect(resolveUsageAccounting()).toBe('full');
    });

    it('ORCHESTRATION_GATE_MODE=off is a kill switch for the metering too', () => {
      // One incident lever. An operator reaching for `off` should not also have
      // to know a second variable exists.
      vi.stubEnv('ORCHESTRATION_METERING_MODE', 'full');
      vi.stubEnv('ORCHESTRATION_GATE_MODE', 'off');
      expect(resolveMeteringMode()).toBe('off');
      expect(resolveUsageAccounting()).toBeUndefined();
    });

    it('falls back to analytics for an unparseable value rather than full', () => {
      vi.stubEnv('ORCHESTRATION_METERING_MODE', 'FULL-ish typo');
      expect(resolveMeteringMode()).toBe('analytics');
    });

    it('accepts values case-insensitively and with whitespace', () => {
      vi.stubEnv('ORCHESTRATION_METERING_MODE', ' FULL ');
      expect(resolveMeteringMode()).toBe('full');
      vi.stubEnv('ORCHESTRATION_METERING_MODE', 'Off');
      expect(resolveMeteringMode()).toBe('off');
    });
  });

  // ── Governance micro-cache ─────────────────────────────────────────────────

  describe('governance decision cache', () => {
    it('does not re-query governance for a repeat of the same org/model/strategy', async () => {
      // `evaluateGovernance` costs an org lookup AND, for any org with a budget,
      // a month-to-date SUM over request_logs. This gate adds that to three
      // routes at default flags, one of them on a streaming TTFB path.
      await evaluateOrchestrationGate(input());
      await evaluateOrchestrationGate(input());
      await evaluateOrchestrationGate(input());

      expect(evaluateGovernanceMock).toHaveBeenCalledTimes(1);
      // The quota leg is NOT cached — it is the counter that actually moves.
      expect(checkQuotaMock).toHaveBeenCalledTimes(3);
    });

    it('keys on model and strategy, so one verdict cannot answer for another', async () => {
      await evaluateOrchestrationGate(input());
      await evaluateOrchestrationGate(input({ model: 'claude-sonnet-4' }));
      await evaluateOrchestrationGate(input({ strategy: 'best' }));

      expect(evaluateGovernanceMock).toHaveBeenCalledTimes(3);
    });

    it('keys on organization, so one tenant cannot answer for another', async () => {
      await evaluateOrchestrationGate(input());
      await evaluateOrchestrationGate(input({ organizationId: 'org-2' }));

      expect(evaluateGovernanceMock).toHaveBeenCalledTimes(2);
    });

    it('can be disabled outright with a 0 TTL', async () => {
      vi.stubEnv('ORCHESTRATION_GATE_GOVERNANCE_CACHE_MS', '0');

      await evaluateOrchestrationGate(input());
      await evaluateOrchestrationGate(input());

      expect(evaluateGovernanceMock).toHaveBeenCalledTimes(2);
    });

    it('still logs a shadow denial on every request, not just the uncached one', async () => {
      // The cache must not deflate `orchestration_gate.shadow_denial`, which is
      // the enforcement-readiness signal. Caching the DECISION is fine; caching
      // the log line would silently make the metric read clean.
      evaluateGovernanceMock.mockResolvedValue({
        allowed: false,
        code: 'organization_budget_exceeded',
        message: 'over budget',
      });

      const first = await evaluateOrchestrationGate(input());
      const second = await evaluateOrchestrationGate(input());

      expect(evaluateGovernanceMock).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({
        allowed: true,
        shadowDenial: { code: 'organization_budget_exceeded', status: 403 },
      });
      expect(second).toMatchObject({
        allowed: true,
        shadowDenial: { code: 'organization_budget_exceeded', status: 403 },
      });
    });
  });
});
