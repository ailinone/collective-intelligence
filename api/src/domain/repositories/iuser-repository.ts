// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IUserRepository Interface
 * Repository contract for User persistence
 *
 * DDD Pattern: Repository Interface (in Domain Layer)
 * - Defined in domain (interface)
 * - Implemented in infrastructure (concrete class)
 * - Dependency Inversion Principle
 */

import { UserEntity } from '../entities/user.entity';
import { UserAggregate } from '../aggregates/user.aggregate';
import { UserId } from '../value-objects/user-id';
import { Email } from '../value-objects/email';

export interface IUserRepository {
  /**
   * Find user by ID
   */
  findById(userId: UserId): Promise<UserEntity | null>;

  /**
   * Find user by email
   */
  findByEmail(email: Email): Promise<UserEntity | null>;

  /**
   * Find users by organization
   */
  findByOrganization(organizationId: string): Promise<UserEntity[]>;

  /**
   * Save user (create or update)
   */
  save(user: UserEntity): Promise<void>;

  /**
   * Save user aggregate (user + API keys).
   * C1 fix: Optional transactionClient allows callers to provide an outer transaction
   * so that outbox writes can be included in the same atomic commit.
   */
  saveAggregate(aggregate: UserAggregate, transactionClient?: unknown): Promise<void>;

  /**
   * Delete user
   */
  delete(userId: UserId): Promise<void>;

  /**
   * Check if email exists
   */
  emailExists(email: Email): Promise<boolean>;

  /**
   * Find user aggregate (user + API keys)
   */
  findAggregateById(userId: UserId): Promise<UserAggregate | null>;
}
