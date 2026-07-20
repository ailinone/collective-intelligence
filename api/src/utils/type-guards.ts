// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Type Guards Utilities
 * 
 * Type-safe utilities for narrowing unknown types without using 'as any' or 'unknown as'
 * All type guards follow TypeScript best practices for type narrowing
 */

/**
 * Type guard to check if a value is an Error object
 */
export function isError(value: unknown): value is Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    value instanceof Error
  );
}

/**
 * Type guard to check if a value is an Error-like object (has message property)
 */
export function isErrorLike(value: unknown): value is { message: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  
  if (!('message' in value)) {
    return false;
  }
  
  // Use Object.getOwnPropertyDescriptor to safely access property without type assertion
  const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
  if (descriptor === undefined) {
    return false;
  }
  return typeof descriptor.value === 'string';
}

/**
 * Type guard to check if a value is a Node.js error with code property
 */
export function isNodeError(value: unknown): value is Error & { code?: string } {
  if (!isError(value)) {
    return false;
  }
  // After isError guard, value is narrowed to Error
  // Check if error has code property (Node.js system errors)
  // Node.js errors can have optional code property
  // Access code property safely using Object.getOwnPropertyDescriptor
  if (!('code' in value)) {
    return true; // Error without code is still valid NodeError
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  if (descriptor === undefined) {
    return true;
  }
  // `descriptor.value` is `any` by definition of PropertyDescriptor.
  const codeProp: unknown = descriptor.value;
  return typeof codeProp === 'string' || codeProp === undefined;
}

/**
 * Type guard to check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard to check if a value is an object (not null, not array)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Type guard to check if an object has a specific property
 * Returns narrowed type indicating the object has the property
 */
export function hasProperty<T extends string>(
  obj: unknown,
  prop: T
): obj is Record<T, unknown> & Record<string, unknown> {
  return (
    isObject(obj) &&
    prop in obj
  );
}

/**
 * Type guard to check if an object has nested error structure with code
 */
export function hasErrorWithCode(obj: unknown): obj is { error?: { code?: string } } {
  if (!isObject(obj)) {
    return false;
  }
  
  if (!('error' in obj)) {
    return false;
  }
  
  const errorProp = obj.error;
  if (!isObject(errorProp)) {
    return false;
  }
  
  if (!('code' in errorProp)) {
    return true; // error object without code is still valid
  }
  
  const codeProp = errorProp.code;
  return typeof codeProp === 'string' || codeProp === undefined;
}

/**
 * Serialized error shape suitable for structured logging. The logger
 * (pino) auto-serializes `Error` instances, but ESLint's no-unsafe-*
 * rules can't see that and flag `{ error: <unknown> }` patterns. This
 * helper produces an explicit object so the call site is type-safe.
 *
 * Returns either:
 *   - `{ name, message, stack? }` for `Error` instances
 *   - the original string when the input is a string
 *   - `{ message }` for arbitrary objects with a string `message`
 *   - `{ message: '<stringified>' }` as a last-resort fallback
 */
export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
}

export function serializeError(value: unknown): SerializedError | string {
  if (isError(value)) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (isErrorLike(value)) {
    return { message: value.message };
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return { message: 'unknown error' };
  }
  // Last-resort: stringify objects, primitives etc. without throwing.
  try {
    return { message: typeof value === 'object' ? JSON.stringify(value) : String(value) };
  } catch {
    return { message: 'unknown error (unserializable)' };
  }
}

/**
 * Safely extract error message from unknown value
 */
export function getErrorMessage(value: unknown): string {
  if (isError(value)) {
    return value.message;
  }
  
  if (isErrorLike(value)) {
    return value.message;
  }
  
  if (typeof value === 'string') {
    return value;
  }
  
  return 'An unknown error occurred';
}

/**
 * Safely extract error code from unknown value
 */
export function getErrorCode(value: unknown): string | undefined {
  if (isNodeError(value)) {
    return value.code;
  }
  
  if (hasErrorWithCode(value) && value.error && isObject(value.error)) {
    return 'code' in value.error && typeof value.error.code === 'string' 
      ? value.error.code 
      : undefined;
  }
  
  return undefined;
}

/**
 * Type guard to check if a value is a FastifyError-like object
 * FastifyError extends Error and adds statusCode, code, validation properties
 */
export function isFastifyError(value: unknown): value is Error & {
  statusCode?: number;
  code?: string;
  validation?: unknown;
} {
  if (!isError(value)) {
    return false;
  }
  
  // FastifyError extends Error and may carry `statusCode`, `code`, or
  // `validation` properties. Any of those further confirms the type, but
  // even an Error-only shape is acceptable because FastifyError's extras
  // are all optional. The original code computed three predicates locally
  // for documentation; here we keep the intent in a comment without binding.
  // (`statusCode in value`, `code in value`, `validation in value`.)
  return true;
}

/**
 * Safely extract FastifyError properties from unknown value
 * Returns an object matching FastifyError structure
 */
export function extractFastifyErrorProperties(value: unknown): {
  message: string;
  statusCode?: number;
  code?: string;
  validation?: unknown;
  stack?: string;
} {
  const message = getErrorMessage(value);
  const code = getErrorCode(value);
  
  let statusCode: number | undefined;
  if (isObject(value) && 'statusCode' in value) {
    const statusCodeValue = value.statusCode;
    if (typeof statusCodeValue === 'number') {
      statusCode = statusCodeValue;
    }
  }
  
  let validation: unknown;
  if (isObject(value) && 'validation' in value) {
    validation = value.validation;
  }
  
  const stack = isError(value) ? value.stack : undefined;
  
  return {
    message,
    statusCode,
    code,
    validation,
    stack,
  };
}

/**
 * Safely extract statusCode from unknown error value
 */
export function extractStatusCode(value: unknown): number | undefined {
  if (isObject(value) && 'statusCode' in value) {
    const statusCodeValue = value.statusCode;
    if (typeof statusCodeValue === 'number') {
      return statusCodeValue;
    }
  }
  return undefined;
}

/**
 * Safely extract error type from unknown error value
 */
export function extractErrorType(value: unknown): string | undefined {
  if (isObject(value) && 'type' in value) {
    const typeValue = value.type;
    if (typeof typeValue === 'string') {
      return typeValue;
    }
  }
  return undefined;
}

/**
 * Safely get a single header value as string from IncomingHttpHeaders.
 * Headers can be string | string[] | undefined; returns first element if array.
 */
export function getHeaderString(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (headers === undefined) return undefined;
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/**
 * Safely extract error code from unknown error value (including nested objects)
 */
export function extractErrorCodeFromObject(value: unknown): string | undefined {
  // First try getErrorCode which handles Node.js errors
  const nodeErrorCode = getErrorCode(value);
  if (nodeErrorCode !== undefined) {
    return nodeErrorCode;
  }
  
  // Then check if it's an object with a code property
  if (isObject(value) && 'code' in value) {
    const codeValue = value.code;
    if (typeof codeValue === 'string') {
      return codeValue;
    }
  }
  
  return undefined;
}

/**
 * Ensure value is a string array; returns empty array if not.
 */
export function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/**
 * Safely get a string property from an object without type assertions.
 */
export function getStringFromObject(obj: unknown, key: string): string | undefined {
  if (!isObject(obj) || !(key in obj)) return undefined;
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Safely get an array from an object property; returns empty array if not present or not array.
 */
export function getArrayFromObject(obj: unknown, key: string): unknown[] {
  if (!isObject(obj) || !(key in obj)) return [];
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

/**
 * Sanctioned single-cast escape hatch for `unknown → T` narrowing.
 *
 * Use ONLY when one of the following holds:
 *   1. The value originates from an SDK whose external types we trust by
 *      contract (e.g. Prisma JsonValue read from a column we own).
 *   2. The value is shaped by a runtime guard immediately preceding this call,
 *      and we want to commit the narrow without a double-cast.
 *   3. The value comes from JSON.parse on a payload that downstream code
 *      validates structurally (e.g. each property is checked before use).
 *
 * The function exists so the project's lint rule against `as unknown as X`
 * has a single, auditable replacement — every cast routes through here, not
 * sprinkled across files. Reviewers can grep for `narrowAs<` to find every
 * trust-boundary in the codebase.
 *
 * NEVER use this for input directly from the network when the downstream
 * code does not validate. Prefer Zod schemas or `isObject` + property guards
 * in those cases.
 */
export function narrowAs<T>(value: unknown): T {
  return value as T;
}