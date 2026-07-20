// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Aggregate
 * Aggregate Root: User + ApiKeys
 *
 * DDD Pattern: Aggregate
 * - Ensures consistency between User and their ApiKeys
 * - Enforces business rules across entities
 * - Transaction boundary
 */

import { UserEntity } from '../entities/user.entity';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { UserCreatedEvent } from '../events/user-created.event';
import { ApiKeyRotatedEvent } from '../events/api-key-rotated.event';
import { BaseDomainEvent } from '../events/base-domain-event';

export class UserAggregate {
  private user: UserEntity;
  private apiKeys: Map<string, ApiKeyEntity>;
  private domainEvents: Array<BaseDomainEvent | UserCreatedEvent | ApiKeyRotatedEvent>;

  private constructor(user: UserEntity, apiKeys: ApiKeyEntity[] = []) {
    this.user = user;
    this.apiKeys = new Map();
    this.domainEvents = [];

    // Initialize API keys map
    for (const key of apiKeys) {
      this.apiKeys.set(key.id, key);
    }
  }

  /**
   * Factory: Create new user aggregate
   */
  static create(data: { email: string; name: string; organizationId: string }): UserAggregate {
    const user = UserEntity.create(data);
    const aggregate = new UserAggregate(user);

    // Emit domain event
    aggregate.addDomainEvent(
      UserCreatedEvent.create({
        userId: user.id, // Already string from getter
        email: user.email, // Already string from getter
        name: user.name,
        organizationId: user.organizationId,
        role: user.role,
      })
    );

    return aggregate;
  }

  /**
   * Reconstitute from persistence
   */
  static reconstitute(user: UserEntity, apiKeys: ApiKeyEntity[] = []): UserAggregate {
    return new UserAggregate(user, apiKeys);
  }

  /**
   * Business Logic: Create API key for user
   */
  createApiKey(data: {
    name: string;
    expiresAt?: Date;
    autoRotate?: boolean;
    rotationIntervalDays?: number;
    ipWhitelist?: string[];
  }): ApiKeyEntity {
    // Business rule: User must be active
    if (!this.user.isActive()) {
      throw new Error('Cannot create API key for inactive user');
    }

    // Create new API key
    const apiKey = ApiKeyEntity.create({
      ...data,
      userId: this.user.id, // Already string
      organizationId: this.user.organizationId,
    });

    // Add to aggregate
    this.apiKeys.set(apiKey.id, apiKey);

    return apiKey;
  }

  /**
   * Business Logic: Rotate API key
   */
  rotateApiKey(
    oldKeyId: string,
    reason: 'manual' | 'auto-rotation' | 'security' = 'manual'
  ): ApiKeyEntity {
    const oldKey = this.apiKeys.get(oldKeyId);

    if (!oldKey) {
      throw new Error(`API key not found: ${oldKeyId}`);
    }

    // Business rule: User must be active
    if (!this.user.isActive()) {
      throw new Error('Cannot rotate API key for inactive user');
    }

    // Create new key
    const newKey = ApiKeyEntity.create({
      name: `${oldKey.name} (rotated)`,
      userId: this.user.id, // Already string from getter
      organizationId: this.user.organizationId,
      autoRotate: oldKey.toPersistence().autoRotate,
      rotationIntervalDays: oldKey.toPersistence().rotationIntervalDays ?? undefined,
      ipWhitelist: oldKey.toPersistence().ipWhitelist,
    });

    // Start rotation on old key
    oldKey.startRotation(newKey.id);

    // Add new key to aggregate
    this.apiKeys.set(newKey.id, newKey);

    // Emit domain event
    this.addDomainEvent(
      ApiKeyRotatedEvent.create({
        apiKeyId: oldKeyId,
        oldKeyId,
        newKeyId: newKey.id,
        userId: this.user.id, // Already string from getter
        organizationId: this.user.organizationId,
        reason,
        gracePeriodDays: oldKey.toPersistence().gracePeriodDays,
      })
    );

    return newKey;
  }

  /**
   * Business Logic: Revoke API key
   */
  revokeApiKey(keyId: string, reason?: string): void {
    const apiKey = this.apiKeys.get(keyId);

    if (!apiKey) {
      throw new Error(`API key not found: ${keyId}`);
    }

    apiKey.revoke(reason);
  }

  /**
   * Business Logic: Suspend user (cascades to API keys)
   */
  suspendUser(reason?: string): void {
    this.user.suspend(reason);

    // Business rule: Suspend all API keys when user is suspended
    for (const apiKey of this.apiKeys.values()) {
      if (apiKey.status !== 'revoked' && apiKey.status !== 'expired') {
        apiKey.revoke(`User suspended: ${reason || 'no reason'}`);
      }
    }
  }

  /**
   * Get all active API keys
   */
  getActiveApiKeys(): ApiKeyEntity[] {
    return Array.from(this.apiKeys.values()).filter(
      (key) => key.status === 'active' || key.status === 'rotating'
    );
  }

  /**
   * Get API key count
   */
  getApiKeyCount(): number {
    return this.apiKeys.size;
  }

  /**
   * Check if user can create more API keys
   * Note: Organization tier limits should be checked by OrganizationAggregate
   */
  canCreateApiKey(organizationTierMaxKeys: number): boolean {
    const activeCount = this.getActiveApiKeys().length;

    if (organizationTierMaxKeys === -1) {
      return true; // Unlimited
    }

    return activeCount < organizationTierMaxKeys;
  }

  /**
   * Domain Events Management
   */
  private addDomainEvent(event: BaseDomainEvent | UserCreatedEvent | ApiKeyRotatedEvent): void {
    this.domainEvents.push(event);
  }

  getDomainEvents(): Array<BaseDomainEvent | UserCreatedEvent | ApiKeyRotatedEvent> {
    return [...this.domainEvents];
  }

  clearDomainEvents(): void {
    this.domainEvents = [];
  }

  /**
   * Getters
   */
  getUser(): UserEntity {
    return this.user;
  }

  getApiKey(apiKeyId: string): ApiKeyEntity | undefined {
    return Array.from(this.apiKeys.values()).find((k) => k.id === apiKeyId);
  }

  getAllApiKeys(): ApiKeyEntity[] {
    return Array.from(this.apiKeys.values());
  }

  /**
   * To persistence (for repository)
   */
  toPersistence(): {
    user: ReturnType<UserEntity['toPersistence']>;
    apiKeys: ReturnType<ApiKeyEntity['toPersistence']>[];
  } {
    return {
      user: this.user.toPersistence(),
      apiKeys: Array.from(this.apiKeys.values()).map((k) => k.toPersistence()),
    };
  }
}
