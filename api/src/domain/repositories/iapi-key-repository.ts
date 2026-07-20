// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IApiKeyRepository Interface
 * Repository contract for ApiKey persistence
 *
 * DDD Pattern: Repository Interface (in Domain Layer)
 */

import { ApiKeyEntity } from '../entities/api-key.entity';
import { ApiKeyValue } from '../value-objects/api-key-value';

export interface IApiKeyRepository {
  /**
   * Find API key by ID
   */
  findById(keyId: string): Promise<ApiKeyEntity | null>;

  /**
   * Find API key by value (for authentication)
   * Note: Should use prefix indexing for performance
   */
  findByKeyValue(keyValue: ApiKeyValue): Promise<ApiKeyEntity | null>;

  /**
   * Find API keys by user
   */
  findByUser(userId: string): Promise<ApiKeyEntity[]>;

  /**
   * Find API keys by organization
   */
  findByOrganization(organizationId: string): Promise<ApiKeyEntity[]>;

  /**
   * Find active API keys
   */
  findActive(options?: { userId?: string; organizationId?: string }): Promise<ApiKeyEntity[]>;

  /**
   * Find keys due for auto-rotation
   */
  findDueForRotation(): Promise<ApiKeyEntity[]>;

  /**
   * Find expired keys
   */
  findExpired(): Promise<ApiKeyEntity[]>;

  /**
   * Save API key (create or update)
   */
  save(apiKey: ApiKeyEntity): Promise<void>;

  /**
   * Delete API key
   */
  delete(keyId: string): Promise<void>;

  /**
   * Batch operations for rotation
   */
  saveMany(apiKeys: ApiKeyEntity[]): Promise<void>;

  /**
   * Get API key count for user
   */
  countByUser(userId: string): Promise<number>;

  /**
   * Get API key count for organization
   */
  countByOrganization(organizationId: string): Promise<number>;
}
