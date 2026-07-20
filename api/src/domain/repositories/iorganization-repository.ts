// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IOrganizationRepository Interface
 * Repository contract for Organization persistence
 *
 * DDD Pattern: Repository Interface (in Domain Layer)
 */

import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationAggregate } from '../aggregates/organization.aggregate';

export interface IOrganizationRepository {
  /**
   * Find organization by ID
   */
  findById(organizationId: string): Promise<OrganizationEntity | null>;

  /**
   * Find organization by name
   */
  findByName(name: string): Promise<OrganizationEntity | null>;

  /**
   * List all organizations
   */
  findAll(options?: {
    limit?: number;
    offset?: number;
    tier?: string;
    status?: string;
  }): Promise<OrganizationEntity[]>;

  /**
   * Save organization (create or update)
   */
  save(organization: OrganizationEntity): Promise<void>;

  /**
   * Get organization member count
   */
  countMembers(organizationId: string): Promise<number>;

  /**
   * Save organization aggregate (org + members)
   */
  saveAggregate(aggregate: OrganizationAggregate): Promise<void>;

  /**
   * Delete organization
   */
  delete(organizationId: string): Promise<void>;

  /**
   * Check if name exists
   */
  nameExists(name: string): Promise<boolean>;

  /**
   * Find organization aggregate (org + members)
   */
  findAggregateById(organizationId: string): Promise<OrganizationAggregate | null>;

  /**
   * Get organization count by tier
   */
  countByTier(): Promise<Record<string, number>>;
}
