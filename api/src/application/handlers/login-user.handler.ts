// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Login User Handler
 * Application Layer: CQRS Command Handler
 *
 * Handles user authentication
 */

import { injectable, inject } from 'tsyringe';
import { LoginUserCommand } from '../commands/login-user.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { Email } from '@/domain/value-objects/email';
import { UserStatus } from '@/domain/entities/user.entity';

export interface LoginUserResult {
  success: boolean;
  userId?: string;
  email?: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  error?: string;
}

@injectable()
export class LoginUserHandler {
  constructor(@inject('IUserRepository') private readonly userRepository: IUserRepository) {}

  async execute(command: LoginUserCommand): Promise<LoginUserResult> {
    try {
      // 1. Validate email format
      const email = Email.create(command.email);

      // 2. Find user by email
      const user = await this.userRepository.findByEmail(email);

      if (!user) {
        return {
          success: false,
          error: 'Invalid email or password',
        };
      }

      // 3. Check status
      if (user.status !== UserStatus.ACTIVE) {
        const statusMessage = user.status === UserStatus.SUSPENDED 
          ? 'Account is suspended' 
          : 'Account is not active';
        return {
          success: false,
          error: statusMessage,
        };
      }

      // 4. Verify password against stored hash
      const passwordMatches = await user.verifyPassword(command.password);

      if (!passwordMatches) {
        return {
          success: false,
          error: 'Invalid email or password',
        };
      }

      // 5. Return user data for JWT generation
      return {
        success: true,
        userId: user.id, // Already string from getter
        email: user.email, // Already string from getter
        organizationId: user.organizationId,
        role: user.role as string,
        roles: [user.role as string],
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
