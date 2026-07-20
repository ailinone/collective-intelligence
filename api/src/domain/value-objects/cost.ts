// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cost Value Object
 * Represents monetary cost in USD with precision
 *
 * DDD Pattern: Value Object
 * - Immutable
 * - Precise decimal calculations (no floating point errors)
 * - Currency-aware
 */

export class Cost {
  private readonly amountUSD: number; // Stored in cents to avoid floating point issues
  private readonly currency: string;

  private constructor(amountUSD: number, currency: string = 'USD') {
    this.amountUSD = Math.round(amountUSD * 100); // Store as cents
    this.currency = currency;
  }

  /**
   * Create from USD amount
   */
  static fromUSD(amount: number): Cost {
    if (amount < 0) {
      throw new Error('Cost cannot be negative');
    }

    if (!Number.isFinite(amount)) {
      throw new Error('Cost must be a finite number');
    }

    return new Cost(amount, 'USD');
  }

  /**
   * Create zero cost
   */
  static zero(): Cost {
    return new Cost(0, 'USD');
  }

  /**
   * Create from cents
   */
  static fromCents(cents: number): Cost {
    if (cents < 0) {
      throw new Error('Cost cannot be negative');
    }

    return new Cost(cents / 100, 'USD');
  }

  /**
   * Add two costs
   */
  add(other: Cost): Cost {
    if (this.currency !== other.currency) {
      throw new Error('Cannot add costs with different currencies');
    }

    return Cost.fromCents(this.amountUSD + other.amountUSD);
  }

  /**
   * Subtract cost
   */
  subtract(other: Cost): Cost {
    if (this.currency !== other.currency) {
      throw new Error('Cannot subtract costs with different currencies');
    }

    const result = this.amountUSD - other.amountUSD;

    if (result < 0) {
      throw new Error('Cannot subtract to negative cost');
    }

    return Cost.fromCents(result);
  }

  /**
   * Multiply by factor
   */
  multiplyBy(factor: number): Cost {
    if (factor < 0) {
      throw new Error('Cannot multiply by negative factor');
    }

    return Cost.fromCents(Math.round(this.amountUSD * factor));
  }

  /**
   * Calculate percentage
   */
  percentage(percent: number): Cost {
    if (percent < 0 || percent > 100) {
      throw new Error('Percentage must be between 0 and 100');
    }

    return Cost.fromCents(Math.round((this.amountUSD * percent) / 100));
  }

  /**
   * Compare costs
   */
  isGreaterThan(other: Cost): boolean {
    return this.amountUSD > other.amountUSD;
  }

  isLessThan(other: Cost): boolean {
    return this.amountUSD < other.amountUSD;
  }

  equals(other: Cost): boolean {
    if (!(other instanceof Cost)) {
      return false;
    }
    return this.amountUSD === other.amountUSD && this.currency === other.currency;
  }

  /**
   * Get amount in USD
   */
  getAmountUSD(): number {
    return this.amountUSD / 100; // Convert from cents
  }

  /**
   * Get amount in cents
   */
  getAmountCents(): number {
    return this.amountUSD;
  }

  /**
   * Format for display
   */
  format(): string {
    const amount = this.getAmountUSD();
    return `$${amount.toFixed(6)}`; // 6 decimals for precision
  }

  /**
   * Format with symbol
   */
  formatWithSymbol(): string {
    return this.format();
  }

  /**
   * String representation
   */
  toString(): string {
    return this.format();
  }

  /**
   * JSON serialization
   */
  toJSON(): number {
    return this.getAmountUSD();
  }
}
