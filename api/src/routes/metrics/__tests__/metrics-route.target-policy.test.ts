// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OPS-001a: the strategy target-policy decision counters are SCRAPED series —
 * after real policy decisions flow through evaluateTargetPolicy, GET /metrics
 * (the existing Prometheus endpoint, real registry — no stub here, unlike
 * metrics-route.auth.test.ts) must expose them. This is the scrape-path half
 * of the contract; the increment semantics live in
 * strategy-target-policy.test.ts (OPS-001a describe block).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTenantEntitlements = vi.fn();

vi.mock('@/services/billing-entitlements-client', () => ({
  resolveTenantEntitlements: (...args: unknown[]) => resolveTenantEntitlements(...args),
}));

vi.mock('@/config', () => ({
  config: { observability: { prometheusToken: undefined } },
}));

import { evaluateTargetPolicy } from '@/services/strategy-target-policy';
import { recordTargetPolicyDecision } from '@/utils/metrics';

async function buildServer(): Promise<FastifyInstance> {
  const { registerMetricsRoute } = await import('../metrics-route');
  const server = Fastify();
  await registerMetricsRoute(server);
  await server.ready();
  return server;
}

describe('GET /metrics exposes the target-policy decision series (OPS-001a)', () => {
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    resolveTenantEntitlements.mockReset();
    resolveTenantEntitlements.mockResolvedValue({
      entitlements: { tenantId: 'org-1', planId: 'professional', source: 'subscription', limits: {} },
      basis: 'fresh',
    });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('includes decisions + shadow_would_deny series after policy decisions', async () => {
    // The shadow_would_deny series is recorded directly: at launch the deny
    // matrix is EMPTY (A3 default-allow), so no (planId, family) evaluates to
    // a would-be deny — routing this through evaluateTargetPolicy only passed
    // locally via cross-file registry pollution, and failed on a clean CI
    // worker. The gate→metrics wiring for the plain allow path still goes
    // through the real evaluateTargetPolicy.
    recordTargetPolicyDecision({
      decision: 'shadow_would_deny',
      mode: 'shadow',
      basis: 'fresh',
      familyRisk: 'high',
    });
    await evaluateTargetPolicy('org-1', 'best');

    server = await buildServer();
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ailin_dev_target_policy_decisions_total');
    expect(res.body).toContain('ailin_dev_target_policy_shadow_would_deny_total');
    expect(res.body).toContain('decision="shadow_would_deny"');
    expect(res.body).toContain('decision="allow"');
  });
});
