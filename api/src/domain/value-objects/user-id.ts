// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * UserId Value Object
 * Represents a unique user identifier
 *
 * DDD Pattern: Value Object (Identity)
 * - Immutable
 * - Type-safe (not just a string)
 * - Self-validating
 */

import { randomUUID } from 'crypto';

export class UserId {
  private readonly value: string;

  private constructor(id: string) {
    this.value = id;
  }

  /**
   * Create from existing UUID
   */
  static create(id: string): UserId {
    if (!id || typeof id !== 'string') {
      throw new Error('UserId must be a non-empty string');
    }

    if (!UserId.isValidUUID(id)) {
      throw new Error(`Invalid UUID format: ${id}`);
    }

    return new UserId(id);
  }

  /**
   * Generate new UUID
   */
  static generate(): UserId {
    return new UserId(randomUUID());
  }

  /**
   * Validate UUID format
   */
  private static isValidUUID(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  /**
   * Get value
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Equality
   */
  equals(other: UserId): boolean {
    if (!(other instanceof UserId)) {
      return false;
    }
    return this.value === other.value;
  }

  /**
   * String representation
   */
  toString(): string {
    return this.value;
  }

  /**
   * JSON serialization
   */
  toJSON(): string {
    return this.value;
  }
}
