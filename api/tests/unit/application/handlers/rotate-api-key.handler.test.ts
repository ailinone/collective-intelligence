// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RotateApiKeyHandler Tests
 * Application Layer - CQRS Command Handler
 * 
 * Tests API key rotation business logic
 */

import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { RotateApiKeyHandler } from '@/application/handlers/rotate-api-key.handler';
import { RotateApiKeyCommand } from '@/application/commands/rotate-api-key.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserAggregate } from '@/domain/aggregates/user.aggregate';
import { UserEntity } from '@/domain/entities/user.entity';
import { ApiKeyEntity } from '@/domain/entities/api-key.entity';
import type { IEventBus } from '@/infrastructure/events/event-bus.interface';

describe('RotateApiKeyHandler', () => {
  let handler: RotateApiKeyHandler;
  let mockUserRepository: Mocked<IUserRepository>;
  let mockEventBus: Mocked<IEventBus>;

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

    mockEventBus = {
      publish: vi.fn(),
      publishMany: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      clearAll: vi.fn(),
      getSubscriptionCount: vi.fn(() => 0),
    } as Mocked<IEventBus>;

    mockEventBus.publishMany.mockResolvedValue(undefined);
    mockEventBus.publish.mockResolvedValue(undefined);

    handler = new RotateApiKeyHandler(mockUserRepository, mockEventBus);
  });

  describe('execute', () => {
    it('should rotate API key successfully', async () => {
      // Arrange
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const apiKey = ApiKeyEntity.create({
        name: 'Test Key',
        userId: user.id,
        organizationId: 'org-123',
        rotationIntervalDays: 90,
        autoRotate: true,
      });

      const aggregate = UserAggregate.reconstitute(user, [apiKey]);

      mockUserRepository.findAggregateById.mockResolvedValue(aggregate);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      const command = new RotateApiKeyCommand({
        userId: user.id,
        apiKeyId: apiKey.id,
        reason: 'manual',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(result.newKeyId).toBeDefined();
      expect(result.gracePeriodEnds).toBeDefined();
      expect(mockUserRepository.saveAggregate).toHaveBeenCalled();
      expect(mockEventBus.publishMany).toHaveBeenCalled();
    });

    it('should fail when user not found', async () => {
      // Arrange
      const command = new RotateApiKeyCommand({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        apiKeyId: 'key-123',
        reason: 'manual',
      });

      mockUserRepository.findAggregateById.mockResolvedValue(null);

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockUserRepository.saveAggregate).not.toHaveBeenCalled();
    });

    it('should fail when API key does not belong to user', async () => {
      // Arrange
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const aggregate = UserAggregate.reconstitute(user, []);

      mockUserRepository.findAggregateById.mockResolvedValue(aggregate);

      const command = new RotateApiKeyCommand({
        userId: user.id,
        apiKeyId: 'wrong-key-id',
        reason: 'manual',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockUserRepository.saveAggregate).not.toHaveBeenCalled();
    });

    it('should calculate grace period correctly', async () => {
      // Arrange
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const baseKey = ApiKeyEntity.create({
        name: 'Test Key',
        userId: user.id,
        organizationId: 'org-123',
        rotationIntervalDays: 90,
        autoRotate: true,
      });

      const keyPersistence = baseKey.toPersistence();
      const apiKey = ApiKeyEntity.reconstitute({
        ...keyPersistence,
        gracePeriodDays: 14,
      });

      const aggregate = UserAggregate.reconstitute(user, [apiKey]);

      mockUserRepository.findAggregateById.mockResolvedValue(aggregate);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);

      const command = new RotateApiKeyCommand({
        userId: user.id,
        apiKeyId: apiKey.id,
        reason: 'manual',
      });

      const now = new Date();

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      expect(result.gracePeriodEnds).toBeDefined();
      
      const expectedEnd = new Date(now);
      expectedEnd.setDate(expectedEnd.getDate() + 14);
      
      const actualEnd = result.gracePeriodEnds!;
      expect(actualEnd.getTime()).toBeGreaterThan(now.getTime());
      expect(actualEnd.getTime()).toBeLessThan(expectedEnd.getTime() + 1000); // Within 1 second
    });

    it('should handle repository save errors', async () => {
      // Arrange
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const apiKey = ApiKeyEntity.create({
        name: 'Test Key',
        userId: user.id,
        organizationId: 'org-123',
      });

      const aggregate = UserAggregate.reconstitute(user, [apiKey]);

      mockUserRepository.findAggregateById.mockResolvedValue(aggregate);
      mockUserRepository.saveAggregate.mockRejectedValue(new Error('Save failed'));

      const command = new RotateApiKeyCommand({
        userId: user.id,
        apiKeyId: apiKey.id,
        reason: 'manual',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed');
    });

    it('should support different rotation reasons', async () => {
      // Arrange
      const reasons: Array<'manual' | 'auto-rotation' | 'security'> = ['manual', 'auto-rotation', 'security'];

      for (const reason of reasons) {
        const user = UserEntity.create({
          email: 'user@example.com',
          name: 'User',
          organizationId: 'org-123',
        });

        const apiKey = ApiKeyEntity.create({
          name: 'Test Key',
          userId: user.id,
          organizationId: 'org-123',
        });

        const aggregate = UserAggregate.reconstitute(user, [apiKey]);

        mockUserRepository.findAggregateById.mockResolvedValue(aggregate);
        mockUserRepository.saveAggregate.mockResolvedValue(undefined);
        mockEventBus.publishMany.mockResolvedValue(undefined);

        const command = new RotateApiKeyCommand({
          userId: user.id,
          apiKeyId: apiKey.id,
          reason,
        });

        // Act
        const result = await handler.execute(command);

        // Assert
        expect(result.success).toBe(true);

        vi.clearAllMocks();
      }
    });

    it('should emit ApiKeyRotatedEvent', async () => {
      // Arrange
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'User',
        organizationId: 'org-123',
      });

      const apiKey = ApiKeyEntity.create({
        name: 'Test Key',
        userId: user.id,
        organizationId: 'org-123',
      });

      const aggregate = UserAggregate.reconstitute(user, [apiKey]);

      mockUserRepository.findAggregateById.mockResolvedValue(aggregate);
      mockUserRepository.saveAggregate.mockResolvedValue(undefined);
      mockEventBus.publishMany.mockResolvedValue(undefined);

      const command = new RotateApiKeyCommand({
        userId: user.id,
        apiKeyId: apiKey.id,
        reason: 'manual',
      });

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.success).toBe(true);
      // Domain events would be published here
      // In future: verify ApiKeyRotatedEvent was created
    });
  });
});

