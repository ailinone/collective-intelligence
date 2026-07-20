// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Email Value Object - Unit Tests
 * Testing DDD Value Object patterns
 */

import { describe, it, expect } from 'vitest';
import { Email } from '@/domain/value-objects/email';

describe('Email Value Object', () => {
  describe('Creation and Validation', () => {
    it('should create valid email', () => {
      const email = Email.create('user@example.com');
      
      expect(email).toBeInstanceOf(Email);
      expect(email.getValue()).toBe('user@example.com');
    });

    it('should normalize email (lowercase + trim)', () => {
      const email = Email.create('  USER@EXAMPLE.COM  ');
      
      expect(email.getValue()).toBe('user@example.com');
    });

    it('should reject empty email', () => {
      expect(() => Email.create('')).toThrow('Email must be a non-empty string');
    });

    it('should reject null email', () => {
      const nullInput: string = JSON.parse('null');
      expect(() => Email.create(nullInput)).toThrow('Email must be a non-empty string');
    });

    it('should reject undefined email', () => {
      const undefInput: string = ({} as { value?: string }).value!;
      expect(() => Email.create(undefInput)).toThrow('Email must be a non-empty string');
    });

    it('should reject invalid format (no @)', () => {
      expect(() => Email.create('invalid-email')).toThrow('Invalid email format');
    });

    it('should reject invalid format (no domain)', () => {
      expect(() => Email.create('user@')).toThrow('Invalid email format');
    });

    it('should reject invalid format (no local part)', () => {
      expect(() => Email.create('@example.com')).toThrow('Invalid email format');
    });

    it('should reject local part > 64 chars', () => {
      const longLocal = 'a'.repeat(65);
      expect(() => Email.create(`${longLocal}@example.com`)).toThrow('Invalid email format');
    });

    it('should reject domain > 255 chars', () => {
      const longDomain = 'a'.repeat(256);
      expect(() => Email.create(`user@${longDomain}.com`)).toThrow('Invalid email format');
    });

    it('should accept valid email with subdomain', () => {
      const email = Email.create('user@mail.example.com');
      expect(email.getValue()).toBe('user@mail.example.com');
    });

    it('should accept valid email with +', () => {
      const email = Email.create('user+test@example.com');
      expect(email.getValue()).toBe('user+test@example.com');
    });

    it('should accept valid email with numbers', () => {
      const email = Email.create('user123@example456.com');
      expect(email.getValue()).toBe('user123@example456.com');
    });
  });

  describe('Domain Methods', () => {
    it('should get domain part', () => {
      const email = Email.create('user@example.com');
      expect(email.getDomain()).toBe('example.com');
    });

    it('should get local part', () => {
      const email = Email.create('user@example.com');
      expect(email.getLocalPart()).toBe('user');
    });
  });

  describe('Value Object Equality', () => {
    it('should be equal if same email', () => {
      const email1 = Email.create('user@example.com');
      const email2 = Email.create('user@example.com');
      
      expect(email1.equals(email2)).toBe(true);
    });

    it('should be equal after normalization', () => {
      const email1 = Email.create('USER@EXAMPLE.COM');
      const email2 = Email.create('user@example.com');
      
      expect(email1.equals(email2)).toBe(true);
    });

    it('should not be equal if different emails', () => {
      const email1 = Email.create('user1@example.com');
      const email2 = Email.create('user2@example.com');
      
      expect(email1.equals(email2)).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize to string', () => {
      const email = Email.create('user@example.com');
      expect(email.toString()).toBe('user@example.com');
    });

    it('should serialize to JSON', () => {
      const email = Email.create('user@example.com');
      expect(email.toJSON()).toBe('user@example.com');
    });
  });

  describe('Immutability', () => {
    it('should be immutable (no public setters)', () => {
      const email = Email.create('user@example.com');
      
      const withOptionalSetters = email as { setValue?: unknown; setEmail?: unknown };
      expect(withOptionalSetters.setValue).toBeUndefined();
      expect(withOptionalSetters.setEmail).toBeUndefined();
      expect(email.getValue).toBeDefined();
      expect(email.getValue()).toBe('user@example.com');
    });
  });
});

