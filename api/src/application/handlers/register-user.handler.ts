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
  error?: string;
}

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

      // 3. Create or find organization
      let organization: OrganizationEntity;

      if (command.organizationId) {
        const existingOrg = await this.organizationRepository.findById(command.organizationId);
        if (!existingOrg) {
          return {
            success: false,
            error: 'Organization not found',
          };
        }
        organization = existingOrg;
      } else if (command.organizationName) {
        // Check if organization exists
        const existingOrg = await this.organizationRepository.findByName(command.organizationName);

        if (existingOrg) {
          organization = existingOrg;
        } else {
          // Create new organization
          organization = OrganizationEntity.create({
            name: command.organizationName,
            tier: TierLevel.FREE, // Default tier
          });

          await this.organizationRepository.save(organization);
        }
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

      const user = UserEntity.create({
        email: email.getValue(), // Convert Email VO to string
        name: sanitizedName,
        organizationId: organization.id,
        role: UserRole.ADMIN, // First user in org is admin
        passwordHash,
      });

      // 6. Save user
      await this.userRepository.save(user);

      return {
        success: true,
        userId: user.id, // Already string from getter
        organizationId: organization.id,
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
