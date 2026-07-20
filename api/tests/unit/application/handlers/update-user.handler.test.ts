// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * UpdateUserHandler Tests
 * Application Layer - CQRS Command Handler
 * 
 * Tests user update business logic
 */

import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { UpdateUserHandler } from '@/application/handlers/update-user.handler';
import { UpdateUserCommand } from '@/application/commands/update-user.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserEntity, UserRole } from '@/domain/entities/user.entity';
import { UserId } from '@/domain/value-objects/user-id';

describe('UpdateUserHandler', () => {
  let handler: UpdateUserHandler;
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

    handler = new UpdateUserHandler(mockUserRepository);
  });

  describe('execute', () => {
    it('should update user name successfully', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {
        name: 'Updated Name',
      });

      const existingUser = UserEntity.create({
        email: 'user@example.com',
        name: 'Old Name',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(existingUser);
      mockUserRepository.save.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(mockUserRepository.save).toHaveBeenCalled();
      const savedUser = mockUserRepository.save.mock.calls[0][0];
      expect(savedUser.name).toBe('Updated Name');
    });

    it('should fail when user not found', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {
        name: 'New Name',
      });

      mockUserRepository.findById.mockResolvedValue(null);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });

    it('should handle empty updates gracefully', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {});

      const existingUser = UserEntity.create({
        email: 'user@example.com',
        name: 'Old Name',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(existingUser);
      mockUserRepository.save.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      // Should still save even with no changes (updates timestamp)
    });

    it('should handle repository save errors', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {
        name: 'New Name',
      });

      const existingUser = UserEntity.create({
        email: 'user@example.com',
        name: 'Old Name',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(existingUser);
      mockUserRepository.save.mockRejectedValue(new Error('Save failed'));

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed');
    });

    it('should validate invalid userId format', async () => {
      // Arrange
      const command = new UpdateUserCommand('invalid-uuid', {
        name: 'New Name',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should trim whitespace from name', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {
        name: '  Trimmed Name  ',
      });

      const existingUser = UserEntity.create({
        email: 'user@example.com',
        name: '  Old Name  ',
        organizationId: 'org-123',
      });

      mockUserRepository.findById.mockResolvedValue(existingUser);
      mockUserRepository.save.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      const savedUser = mockUserRepository.save.mock.calls[0][0];
      expect(savedUser.name).toBe('Trimmed Name');
    });

    it('should update updatedAt timestamp', async () => {
      // Arrange
      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const command = new UpdateUserCommand(userId, {
        name: 'New Name',
      });

      const existingUser = UserEntity.create({
        email: 'user@example.com',
        name: 'Old Name',
        organizationId: 'org-123',
      });

      const oldUpdatedAt = existingUser.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      mockUserRepository.findById.mockResolvedValue(existingUser);
      mockUserRepository.save.mockResolvedValue(undefined);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      const savedUser = mockUserRepository.save.mock.calls[0][0];
      expect(savedUser.updatedAt.getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
    });
  });
});

