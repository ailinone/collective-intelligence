// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Entity - Unit Tests
 * Testing DDD Entity patterns and business logic
 */

import { describe, it, expect } from 'vitest';
import { UserEntity, UserRole, UserStatus } from '@/domain/entities/user.entity';
import { Email } from '@/domain/value-objects/email';
import { UserId } from '@/domain/value-objects/user-id';

describe('UserEntity', () => {
  const validUserData = {
    email: 'user@example.com',
    name: 'John Doe',
    organizationId: '550e8400-e29b-41d4-a716-446655440000',
    role: UserRole.USER,
  };

  describe('Creation (Factory Method)', () => {
    it('should create new user with default role', () => {
      const user = UserEntity.create({
        email: 'user@example.com',
        name: 'John Doe',
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(user).toBeInstanceOf(UserEntity);
      expect(user.getEmailObject()).toBeInstanceOf(Email);
      expect(user.getIdObject()).toBeInstanceOf(UserId);
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(user.email).toBe('user@example.com');
      expect(user.name).toBe('John Doe');
      expect(user.role).toBe(UserRole.USER);
      expect(user.status).toBe(UserStatus.ACTIVE);
    });

    it('should create user with specified role', () => {
      const user = UserEntity.create({
        ...validUserData,
        role: UserRole.ADMIN,
      });

      expect(user.role).toBe(UserRole.ADMIN);
    });

    it('should trim name whitespace', () => {
      const user = UserEntity.create({
        ...validUserData,
        name: '  John Doe  ',
      });

      expect(user.name).toBe('John Doe');
    });

    it('should set createdAt and updatedAt', () => {
      const before = new Date();
      const user = UserEntity.create(validUserData);
      const after = new Date();

      expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(user.updatedAt).toEqual(user.createdAt);
    });

    it('should generate unique UserId', () => {
      const user1 = UserEntity.create(validUserData);
      const user2 = UserEntity.create(validUserData);

      expect(user1.getIdObject().getValue()).not.toBe(user2.getIdObject().getValue());
    });
  });

  describe('Reconstitution (from DB)', () => {
    it('should reconstitute user from persistence', () => {
      const dbData = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'user@example.com',
        name: 'John Doe',
        role: 'user',
        status: 'active',
        organizationId: '660e8400-e29b-41d4-a716-446655440000',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-02'),
      };

      const user = UserEntity.reconstitute(dbData);

      expect(user.id).toBe(dbData.id);
      expect(user.email).toBe(dbData.email);
      expect(user.getIdObject().getValue()).toBe(dbData.id);
      expect(user.getEmailObject().getValue()).toBe(dbData.email);
      expect(user.name).toBe(dbData.name);
      expect(user.role).toBe(UserRole.USER);
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.createdAt).toEqual(dbData.createdAt);
    });
  });

  describe('Invariant Validation', () => {
    it('should reject empty name', () => {
      expect(() => UserEntity.create({
        ...validUserData,
        name: '',
      })).toThrow('User name cannot be empty');
    });

    it('should reject whitespace-only name', () => {
      expect(() => UserEntity.create({
        ...validUserData,
        name: '   ',
      })).toThrow('User name cannot be empty');
    });

    it('should reject name > 100 chars', () => {
      expect(() => UserEntity.create({
        ...validUserData,
        name: 'a'.repeat(101),
      })).toThrow('User name cannot exceed 100 characters');
    });

    it('should reject missing organizationId', () => {
      expect(() => UserEntity.create({
        ...validUserData,
        organizationId: '',
      })).toThrow('User must belong to an organization');
    });
  });

  describe('Business Logic: Activate', () => {
    it('should activate suspended user', () => {
      const user = UserEntity.reconstitute({
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'user@example.com',
        name: 'John Doe',
        role: 'user',
        status: 'suspended',
        organizationId: '660e8400-e29b-41d4-a716-446655440000',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const before = user.updatedAt;
      user.activate();

      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('should throw if already active', () => {
      const user = UserEntity.create(validUserData);
      expect(() => user.activate()).toThrow('User is already active');
    });
  });

  describe('Business Logic: Suspend', () => {
    it('should suspend active user', () => {
      const user = UserEntity.create(validUserData);

      const before = user.updatedAt.getTime();
      
      // Small delay to ensure different timestamp
      const startTime = Date.now();
      while (Date.now() - startTime < 2) {} // 2ms delay
      
      user.suspend('Policy violation');

      expect(user.status).toBe(UserStatus.SUSPENDED);
      expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('should throw if already suspended', () => {
      const user = UserEntity.create(validUserData);
      user.suspend();

      expect(() => user.suspend()).toThrow('User is already suspended');
    });
  });

  describe('Business Logic: Change Name', () => {
    it('should change user name', () => {
      const user = UserEntity.create(validUserData);

      const before = user.updatedAt.getTime();
      
      // Small delay to ensure different timestamp
      const startTime = Date.now();
      while (Date.now() - startTime < 2) {} // 2ms delay
      
      user.changeName('Jane Smith');

      expect(user.name).toBe('Jane Smith');
      expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('should trim name whitespace', () => {
      const user = UserEntity.create(validUserData);
      user.changeName('  Jane Smith  ');

      expect(user.name).toBe('Jane Smith');
    });

    it('should reject empty name', () => {
      const user = UserEntity.create(validUserData);
      expect(() => user.changeName('')).toThrow('Name cannot be empty');
    });

    it('should reject name > 100 chars', () => {
      const user = UserEntity.create(validUserData);
      expect(() => user.changeName('a'.repeat(101))).toThrow('Name cannot exceed 100 characters');
    });
  });

  describe('Business Logic: Promote to Admin', () => {
    it('should promote user to admin', () => {
      const user = UserEntity.create(validUserData);

      const before = user.updatedAt.getTime();
      
      // Small delay to ensure different timestamp
      const startTime = Date.now();
      while (Date.now() - startTime < 2) {} // 2ms delay
      
      user.promoteToAdmin();

      expect(user.role).toBe(UserRole.ADMIN);
      expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('should throw if already admin', () => {
      const user = UserEntity.create({
        ...validUserData,
        role: UserRole.ADMIN,
      });

      expect(() => user.promoteToAdmin()).toThrow('User is already an admin');
    });
  });

  describe('Query Methods', () => {
    it('should check if user is active', () => {
      const user = UserEntity.create(validUserData);
      expect(user.isActive()).toBe(true);

      user.suspend();
      expect(user.isActive()).toBe(false);
    });

    it('should check if user is admin', () => {
      const user = UserEntity.create({
        ...validUserData,
        role: UserRole.USER,
      });
      expect(user.isAdmin()).toBe(false);

      user.promoteToAdmin();
      expect(user.isAdmin()).toBe(true);
    });
  });

  describe('Serialization', () => {
    it('should convert to persistence DTO', () => {
      const user = UserEntity.create(validUserData);
      const dto = user.toPersistence();

      expect(dto.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(dto.email).toBe('user@example.com');
      expect(dto.name).toBe('John Doe');
      expect(dto.role).toBe('user');
      expect(dto.status).toBe('active');
      expect(dto.organizationId).toBe(validUserData.organizationId);
      expect(dto.createdAt).toBeInstanceOf(Date);
      expect(dto.updatedAt).toBeInstanceOf(Date);
    });

    it('should convert to presentation DTO', () => {
      const user = UserEntity.create(validUserData);
      const dto = user.toDTO();

      expect(dto.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(dto.email).toBe('user@example.com');
      expect(dto.name).toBe('John Doe');
      expect(dto.role).toBe('user');
      expect(dto.status).toBe('active');
      expect(dto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO string
      expect(dto.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('Encapsulation', () => {
    it('should not expose internal state directly', () => {
      const user = UserEntity.create(validUserData);

      // No setters
      const withOptionalSetters = user as { setName?: unknown; setEmail?: unknown; setRole?: unknown };
      expect(withOptionalSetters.setName).toBeUndefined();
      expect(withOptionalSetters.setEmail).toBeUndefined();
      expect(withOptionalSetters.setRole).toBeUndefined();

      // Only business methods
      expect(user.changeName).toBeDefined();
      expect(user.promoteToAdmin).toBeDefined();
      expect(user.activate).toBeDefined();
      expect(user.suspend).toBeDefined();
    });

    it('should expose getters for read-only access', () => {
      const user = UserEntity.create(validUserData);

      expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(user.email).toBe('user@example.com');
      expect(user.getIdObject()).toBeInstanceOf(UserId);
      expect(user.getEmailObject()).toBeInstanceOf(Email);
      expect(user.name).toBe('John Doe');
      expect(user.role).toBe(UserRole.USER);
      expect(user.status).toBe(UserStatus.ACTIVE);
    });
  });
});

