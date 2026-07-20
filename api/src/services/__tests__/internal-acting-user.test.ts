// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for resolveOrProvisionActingUser — the just-in-time provisioning
 * shim for the internal on-behalf surface. prisma, config, the auth service,
 * and the logger are all mocked so these tests focus purely on the decision
 * logic: resolve-by-id, the guard conditions for provisioning, and the
 * fail-closed behaviour (never fabricate a principal on error / missing hints).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, ensureMock, federationFlags } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  ensureMock: vi.fn(),
  federationFlags: { autoProvisionUsers: true },
}));

vi.mock('@/database/client', () => ({
  prisma: { user: { findUnique: findUniqueMock } },
}));
vi.mock('@/config', () => ({
  config: { security: { federation: federationFlags } },
}));
vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ ensureProvisionedOnBehalf: ensureMock }),
}));
vi.mock('@/utils/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { resolveOrProvisionActingUser } from '@/services/internal-acting-user';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT_ID = '11111111-2222-3333-4444-555555555555';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (over: Record<string, unknown> = {}): any => ({
  context: {},
  actingUserId: USER_ID,
  ...over,
});

beforeEach(() => {
  findUniqueMock.mockReset();
  ensureMock.mockReset();
  federationFlags.autoProvisionUsers = true;
});

describe('resolveOrProvisionActingUser', () => {
  it('returns an existing user without provisioning', async () => {
    const user = { id: USER_ID, organizationId: TENANT_ID };
    findUniqueMock.mockResolvedValueOnce(user);

    const result = await resolveOrProvisionActingUser(
      ctx({ actingUserEmail: 'user@example.com', actingUserTenant: TENANT_ID }),
    );

    expect(result).toBe(user);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  it('returns null without provisioning when hints are absent', async () => {
    findUniqueMock.mockResolvedValueOnce(null);

    const result = await resolveOrProvisionActingUser(ctx());

    expect(result).toBeNull();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('returns null when auto-provision is disabled', async () => {
    federationFlags.autoProvisionUsers = false;
    findUniqueMock.mockResolvedValueOnce(null);

    const result = await resolveOrProvisionActingUser(
      ctx({ actingUserEmail: 'user@example.com', actingUserTenant: TENANT_ID }),
    );

    expect(result).toBeNull();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('provisions on first touch then returns the materialized user', async () => {
    const provisioned = { id: USER_ID, organizationId: TENANT_ID };
    findUniqueMock.mockResolvedValueOnce(null).mockResolvedValueOnce(provisioned);
    ensureMock.mockResolvedValueOnce(undefined);

    const result = await resolveOrProvisionActingUser(
      ctx({ actingUserEmail: 'user@example.com', actingUserTenant: TENANT_ID }),
    );

    expect(ensureMock).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: TENANT_ID,
      email: 'user@example.com',
    });
    expect(result).toBe(provisioned);
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed (returns null) when provisioning throws', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    ensureMock.mockRejectedValueOnce(new Error('federated_email_collision'));

    const result = await resolveOrProvisionActingUser(
      ctx({ actingUserEmail: 'user@example.com', actingUserTenant: TENANT_ID }),
    );

    expect(result).toBeNull();
    // never re-fetches after a failed provision.
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });
});
