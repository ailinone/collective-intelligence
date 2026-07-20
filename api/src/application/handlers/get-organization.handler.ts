// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Get Organization Handler
 * Application Layer: CQRS Query Handler
 */

import { inject, injectable } from 'tsyringe';
import { GetOrganizationQuery } from '../queries/get-organization.query';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';

export interface GetOrganizationResult {
  success: boolean;
  organization?: {
    id: string;
    name: string;
    tier: string;
    status: string;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
  errorCode?: 'forbidden' | 'not_found' | 'unexpected';
}

@injectable()
export class GetOrganizationHandler {
  constructor(
    @inject('IOrganizationRepository')
    private readonly organizationRepository: IOrganizationRepository
  ) {}

  async execute(query: GetOrganizationQuery): Promise<GetOrganizationResult> {
    try {
      if (query.requesterOrganizationId !== query.organizationId) {
        return {
          success: false,
          errorCode: 'forbidden',
          error: 'You are not a member of this organization',
        };
      }

      const organization = await this.organizationRepository.findById(query.organizationId);

      if (!organization) {
        return {
          success: false,
          errorCode: 'not_found',
          error: 'Organization not found',
        };
      }

      const memberCount = await this.organizationRepository.countMembers(query.organizationId);

      return {
        success: true,
        organization: {
          id: organization.id,
          name: organization.name,
          tier: organization.tier.getLevel(),
          status: organization.status,
          memberCount,
          createdAt: organization.createdAt.toISOString(),
          updatedAt: organization.updatedAt.toISOString(),
        },
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
