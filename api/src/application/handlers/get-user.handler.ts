// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GetUser Query Handler
 * CQRS Pattern: Query Handler (Read-only)
 */

import { injectable, inject } from 'tsyringe';
import { GetUserQuery } from '../queries/get-user.query';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserId } from '@/domain/value-objects/user-id';

export interface GetUserResult {
  success: boolean;
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId: string;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
}

@injectable()
export class GetUserHandler {
  constructor(@inject('IUserRepository') private readonly userRepository: IUserRepository) {}

  async execute(query: GetUserQuery): Promise<GetUserResult> {
    try {
      // 1. Load user entity
      const userId = UserId.create(query.userId);
      const user = await this.userRepository.findById(userId);

      if (!user) {
        return {
          success: false,
          error: 'User not found',
        };
      }

      // 2. Convert to DTO (presentation layer)
      const userDTO = user.toDTO();

      return {
        success: true,
        user: userDTO,
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
