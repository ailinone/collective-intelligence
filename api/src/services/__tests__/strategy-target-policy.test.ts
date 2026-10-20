// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-target-policy.test.ts — the A3 gate (ENT-001 Phase 1).
 *
 * Implements the 10-test matrix of a3-deny-matrix-design.md §8 EXACTLY —
 * that matrix IS the blocker's gate. Hermetic: no Redis, no network, no
 * billing — `resolveTenantEntitlements` (the client's availability-aware
 * resolution API) is mocked to return the fresh/stale/unavailable basis each
 * scenario needs, mirroring what the real client returns under the
 * corresponding Billing state.
 *
 * Note on test #1: the SHIPPED matrix is empty (the resolved Phase 1
 * commercial decision — default-allow + telemetry, design §9), so the
 * matrix_deny path is exercised through the module's documented test hook
 * (`__setPlanFamilyMatrixForTests`) — which is also exactly how Phase 2 will
 * rehearse matrix entries before configuring them for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTenantEntitlements = vi.fn();

vi.mock('@/services/billing-entitlements-client', () => ({
  // Name-shape parity with the real module (the policy imports only this).
  resolveTenantEntitlements: (...args: unknown[]) => resolveTenantEntitlements(...args),
}));

import {
  decideTargetAccess,
  evaluateTargetPolicy,
  evaluateTargetPolicyGate,
  isLowRiskFamily,
  targetPolicyDenyBody,
  __resetPlanFamilyMatrixForTests,
  __setPlanFamilyMatrixForTests,
  __resetTargetPolicyCountersForTests,
} from '@/services/strategy-target-policy';
import { assertTargetPolicyBootConfiguration } from '@/services/strategy-family';

const ORG = 'org-1';

/** A POST-normalization composite request (`best:medium`): the SERVER-SET
 * tier carrier is what makes the gate fire at all. */
const composite = {
  ailin_tier: 'medium',
  ailin_tier_rate: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
  ailin_alias: 'best:medium',
  strategy: 'quality-multipass',
  model: 'auto',
};

/** A legacy preset (`ailin-best`): alias resolved, NO tier carrier. */
const legacyPreset = {
  ailin_alias: 'ailin-best',
  strategy: 'quality-multipass',
  model: 'auto',
};

function fresh(planId: string | null, source: 'subscription' | 'fallback_sandbox' = 'subscription') {
  return resolveTenantEntitlements.mockResolvedValue({
    entitlements: planId === null ? null : { tenantId: ORG, planId, source, limits: {} },
    basis: 'fresh',
  });
}
function stale(planId: string) {
  return resolveTenantEntitlements.mockResolvedValue({
    entitlements: { tenantId: ORG, planId, source: 'subscription', limits: {} },
    basis: 'stale',
  });
}
function unavailable() {
  return resolveTenantEntitlements.mockResolvedValue({
    entitlements: null,
    basis: 'unavailable',
  });
}

beforeEach(() => {
  resolveTenantEntitlements.mockReset();
  __resetPlanFamilyMatrixForTests();
  __resetTargetPolicyCountersForTests();
  delete process.env.TARGET_POLICY_MODE;
  delete process.env.TARGET_POLICY_ALERT_DENY_RATE;
});

// ── §8 #1: matrix deny → structured deny; NO wallet hold (gate-order) ──────
describe('§8 #1 — matrix deny returns the structured deny and precedes the wallet gate', () => {
  it('returns allowed:false with the exact structured deny shape', async () => {
    // Deny-path tests pin ENFORCE (shadow — the deploy default — would log the
    // would-be deny and allow, which §8 #8 covers on its own).
    process.env.TARGET_POLICY_MODE = 'enforce';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision).toEqual({
      allowed: false,
      reason: 'matrix_deny',
      planId: 'professional',
      basis: 'fresh',
    });

    const body = targetPolicyDenyBody(decision, 'best');
    expect(body).toEqual({
      code: 'target_policy_denied',
      family: 'best',
      planId: 'professional',
      reason: 'matrix_deny',
      message: expect.any(String),
    });
  });

  it('the chat route runs the policy BEFORE gateChatRequest (gate-order, source-level)', async () => {
    // Behavioral booting of /v1/chat/completions is out of scope here (it
    // needs the full provider stack); the ORDER is the load-bearing property
    // (a denied target must never create a hold), so pin it at the source
    // level with positive anchors — the house pattern of
    // orchestration-gate-wallet-exclusion.test.ts.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../routes/chat/chat-routes.ts', import.meta.url));
    const code = readFileSync(path, 'utf8');

    expect(code).toContain('evaluateTargetPolicyGate');
    // Per-user billing (#720): the wallet hold runs against the END USER's
    // org when the billing path resolved one — the pin follows the call site.
    expect(code).toContain(
      'gateChatRequest(billingOrganizationId ?? organizationId, chatRequest)'
    );
    // The policy call site must precede the wallet-gate call site...
    const policyAt = code.indexOf('evaluateTargetPolicyGate(organizationId, chatRequest)');
    const walletAt = code.indexOf(
      'await gateChatRequest(billingOrganizationId ?? organizationId, chatRequest)'
    );
    expect(policyAt).toBeGreaterThan(-1);
    expect(walletAt).toBeGreaterThan(policyAt);
    // ...and the wallet gate must NOT be evaluated inside the quota/governance
    // Promise.all anymore (it moved out so the policy can run first).
    const quotaAllStart = code.indexOf(
      'const [quotaCheck, governanceDecision] = await Promise.all(['
    );
    expect(quotaAllStart).toBeGreaterThan(-1);
    const between = code.slice(quotaAllStart, policyAt);
    expect(between).toContain('evaluateGovernance');
    // Call-site pattern, not the bare name (comments legitimately mention the
    // gate; no CALL may sit inside the quota/governance Promise.all block).
    expect(between).not.toContain('gateChatRequest(organizationId');
    // The deny path returns before the wallet gate line could run (the 403
    // block sits between policy and wallet). The structured
    // `target_policy_denied` body itself lives in the policy module — pinned
    // there; the route's block is pinned on the early-return send.
    const policySource = readFileSync(
      fileURLToPath(new URL('../strategy-target-policy.ts', import.meta.url)),
      'utf8'
    );
    expect(policySource).toContain("code: 'target_policy_denied'");
    const policyBlock = code.slice(policyAt, walletAt);
    expect(policyBlock).toContain('reply.status(targetPolicy.status).send(targetPolicy.body)');
  });
});

// ── §8 #2: matrix allow → passes through; decision logged ──────────────────
describe('§8 #2 — matrix allow passes through', () => {
  it('reports matrix_allow with the matched planId and basis fresh', async () => {
    __setPlanFamilyMatrixForTests({ professional: { best: true } });
    fresh('professional');

    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision).toEqual({
      allowed: true,
      reason: 'matrix_allow',
      planId: 'professional',
      basis: 'fresh',
    });
  });
});

// ── §8 #3: unknown planId → DEFAULT applies (no crash, no implicit deny) ───
describe('§8 #3 — unknown planId falls back to DEFAULT (no implicit deny)', () => {
  it('default-allows every family for a planId absent from the matrix', async () => {
    fresh('brand-new-plan');

    for (const family of [
      'auto',
      'best',
      'fast',
      'economy',
      'single',
      'parallel',
      'consensus',
      'expert-panel',
    ] as const) {
      const decision = await evaluateTargetPolicy(ORG, family);
      expect(decision.allowed, family).toBe(true);
      expect(decision.reason, family).toBe('default_allow');
    }
  });

  it('treats a null planId (billing answered without one) the same way', async () => {
    fresh(null);
    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('default_allow');
    expect(decision.planId).toBeNull();
  });
});

// ── §8 #4: billing outage + stale present → stale_allow (BOTH classes) ─────
describe('§8 #4 — outage with a stale snapshot decides on the stale planId', () => {
  it('low-risk family: stale_allow on the stale planId', async () => {
    stale('professional');
    const decision = await evaluateTargetPolicy(ORG, 'auto');
    expect(decision).toEqual({
      allowed: true,
      reason: 'stale_allow',
      planId: 'professional',
      basis: 'stale',
    });
  });

  it('high-risk family: stale_allow on the stale planId too', async () => {
    stale('professional');
    const decision = await evaluateTargetPolicy(ORG, 'expert-panel');
    expect(decision).toEqual({
      allowed: true,
      reason: 'stale_allow',
      planId: 'professional',
      basis: 'stale',
    });
  });

  it('a matrix DENY is not softened by being stale (deny keeps matrix_deny)', async () => {
    process.env.TARGET_POLICY_MODE = 'enforce'; // deny paths pin enforce (see §8 #1)
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    stale('professional');
    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('matrix_deny');
    expect(decision.basis).toBe('stale');
  });
});

// ── §8 #5: outage + no stale + low-risk → allow (platform default chat) ────
describe('§8 #5 — outage, no stale, low-risk family allows', () => {
  it.each(['auto', 'best', 'fast', 'economy', 'single'] as const)(
    '%s allows with unavailable_low_risk_default and null planId',
    async (family) => {
      unavailable();
      const decision = await evaluateTargetPolicy(ORG, family);
      expect(decision).toEqual({
        allowed: true,
        reason: 'unavailable_low_risk_default',
        planId: null,
        basis: 'unavailable',
      });
      expect(isLowRiskFamily(family)).toBe(true);
    }
  );
});

// ── §8 #6: outage + no stale + high-risk → deny (Phase 2 readiness) ────────
describe('§8 #6 — outage, no stale, high-risk family denies (no free first fan-out)', () => {
  beforeEach(() => {
    // Deny-path tests pin ENFORCE (shadow converts to shadow_would_deny — §8 #8).
    process.env.TARGET_POLICY_MODE = 'enforce';
  });

  it.each(['parallel', 'consensus', 'expert-panel'] as const)(
    '%s denies with unavailable_deny',
    async (family) => {
      unavailable();
      const decision = await evaluateTargetPolicy(ORG, family);
      expect(decision).toEqual({
        allowed: false,
        reason: 'unavailable_deny',
        planId: null,
        basis: 'unavailable',
      });
      expect(isLowRiskFamily(family)).toBe(false);
    }
  );
});

// ── §8 #7: enforce + unconfigured credentials → boot refusal ───────────────
describe('§8 #7 — enforce mode with missing billing credentials refuses to boot', () => {
  it.each([
    ['both missing', {}],
    ['only BILLING_SERVICE_URL set', { BILLING_SERVICE_URL: 'https://billing.internal' }],
    [
      'only BILLING_API_SECRET_KEY set',
      { BILLING_API_SECRET_KEY: 'secret' },
    ],
  ])('%s → throws naming the missing variable(s)', (_label, env) => {
    expect(() =>
      assertTargetPolicyBootConfiguration({ TARGET_POLICY_MODE: 'enforce', ...env })
    ).toThrow(/TARGET_POLICY_MODE=enforce requires billing credentials/);
  });

  it('shadow and off modes boot fine without credentials (safe defaults)', () => {
    expect(() =>
      assertTargetPolicyBootConfiguration({ TARGET_POLICY_MODE: 'shadow' })
    ).not.toThrow();
    expect(() =>
      assertTargetPolicyBootConfiguration({ TARGET_POLICY_MODE: 'off' })
    ).not.toThrow();
    // Mode absent → shadow default → boots.
    expect(() => assertTargetPolicyBootConfiguration({})).not.toThrow();
  });

  it('validateConfig aggregates the refusal (config/index.ts wiring)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../config/index.ts', import.meta.url));
    const code = readFileSync(path, 'utf8');
    expect(code).toContain('assertTargetPolicyBootConfiguration');
    expect(code).toContain('assertTargetPolicyBootConfiguration()');
  });
});

// ── §8 #8: shadow mode logs the would-be deny and ALLOWS ───────────────────
describe('§8 #8 — shadow mode never denies', () => {
  it('converts a matrix deny into shadow_would_deny + allow', async () => {
    process.env.TARGET_POLICY_MODE = 'shadow';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('shadow_would_deny');
    expect(decision.planId).toBe('professional');
  });

  it('converts an outage deny (high-risk) into shadow_would_deny + allow too', async () => {
    process.env.TARGET_POLICY_MODE = 'shadow';
    unavailable();
    const decision = await evaluateTargetPolicy(ORG, 'expert-panel');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('shadow_would_deny');
  });

  it('enforce mode returns the real deny unchanged', async () => {
    process.env.TARGET_POLICY_MODE = 'enforce';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const decision = await evaluateTargetPolicy(ORG, 'best');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('matrix_deny');
  });

  it('off mode is compute-free: never consults entitlements', async () => {
    process.env.TARGET_POLICY_MODE = 'off';
    const decision = await evaluateTargetPolicy(ORG, 'expert-panel');
    expect(decision.allowed).toBe(true);
    expect(resolveTenantEntitlements).not.toHaveBeenCalled();
  });
});

// ── §8 #9: malformed billing body → unavailable path (no partial trust) ────
describe('§8 #9 — malformed billing data lands on the unavailable path', () => {
  it('a null/undefined payload with basis unavailable follows the risk-class table', async () => {
    unavailable();
    const lowRisk = await decideTargetAccess(ORG, 'fast');
    expect(lowRisk.allowed).toBe(true);
    expect(lowRisk.reason).toBe('unavailable_low_risk_default');

    unavailable();
    const highRisk = await decideTargetAccess(ORG, 'consensus');
    expect(highRisk.allowed).toBe(false);
    expect(highRisk.reason).toBe('unavailable_deny');
  });

  it('never trusts a planId outside a well-formed entitlements object', async () => {
    // The real client's parseEntitlements drops malformed shapes to null
    // (billing-entitlements-client.ts) — which resolveTenantEntitlements
    // reports as basis 'unavailable'. The policy sees NO planId, i.e. no
    // partial trust.
    resolveTenantEntitlements.mockResolvedValue({
      entitlements: null,
      basis: 'unavailable',
    });
    const decision = await decideTargetAccess(ORG, 'best');
    expect(decision.planId).toBeNull();
    expect(decision.basis).toBe('unavailable');
  });
});

// ── Guardrails: non-composite targets never reach the policy ───────────────
describe('guardrail #3 — the gate never fires for non-composite targets', () => {
  it.each([
    ['legacy preset (ailin-best)', legacyPreset],
    ['raw provider id', { model: 'gpt-4o-mini' }],
    ['literal auto', { model: 'auto' }],
    ['absent model', {}],
    [
      'client-injected alias WITHOUT the server tier carrier',
      { model: 'gpt-4o-mini', ailin_alias: 'expert-panel:extra' },
    ],
  ])('%s is a no-op (applied:false, no billing call)', async (_label, req) => {
    const result = await evaluateTargetPolicyGate(ORG, req);
    expect(result).toEqual({ applied: false, allowed: true });
    expect(resolveTenantEntitlements).not.toHaveBeenCalled();
  });

  it('a composite target goes through and (default policy) is allowed', async () => {
    fresh('professional');
    const result = await evaluateTargetPolicyGate(ORG, composite);
    expect(result.applied).toBe(true);
    expect(result.allowed).toBe(true);
    expect(resolveTenantEntitlements).toHaveBeenCalledTimes(1);
    if (result.applied) {
      expect(result.family).toBe('best');
    }
  });

  it('an enforce-mode deny of a composite returns the structured 403 payload', async () => {
    process.env.TARGET_POLICY_MODE = 'enforce';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const result = await evaluateTargetPolicyGate(ORG, composite);
    expect(result.applied).toBe(true);
    expect(result.allowed).toBe(false);
    if (!result.allowed && result.applied) {
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('target_policy_denied');
      expect(result.body.family).toBe('best');
      expect(result.body.planId).toBe('professional');
    }
  });
});

// ── Deny-rate alert surface (design §6, TARGET_POLICY_ALERT_DENY_RATE) ─────
describe('deny-rate counters (OPS-001 alert source)', () => {
  it('counts evaluations and denies', async () => {
    process.env.TARGET_POLICY_ALERT_DENY_RATE = '0.5';
    unavailable();
    await evaluateTargetPolicy(ORG, 'consensus'); // deny (high-risk)
    unavailable();
    await evaluateTargetPolicy(ORG, 'fast'); // allow (low-risk)

    const counters = (
      await import('@/services/strategy-target-policy')
    ).targetPolicyCountersForTests();
    expect(counters.evaluations).toBe(2);
    expect(counters.denies).toBe(1);
  });
});

// ── OPS-001a: the decision as a Prometheus series, not just a log line ──────
describe('OPS-001a — Prometheus decision counters (utils/metrics)', () => {
  // The registry is global and persists across this file's tests, so every
  // assertion is a DELTA: snapshot the matching series before the decision,
  // re-snapshot after, expect +1 on exactly the label set the decision kind
  // implies (and nothing else).

  async function snapshot(counterName: 'decisions' | 'shadow'): Promise<Map<string, number>> {
    const metrics = await import('@/utils/metrics');
    const counter =
      counterName === 'decisions' ? metrics.targetPolicyDecisions : metrics.targetPolicyShadowWouldDeny;
    const { values } = await counter.get();
    return new Map(values.map((v) => [JSON.stringify(v.labels), v.value]));
  }

  function deltaOf(before: Map<string, number>, after: Map<string, number>, labels: unknown): number {
    const key = JSON.stringify(labels);
    return (after.get(key) ?? 0) - (before.get(key) ?? 0);
  }

  it('a shadow-mode would-be deny records decision="shadow_would_deny" and bumps the dedicated alert series', async () => {
    process.env.TARGET_POLICY_MODE = 'shadow';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const decisionsBefore = await snapshot('decisions');
    const shadowBefore = await snapshot('shadow');

    await evaluateTargetPolicy(ORG, 'best');

    expect(
      deltaOf(decisionsBefore, await snapshot('decisions'), {
        decision: 'shadow_would_deny',
        mode: 'shadow',
        basis: 'fresh',
        family_risk: 'low',
      })
    ).toBe(1);
    expect((await snapshot('shadow')).get('{}') ?? 0).toBe((shadowBefore.get('{}') ?? 0) + 1);
  });

  it('an allow records decision="allow" and leaves the alert series untouched', async () => {
    fresh('professional');

    const decisionsBefore = await snapshot('decisions');
    const shadowBefore = await snapshot('shadow');

    await evaluateTargetPolicy(ORG, 'best');

    expect(
      deltaOf(decisionsBefore, await snapshot('decisions'), {
        decision: 'allow',
        mode: 'shadow', // TARGET_POLICY_MODE unset → the shadow default
        basis: 'fresh',
        family_risk: 'low',
      })
    ).toBe(1);
    expect(await snapshot('shadow')).toEqual(shadowBefore);
  });

  it('an enforce-mode deny records decision="deny" (never shadow_would_deny)', async () => {
    process.env.TARGET_POLICY_MODE = 'enforce';
    __setPlanFamilyMatrixForTests({ professional: { best: false } });
    fresh('professional');

    const decisionsBefore = await snapshot('decisions');
    const shadowBefore = await snapshot('shadow');

    await evaluateTargetPolicy(ORG, 'best');

    expect(
      deltaOf(decisionsBefore, await snapshot('decisions'), {
        decision: 'deny',
        mode: 'enforce',
        basis: 'fresh',
        family_risk: 'low',
      })
    ).toBe(1);
    expect(await snapshot('shadow')).toEqual(shadowBefore);
  });

  it('the outage path carries basis="unavailable" and the high-risk class', async () => {
    process.env.TARGET_POLICY_MODE = 'enforce';
    unavailable();

    const decisionsBefore = await snapshot('decisions');

    await evaluateTargetPolicy(ORG, 'expert-panel'); // high-risk: unavailable_deny

    expect(
      deltaOf(decisionsBefore, await snapshot('decisions'), {
        decision: 'deny',
        mode: 'enforce',
        basis: 'unavailable',
        family_risk: 'high',
      })
    ).toBe(1);
  });

  it('mode off is silent on the wire (compute-free by design)', async () => {
    process.env.TARGET_POLICY_MODE = 'off';

    const decisionsBefore = await snapshot('decisions');
    const shadowBefore = await snapshot('shadow');

    await evaluateTargetPolicy(ORG, 'expert-panel');

    expect(await snapshot('decisions')).toEqual(decisionsBefore);
    expect(await snapshot('shadow')).toEqual(shadowBefore);
  });
});
