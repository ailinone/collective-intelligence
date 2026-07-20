// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Entity
 * Multi-tenant organization with tier-based limits
 *
 * DDD Pattern: Aggregate Root
 * - Manages members
 * - Enforces tier limits
 * - Controls API keys
 */

import { OrganizationTier, TierLevel } from '../value-objects/organization-tier';

export enum OrganizationStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
}

export interface OrganizationProps {
  id: string;
  name: string;
  tier: OrganizationTier;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
  statusReason?: string;

  // Counts (for tier validation)
  memberCount?: number;
  apiKeyCount?: number;
}

export class OrganizationEntity {
  private props: OrganizationProps;

  private constructor(props: OrganizationProps) {
    this.validateInvariants(props);
    this.props = props;
  }

  /**
   * Factory: Create new organization
   */
  static create(data: { name: string; tier?: TierLevel }): OrganizationEntity {
    const now = new Date();

    return new OrganizationEntity({
      id: crypto.randomUUID(),
      name: data.name.trim(),
      tier: OrganizationTier.create(data.tier || TierLevel.FREE),
      status: OrganizationStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      memberCount: 0,
      apiKeyCount: 0,
      statusReason: undefined,
    });
  }

  /**
   * Reconstitute from persistence
   */
  static reconstitute(data: {
    id: string;
    name: string;
    tier: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    memberCount?: number;
    apiKeyCount?: number;
    statusReason?: string | null;
  }): OrganizationEntity {
    return new OrganizationEntity({
      id: data.id,
      name: data.name,
      tier: OrganizationTier.create(data.tier as TierLevel),
      status: data.status as OrganizationStatus,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      memberCount: data.memberCount,
      apiKeyCount: data.apiKeyCount,
      statusReason: data.statusReason ?? undefined,
    });
  }

  /**
   * Invariant validation
   */
  private validateInvariants(props: OrganizationProps): void {
    if (!props.name || props.name.trim().length === 0) {
      throw new Error('Organization name cannot be empty');
    }

    if (props.name.length > 100) {
      throw new Error('Organization name cannot exceed 100 characters');
    }
  }

  /**
   * Business Logic: Upgrade tier
   */
  upgradeTier(newTier: TierLevel): void {
    const currentTier = this.props.tier;
    const proposedTier = OrganizationTier.create(newTier);

    if (!proposedTier.isHigherThan(currentTier)) {
      throw new Error('Can only upgrade to a higher tier');
    }

    this.props.tier = proposedTier;
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Downgrade tier (with validation)
   */
  downgradeTier(newTier: TierLevel): void {
    const currentTier = this.props.tier;
    const proposedTier = OrganizationTier.create(newTier);

    if (proposedTier.isHigherThan(currentTier)) {
      throw new Error('Cannot downgrade to a higher tier');
    }

    // Check if current usage fits within new limits
    const limits = proposedTier.getLimits();

    if (
      this.props.memberCount &&
      limits.maxMembers !== -1 &&
      this.props.memberCount > limits.maxMembers
    ) {
      throw new Error(
        `Cannot downgrade: organization has ${this.props.memberCount} members, new tier allows ${limits.maxMembers}`
      );
    }

    if (
      this.props.apiKeyCount &&
      limits.maxApiKeys !== -1 &&
      this.props.apiKeyCount > limits.maxApiKeys
    ) {
      throw new Error(
        `Cannot downgrade: organization has ${this.props.apiKeyCount} API keys, new tier allows ${limits.maxApiKeys}`
      );
    }

    this.props.tier = proposedTier;
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Suspend organization
   */
  suspend(reason?: string): void {
    if (this.props.status === OrganizationStatus.SUSPENDED) {
      throw new Error('Organization is already suspended');
    }

    this.props.status = OrganizationStatus.SUSPENDED;
    this.props.updatedAt = new Date();
    this.props.statusReason = reason ?? 'suspended';
  }

  /**
   * Business Logic: Activate organization
   */
  activate(): void {
    if (this.props.status === OrganizationStatus.ACTIVE) {
      throw new Error('Organization is already active');
    }

    this.props.status = OrganizationStatus.ACTIVE;
    this.props.updatedAt = new Date();
    this.props.statusReason = undefined;
  }

  /**
   * Business Logic: Rename organization
   */
  rename(newName: string): void {
    if (!newName || newName.trim().length === 0) {
      throw new Error('Organization name cannot be empty');
    }

    if (newName.length > 100) {
      throw new Error('Organization name cannot exceed 100 characters');
    }

    this.props.name = newName.trim();
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Check if can add member
   */
  canAddMember(): boolean {
    const memberCount = this.props.memberCount || 0;
    return this.props.tier.canAddMember(memberCount);
  }

  /**
   * Business Logic: Check if can add API key
   */
  canAddApiKey(): boolean {
    const apiKeyCount = this.props.apiKeyCount || 0;
    return this.props.tier.canAddApiKey(apiKeyCount);
  }

  /**
   * Business Logic: Check if within request limit
   */
  isWithinRequestLimit(dailyRequests: number): boolean {
    return this.props.tier.isWithinRequestLimit(dailyRequests);
  }

  /**
   * Business Logic: Check if can use N models
   */
  canUseModels(modelCount: number): boolean {
    return this.props.tier.canUseModels(modelCount);
  }

  /**
   * Business Logic: Increment member count
   */
  incrementMemberCount(): void {
    if (!this.canAddMember()) {
      throw new Error('Cannot add member: tier limit reached');
    }

    this.props.memberCount = (this.props.memberCount || 0) + 1;
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Decrement member count
   */
  decrementMemberCount(): void {
    const current = this.props.memberCount || 0;

    if (current === 0) {
      throw new Error('Organization member count cannot be negative');
    }

    this.props.memberCount = current - 1;
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Increment API key count
   */
  incrementApiKeyCount(): void {
    if (!this.canAddApiKey()) {
      throw new Error('Cannot add API key: tier limit reached');
    }

    this.props.apiKeyCount = (this.props.apiKeyCount || 0) + 1;
    this.props.updatedAt = new Date();
  }

  /**
   * Query: Is active
   */
  isActive(): boolean {
    return this.props.status === OrganizationStatus.ACTIVE;
  }

  /**
   * Query: Is enterprise tier
   */
  isEnterprise(): boolean {
    return this.props.tier.getLevel() === TierLevel.ENTERPRISE;
  }

  /**
   * Getters
   */
  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get tier(): OrganizationTier {
    return this.props.tier;
  }

  get status(): OrganizationStatus {
    return this.props.status;
  }

  get statusReason(): string | undefined {
    return this.props.statusReason;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /**
   * To persistence DTO
   */
  toPersistence(): {
    id: string;
    name: string;
    tier: string;
    status: string;
    statusReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  } {
    const idValue = typeof this.props.id === 'string' ? this.props.id : `${this.props.id}`;
    return {
      id: idValue,
      name: this.props.name,
      tier: this.props.tier.getLevel(),
      status: this.props.status,
      statusReason: this.props.statusReason ?? null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    };
  }

  /**
   * To presentation DTO
   */
  toDTO(): {
    id: string;
    name: string;
    tier: string;
    tierLimits: {
      maxApiKeys: number;
      maxMembers: number;
      maxRequestsPerDay: number;
      maxModelsPerRequest: number;
      prioritySupport: boolean;
      customModels: boolean;
      advancedOrchestration: boolean;
    };
    status: string;
    statusReason: string | null;
    memberCount: number;
    apiKeyCount: number;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      id: this.props.id,
      name: this.props.name,
      tier: this.props.tier.getLevel(),
      tierLimits: this.props.tier.getLimits(),
      status: this.props.status,
      statusReason: this.props.statusReason ?? null,
      memberCount: this.props.memberCount || 0,
      apiKeyCount: this.props.apiKeyCount || 0,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
