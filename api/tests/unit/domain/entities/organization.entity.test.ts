// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OrganizationEntity - Unit Tests
 * Testing tier management, member/API key limits
 */

import { describe, it, expect } from 'vitest';
import { OrganizationEntity, OrganizationStatus } from '@/domain/entities/organization.entity';
import { TierLevel } from '@/domain/value-objects/organization-tier';

describe('OrganizationEntity', () => {
  const validData = {
    name: 'Acme Corporation',
    tier: TierLevel.PRO,
  };

  describe('Creation', () => {
    it('should create new organization with default tier (FREE)', () => {
      const org = OrganizationEntity.create({ name: 'Test Org' });
      
      expect(org).toBeInstanceOf(OrganizationEntity);
      expect(org.name).toBe('Test Org');
      expect(org.tier.getLevel()).toBe(TierLevel.FREE);
      expect(org.status).toBe(OrganizationStatus.ACTIVE);
    });

    it('should create with specified tier', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(org.tier.getLevel()).toBe(TierLevel.PRO);
    });

    it('should trim name', () => {
      const org = OrganizationEntity.create({
        name: '  Acme Corp  ',
      });
      
      expect(org.name).toBe('Acme Corp');
    });

    it('should initialize counts to zero', () => {
      const org = OrganizationEntity.create(validData);
      const dto = org.toDTO();
      
      expect(dto.memberCount).toBe(0);
      expect(dto.apiKeyCount).toBe(0);
    });
  });

  describe('Invariant Validation', () => {
    it('should reject empty name', () => {
      expect(() => OrganizationEntity.create({
        name: '',
      })).toThrow('Organization name cannot be empty');
    });

    it('should reject whitespace-only name', () => {
      expect(() => OrganizationEntity.create({
        name: '   ',
      })).toThrow('Organization name cannot be empty');
    });

    it('should reject name > 100 chars', () => {
      expect(() => OrganizationEntity.create({
        name: 'a'.repeat(101),
      })).toThrow('Organization name cannot exceed 100 characters');
    });
  });

  describe('Business Logic: Upgrade Tier', () => {
    it('should upgrade from FREE to PRO', () => {
      const org = OrganizationEntity.create({ name: 'Test Org' });
      
      org.upgradeTier(TierLevel.PRO);
      
      expect(org.tier.getLevel()).toBe(TierLevel.PRO);
    });

    it('should upgrade from PRO to ENTERPRISE', () => {
      const org = OrganizationEntity.create(validData);
      
      org.upgradeTier(TierLevel.ENTERPRISE);
      
      expect(org.tier.getLevel()).toBe(TierLevel.ENTERPRISE);
    });

    it('should throw if trying to downgrade via upgrade', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(() => org.upgradeTier(TierLevel.FREE)).toThrow('Can only upgrade to a higher tier');
    });

    it('should throw if upgrading to same tier', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(() => org.upgradeTier(TierLevel.PRO)).toThrow('Can only upgrade to a higher tier');
    });
  });

  describe('Business Logic: Downgrade Tier', () => {
    it('should downgrade from PRO to FREE if within limits', () => {
      const org = OrganizationEntity.create(validData);
      
      org.downgradeTier(TierLevel.FREE);
      
      expect(org.tier.getLevel()).toBe(TierLevel.FREE);
    });

    it('should throw if downgrade exceeds member limit', () => {
      const org = OrganizationEntity.reconstitute({
        id: 'org-123',
        name: 'Test Org',
        tier: 'pro',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberCount: 5, // PRO allows 10, FREE allows 1
        apiKeyCount: 1,
      });
      
      expect(() => org.downgradeTier(TierLevel.FREE)).toThrow('Cannot downgrade: organization has 5 members');
    });

    it('should throw if downgrade exceeds API key limit', () => {
      const org = OrganizationEntity.reconstitute({
        id: 'org-123',
        name: 'Test Org',
        tier: 'pro',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberCount: 1,
        apiKeyCount: 10, // PRO allows 20, FREE allows 2
      });
      
      expect(() => org.downgradeTier(TierLevel.FREE)).toThrow('Cannot downgrade: organization has 10 API keys');
    });

    it('should throw if trying to upgrade via downgrade', () => {
      const org = OrganizationEntity.create({ name: 'Test Org', tier: TierLevel.FREE });
      
      expect(() => org.downgradeTier(TierLevel.ENTERPRISE)).toThrow('Cannot downgrade to a higher tier');
    });
  });

  describe('Business Logic: Suspend/Activate', () => {
    it('should suspend active organization', () => {
      const org = OrganizationEntity.create(validData);
      
      org.suspend('Payment failure');
      
      expect(org.status).toBe(OrganizationStatus.SUSPENDED);
    });

    it('should throw if already suspended', () => {
      const org = OrganizationEntity.create(validData);
      org.suspend();
      
      expect(() => org.suspend()).toThrow('Organization is already suspended');
    });

    it('should activate suspended organization', () => {
      const org = OrganizationEntity.create(validData);
      org.suspend();
      
      org.activate();
      
      expect(org.status).toBe(OrganizationStatus.ACTIVE);
    });

    it('should throw if already active', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(() => org.activate()).toThrow('Organization is already active');
    });
  });

  describe('Business Logic: Rename', () => {
    it('should rename organization', () => {
      const org = OrganizationEntity.create(validData);
      
      org.rename('New Company Name');
      
      expect(org.name).toBe('New Company Name');
    });

    it('should trim whitespace', () => {
      const org = OrganizationEntity.create(validData);
      
      org.rename('  New Name  ');
      
      expect(org.name).toBe('New Name');
    });

    it('should reject empty name', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(() => org.rename('')).toThrow('Organization name cannot be empty');
    });

    it('should reject name > 100 chars', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(() => org.rename('a'.repeat(101))).toThrow('Organization name cannot exceed 100 characters');
    });
  });

  describe('Business Logic: Add Member/API Key', () => {
    it('should allow adding member within limit', () => {
      const org = OrganizationEntity.create(validData); // PRO = 10 members
      
      expect(org.canAddMember()).toBe(true);
      
      org.incrementMemberCount();
      
      const dto = org.toDTO();
      expect(dto.memberCount).toBe(1);
    });

    it('should throw if member limit exceeded', () => {
      const org = OrganizationEntity.reconstitute({
        id: 'org-123',
        name: 'Test Org',
        tier: 'pro',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberCount: 10, // Limit reached
        apiKeyCount: 0,
      });
      
      expect(() => org.incrementMemberCount()).toThrow('Cannot add member: tier limit reached');
    });

    it('should allow adding API key within limit', () => {
      const org = OrganizationEntity.create(validData); // PRO = 20 keys
      
      expect(org.canAddApiKey()).toBe(true);
      
      org.incrementApiKeyCount();
      
      const dto = org.toDTO();
      expect(dto.apiKeyCount).toBe(1);
    });

    it('should throw if API key limit exceeded', () => {
      const org = OrganizationEntity.reconstitute({
        id: 'org-123',
        name: 'Test Org',
        tier: 'pro',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberCount: 0,
        apiKeyCount: 20, // Limit reached
      });
      
      expect(() => org.incrementApiKeyCount()).toThrow('Cannot add API key: tier limit reached');
    });
  });

  describe('Business Logic: Request Limits', () => {
    it('should check if within daily request limit', () => {
      const org = OrganizationEntity.create(validData); // PRO = 100k/day
      
      expect(org.isWithinRequestLimit(50000)).toBe(true);
      expect(org.isWithinRequestLimit(100000)).toBe(false);
    });

    it('should check model count limit', () => {
      const org = OrganizationEntity.create(validData); // PRO = 6 models
      
      expect(org.canUseModels(6)).toBe(true);
      expect(org.canUseModels(7)).toBe(false);
    });

    it('should allow 9 models for ENTERPRISE', () => {
      const org = OrganizationEntity.create({
        name: 'Enterprise Corp',
        tier: TierLevel.ENTERPRISE,
      });
      
      expect(org.canUseModels(9)).toBe(true);
      expect(org.canUseModels(10)).toBe(false);
    });
  });

  describe('Query Methods', () => {
    it('should check if active', () => {
      const org = OrganizationEntity.create(validData);
      
      expect(org.isActive()).toBe(true);
      
      org.suspend();
      expect(org.isActive()).toBe(false);
    });

    it('should check if enterprise tier', () => {
      const org = OrganizationEntity.create({
        name: 'Test',
        tier: TierLevel.ENTERPRISE,
      });
      
      expect(org.isEnterprise()).toBe(true);
    });

    it('should return false for non-enterprise', () => {
      const org = OrganizationEntity.create(validData); // PRO
      
      expect(org.isEnterprise()).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should convert to persistence DTO', () => {
      const org = OrganizationEntity.create(validData);
      const dto = org.toPersistence();
      
      expect(dto.id).toBeDefined();
      expect(dto.name).toBe('Acme Corporation');
      expect(dto.tier).toBe('pro');
      expect(dto.status).toBe('active');
      expect(dto.createdAt).toBeInstanceOf(Date);
    });

    it('should convert to presentation DTO with tier limits', () => {
      const org = OrganizationEntity.create(validData);
      const dto = org.toDTO();
      
      expect(dto.id).toBeDefined();
      expect(dto.name).toBe('Acme Corporation');
      expect(dto.tier).toBe('pro');
      expect(dto.tierLimits).toBeDefined();
      expect(dto.tierLimits.maxApiKeys).toBe(20);
      expect(dto.memberCount).toBe(0);
      expect(dto.apiKeyCount).toBe(0);
      expect(dto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

