// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PasswordHash Value Object
 * Represents a secure bcrypt hash of a user's password.
 */

import bcrypt from 'bcrypt';

const MIN_BCRYPT_LENGTH = 20; // "$2b$" + cost + salt/hash segments

export class PasswordHash {
  private readonly value: string;

  private constructor(hash: string) {
    if (!hash || typeof hash !== 'string') {
      throw new Error('Password hash cannot be empty');
    }

    if (!hash.startsWith('$2') || hash.length < MIN_BCRYPT_LENGTH) {
      throw new Error('Invalid bcrypt hash format');
    }

    this.value = hash;
  }

  /**
   * Create PasswordHash from previously hashed value (e.g., database)
   */
  static fromHash(hash: string): PasswordHash {
    return new PasswordHash(hash);
  }

  /**
   * Hash a plain text password using bcrypt
   */
  static async fromPlainText(password: string, saltRounds = 12): Promise<PasswordHash> {
    if (!password || password.trim().length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    const normalized = password.trim();
    const hash = await bcrypt.hash(normalized, saltRounds);
    return new PasswordHash(hash);
  }

  /**
   * Compare plain text password with hashed value
   */
  async verify(password: string): Promise<boolean> {
    if (!password) {
      return false;
    }

    return bcrypt.compare(password, this.value);
  }

  /**
   * Get raw hash string (for persistence)
   */
  getValue(): string {
    return this.value;
  }
}
