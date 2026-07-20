// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ApiKeyValue Value Object
 * Represents an API key with validation and security
 *
 * DDD Pattern: Value Object
 * Format: ak_live_xxxxxxxxxxxx (15 chars prefix for indexing)
 */

import { randomBytes } from 'crypto';

export class ApiKeyValue {
  private readonly value: string;
  private readonly prefix: string;

  private constructor(apiKey: string, prefix: string) {
    this.value = apiKey;
    this.prefix = prefix;
  }

  /**
   * Generate new API key
   * Format: ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (48 chars total)
   */
  static generate(environment: 'live' | 'test' = 'live'): ApiKeyValue {
    // Generate cryptographically secure random key
    const randomPart = randomBytes(32).toString('base64url'); // 43 chars
    const apiKey = `ak_${environment}_${randomPart}`;
    const prefix = apiKey.substring(0, 15); // For database indexing

    return new ApiKeyValue(apiKey, prefix);
  }

  /**
   * Create from existing key (for validation)
   */
  static create(apiKey: string): ApiKeyValue {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('API key must be a non-empty string');
    }

    if (!ApiKeyValue.isValid(apiKey)) {
      throw new Error(`Invalid API key format: ${apiKey.substring(0, 10)}...`);
    }

    const prefix = apiKey.substring(0, 15);
    return new ApiKeyValue(apiKey, prefix);
  }

  /**
   * Validate API key format
   */
  private static isValid(apiKey: string): boolean {
    // Must start with ak_live_ or ak_test_
    if (!apiKey.startsWith('ak_live_') && !apiKey.startsWith('ak_test_')) {
      return false;
    }

    // Must have minimum length (ak_live_ = 8, + random part minimum 32)
    if (apiKey.length < 40) {
      return false;
    }

    // Must have maximum length (security best practice)
    if (apiKey.length > 100) {
      return false;
    }

    // Only allow alphanumeric, underscore, hyphen (base64url safe)
    const validCharsRegex = /^ak_(live|test)_[A-Za-z0-9_-]+$/;
    if (!validCharsRegex.test(apiKey)) {
      return false;
    }

    return true;
  }

  /**
   * Get full API key value (SENSITIVE)
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Get prefix for database indexing (first 15 chars)
   */
  getPrefix(): string {
    return this.prefix;
  }

  /**
   * Get environment (live or test)
   */
  getEnvironment(): 'live' | 'test' {
    return this.value.startsWith('ak_live_') ? 'live' : 'test';
  }

  /**
   * Get masked version for display (security)
   * Returns: ak_live_abc***...***xyz (shows first 3 + last 3 of random part)
   */
  getMasked(): string {
    const environment = this.getEnvironment();
    const prefixLength = environment === 'live' ? 'ak_live_'.length : 'ak_test_'.length;
    const randomPart = this.value.substring(prefixLength);

    if (randomPart.length < 6) {
      return `ak_${environment}_***`;
    }

    const first3 = randomPart.substring(0, 3);
    const last3 = randomPart.substring(randomPart.length - 3);

    return `ak_${environment}_${first3}***...***${last3}`;
  }

  /**
   * Equality
   */
  equals(other: ApiKeyValue): boolean {
    if (!(other instanceof ApiKeyValue)) {
      return false;
    }
    return this.value === other.value;
  }

  /**
   * String representation (MASKED for security)
   */
  toString(): string {
    return this.getMasked();
  }

  /**
   * JSON serialization (MASKED for security)
   */
  toJSON(): string {
    return this.getMasked();
  }
}
