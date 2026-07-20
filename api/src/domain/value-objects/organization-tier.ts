// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OrganizationTier Value Object
 * Represents organization subscription tier with associated limits
 *
 * DDD Pattern: Value Object
 */

export enum TierLevel {
  FREE = 'free',
  STARTER = 'starter',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export interface TierLimits {
  maxApiKeys: number;
  maxMembers: number;
  maxRequestsPerDay: number;
  maxModelsPerRequest: number;
  prioritySupport: boolean;
  customModels: boolean;
  advancedOrchestration: boolean;
}

export class OrganizationTier {
  private readonly level: TierLevel;
  private readonly limits: TierLimits;

  private constructor(level: TierLevel, limits: TierLimits) {
    this.level = level;
    this.limits = limits;
  }

  /**
   * Create tier from level
   */
  static create(level: TierLevel): OrganizationTier {
    const limits = OrganizationTier.getLimitsForTier(level);
    return new OrganizationTier(level, limits);
  }

  /**
   * Get default limits for each tier
   */
  private static getLimitsForTier(tier: TierLevel): TierLimits {
    switch (tier) {
      case TierLevel.FREE:
        return {
          maxApiKeys: 2,
          maxMembers: 1,
          maxRequestsPerDay: 1000,
          maxModelsPerRequest: 1,
          prioritySupport: false,
          customModels: false,
          advancedOrchestration: false,
        };

      case TierLevel.STARTER:
        return {
          maxApiKeys: 5,
          maxMembers: 3,
          maxRequestsPerDay: 10000,
          maxModelsPerRequest: 3,
          prioritySupport: false,
          customModels: false,
          advancedOrchestration: true,
        };

      case TierLevel.PRO:
        return {
          maxApiKeys: 20,
          maxMembers: 10,
          maxRequestsPerDay: 100000,
          maxModelsPerRequest: 6,
          prioritySupport: true,
          customModels: true,
          advancedOrchestration: true,
        };

      case TierLevel.ENTERPRISE:
        return {
          maxApiKeys: -1, // Unlimited
          maxMembers: -1, // Unlimited
          maxRequestsPerDay: -1, // Unlimited
          maxModelsPerRequest: 9,
          prioritySupport: true,
          customModels: true,
          advancedOrchestration: true,
        };
    }
  }

  /**
   * Check if can add API key
   */
  canAddApiKey(currentCount: number): boolean {
    if (this.limits.maxApiKeys === -1) {
      return true; // Unlimited
    }
    return currentCount < this.limits.maxApiKeys;
  }

  /**
   * Check if can add member
   */
  canAddMember(currentCount: number): boolean {
    if (this.limits.maxMembers === -1) {
      return true; // Unlimited
    }
    return currentCount < this.limits.maxMembers;
  }

  /**
   * Check if within daily request limit
   */
  isWithinRequestLimit(dailyRequests: number): boolean {
    if (this.limits.maxRequestsPerDay === -1) {
      return true; // Unlimited
    }
    return dailyRequests < this.limits.maxRequestsPerDay;
  }

  /**
   * Check if can use N models
   */
  canUseModels(modelCount: number): boolean {
    return modelCount <= this.limits.maxModelsPerRequest;
  }

  /**
   * Check if feature is available
   */
  hasFeature(
    feature: keyof Omit<
      TierLimits,
      'maxApiKeys' | 'maxMembers' | 'maxRequestsPerDay' | 'maxModelsPerRequest'
    >
  ): boolean {
    return this.limits[feature] === true;
  }

  /**
   * Getters
   */
  getLevel(): TierLevel {
    return this.level;
  }

  getLimits(): Readonly<TierLimits> {
    return { ...this.limits }; // Return copy to prevent mutation
  }

  /**
   * Equality
   */
  equals(other: OrganizationTier): boolean {
    if (!(other instanceof OrganizationTier)) {
      return false;
    }
    return this.level === other.level;
  }

  /**
   * Comparison
   */
  isHigherThan(other: OrganizationTier): boolean {
    const tierOrder: Record<TierLevel, number> = {
      [TierLevel.FREE]: 0,
      [TierLevel.STARTER]: 1,
      [TierLevel.PRO]: 2,
      [TierLevel.ENTERPRISE]: 3,
    };

    return tierOrder[this.level] > tierOrder[other.level];
  }

  /**
   * String representation
   */
  toString(): string {
    return this.level;
  }

  /**
   * JSON serialization
   */
  toJSON(): string {
    return this.level;
  }
}
