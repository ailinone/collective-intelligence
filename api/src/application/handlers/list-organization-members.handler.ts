// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * List Organization Members Handler
 * Application Layer: CQRS Query Handler
 */

import { inject, injectable } from 'tsyringe';
import { ListOrganizationMembersQuery } from '../queries/list-organization-members.query';
import { IUserRepository } from '@/domain/repositories/iuser-repository';

export interface ListOrganizationMembersResult {
  success: boolean;
  members?: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  error?: string;
  errorCode?: 'forbidden' | 'unexpected';
}

@injectable()
export class ListOrganizationMembersHandler {
  constructor(@inject('IUserRepository') private readonly userRepository: IUserRepository) {}

  async execute(query: ListOrganizationMembersQuery): Promise<ListOrganizationMembersResult> {
    try {
      if (query.requesterOrganizationId !== query.organizationId) {
        return {
          success: false,
          errorCode: 'forbidden',
          error: 'You are not a member of this organization',
        };
      }

      const members = await this.userRepository.findByOrganization(query.organizationId);

      const orderedMembers = members
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((member) => ({
          id: member.id,
          email: member.email,
          name: member.name,
          role: member.role,
          status: member.status,
          createdAt: member.createdAt.toISOString(),
          updatedAt: member.updatedAt.toISOString(),
        }));

      return {
        success: true,
        members: orderedMembers,
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
