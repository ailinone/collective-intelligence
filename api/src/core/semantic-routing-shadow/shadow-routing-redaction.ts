// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-redaction.ts — MVP 8C.0
 *
 * Defence-in-depth scrubber for shadow log payloads. Strips:
 *   - any forbidden top-level key
 *   - email + phone patterns inside string values
 *   - raw modelId / providerId — hashed to a short deterministic token
 *     (so two requests using the same model produce the same hash and
 *     the operator can compare aggregate diffs without leaking the id)
 *
 * Pure. No I/O. No randomness.
 */

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'rawPrompt',
  'response',
  'rawResponse',
  'messages',
  'userMessage',
  'rawContext',
  'context',
  'attachments',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'cookies',
  'token',
  'accessToken',
  'refreshToken',
  'email',
  'phone',
  'fullName',
  'userId',
  'userName',
  'rawProviderPayload',
  'rawToolOutputs',
  'judge_rubric',
  'judgeRubric',
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}/g;
const REDACTION = '[REDACTED]';

/**
 * Scrubs a single string for email/phone matches. Pure.
 */
export function scrubString(s: string): string {
  let out = s.replace(EMAIL_RE, REDACTION);
  let digits = 0;
  for (const ch of out) if (ch >= '0' && ch <= '9') digits += 1;
  if (digits >= 9) out = out.replace(PHONE_RE, REDACTION);
  return out;
}

/**
 * Deterministic short hash for a sensitive identifier (modelId,
 * providerId, userId, …). 32-bit FNV-1a → 8-char hex. Two equal
 * inputs always yield the same hash; an operator can group across
 * requests without ever seeing the raw value.
 */
export function hashIdentifier(value: string | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const u32 = h >>> 0;
  return u32.toString(16).padStart(8, '0');
}

/**
 * Deep redaction over an arbitrary JSON-shaped value:
 *   - drops forbidden keys
 *   - scrubs all string leaves
 *   - preserves numbers / booleans / null
 *
 * Limited depth (8) so a runaway nested object cannot lock up the
 * shadow path.
 */
export function redactPayload(input: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTION;
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return scrubString(input);
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const item of input) out.push(redactPayload(item, depth + 1));
    return out;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = redactPayload(v, depth + 1);
    }
    return out;
  }
  return REDACTION;
}

export const __forTesting = Object.freeze({
  FORBIDDEN_KEYS,
  EMAIL_RE,
  PHONE_RE,
  REDACTION,
});
