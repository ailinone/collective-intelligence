// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OrganizationTier Value Object - Unit Tests
 * Testing tier limits and business rules
 */

import { describe, it, expect } from 'vitest';
import { OrganizationTier, TierLevel } from '@/domain/value-objects/organization-tier';

describe('OrganizationTier', () => {
  describe('Creation', () => {
    it('should create FREE tier', () => {
      const tier = OrganizationTier.create(TierLevel.FREE);
      
      expect(tier.getLevel()).toBe(TierLevel.FREE);
      const limits = tier.getLimits();
      expect(limits.maxApiKeys).toBe(2);
      expect(limits.maxMembers).toBe(1);
      expect(limits.maxRequestsPerDay).toBe(1000);
      expect(limits.maxModelsPerRequest).toBe(1);
      expect(limits.prioritySupport).toBe(false);
    });

    it('should create STARTER tier', () => {
      const tier = OrganizationTier.create(TierLevel.STARTER);
      
      expect(tier.getLevel()).toBe(TierLevel.STARTER);
      const limits = tier.getLimits();
      expect(limits.maxApiKeys).toBe(5);
      expect(limits.maxMembers).toBe(3);
      expect(limits.maxRequestsPerDay).toBe(10000);
      expect(limits.maxModelsPerRequest).toBe(3);
      expect(limits.advancedOrchestration).toBe(true);
    });

    it('should create PRO tier', () => {
      const tier = OrganizationTier.create(TierLevel.PRO);
      
      expect(tier.getLevel()).toBe(TierLevel.PRO);
      const limits = tier.getLimits();
      expect(limits.maxApiKeys).toBe(20);
      expect(limits.maxMembers).toBe(10);
      expect(limits.maxRequestsPerDay).toBe(100000);
      expect(limits.maxModelsPerRequest).toBe(6);
      expect(limits.prioritySupport).toBe(true);
      expect(limits.customModels).toBe(true);
    });

    it('should create ENTERPRISE tier', () => {
      const tier = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(tier.getLevel()).toBe(TierLevel.ENTERPRISE);
      const limits = tier.getLimits();
      expect(limits.maxApiKeys).toBe(-1); // Unlimited
      expect(limits.maxMembers).toBe(-1); // Unlimited
      expect(limits.maxRequestsPerDay).toBe(-1); // Unlimited
      expect(limits.maxModelsPerRequest).toBe(9);
      expect(limits.prioritySupport).toBe(true);
      expect(limits.customModels).toBe(true);
      expect(limits.advancedOrchestration).toBe(true);
    });
  });

  describe('Limit Validation: API Keys', () => {
    it('should allow adding API key within limit (FREE)', () => {
      const tier = OrganizationTier.create(TierLevel.FREE);
      
      expect(tier.canAddApiKey(0)).toBe(true);
      expect(tier.canAddApiKey(1)).toBe(true);
      expect(tier.canAddApiKey(2)).toBe(false); // Limit reached
    });

    it('should allow unlimited API keys (ENTERPRISE)', () => {
      const tier = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(tier.canAddApiKey(0)).toBe(true);
      expect(tier.canAddApiKey(100)).toBe(true);
      expect(tier.canAddApiKey(10000)).toBe(true); // Unlimited
    });
  });

  describe('Limit Validation: Members', () => {
    it('should allow adding member within limit (STARTER)', () => {
      const tier = OrganizationTier.create(TierLevel.STARTER);
      
      expect(tier.canAddMember(0)).toBe(true);
      expect(tier.canAddMember(2)).toBe(true);
      expect(tier.canAddMember(3)).toBe(false); // Limit reached
    });

    it('should allow unlimited members (ENTERPRISE)', () => {
      const tier = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(tier.canAddMember(1000)).toBe(true); // Unlimited
    });
  });

  describe('Limit Validation: Daily Requests', () => {
    it('should enforce daily request limit (FREE)', () => {
      const tier = OrganizationTier.create(TierLevel.FREE);
      
      expect(tier.isWithinRequestLimit(999)).toBe(true);
      expect(tier.isWithinRequestLimit(1000)).toBe(false); // Limit reached
    });

    it('should allow unlimited requests (ENTERPRISE)', () => {
      const tier = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(tier.isWithinRequestLimit(1000000)).toBe(true); // Unlimited
    });
  });

  describe('Limit Validation: Models Per Request', () => {
    it('should enforce model limit (FREE)', () => {
      const tier = OrganizationTier.create(TierLevel.FREE);
      
      expect(tier.canUseModels(1)).toBe(true);
      expect(tier.canUseModels(2)).toBe(false);
    });

    it('should allow up to 9 models (ENTERPRISE)', () => {
      const tier = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(tier.canUseModels(9)).toBe(true);
      expect(tier.canUseModels(10)).toBe(false); // Even enterprise has limit
    });
  });

  describe('Feature Availability', () => {
    it('should check priority support (PRO)', () => {
      const tier = OrganizationTier.create(TierLevel.PRO);
      expect(tier.hasFeature('prioritySupport')).toBe(true);
    });

    it('should check custom models (FREE)', () => {
      const tier = OrganizationTier.create(TierLevel.FREE);
      expect(tier.hasFeature('customModels')).toBe(false);
    });

    it('should check advanced orchestration (STARTER)', () => {
      const tier = OrganizationTier.create(TierLevel.STARTER);
      expect(tier.hasFeature('advancedOrchestration')).toBe(true);
    });
  });

  describe('Comparison', () => {
    it('should compare tiers (higher than)', () => {
      const free = OrganizationTier.create(TierLevel.FREE);
      const pro = OrganizationTier.create(TierLevel.PRO);
      
      expect(pro.isHigherThan(free)).toBe(true);
      expect(free.isHigherThan(pro)).toBe(false);
    });

    it('should not be higher than same tier', () => {
      const pro1 = OrganizationTier.create(TierLevel.PRO);
      const pro2 = OrganizationTier.create(TierLevel.PRO);
      
      expect(pro1.isHigherThan(pro2)).toBe(false);
    });

    it('should order tiers correctly', () => {
      const free = OrganizationTier.create(TierLevel.FREE);
      const starter = OrganizationTier.create(TierLevel.STARTER);
      const pro = OrganizationTier.create(TierLevel.PRO);
      const enterprise = OrganizationTier.create(TierLevel.ENTERPRISE);
      
      expect(enterprise.isHigherThan(pro)).toBe(true);
      expect(pro.isHigherThan(starter)).toBe(true);
      expect(starter.isHigherThan(free)).toBe(true);
    });
  });

  describe('Equality', () => {
    it('should be equal if same tier', () => {
      const tier1 = OrganizationTier.create(TierLevel.PRO);
      const tier2 = OrganizationTier.create(TierLevel.PRO);
      
      expect(tier1.equals(tier2)).toBe(true);
    });

    it('should not be equal if different tiers', () => {
      const free = OrganizationTier.create(TierLevel.FREE);
      const pro = OrganizationTier.create(TierLevel.PRO);
      
      expect(free.equals(pro)).toBe(false);
    });
  });

  describe('Immutability', () => {
    it('should return copy of limits (prevent mutation)', () => {
      const tier = OrganizationTier.create(TierLevel.PRO);
      const limits1 = tier.getLimits();
      const limits2 = tier.getLimits();
      
      // Should be different objects (copies)
      expect(limits1).not.toBe(limits2);
      
      // But same values
      expect(limits1.maxApiKeys).toBe(limits2.maxApiKeys);
    });

    it('should not allow mutation of returned limits', () => {
      const tier = OrganizationTier.create(TierLevel.PRO);
      const limits = tier.getLimits();
      
      // Modify returned object
      const mutableLimits = limits as Record<string, unknown>;
      mutableLimits.maxApiKeys = 999;
      
      // Original should not be affected
      expect(tier.getLimits().maxApiKeys).toBe(20); // Still 20
    });
  });
});

