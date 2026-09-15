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

import { TIER_CONFIGS } from '@/config/multi-tenancy-config';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'organization-tier' });

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
   *
   * `prioritySupport`/`customModels`/`advancedOrchestration` are sourced
   * from TIER_CONFIGS (multi-tenancy-config.ts, the API-gateway's own tier
   * table) rather than a second independent copy here (cross-repo
   * quota/tier follow-up, item 1) -- these 3 fields are the only ones both
   * tables represent, and having two meant they could (and did: TIER_CONFIGS
   * once said PRO's prioritySupport/customModels were false while this table
   * always said true, per this file's own long-standing tests) silently
   * drift apart. `maxApiKeys`/`maxMembers`/`maxRequestsPerDay`/
   * `maxModelsPerRequest` stay defined here: they are genuinely domain-only
   * concepts (organization-level business limits) with no TIER_CONFIGS
   * analogue -- that table is infra-shaped (connections, storage,
   * requests/time), not domain-shaped.
   */
  private static getLimitsForTier(tier: TierLevel): TierLimits {
    const features = TIER_CONFIGS[tier]?.features;

    switch (tier) {
      case TierLevel.FREE:
        return {
          maxApiKeys: 2,
          maxMembers: 1,
          maxRequestsPerDay: 1000,
          maxModelsPerRequest: 1,
          prioritySupport: features?.prioritySupport ?? false,
          customModels: features?.customModels ?? false,
          advancedOrchestration: features?.advancedOrchestration ?? false,
        };

      case TierLevel.STARTER:
        return {
          maxApiKeys: 5,
          maxMembers: 3,
          maxRequestsPerDay: 10000,
          maxModelsPerRequest: 3,
          prioritySupport: features?.prioritySupport ?? false,
          customModels: features?.customModels ?? false,
          advancedOrchestration: features?.advancedOrchestration ?? true,
        };

      case TierLevel.PRO:
        return {
          maxApiKeys: 20,
          maxMembers: 10,
          maxRequestsPerDay: 100000,
          maxModelsPerRequest: 6,
          prioritySupport: features?.prioritySupport ?? true,
          customModels: features?.customModels ?? true,
          advancedOrchestration: features?.advancedOrchestration ?? true,
        };

      case TierLevel.ENTERPRISE:
        return {
          maxApiKeys: -1, // Unlimited
          maxMembers: -1, // Unlimited
          maxRequestsPerDay: -1, // Unlimited
          maxModelsPerRequest: 9,
          prioritySupport: features?.prioritySupport ?? true,
          customModels: features?.customModels ?? true,
          advancedOrchestration: features?.advancedOrchestration ?? true,
        };

      default:
        // Fail-closed, not silently-undefined: this switch used to have no
        // default, so a tier value that doesn't match any TierLevel member
        // (bad/legacy DB data -- e.g. the schema comment's stale "team" --
        // a typo, or a future tier removed/renamed without a migration)
        // made this function return `undefined`. Every caller
        // (canAddApiKey/canAddMember/isWithinRequestLimit/canUseModels/
        // hasFeature) then threw a TypeError reading a property off
        // `undefined`, turning one bad row into an unhandled 500. Treat the
        // unknown tier as the most restrictive real tier (FREE) instead, and
        // log loudly so the bad data actually gets noticed and fixed.
        log.error(
          { tier },
          `Unknown organization tier "${String(tier)}" — falling back to FREE limits`
        );
        return OrganizationTier.getLimitsForTier(TierLevel.FREE);
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
