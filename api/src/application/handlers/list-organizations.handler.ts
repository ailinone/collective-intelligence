// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * List Organizations Handler
 * Application Layer: CQRS Query Handler
 */

import { injectable, inject } from 'tsyringe';
import { ListOrganizationsQuery } from '../queries/list-organizations.query';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';

export interface ListOrganizationsResult {
  success: boolean;
  organizations?: Array<{
    id: string;
    name: string;
    tier: string;
    status: string;
    createdAt: string;
  }>;
  error?: string;
}

@injectable()
export class ListOrganizationsHandler {
  constructor(
    @inject('IOrganizationRepository')
    private readonly organizationRepository: IOrganizationRepository
  ) {}

  async execute(query: ListOrganizationsQuery): Promise<ListOrganizationsResult> {
    try {
      const organizations = await this.organizationRepository.findAll({
        limit: query.limit,
        offset: query.offset,
        tier: query.tier,
      });

      return {
        success: true,
        organizations: organizations.map((org) => {
          const persistence = org.toPersistence();
          return {
            id: org.id,
            name: org.name,
            tier: persistence.tier, // From toPersistence()
            status: persistence.status,
            createdAt: org.createdAt.toISOString(),
          };
        }),
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
