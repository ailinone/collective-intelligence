// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for resolveOrProvisionChatActingUserOrganizationId — the
 * chat-surface counterpart of internal-acting-user.ts's JIT provisioning.
 *
 * Contract under test:
 *  - lookup-first: an existing ACTIVE user row resolves without provisioning
 *  - first-seen user + email/tenant hints + autoProvision flag → provisioned
 *    via the EXACT ensureProvisionedOnBehalf call (same invariants as the
 *    internal on-behalf surface)
 *  - fail-closed: no hints / flag off / provisioning error / inactive result
 *    all resolve to null — never a fabricated org, never the principal's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindFirstMock, ensureProvisionedOnBehalfMock } = vi.hoisted(() => ({
  userFindFirstMock: vi.fn(),
  ensureProvisionedOnBehalfMock: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: { user: { findFirst: userFindFirstMock } },
}));

vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ ensureProvisionedOnBehalf: ensureProvisionedOnBehalfMock }),
}));

vi.mock('@/config', () => ({
  config: { security: { federation: { autoProvisionUsers: true } } },
}));

import { resolveOrProvisionChatActingUserOrganizationId } from '@/services/auto-preset-billing';

const USER_ID = 'dddddddd-3333-3333-3333-333333333333';
const TENANT_ID = 'eeeeeeee-4444-4444-4444-444444444444';
const EMAIL = 'invited@ailin.one';
const HINTS = { email: EMAIL, tenant: TENANT_ID };

function userRow(organizationId: string | null, status = 'active') {
  return organizationId ? { organizationId, status } : null;
}

beforeEach(() => {
  userFindFirstMock.mockReset();
  ensureProvisionedOnBehalfMock.mockReset();
  ensureProvisionedOnBehalfMock.mockResolvedValue(undefined);
});

describe('resolveOrProvisionChatActingUserOrganizationId', () => {
  it('resolves an existing active user without provisioning', async () => {
    userFindFirstMock.mockResolvedValueOnce(userRow(TENANT_ID));

    await expect(resolveOrProvisionChatActingUserOrganizationId(USER_ID, HINTS)).resolves.toBe(
      TENANT_ID
    );
    expect(ensureProvisionedOnBehalfMock).not.toHaveBeenCalled();
    expect(userFindFirstMock).toHaveBeenCalledTimes(1);
  });

  it('JIT-provisions a first-seen user when hints and the flag allow it', async () => {
    userFindFirstMock
      .mockResolvedValueOnce(userRow(null)) // pre-provision lookup
      .mockResolvedValueOnce(userRow(TENANT_ID)); // post-provision lookup

    await expect(resolveOrProvisionChatActingUserOrganizationId(USER_ID, HINTS)).resolves.toBe(
      TENANT_ID
    );
    expect(ensureProvisionedOnBehalfMock).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: TENANT_ID,
      email: EMAIL,
    });
  });

  it('returns null without provisioning when hints are incomplete', async () => {
    userFindFirstMock.mockResolvedValue(userRow(null));

    await expect(
      resolveOrProvisionChatActingUserOrganizationId(USER_ID, { email: EMAIL })
    ).resolves.toBeNull();
    await expect(
      resolveOrProvisionChatActingUserOrganizationId(USER_ID, { tenant: TENANT_ID })
    ).resolves.toBeNull();
    expect(ensureProvisionedOnBehalfMock).not.toHaveBeenCalled();
  });

  it('returns null when the auto-provision flag is off (fail-closed)', async () => {
    const { config } = await import('@/config');
    const spy = vi.spyOn(config.security.federation, 'autoProvisionUsers', 'get');
    spy.mockReturnValue(false);
    try {
      userFindFirstMock.mockResolvedValueOnce(userRow(null));

      await expect(
        resolveOrProvisionChatActingUserOrganizationId(USER_ID, HINTS)
      ).resolves.toBeNull();
      expect(ensureProvisionedOnBehalfMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('returns null when provisioning throws (never bills blind)', async () => {
    userFindFirstMock.mockResolvedValueOnce(userRow(null));
    ensureProvisionedOnBehalfMock.mockRejectedValueOnce(new Error('email collision'));

    await expect(resolveOrProvisionChatActingUserOrganizationId(USER_ID, HINTS)).resolves.toBeNull();
    expect(userFindFirstMock).toHaveBeenCalledTimes(1); // no second lookup after failure
  });

  it('returns null when the provisioned row still does not resolve active', async () => {
    // lookupActingUserOrganizationId filters `status: 'active'` in the WHERE
    // clause, so a provisioned-but-suspended row NEVER matches it — model the
    // DB row as invisible to every active-filtered lookup (before AND after
    // provisioning), which is exactly what PostgreSQL would return.
    userFindFirstMock.mockResolvedValue(null);

    await expect(resolveOrProvisionChatActingUserOrganizationId(USER_ID, HINTS)).resolves.toBeNull();
    expect(ensureProvisionedOnBehalfMock).toHaveBeenCalledTimes(1);
  });
});
