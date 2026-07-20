// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Update User Handler
 * Application Layer: CQRS Command Handler
 *
 * Handles UpdateUserCommand
 * - Retrieves user from repository
 * - Applies domain logic (via entity)
 * - Persists changes
 */

import { injectable, inject } from 'tsyringe';
import { UpdateUserCommand } from '../commands/update-user.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserId } from '@/domain/value-objects/user-id';

export interface UpdateUserResult {
  success: boolean;
  error?: string;
}

@injectable()
export class UpdateUserHandler {
  constructor(@inject('IUserRepository') private readonly userRepository: IUserRepository) {}

  async execute(command: UpdateUserCommand): Promise<UpdateUserResult> {
    try {
      // 1. Load user
      const userId = UserId.create(command.userId);
      const user = await this.userRepository.findById(userId);

      if (!user) {
        return {
          success: false,
          error: 'User not found',
        };
      }

      // 2. Apply updates via domain entity (domain logic)
      if (command.updates.name) {
        user.changeName(command.updates.name);
      }

      if (command.updates.email) {
        user.changeEmail(command.updates.email);
      }

      // 3. Persist changes
      await this.userRepository.save(user);

      return {
        success: true,
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
