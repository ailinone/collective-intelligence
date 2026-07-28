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
 * Format: ai1sk_xxxxxxxxxxxx (15 chars prefix for indexing)
 *
 * Legacy: keys minted before the ai1sk_ rename used ak_live_/ak_test_/
 * ak_local_/bare ak_<random> shapes (see api/src/utils/api-key-format.ts
 * for why there's more than one legacy shape). isValid()/create() still
 * accept all of them — via the generic `ak_` root, not per-variant — so
 * already-issued customer keys keep authenticating. Only generate() is
 * new-format-only.
 */

import { randomBytes } from 'crypto';
import { API_KEY_PREFIX, matchApiKeyPrefix } from '@/utils/api-key-format';

export class ApiKeyValue {
  private readonly value: string;
  private readonly prefix: string;

  private constructor(apiKey: string, prefix: string) {
    this.value = apiKey;
    this.prefix = prefix;
  }

  /**
   * Generate new API key
   * Format: ai1sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (49 chars total)
   */
  static generate(): ApiKeyValue {
    // Generate cryptographically secure random key
    const randomPart = randomBytes(32).toString('base64url'); // 43 chars
    const apiKey = `${API_KEY_PREFIX}${randomPart}`;
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
   * Validate API key format: current ai1sk_ prefix, or any legacy
   * ak_-rooted shape.
   */
  private static isValid(apiKey: string): boolean {
    // Must have minimum length (prefix + random part) and a sane maximum
    // (security best practice)
    if (apiKey.length < 40 || apiKey.length > 100) {
      return false;
    }

    // Only allow the known prefixes, followed by alphanumeric, underscore,
    // hyphen (base64url/nanoid safe) — covers ak_live_/ak_test_/ak_local_/
    // bare ak_<random> under the single `ak_` root, no need to enumerate
    // each historical sub-variant.
    return /^(?:ai1sk_|ak_)[A-Za-z0-9_-]+$/.test(apiKey);
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
   * Get environment tag. Preserved only for reading pre-rename legacy
   * values (ak_test_...) — new ai1sk_ keys have no environment concept
   * and always report 'live'.
   */
  getEnvironment(): 'live' | 'test' {
    return this.value.startsWith('ak_test_') ? 'test' : 'live';
  }

  /**
   * Get masked version for display (security)
   * Returns: <prefix>abc***...***xyz (shows first 3 + last 3 chars after
   * the recognized prefix). Format-agnostic so it works the same for the
   * current ai1sk_ prefix and every legacy ak_-rooted shape.
   */
  getMasked(): string {
    const prefix = matchApiKeyPrefix(this.value) ?? '';
    const randomPart = this.value.substring(prefix.length);

    if (randomPart.length < 6) {
      return `${prefix}***`;
    }

    const first3 = randomPart.substring(0, 3);
    const last3 = randomPart.substring(randomPart.length - 3);

    return `${prefix}${first3}***...***${last3}`;
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
