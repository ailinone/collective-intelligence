// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the federated JWT auto-provisioning path
 * (`AuthService.ensureFederatedPrincipal`, exercised via the public
 * `verifyToken`) — uses a REAL database, no mocks, same convention as
 * `auth-service.test.ts`.
 *
 * THE BUG: when a federated JWT (signed by `id`, verified here via the
 * HS256 shared-secret fallback) names an `organizationId` `ci` has never
 * seen before, `ensureFederatedPrincipal` used to JIT-provision that
 * Organization with `tier: 'enterprise'` — the single MOST permissive tier
 * — with no billing relationship backing that at all. `id` has no concept
 * of plan/tier of its own to have asserted otherwise (its `Account.plan`
 * defaults to `'basic'` and is never synced anywhere). This is the opposite
 * of the fail-closed posture used everywhere else in the quota/tier program
 * (see `billing`'s own sandbox/free fallback in `usage_service.py`). Fixed
 * to default to `'free'` instead.
 *
 * This file needs its own `vi.resetModules()` + dynamic imports (isolated
 * from `auth-service.test.ts`'s module-level `authService`/`prisma`
 * bindings) because `config.security.federation.sharedSecret` is read from
 * `AILIN_SHARED_JWT_SECRET` at `@/config` MODULE-LOAD time and deep-frozen
 * — it must be set before that module is first imported in this process,
 * which `resetModules` + a fresh dynamic `import('@/config')` achieves
 * without disturbing any other test file's already-loaded config. Real
 * Prisma access after the reset is still safe: `@/database/client` caches
 * its client on `globalThis.__prisma` (see that file's header), so a
 * fresh import after `resetModules` reuses the same live connection
 * instead of opening a second pool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const ORIGINAL_SHARED_SECRET = process.env.AILIN_SHARED_JWT_SECRET;
const TEST_SHARED_SECRET = 'test-federation-shared-secret-do-not-use-in-prod';

describe('AuthService federated auto-provisioning (REAL DB, no mocks)', () => {
  let createdOrgId: string | undefined;
  let createdUserId: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    process.env.AILIN_SHARED_JWT_SECRET = TEST_SHARED_SECRET;
  });

  afterEach(async () => {
    vi.resetModules();
    if (ORIGINAL_SHARED_SECRET === undefined) {
      delete process.env.AILIN_SHARED_JWT_SECRET;
    } else {
      process.env.AILIN_SHARED_JWT_SECRET = ORIGINAL_SHARED_SECRET;
    }

    const { prisma } = await import('@/database/client');
    if (createdUserId) {
      await prisma.user.deleteMany({ where: { id: createdUserId } }).catch(() => {});
    }
    if (createdOrgId) {
      await prisma.organization.deleteMany({ where: { id: createdOrgId } }).catch(() => {});
    }
    createdOrgId = undefined;
    createdUserId = undefined;
  });

  function signFederatedToken(config: {
    issuer: string;
    audience: string;
  }): { token: string; userId: string; organizationId: string; email: string } {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const email = `federated-${Date.now()}@example.com`;

    const token = jwt.sign(
      {
        sub: userId,
        tenant_id: organizationId,
        email,
        token_use: 'access',
      },
      TEST_SHARED_SECRET,
      {
        algorithm: 'HS256',
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: '5m',
      }
    );

    return { token, userId, organizationId, email };
  }

  it('auto-provisions a brand-new federated organization on the FREE tier, not enterprise', async () => {
    const { config } = await import('@/config');
    const { AuthService } = await import('@/services/auth-service');
    const { prisma } = await import('@/database/client');

    expect(config.security.federation.sharedSecret).toBe(TEST_SHARED_SECRET);
    expect(config.security.federation.autoProvisionOrganizations).toBe(true);

    const authService = new AuthService();
    const { token, organizationId, userId } = signFederatedToken({
      issuer: config.security.federation.issuer,
      audience: config.security.federation.audience,
    });
    createdOrgId = organizationId;
    createdUserId = userId;

    const payload = await authService.verifyToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.organizationId).toBe(organizationId);

    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    expect(org).not.toBeNull();
    expect(org?.tier).toBe('free');
    expect(org?.status).toBe('active');
  });

  it('does NOT downgrade an existing organization that already has a real tier', async () => {
    const { config } = await import('@/config');
    const { AuthService } = await import('@/services/auth-service');
    const { prisma } = await import('@/database/client');

    const authService = new AuthService();
    const { token, organizationId, userId } = signFederatedToken({
      issuer: config.security.federation.issuer,
      audience: config.security.federation.audience,
    });
    createdOrgId = organizationId;
    createdUserId = userId;

    // Pre-existing org with a real paid tier, established some other way
    // (e.g. a resolved billing entitlement) BEFORE this federated JWT is
    // ever seen — the auto-provisioning default must never override it.
    await prisma.organization.create({
      data: { id: organizationId, name: 'Pre-existing Paid Org', tier: 'pro', status: 'active' },
    });

    await authService.verifyToken(token);

    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    expect(org?.tier).toBe('pro');
  });
});
