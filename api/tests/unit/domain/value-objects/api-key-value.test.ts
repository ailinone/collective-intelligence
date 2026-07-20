// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ApiKeyValue Value Object - Unit Tests
 * Testing API key generation, validation, and masking
 */

import { describe, it, expect } from 'vitest';
import { ApiKeyValue } from '@/domain/value-objects/api-key-value';

describe('ApiKeyValue', () => {
  describe('Generation', () => {
    it('should generate live API key', () => {
      const apiKey = ApiKeyValue.generate('live');
      
      expect(apiKey).toBeInstanceOf(ApiKeyValue);
      expect(apiKey.getValue()).toMatch(/^ak_live_[A-Za-z0-9_-]{32,}$/);
      expect(apiKey.getEnvironment()).toBe('live');
    });

    it('should generate test API key', () => {
      const apiKey = ApiKeyValue.generate('test');
      
      expect(apiKey.getValue()).toMatch(/^ak_test_[A-Za-z0-9_-]{32,}$/);
      expect(apiKey.getEnvironment()).toBe('test');
    });

    it('should generate unique keys', () => {
      const key1 = ApiKeyValue.generate();
      const key2 = ApiKeyValue.generate();
      
      expect(key1.getValue()).not.toBe(key2.getValue());
    });

    it('should generate default environment (live)', () => {
      const apiKey = ApiKeyValue.generate();
      expect(apiKey.getEnvironment()).toBe('live');
    });

    it('should generate prefix for indexing', () => {
      const apiKey = ApiKeyValue.generate('live');
      const prefix = apiKey.getPrefix();
      
      expect(prefix).toHaveLength(15);
      expect(prefix).toBe(apiKey.getValue().substring(0, 15));
      expect(prefix).toMatch(/^ak_live_[A-Za-z0-9_-]+$/);
    });
  });

  describe('Validation', () => {
    it('should create from valid live key', () => {
      const validKey = 'ak_live_' + 'a'.repeat(40);
      const apiKey = ApiKeyValue.create(validKey);
      
      expect(apiKey.getValue()).toBe(validKey);
    });

    it('should create from valid test key', () => {
      const validKey = 'ak_test_' + 'b'.repeat(40);
      const apiKey = ApiKeyValue.create(validKey);
      
      expect(apiKey.getValue()).toBe(validKey);
    });

    it('should reject empty string', () => {
      expect(() => ApiKeyValue.create('')).toThrow('API key must be a non-empty string');
    });

    it('should reject null', () => {
      const nullInput: string = JSON.parse('null');
      expect(() => ApiKeyValue.create(nullInput)).toThrow('API key must be a non-empty string');
    });

    it('should reject undefined', () => {
      const undefInput: string = ({} as { value?: string }).value!;
      expect(() => ApiKeyValue.create(undefInput)).toThrow('API key must be a non-empty string');
    });

    it('should reject invalid prefix', () => {
      expect(() => ApiKeyValue.create('invalid_prefix_123')).toThrow('Invalid API key format');
    });

    it('should reject too short key', () => {
      expect(() => ApiKeyValue.create('ak_live_123')).toThrow('Invalid API key format');
    });

    it('should reject too long key', () => {
      const tooLong = 'ak_live_' + 'a'.repeat(100);
      expect(() => ApiKeyValue.create(tooLong)).toThrow('Invalid API key format');
    });

    it('should reject key with invalid characters', () => {
      expect(() => ApiKeyValue.create('ak_live_abc@def#ghi')).toThrow('Invalid API key format');
    });
  });

  describe('Masking (Security)', () => {
    it('should mask API key for display', () => {
      const apiKey = ApiKeyValue.generate('live');
      const masked = apiKey.getMasked();
      
      expect(masked).toMatch(/^ak_live_[A-Za-z0-9_-]{3}\*\*\*\.\.\.\*\*\*[A-Za-z0-9_-]{3}$/);
      expect(masked).not.toBe(apiKey.getValue());
      expect(masked.length).toBeLessThan(apiKey.getValue().length);
    });

    it('should show environment in masked version', () => {
      const apiKey = ApiKeyValue.generate('test');
      const masked = apiKey.getMasked();
      
      expect(masked).toContain('ak_test_');
    });

    it('should mask toString()', () => {
      const apiKey = ApiKeyValue.generate();
      const str = apiKey.toString();
      
      expect(str).toMatch(/^ak_live_.*\*\*\*.*$/);
      expect(str).not.toBe(apiKey.getValue());
    });

    it('should mask toJSON()', () => {
      const apiKey = ApiKeyValue.generate();
      const json = apiKey.toJSON();
      
      expect(json).toMatch(/^ak_live_.*\*\*\*.*$/);
      expect(json).not.toBe(apiKey.getValue());
    });
  });

  describe('Equality', () => {
    it('should be equal if same key', () => {
      const key = 'ak_live_' + 'a'.repeat(40);
      const apiKey1 = ApiKeyValue.create(key);
      const apiKey2 = ApiKeyValue.create(key);
      
      expect(apiKey1.equals(apiKey2)).toBe(true);
    });

    it('should not be equal if different keys', () => {
      const apiKey1 = ApiKeyValue.generate();
      const apiKey2 = ApiKeyValue.generate();
      
      expect(apiKey1.equals(apiKey2)).toBe(false);
    });
  });

  describe('Immutability', () => {
    it('should be immutable (no public setters)', () => {
      const apiKey = ApiKeyValue.generate();
      
      const withOptionalSetters = apiKey as { setValue?: unknown; setPrefix?: unknown };
      expect(withOptionalSetters.setValue).toBeUndefined();
      expect(withOptionalSetters.setPrefix).toBeUndefined();
      
      // Only getters
      expect(apiKey.getValue).toBeDefined();
      expect(apiKey.getPrefix).toBeDefined();
      expect(apiKey.getMasked).toBeDefined();
    });
  });
});

