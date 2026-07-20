// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * UserId Value Object - Unit Tests
 * Testing DDD Identity Value Object
 */

import { describe, it, expect } from 'vitest';
import { UserId } from '@/domain/value-objects/user-id';

describe('UserId Value Object', () => {
  describe('Creation', () => {
    it('should create from valid UUID', () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      const userId = UserId.create(validUUID);
      
      expect(userId).toBeInstanceOf(UserId);
      expect(userId.getValue()).toBe(validUUID);
    });

    it('should generate new UUID', () => {
      const userId = UserId.generate();
      
      expect(userId).toBeInstanceOf(UserId);
      expect(userId.getValue()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate unique UUIDs', () => {
      const userId1 = UserId.generate();
      const userId2 = UserId.generate();
      
      expect(userId1.getValue()).not.toBe(userId2.getValue());
    });
  });

  describe('Validation', () => {
    it('should reject empty string', () => {
      expect(() => UserId.create('')).toThrow('UserId must be a non-empty string');
    });

    it('should reject null', () => {
      const nullInput: string = JSON.parse('null');
      expect(() => UserId.create(nullInput)).toThrow('UserId must be a non-empty string');
    });

    it('should reject undefined', () => {
      const undefInput: string = ({} as { value?: string }).value!;
      expect(() => UserId.create(undefInput)).toThrow('UserId must be a non-empty string');
    });

    it('should reject invalid UUID format', () => {
      expect(() => UserId.create('not-a-uuid')).toThrow('Invalid UUID format');
    });

    it('should reject UUID with wrong length', () => {
      expect(() => UserId.create('550e8400-e29b-41d4-a716-44665544000')).toThrow('Invalid UUID format');
    });

    it('should reject UUID with invalid characters', () => {
      expect(() => UserId.create('550e8400-e29b-41d4-a716-44665544000g')).toThrow('Invalid UUID format');
    });

    it('should accept UUID in lowercase', () => {
      const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      expect(userId.getValue()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should accept UUID in uppercase', () => {
      const userId = UserId.create('550E8400-E29B-41D4-A716-446655440000');
      expect(userId.getValue()).toBe('550E8400-E29B-41D4-A716-446655440000');
    });
  });

  describe('Equality', () => {
    it('should be equal if same UUID', () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const userId1 = UserId.create(id);
      const userId2 = UserId.create(id);
      
      expect(userId1.equals(userId2)).toBe(true);
    });

    it('should not be equal if different UUIDs', () => {
      const userId1 = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      const userId2 = UserId.create('660e8400-e29b-41d4-a716-446655440000');
      
      expect(userId1.equals(userId2)).toBe(false);
    });

    it('should handle case-sensitive comparison', () => {
      const userId1 = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      const userId2 = UserId.create('550E8400-E29B-41D4-A716-446655440000');
      
      // Different case = different value
      expect(userId1.equals(userId2)).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize to string', () => {
      const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      expect(userId.toString()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should serialize to JSON', () => {
      const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      expect(userId.toJSON()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should work with JSON.stringify', () => {
      const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      expect(JSON.stringify({ id: userId })).toBe('{"id":"550e8400-e29b-41d4-a716-446655440000"}');
    });
  });

  describe('Immutability', () => {
    it('should be immutable (no public setters)', () => {
      const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');
      
      // No public setters available (verify API surface is immutable)
      const withOptionalSetter = userId as { setValue?: unknown };
      expect(withOptionalSetter.setValue).toBeUndefined();
      
      expect(userId.getValue).toBeDefined();
      expect(userId.getValue()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
  });
});

