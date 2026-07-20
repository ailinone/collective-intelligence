// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Remove Organization Member Handler
 * Application Layer: CQRS Command Handler
 */

import { inject, injectable } from 'tsyringe';
import { RemoveOrganizationMemberCommand } from '../commands/remove-organization-member.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { UserId } from '@/domain/value-objects/user-id';

export interface RemoveOrganizationMemberResult {
  success: boolean;
  message?: string;
  error?: string;
  errorCode?: 'forbidden' | 'not_found' | 'invalid_payload' | 'unexpected';
}

@injectable()
export class RemoveOrganizationMemberHandler {
  constructor(
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
    @inject('IOrganizationRepository')
    private readonly organizationRepository: IOrganizationRepository
  ) {}

  async execute(command: RemoveOrganizationMemberCommand): Promise<RemoveOrganizationMemberResult> {
    try {
      if (command.requesterOrganizationId !== command.organizationId) {
        return {
          success: false,
          errorCode: 'forbidden',
          error: 'You are not a member of this organization',
        };
      }

      if (command.memberId === command.requesterUserId) {
        return {
          success: false,
          errorCode: 'invalid_payload',
          error: 'You cannot remove yourself from the organization',
        };
      }

      let memberUserId: UserId;

      try {
        memberUserId = UserId.create(command.memberId);
      } catch {
        return {
          success: false,
          errorCode: 'invalid_payload',
          error: 'Invalid user identifier provided',
        };
      }
      const targetUser = await this.userRepository.findById(memberUserId);

      if (!targetUser || targetUser.organizationId !== command.organizationId) {
        return {
          success: false,
          errorCode: 'not_found',
          error: 'User not found in this organization',
        };
      }

      const aggregate = await this.organizationRepository.findAggregateById(command.organizationId);

      if (!aggregate) {
        return {
          success: false,
          errorCode: 'not_found',
          error: 'Organization not found',
        };
      }

      // Apply domain rules for removal
      try {
        aggregate.removeMember(command.memberId);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          errorCode: 'invalid_payload',
          error: errorMessage,
        };
      }

      await this.organizationRepository.saveAggregate(aggregate);

      return {
        success: true,
        message: 'Member removed successfully',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorCode: 'unexpected',
        error: errorMessage,
      };
    }
  }
}
