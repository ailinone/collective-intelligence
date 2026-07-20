// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Update Organization Handler
 * Application Layer: CQRS Command Handler
 */

import { inject, injectable } from 'tsyringe';
import { UpdateOrganizationCommand } from '../commands/update-organization.command';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { TierLevel, OrganizationTier } from '@/domain/value-objects/organization-tier';

export interface UpdateOrganizationResult {
  success: boolean;
  organization?: {
    id: string;
    name: string;
    tier: string;
    status: string;
    updatedAt: string;
  };
  error?: string;
  errorCode?: 'forbidden' | 'not_found' | 'invalid_payload' | 'unexpected';
}

@injectable()
export class UpdateOrganizationHandler {
  constructor(
    @inject('IOrganizationRepository')
    private readonly organizationRepository: IOrganizationRepository
  ) {}

  async execute(command: UpdateOrganizationCommand): Promise<UpdateOrganizationResult> {
    try {
      if (command.requesterOrganizationId !== command.organizationId) {
        return {
          success: false,
          errorCode: 'forbidden',
          error: 'You are not a member of this organization',
        };
      }

      if (!command.name && !command.tier) {
        return {
          success: false,
          errorCode: 'invalid_payload',
          error: 'At least one field (name or tier) must be provided',
        };
      }

      const organization = await this.organizationRepository.findById(command.organizationId);

      if (!organization) {
        return {
          success: false,
          errorCode: 'not_found',
          error: 'Organization not found',
        };
      }

      let hasChanges = false;

      if (command.name && command.name.trim() && command.name.trim() !== organization.name) {
        organization.rename(command.name.trim());
        hasChanges = true;
      }

      if (command.tier) {
        const normalizedTier = command.tier.toLowerCase() as TierLevel;
        const allowedTiers = Object.values(TierLevel);

        if (!allowedTiers.includes(normalizedTier)) {
          return {
            success: false,
            errorCode: 'invalid_payload',
            error: `Invalid tier "${command.tier}". Allowed values: ${allowedTiers.join(', ')}`,
          };
        }

        const currentTier = organization.tier.getLevel();

        if (normalizedTier !== currentTier) {
          const targetTier = OrganizationTier.create(normalizedTier);
          const currentTierVo = OrganizationTier.create(currentTier);

          if (targetTier.isHigherThan(currentTierVo)) {
            organization.upgradeTier(normalizedTier);
          } else {
            organization.downgradeTier(normalizedTier);
          }

          hasChanges = true;
        }
      }

      if (!hasChanges) {
        return {
          success: true,
          organization: {
            id: organization.id,
            name: organization.name,
            tier: organization.tier.getLevel(),
            status: organization.status,
            updatedAt: organization.updatedAt.toISOString(),
          },
        };
      }

      await this.organizationRepository.save(organization);

      return {
        success: true,
        organization: {
          id: organization.id,
          name: organization.name,
          tier: organization.tier.getLevel(),
          status: organization.status,
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
