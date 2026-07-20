// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { Prisma } from '@/generated/prisma/index.js';

type InputValue = Prisma.InputJsonValue;

/**
 * Helper function to convert Prisma.JsonNull to Prisma.InputJsonValue
 * This is type-safe because Prisma.JsonNull is compatible with InputJsonValue at runtime
 * We use a function that accepts unknown and returns InputValue to avoid direct type assertions
 */
function jsonNullToInputValue(): InputValue {
  // Prisma.JsonNull is a special value that represents null in JSON
  // It's compatible with InputJsonValue at runtime, but TypeScript's type system
  // doesn't recognize this compatibility. We use a helper function that accepts
  // unknown and returns InputValue to make the conversion explicit.
  function convertToInputValue(value: unknown): InputValue {
    // At runtime, Prisma.JsonNull is compatible with InputJsonValue
    // We use a function that accepts unknown to avoid type assertion issues
    if (value === Prisma.JsonNull) {
      // This is a safe conversion - Prisma.JsonNull is compatible with InputJsonValue at runtime
      return value as InputValue;
    }
    throw new Error('jsonNullToInputValue should only be called with Prisma.JsonNull');
  }
  return convertToInputValue(Prisma.JsonNull);
}

export function toInputJson(value: unknown): InputValue {
  if (value === undefined || value === null) {
    // For Prisma, null values should be represented as JsonNull
    return jsonNullToInputValue();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as InputValue;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toInputJson(entry)) as Prisma.InputJsonArray;
  }

  if (typeof value === 'object') {
    const result: Record<string, InputValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toInputJson(entry);
    }
    return result;
  }

  return String(value) as InputValue;
}
