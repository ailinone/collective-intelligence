// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Register User Handler
 * Application Layer: CQRS Command Handler
 *
 * Handles new user registration
 */

import { injectable, inject } from 'tsyringe';
import { RegisterUserCommand } from '../commands/register-user.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { UserEntity, UserRole } from '@/domain/entities/user.entity';
import { OrganizationEntity } from '@/domain/entities/organization.entity';
import { Email } from '@/domain/value-objects/email';
import { TierLevel } from '@/domain/value-objects/organization-tier';
import { PasswordHash } from '@/domain/value-objects/password-hash';

export interface RegisterUserResult {
  success: boolean;
  userId?: string;
  organizationId?: string;
  /**
   * The authoritative roles actually granted in `user_roles` by this
   * registration. Callers MUST mint tokens from this, never from a hardcoded
   * assumption about what the first user of an org is.
   */
  roles?: string[];
  error?: string;
}

/**
 * Returned when an anonymous registration targets an organization that already
 * exists. Joining an existing tenant must go through an invitation flow.
 */
export const ORGANIZATION_JOIN_REQUIRES_INVITATION = 'organization_join_requires_invitation';

@injectable()
export class RegisterUserHandler {
  constructor(
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
    @inject('IOrganizationRepository')
    private readonly organizationRepository: IOrganizationRepository
  ) {}

  async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    try {
      // 1. Validate email
      const email = Email.create(command.email);

      // 2. Check if user already exists
      const existingUser = await this.userRepository.findByEmail(email);
      if (existingUser) {
        return {
          success: false,
          error: 'Email already registered',
        };
      }

      // 3. Create the organization.
      //
      // SECURITY (rbac-silent-role-downgrade): this route is UNAUTHENTICATED
      // (POST /v1/auth/register has no preHandler) and the caller supplies
      // `organizationId` / `organizationName`. Anonymous registration therefore
      // NEVER attaches to a pre-existing tenant — not even an empty one.
      //
      // "Empty" is not a safe proxy for "unowned": a freshly provisioned tenant
      // whose first user has not been materialized yet is exactly that shape
      // (see internal-acting-user.ts — a console/BFF-only principal is never
      // materialized), so an anonymous caller who knows or guesses the id or
      // name would land inside a real customer's organization. Joining an
      // existing organization is an invitation flow, full stop.
      let organization: OrganizationEntity;

      if (command.organizationId) {
        const existingOrg = await this.organizationRepository.findById(command.organizationId);
        return {
          success: false,
          error: existingOrg ? ORGANIZATION_JOIN_REQUIRES_INVITATION : 'Organization not found',
        };
      }

      if (command.organizationName) {
        const existingOrg = await this.organizationRepository.findByName(command.organizationName);
        if (existingOrg) {
          return {
            success: false,
            error: ORGANIZATION_JOIN_REQUIRES_INVITATION,
          };
        }
        organization = OrganizationEntity.create({
          name: command.organizationName,
          tier: TierLevel.FREE, // Default tier
        });
        await this.organizationRepository.save(organization);
      } else {
        // Create default organization
        const orgName = `${email.getValue().split('@')[0]}'s Organization`;
        organization = OrganizationEntity.create({
          name: orgName,
          tier: TierLevel.FREE,
        });

        await this.organizationRepository.save(organization);
      }

      // 4. Hash password (placeholder - User entity doesn't have password yet)
      // const passwordHash = await bcrypt.hash(command.password, 10);

      // 5. Sanitize user input to prevent XSS attacks
      const { sanitizeHTML } = await import('@/utils/sanitizers');
      const sanitizedName = sanitizeHTML(command.name || email.getValue().split('@')[0]);

      // 6. Create user
      const passwordHash = await PasswordHash.fromPlainText(command.password);

      // SECURITY: never stamp an elevated role on the denormalized column. The
      // declared role is the baseline; real authority is granted below through
      // the authoritative `user_roles` table.
      const user = UserEntity.create({
        email: email.getValue(), // Convert Email VO to string
        name: sanitizedName,
        organizationId: organization.id,
        role: UserRole.VIEWER,
        passwordHash,
      });

      // 6. Save user
      await this.userRepository.save(user);

      // 7. Create the AUTHORITATIVE grant — the configured BASELINE role, always.
      //
      // Deliberately NOT `owner`. This endpoint is anonymous and unverified: no
      // email confirmation, no invitation, no operator in the loop. Minting an
      // `owner` grant here would hand any internet caller `secrets:manage` and
      // `quotas:override`, make them a `superRole` that short-circuits
      // `requirePermission`, and let them through the
      // `requireRole('admin','owner')` gate on the `/v1/tools/*`
      // shell/git/filesystem surface — permanently, and for every API key they
      // ever create. "The organization is empty so there is nobody to escalate
      // over" is true and beside the point; the escalation is over the platform,
      // not over a co-tenant.
      //
      // Owner is bootstrapped by a human: `pnpm run rbac:grant-owner`.
      //
      // The grant itself is required, not cosmetic: `getUserRoles()` no longer
      // self-heals, so without it a freshly registered user would resolve to [].
      const { ensureBaselineRole } = await import('@/services/rbac-service');
      const roles = await ensureBaselineRole(
        user.id,
        organization.id,
        'self-registration:new-org'
      );

      return {
        success: true,
        userId: user.id, // Already string from getter
        organizationId: organization.id,
        roles,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
