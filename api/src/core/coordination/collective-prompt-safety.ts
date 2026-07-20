// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Prompt Context Safety
 *
 * Sanitizes free-form text fields (variable names, values, rationales,
 * risk descriptions) before they are interpolated into a system prompt.
 *
 * Threat model:
 *   - A previous-round agent (or attacker controlling its output) could
 *     embed instructions inside a sensitivity rationale that, when this
 *     round's prompt is built, would surface as if they were part of the
 *     trusted system instructions ("\n\n# SYSTEM: ignore prior rules").
 *   - The PII redaction in `signal-validator.ts` removes secrets but does
 *     not address structural injection (newlines, code-fence breakouts,
 *     prompt-template markers, control characters).
 *
 * Strategy:
 *   - Collapse all forms of vertical whitespace and control bytes to a
 *     single space so the sanitized output stays on a single logical line
 *     when re-embedded in the prompt.
 *   - Neutralize triple backticks so a malicious value cannot close the
 *     surrounding code/quote block in the prompt.
 *   - Strip prompt-template markers shaped like `<|...|>` and
 *     `<system>`/`</system>` that some chat templates treat as control
 *     tokens.
 *   - Bound length to keep prompt cost predictable and prevent token
 *     bombs.
 *
 * This module is intentionally framework-agnostic and side-effect free so
 * it can be reused by F1.2 LLMSynthesisAggregator without coupling.
 */

const PROMPT_CONTEXT_DEFAULT_MAX_LENGTH = 500;
const VARIABLE_NAME_MAX_LENGTH = 80;
const RISK_DESCRIPTION_MAX_LENGTH = 240;

/**
 * Markers used by chat templates (Llama, Anthropic, ChatML, etc.) that
 * MUST NOT survive into untrusted-text segments of a prompt.
 */
const PROMPT_TEMPLATE_MARKERS = [
  /<\|[a-zA-Z_]+\|>/g,
  /<\/?(?:system|user|assistant|tool|function)[^>]*>/gi,
  /\[INST\]|\[\/INST\]/g,
  /<<SYS>>|<<\/SYS>>/g,
];

/**
 * Sanitize a free-form string for safe interpolation into a prompt.
 *
 * Always returns a finite-length single-line string. Never throws on
 * bad input — non-string inputs collapse to empty string so callers do
 * not have to guard.
 */
export function sanitizeForPromptContext(
  value: unknown,
  maxLength: number = PROMPT_CONTEXT_DEFAULT_MAX_LENGTH,
): string {
  if (typeof value !== 'string') return '';
  if (value.length === 0) return '';

  let sanitized = value;

  // Strip prompt-template markers BEFORE other replacements so the
  // collapse-to-space step does not split a marker across boundaries.
  for (const marker of PROMPT_TEMPLATE_MARKERS) {
    sanitized = sanitized.replace(marker, ' ');
  }

  // Collapse newlines/CR/tabs/control chars (0x00-0x1F + DEL 0x7F) to a
  // single space. Tab is folded together with newlines because mixed
  // whitespace inside a sanitized field has no semantic value once the
  // string is single-line.
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]+/g, ' ');

  // Triple backticks (and longer runs) would close a surrounding fenced
  // block in the system prompt. Replace with a visible-but-inert marker.
  sanitized = sanitized.replace(/`{3,}/g, "'''");

  // Collapse any resulting runs of whitespace.
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength - 1)}…`;
  }

  return sanitized;
}

/**
 * Sanitize a coordination variable NAME. Variables are emitted by agents,
 * so a malicious variable name like `"\n# SYSTEM:"` could break the
 * prompt structure. We restrict the allowed character class and bound
 * length tightly because variable names should look like identifiers.
 */
export function sanitizeVariableName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  // Allow: letters, digits, dot, dash, underscore, slash, colon. Anything
  // else (including whitespace and quotes) is replaced with an underscore
  // to keep the resulting string usable as a key in the formatted state
  // listing without being mistaken for a control character.
  const safe = trimmed
    .replace(/[^A-Za-z0-9._\-/:]+/g, '_')
    .replace(/_{2,}/g, '_');

  return safe.length > VARIABLE_NAME_MAX_LENGTH
    ? safe.slice(0, VARIABLE_NAME_MAX_LENGTH)
    : safe;
}

/**
 * Render a coordination-variable value as a single inert line that is
 * safe to embed in a prompt regardless of the value's runtime type.
 *
 * Numbers and booleans are rendered as their literal form. Strings flow
 * through `sanitizeForPromptContext`. Objects (including arrays) are
 * `JSON.stringify`'d and then sanitized so embedded newlines or markers
 * inside object string fields cannot escape.
 */
export function sanitizeVariableValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    return sanitizeForPromptContext(value, PROMPT_CONTEXT_DEFAULT_MAX_LENGTH);
  }

  // Best-effort JSON for objects/arrays. JSON.stringify already escapes
  // newlines inside string properties, but we sanitize the result anyway
  // so structural markers cannot survive at the JSON layer.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  return sanitizeForPromptContext(serialized ?? '', PROMPT_CONTEXT_DEFAULT_MAX_LENGTH);
}

/**
 * Sanitize a risk description for embedding under `Active risks:` lines.
 * Risk descriptions are short by convention; we cap them tighter than
 * generic free-form fields to keep the state context compact.
 */
export function sanitizeRiskDescription(value: unknown): string {
  return sanitizeForPromptContext(value, RISK_DESCRIPTION_MAX_LENGTH);
}

/**
 * Risk severities are validated upstream by the signal-validator against
 * a fixed enum, but we re-validate here defensively in case this module
 * is reused with non-validated input.
 */
const SAFE_RISK_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function sanitizeRiskSeverity(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.toLowerCase();
  return SAFE_RISK_SEVERITIES.has(lower) ? lower : 'unknown';
}

/**
 * Pure helper used by tests and by callers that want to know whether a
 * piece of free-form text *would* be modified by sanitization. Returns
 * true when the sanitized form differs from the (only-trimmed) input —
 * i.e. the input carried a structural injection signal of some kind.
 *
 * The right-hand side intentionally only `.trim()`s. Earlier drafts
 * also collapsed whitespace there, but that defeated the purpose: an
 * input with embedded newlines collapsed to spaces on both sides and
 * the comparison reported "no injection" despite the newline being a
 * structural marker that the sanitizer rightfully neutralized.
 */
export function hasPromptInjectionMarkers(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return sanitizeForPromptContext(value) !== value.trim();
}
