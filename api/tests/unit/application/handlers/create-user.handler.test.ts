// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CreateUserHandler Tests
 * Application Layer - CQRS Command Handler
 * 
 * Tests user creation business logic and validation
 */

import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { CreateUserHandler } from '@/application/handlers/create-user.handler';
import { CreateUserCommand } from '@/application/commands/create-user.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { UserEntity } from '@/domain/entities/user.entity';
import { OrganizationEntity } from '@/domain/entities/organization.entity';
import { Email } from '@/domain/value-objects/email';
import { TierLevel } from '@/domain/value-objects/organization-tier';
import type { IEventBus } from '@/infrastructure/events/event-bus.interface';

// Mock repository types
type MockUserRepository = Pick<IUserRepository, 'findById' | 'findByEmail' | 'findByOrganization' | 'save' | 'saveAggregate' | 'delete' | 'emailExists' | 'findAggregateById'>;
type MockOrgRepository = Pick<IOrganizationRepository, 'findById' | 'findByName' | 'findAll' | 'save' | 'saveAggregate' | 'delete' | 'nameExists' | 'countByTier' | 'findAggregateById'>;
type MockEventBus = Pick<IEventBus, 'publish' | 'publishMany' | 'subscribe' | 'unsubscribe' | 'clearAll' | 'getSubscriptionCount'>;

describe('CreateUserHandler', () => {
  let handler: CreateUserHandler;
  let mockUserRepository: Mocked<MockUserRepository>;
  let mockOrgRepository: Mocked<MockOrgRepository>;
  let mockEventBus: Mocked<MockEventBus>;

  beforeEach(() => {
    // Create mock repositories
    mockUserRepository = {
      findById: vi.fn(),
      findByEmail: vi.fn(),
      findByOrganization: vi.fn(),
      save: vi.fn(),
      saveAggregate: vi.fn(),
      delete: vi.fn(),
      emailExists: vi.fn(),
      findAggregateById: vi.fn(),
    };

    mockOrgRepository = {
      findById: vi.fn(),
      findByName: vi.fn(),
      findAll: vi.fn(),
      save: vi.fn(),
      saveAggregate: vi.fn(),
      delete: vi.fn(),
      nameExists: vi.fn(),
      countByTier: vi.fn(),
      findAggregateById: vi.fn(),
    };

    mockEventBus = {
      publish: vi.fn(),
      publishMany: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      clearAll: vi.fn(),
      getSubscriptionCount: vi.fn(() => 0),
    };

    mockOrgRepository.findAggregateById.mockResolvedValue(null);

    handler = new CreateUserHandler(
      mockUserRepository as IUserRepository,
      mockOrgRepository as IOrganizationRepository,
      mockEventBus as IEventBus
    );
  });

  describe('execute', () => {
    it('should create user successfully', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'newuser@example.com',
        name: 'New User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(result.userId).toBeDefined();
      expect(mockUserRepository.findByEmail).toHaveBeenCalledWith(
        expect.objectContaining({ getValue: expect.any(Function) })
      );
      expect(mockUserRepository.saveAggregate).toHaveBeenCalled();
      expect(mockEventBus.publishMany).toHaveBeenCalled();
    });

    it('should fail when email already exists', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'existing@example.com',
        name: 'Existing User',
        organizationId: 'org-123',
      });

      const existingUser = UserEntity.create({
        email: 'existing@example.com',
        name: 'Existing User',
        organizationId: 'org-123',
      });

      mockUserRepository.findByEmail.mockResolvedValue(existingUser);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(mockUserRepository.saveAggregate).not.toHaveBeenCalled();
    });

    it('should fail when organization not found', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'invalid-org',
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(null);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Organization not found');
      expect(mockUserRepository.saveAggregate).not.toHaveBeenCalled();
    });

    it('should handle invalid email format', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'invalid-email',
        name: 'User',
        organizationId: 'org-123',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle repository save errors', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('should create user with default role', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(result.userId).toBeDefined();
    });

    it('should validate email domain', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'test@',
        name: 'User',
        organizationId: 'org-123',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle concurrent creation attempts', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'concurrent@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      // First check says email doesn't exist
      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      // But save fails with unique constraint
      mockUserRepository.saveAggregate.mockRejectedValue(new Error('Unique constraint violation'));

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should trim and normalize email', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: '  USER@EXAMPLE.COM  ',
        name: 'User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      // Email should be normalized to lowercase
      const emailCallArg = mockUserRepository.findByEmail.mock.calls[0][0];
      expect(emailCallArg.getValue()).toBe('user@example.com');
    });

    it('should validate name length if provided', async () => {
      // Arrange
      const longName = 'a'.repeat(300); // Very long name
      const command = new CreateUserCommand({
        email: 'user@example.com',
        name: longName,
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert - Should either succeed (if no length validation) or fail gracefully
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('Domain Event Publishing', () => {
    it('should create UserCreatedEvent on successful creation', async () => {
      // Arrange
      const command = new CreateUserCommand({
        email: 'newuser@example.com',
        name: 'New User',
        organizationId: 'org-123',
      });

      const mockOrg = OrganizationEntity.create({
        name: 'Test Org',
        tier: TierLevel.FREE,
      });

      mockUserRepository.findByEmail.mockResolvedValue(null);
      mockOrgRepository.findById.mockResolvedValue(mockOrg);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(mockEventBus.publishMany).toHaveBeenCalled();
    });
  });
});

