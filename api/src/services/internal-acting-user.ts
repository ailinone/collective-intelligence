// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Resolve (and, when first-seen, just-in-time provision) the acting user for
 * the trusted internal (`/v1/internal/*`) on-behalf surface.
 *
 * WHY: the service-token middleware authenticates a first-party M2M client and
 * resolves the acting user from a header, but — unlike the federated user-JWT
 * path — never runs principal synchronization. A user who has only ever reached
 * ci through the on-behalf BFF (the dev portal's typical flow) therefore never
 * gets materialized, and every internal route 409s with
 * `acting_user_not_provisioned`. This was systemic across wallet/usage/api-keys.
 *
 * FIX: try to resolve by id (the id `sub`, which is also the ci `User.id` —
 * preserving the `User.id == id-sub` invariant). If absent, provision exactly
 * once, reusing AuthService.ensureProvisionedOnBehalf (→ ensureFederatedPrincipal)
 * so org/user creation, the `organizationId == id-tenant_id` invariant, the
 * auto-provision flags, and role sync are identical to the user-JWT path.
 *
 * SECURITY: provisioning runs ONLY when the trusted BFF asserts a well-formed
 * email + tenant (validated in the middleware) AND the federation
 * auto-provision flag is on. The service token is the trust boundary — the BFF
 * cryptographically verifies the user's id token (RS256/JWKS) before asserting
 * these headers. If the hints are missing/disabled, we fall back to
 * resolve-only (returns null → the route's 409), never provisioning on guesswork.
 */

import { prisma } from '@/database/client';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { getAuthService } from '@/services/auth-service';
import type { ServiceAuthContext } from '@/api/middleware/internal-service-auth-middleware';

const log = logger.child({ component: 'internal-acting-user' });

type ActingUser = Awaited<ReturnType<typeof prisma.user.findUnique>>;

/**
 * Returns the acting user, provisioning it on first touch when allowed.
 * Returns null when the user does not exist and cannot be provisioned — the
 * caller maps that to 409 `acting_user_not_provisioned`.
 */
export async function resolveOrProvisionActingUser(
  auth: ServiceAuthContext,
): Promise<ActingUser> {
  const { actingUserId, actingUserEmail, actingUserTenant } = auth;

  const existing = await prisma.user.findUnique({ where: { id: actingUserId } });
  if (existing) return existing;

  // Provisioning hints are validated upstream; require both + the flag.
  if (!actingUserEmail || !actingUserTenant) return null;
  if (!config.security.federation.autoProvisionUsers) return null;

  try {
    await getAuthService().ensureProvisionedOnBehalf({
      userId: actingUserId,
      organizationId: actingUserTenant,
      email: actingUserEmail,
    });
    log.info(
      { actingUserId, organizationId: actingUserTenant },
      'provisioned acting user on first internal on-behalf touch',
    );
  } catch (error) {
    // e.g. email collision under a different id, inactive org, flag off, or a
    // transient DB error — never fabricate a principal; surface as 409.
    log.warn(
      { error, actingUserId, organizationId: actingUserTenant },
      'on-behalf provisioning failed; treating acting user as unprovisioned',
    );
    return null;
  }

  return prisma.user.findUnique({ where: { id: actingUserId } });
}
