// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GetUserHandler Tests
 * Application Layer - CQRS Query Handler
 * 
 * Tests user retrieval (read-only operations)
 */

import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { GetUserHandler } from '@/application/handlers/get-user.handler';
import { GetUserQuery } from '@/application/queries/get-user.query';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserEntity, UserRole } from '@/domain/entities/user.entity';

describe('GetUserHandler', () => {
  let handler: GetUserHandler;
  let mockUserRepository: Mocked<IUserRepository>;

  beforeEach(() => {
    mockUserRepository = {
      findById: vi.fn(),
      findByEmail: vi.fn(),
      findByOrganization: vi.fn(),
      save: vi.fn(),
      saveAggregate: vi.fn(),
      findAggregateById: vi.fn(),
      delete: vi.fn(),
      emailExists: vi.fn(),
    } as Mocked<IUserRepository>;

    handler = new GetUserHandler(mockUserRepository);
  });

  describe('execute', () => {
    it('should get user successfully', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      const mockUser = UserEntity.create({
        email: 'user@example.com',
        name: 'Test User',
        organizationId: 'org-123',
        role: UserRole.USER,
      });

      mockUserRepository.findById.mockResolvedValue(mockUser);

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.email).toBe('user@example.com');
      expect(result.user?.name).toBe('Test User');
      expect(result.user?.role).toBe('user');
    });

    it('should return error when user not found', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      mockUserRepository.findById.mockResolvedValue(null);

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.user).toBeUndefined();
    });

    it('should handle invalid userId format', async () => {
      // Arrange
      const query = new GetUserQuery({ userId: 'invalid-uuid' });

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return user DTO with correct format', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      const mockUser = UserEntity.create({
        email: 'dto@example.com',
        name: 'DTO User',
        organizationId: 'org-123',
        role: UserRole.ADMIN,
      });

      mockUserRepository.findById.mockResolvedValue(mockUser);

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(true);
      expect(result.user).toMatchObject({
        email: 'dto@example.com',
        name: 'DTO User',
        role: 'admin',
        status: 'active',
        organizationId: 'org-123',
      });
      expect(result.user?.createdAt).toBeDefined();
      expect(result.user?.updatedAt).toBeDefined();
    });

    it('should handle repository errors', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      mockUserRepository.findById.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('should not expose sensitive data in DTO', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      const mockUser = UserEntity.create({
        email: 'sensitive@example.com',
        name: 'Sensitive User',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(mockUser);

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(true);
      // DTO should not contain internal domain objects
      expect(result.user).not.toHaveProperty('_email');
      expect(result.user).not.toHaveProperty('_events');
    });

    it('should handle suspended users', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      const mockUser = UserEntity.create({
        email: 'suspended@example.com',
        name: 'Suspended User',
        organizationId: 'org-123',
      });
      mockUser.suspend();

      mockUserRepository.findById.mockResolvedValue(mockUser);

      // Act
      const result = await handler.execute(query);

      // Assert
      expect(result.success).toBe(true);
      expect(result.user?.status).toBe('suspended');
    });

    it('should be idempotent (read-only)', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const query = new GetUserQuery({ userId });

      const mockUser = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(mockUser);

      // Act
      await handler.execute(query);
      await handler.execute(query);

      // Assert - Should not call save (read-only)
      expect(mockUserRepository.save).not.toHaveBeenCalled();
      expect(mockUserRepository.saveAggregate).not.toHaveBeenCalled();
    });
  });
});

