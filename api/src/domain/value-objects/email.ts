// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Email Value Object
 * Immutable, self-validating email address
 *
 * DDD Pattern: Value Object
 * - No identity
 * - Immutable
 * - Self-validating
 * - Replaceable
 */

export class Email {
  private readonly value: string;

  private constructor(email: string) {
    this.value = email;
  }

  /**
   * Factory method - ensures validation
   */
  static create(email: string): Email {
    if (!email || typeof email !== 'string') {
      throw new Error('Email must be a non-empty string');
    }

    const trimmed = email.trim().toLowerCase();

    if (!Email.isValid(trimmed)) {
      throw new Error(`Invalid email format: ${email}`);
    }

    return new Email(trimmed);
  }

  /**
   * Validation logic
   */
  private static isValid(email: string): boolean {
    // RFC 5322 compliant regex (simplified)
    const emailRegex =
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

    if (!emailRegex.test(email)) {
      return false;
    }

    // Additional checks
    const [localPart, domain] = email.split('@');

    if (localPart.length > 64) {
      return false; // Local part too long
    }

    if (domain.length > 255) {
      return false; // Domain too long
    }

    return true;
  }

  /**
   * Get email value
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Get domain part
   */
  getDomain(): string {
    return this.value.split('@')[1];
  }

  /**
   * Get local part (before @)
   */
  getLocalPart(): string {
    return this.value.split('@')[0];
  }

  /**
   * Value Object equality - compare by value, not reference
   */
  equals(other: Email): boolean {
    if (!(other instanceof Email)) {
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
