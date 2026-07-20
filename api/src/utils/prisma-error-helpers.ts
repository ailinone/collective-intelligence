// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma Error Helpers
 * 
 * Type-safe utilities for handling Prisma errors without using 'any' or 'unknown as unknown'
 */

import { Prisma } from '@/generated/prisma/index.js';

/**
 * Type guard to check if an error is a Prisma known request error
 */
export function isPrismaKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  
  if (!('code' in error)) {
    return false;
  }
  
  // Use Object.getOwnPropertyDescriptor to safely access code property
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, 'code');
  if (!codeDescriptor || typeof codeDescriptor.value !== 'string') {
    return false;
  }
  
  // Check for Prisma-specific properties
  return 'meta' in error && 'clientVersion' in error;
}

/**
 * Type guard to check if an error is a Prisma validation error
 */
export function isPrismaValidationError(error: unknown): error is Prisma.PrismaClientValidationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    error instanceof Error &&
    error.name === 'PrismaClientValidationError'
  );
}

/**
 * Type guard to check if an error is a Prisma client initialization error
 */
export function isPrismaInitializationError(error: unknown): error is Prisma.PrismaClientInitializationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    error instanceof Error &&
    error.name === 'PrismaClientInitializationError'
  );
}

/**
 * Check if error is a unique constraint violation (P2002)
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return isPrismaKnownRequestError(error) && error.code === 'P2002';
}

/**
 * Extract constraint fields from a unique constraint error
 */
export function getUniqueConstraintFields(error: unknown): string[] | null {
  if (!isUniqueConstraintError(error)) {
    return null;
  }

  // After isPrismaKnownRequestError guard, error is narrowed to PrismaClientKnownRequestError
  // Use type-safe access to meta property
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  
  const metaDescriptor = Object.getOwnPropertyDescriptor(error, 'meta');
  if (!metaDescriptor) {
    return null;
  }

  // PropertyDescriptor.value is typed as `any` in lib.es5; narrow it to
  // unknown explicitly so the runtime type-guards below carry the burden.
  const meta: unknown = metaDescriptor.value;
  if (meta && typeof meta === 'object') {
    const targetDescriptor = Object.getOwnPropertyDescriptor(meta, 'target');
    if (targetDescriptor) {
      const target: unknown = targetDescriptor.value;
      if (Array.isArray(target)) {
        return target.map((field: unknown) => String(field));
      }
    }
  }

  return null;
}

/**
 * Type-safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (isPrismaKnownRequestError(error)) {
    return error.message;
  }

  if (isPrismaValidationError(error)) {
    // Type guard ensures error is PrismaClientValidationError which extends Error
    // After type guard, error is narrowed to PrismaClientValidationError
    // PrismaClientValidationError extends Error, so we can safely access message
    if (error instanceof Error) {
      return error.message;
    }
    return 'Validation error';
  }

  if (isPrismaInitializationError(error)) {
    // Type guard ensures error is PrismaClientInitializationError which extends Error
    // After type guard, error is narrowed to PrismaClientInitializationError
    // PrismaClientInitializationError extends Error, so we can safely access message
    if (error instanceof Error) {
      return error.message;
    }
    return 'Initialization error';
  }

  return 'An unknown error occurred';
}

/**
 * Type-safe error code extraction for Prisma errors
 */
export function getPrismaErrorCode(error: unknown): string | null {
  if (isPrismaKnownRequestError(error)) {
    return error.code;
  }
  return null;
}

