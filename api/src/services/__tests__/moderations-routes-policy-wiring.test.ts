// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level wiring tests for the custom-moderation-policy surface
 * (F3/F1 §P6) — exercised through a real Fastify instance via `server.inject`.
 *
 * These complement the pure-logic coverage in moderation-policy-service.test.ts
 * by asserting the HTTP glue:
 *   - CRUD endpoints map service results → status codes (201 / 200 / 404 / 409);
 *   - tenant scoping: a cross-tenant policy_id / get / delete returns 404;
 *   - POST /v1/moderations with policy_id applies the policy (changes flagged);
 *   - POST /v1/moderations WITHOUT policy_id is byte-for-byte the base result
 *     (the policy service apply path is never touched);
 *   - action block vs flag flows through to the response.
 *
 * Lives under src/services/__tests__ (NOT src/routes/**​/__tests__) so it is
 * picked up by vitest.ci.config.ts, which excludes the route __tests__ dir.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Auth + tenant middleware: inject a fixed org context, no real auth ─────────
const TEST_ORG = 'org-under-test';

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn(async (request: FastifyRequest) => {
    (request as unknown as { organizationId: string; userId: string }).organizationId = TEST_ORG;
    (request as unknown as { organizationId: string; userId: string }).userId = 'user-1';
  }),
}));

vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => async (request: FastifyRequest) => {
    (request as unknown as { tenantContext: { organizationId: string; userId: string } }).tenantContext = {
      organizationId: TEST_ORG,
      userId: 'user-1',
    };
  },
}));

vi.mock('@/utils/orchestration-context', () => ({
  createOrchestrationContext: () => ({ organizationId: TEST_ORG, userId: 'user-1' }),
}));

vi.mock('@/utils/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child } };
});

// ─── Base moderation orchestration: a deterministic base result ────────────────
const moderateContentMock = vi.fn();
vi.mock('@/services/moderations-orchestration-service', () => ({
  ModerationsOrchestrationService: vi.fn().mockImplementation(() => ({
    moderateContent: moderateContentMock,
  })),
}));

// ─── Policy service: spy-able CRUD + REAL apply logic ──────────────────────────
// We mock the persistence functions (createPolicy/getPolicy/...) but keep the
// pure applyPolicy from the real module so the application assertions exercise
// production code, not a fake.
const createPolicyMock = vi.fn();
const listPoliciesMock = vi.fn();
const getPolicyMock = vi.fn();
const deletePolicyMock = vi.fn();

vi.mock('@/services/moderation-policy-service', async () => {
  const actual = await vi.importActual<typeof import('../moderation-policy-service')>(
    '../moderation-policy-service'
  );
  return {
    ...actual,
    createPolicy: (...args: unknown[]) => createPolicyMock(...args),
    listPolicies: (...args: unknown[]) => listPoliciesMock(...args),
    getPolicy: (...args: unknown[]) => getPolicyMock(...args),
    deletePolicy: (...args: unknown[]) => deletePolicyMock(...args),
  };
});

function policyRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'pol-1',
    organizationId: TEST_ORG,
    name: 'strict',
    thresholds: { hate: 0.3 },
    customCategories: [],
    action: 'flag',
    enabled: true,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...over,
  };
}

function baseResult(scores: Record<string, number>, flagged = false) {
  const categories: Record<string, boolean> = {};
  for (const k of Object.keys(scores)) categories[k] = false;
  return {
    results: [{ flagged, categories, category_scores: scores }],
    modelUsed: 'mock-moderation-model',
    provider: 'mock-provider',
    durationMs: 3,
  };
}

describe('Moderation policy routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    moderateContentMock.mockReset();
    server = Fastify();
    const { registerModerationsRoutes } = await import('@/routes/moderations/moderations-routes');
    await registerModerationsRoutes(server);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  it('POST /v1/moderations/policies → 201 with the created policy', async () => {
    createPolicyMock.mockResolvedValueOnce({ ok: true, policy: policyRecord() });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations/policies',
      payload: { name: 'strict', thresholds: { hate: 0.3 }, action: 'flag' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.policy.id).toBe('pol-1');
    expect(createPolicyMock).toHaveBeenCalledWith(TEST_ORG, expect.objectContaining({ name: 'strict' }));
  });

  it('POST /v1/moderations/policies → 409 on a name conflict', async () => {
    createPolicyMock.mockResolvedValueOnce({ ok: false, code: 'name_conflict', message: 'dup' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations/policies',
      payload: { name: 'dup' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('name_conflict');
  });

  it('POST /v1/moderations/policies → 400 on an invalid payload (missing name)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations/policies',
      payload: { thresholds: { hate: 0.3 } },
    });
    expect(res.statusCode).toBe(400);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('GET /v1/moderations/policies → 200 list scoped to the caller org', async () => {
    listPoliciesMock.mockResolvedValueOnce([policyRecord(), policyRecord({ id: 'pol-2', name: 'lax' })]);
    const res = await server.inject({ method: 'GET', url: '/v1/moderations/policies' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    expect(listPoliciesMock).toHaveBeenCalledWith(TEST_ORG);
  });

  it('GET /v1/moderations/policies/:id → 200 when owned', async () => {
    getPolicyMock.mockResolvedValueOnce(policyRecord());
    const res = await server.inject({ method: 'GET', url: '/v1/moderations/policies/pol-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).policy.id).toBe('pol-1');
    expect(getPolicyMock).toHaveBeenCalledWith(TEST_ORG, 'pol-1');
  });

  it('GET /v1/moderations/policies/:id → 404 for a cross-tenant / missing id', async () => {
    getPolicyMock.mockResolvedValueOnce(null);
    const res = await server.inject({ method: 'GET', url: '/v1/moderations/policies/other-org-policy' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('policy_not_found');
  });

  it('DELETE /v1/moderations/policies/:id → 200 when deleted', async () => {
    deletePolicyMock.mockResolvedValueOnce(true);
    const res = await server.inject({ method: 'DELETE', url: '/v1/moderations/policies/pol-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
    expect(deletePolicyMock).toHaveBeenCalledWith(TEST_ORG, 'pol-1');
  });

  it('DELETE /v1/moderations/policies/:id → 404 for a cross-tenant / missing id', async () => {
    deletePolicyMock.mockResolvedValueOnce(false);
    const res = await server.inject({ method: 'DELETE', url: '/v1/moderations/policies/nope' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('policy_not_found');
  });

  // ─── Application via POST /v1/moderations ─────────────────────────────────────

  it('POST /v1/moderations WITHOUT policy_id leaves the base result unchanged', async () => {
    moderateContentMock.mockResolvedValueOnce(baseResult({ hate: 0.4, violence: 0 }, false));
    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations',
      payload: { input: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Base classifier said not flagged; with no policy it stays not flagged
    // even though hate=0.4 would trip a 0.3 threshold.
    expect(body.results[0].flagged).toBe(false);
    expect(body.results[0].categories.hate).toBe(false);
    expect(body._ailin.policy).toBeUndefined();
    expect(getPolicyMock).not.toHaveBeenCalled();
  });

  it('POST /v1/moderations WITH policy_id applies thresholds and changes flagged', async () => {
    getPolicyMock.mockResolvedValueOnce(policyRecord({ thresholds: { hate: 0.3 }, action: 'flag' }));
    moderateContentMock.mockResolvedValueOnce(baseResult({ hate: 0.4, violence: 0 }, false));

    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations',
      payload: { input: 'borderline content', policy_id: 'pol-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // hate score 0.4 ≥ policy threshold 0.3 → re-flagged.
    expect(body.results[0].categories.hate).toBe(true);
    expect(body.results[0].flagged).toBe(true);
    expect(body.results[0].policy_triggered).toContain('hate');
    expect(body._ailin.policy).toMatchObject({ id: 'pol-1', action: 'flag' });
    expect(getPolicyMock).toHaveBeenCalledWith(TEST_ORG, 'pol-1');
  });

  it("POST /v1/moderations with an action='block' policy sets blocked=true", async () => {
    getPolicyMock.mockResolvedValueOnce(policyRecord({ thresholds: { hate: 0.3 }, action: 'block' }));
    moderateContentMock.mockResolvedValueOnce(baseResult({ hate: 0.9, violence: 0 }, true));

    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations',
      payload: { input: 'bad content', policy_id: 'pol-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results[0].flagged).toBe(true);
    expect(body.results[0].blocked).toBe(true);
    expect(body._ailin.policy.action).toBe('block');
  });

  it('POST /v1/moderations with an unknown / cross-tenant policy_id → 404 (no base call)', async () => {
    getPolicyMock.mockResolvedValueOnce(null);
    const res = await server.inject({
      method: 'POST',
      url: '/v1/moderations',
      payload: { input: 'x', policy_id: 'unknown' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('policy_not_found');
    // The base classifier is never invoked when the policy resolution fails.
    expect(moderateContentMock).not.toHaveBeenCalled();
  });
});
