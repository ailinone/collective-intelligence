// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Direct provisioning primitives for OPERATOR scripts.
 *
 * Why this exists: `RegisterUserHandler` / `AuthService.register` back the
 * anonymous, unauthenticated `POST /v1/auth/register`. They therefore refuse to
 * attach a new user to any pre-existing organization, and they never grant
 * anything above the configured baseline role — an internet caller must not be
 * able to implant itself into a tenant or bootstrap a super-role.
 *
 * Operator provisioning is the opposite situation: a human at a shell with
 * DATABASE_URL, deliberately creating a named organization and its owner. That
 * is a legitimate thing to do and it must not be expressed by borrowing the
 * anonymous registration path (which is how these scripts used to work — they
 * only functioned at all because the tenant guard did not exist yet).
 *
 * Nothing here is reachable from the API surface: this module lives under
 * `scripts/` and is imported only by operator CLIs.
 */

import { prisma } from '@/database/client';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { sanitizeHTML } from '@/utils/sanitizers';

export interface ProvisionedOrganization {
  id: string;
  name: string;
  created: boolean;
}

export interface ProvisionedUser {
  userId: string;
  created: boolean;
  /** Only set when this call generated the account and hashed a new password. */
  temporaryPassword?: string;
}

/** Find an organization by name, creating it (with `tier`) when absent. */
export async function ensureOrganizationByName(
  name: string,
  tier: string
): Promise<ProvisionedOrganization> {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) {
    if (existing.tier !== tier || existing.status !== 'active') {
      await prisma.organization.update({
        where: { id: existing.id },
        data: { tier, status: 'active' },
      });
    }
    return { id: existing.id, name: existing.name, created: false };
  }

  const created = await prisma.organization.create({
    data: { name, tier, status: 'active' },
  });
  return { id: created.id, name: created.name, created: true };
}

/**
 * Ensure a user row exists inside `organizationId`.
 *
 * The declared `users.role` column is left at its schema default. Authority is
 * granted separately and explicitly by the caller through `assignRoleToUser`,
 * which is what keeps `users.role` a mirror of real grants rather than an
 * independent source of privilege.
 *
 * Refuses to move an existing user between organizations — that is a tenancy
 * change, not a provisioning step.
 */
export async function ensureUserInOrganization(input: {
  email: string;
  name: string;
  password: string;
  organizationId: string;
}): Promise<ProvisionedUser> {
  const email = input.email.trim().toLowerCase();
  const name = sanitizeHTML(input.name || email.split('@')[0]);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.organizationId !== input.organizationId) {
      throw new Error(
        `User ${email} already belongs to organization ${existing.organizationId}; refusing to move them to ${input.organizationId}`
      );
    }
    if (existing.name !== name) {
      await prisma.user.update({ where: { id: existing.id }, data: { name } });
    }
    return { userId: existing.id, created: false };
  }

  const passwordHash = await PasswordHash.fromPlainText(input.password);
  const created = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: passwordHash.getValue(),
      organizationId: input.organizationId,
      status: 'active',
    },
  });

  return { userId: created.id, created: true, temporaryPassword: input.password };
}
