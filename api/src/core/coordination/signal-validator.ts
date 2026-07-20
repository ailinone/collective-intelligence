// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Signal Validation
 *
 * Validates CoordinationSignal and Sensitivity structures before they
 * enter the aggregation pipeline. Rejects malformed, suspicious or
 * degenerate signals to protect the collective state.
 */

import type {
  CoordinationSignal,
  Sensitivity,
  AgentDecision,
  SensitivityDirection,
  RiskSeverity,
} from './coordination-types';

// ============================================
// Validation result
// ============================================

export interface SignalValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: CoordinationSignal;
}

// ============================================
// Constants
// ============================================

const VALID_DIRECTIONS = new Set<string>([
  'increase', 'decrease', 'hold', 'block', 'unlock',
]);

const VALID_SEVERITIES = new Set<string>([
  'low', 'medium', 'high', 'critical',
]);

/** Maximum length for rationale strings (prevent token bloat) */
const MAX_RATIONALE_LENGTH = 2000;

/** Maximum length for variable names */
const MAX_VARIABLE_LENGTH = 200;

/** Maximum length for trigger descriptions */
const MAX_TRIGGER_LENGTH = 1000;

/** Minimum sensitivities per signal */
const MIN_SENSITIVITIES = 1;

/** Maximum sensitivities per signal (prevent token explosion) */
const MAX_SENSITIVITIES = 20;

// ============================================
// PII Redaction
// ============================================

/**
 * `String.prototype.replace` accepts EITHER a string literal OR a replacer
 * callback as its second argument. Most PII patterns just need a constant
 * redaction string (e.g. `[REDACTED_API_KEY]`), but two patterns —
 * `password_in_string` and `url_with_query` — need to peek inside the match
 * to preserve a structural prefix (the `key:` separator, the URL host)
 * before the redaction. Modeling that intent in the type removes the need
 * for the unsafe `as unknown as string` cast at the call site below and
 * lets `tsc` validate each entry against the real lib.d.ts contract.
 */
type PiiReplacer = string | ((match: string, ...args: unknown[]) => string);

interface PiiPattern {
  name: string;
  regex: RegExp;
  replacement: PiiReplacer;
}

const PII_PATTERNS: PiiPattern[] = [
  {
    name: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    name: 'basic_auth',
    regex: /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
    replacement: 'Basic [REDACTED_CREDENTIAL]',
  },
  {
    name: 'aws_access_key',
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    name: 'api_key_generic',
    regex: /((?:^|[\s:="'])\s*(?:sk|pk|ak|rk|ghp|gho|github_pat|glpat|xox[bpas])[-_][A-Za-z0-9_\-]{20,})/gm,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    name: 'aws_secret_key',
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*[A-Za-z0-9/+=]{40}/g,
    replacement: '[REDACTED_AWS_SECRET]',
  },
  {
    name: 'password_in_string',
    regex: /(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key)\s*[:=]\s*["']?[^\s"',;}\]]{8,}/gi,
    replacement: (match: string) => {
      const sepIndex = Math.max(match.indexOf(':'), match.indexOf('='));
      return sepIndex >= 0 ? match.substring(0, sepIndex + 1) + ' [REDACTED_SECRET]' : '[REDACTED_SECRET]';
    },
  },
  {
    name: 'url_with_query',
    regex: /https?:\/\/[^\s<>"']+(\?[^\s<>"']+)/gi,
    replacement: (url: string) => {
      const qIndex = url.indexOf('?');
      return qIndex >= 0 ? url.substring(0, qIndex) + '?[REDACTED_QUERY]' : url;
    },
  },
  {
    name: 'private_ip',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: '[REDACTED_IP]',
  },
  {
    name: 'email',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    name: 'cpf',
    regex: /\b\d{3}\.?\d{3}\.?\d{3}[\s\-]?\d{2}\b/g,
    replacement: '[REDACTED_CPF]',
  },
  {
    name: 'cnpj',
    regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}[\s\-]?\d{2}\b/g,
    replacement: '[REDACTED_CNPJ]',
  },
  {
    name: 'phone_br',
    regex: /(?:\+?55\s?)?\(?\d{2}\)?\s?9\d{4}[\s\-]?\d{4}/g,
    replacement: '[REDACTED_PHONE]',
  },
];

export interface PiiRedactionResult {
  redacted: string;
  patterns: string[];
}

export function redactPii(text: string): PiiRedactionResult {
  if (!text || typeof text !== 'string') {
    return { redacted: text ?? '', patterns: [] };
  }

  let result = text;
  const matched: string[] = [];

  for (const pattern of PII_PATTERNS) {
    if (pattern.regex.test(result)) {
      matched.push(pattern.name);
      // `String.prototype.replace` is overloaded for both `string` and replacer
      // callback. The PiiReplacer union covers both arms, but TS picks the
      // string overload from the union — explicit overload selection via
      // typeof keeps both arms type-safe without `any`/casts.
      result = typeof pattern.replacement === 'string'
        ? result.replace(pattern.regex, pattern.replacement)
        : result.replace(pattern.regex, pattern.replacement);
    }
    pattern.regex.lastIndex = 0;
  }

  return { redacted: result, patterns: matched };
}

function redactStringField(value: string): string {
  return redactPii(value).redacted;
}

// ============================================
// Validation helpers
// ============================================

function isString(val: unknown): val is string {
  return typeof val === 'string';
}

function isNumber(val: unknown): val is number {
  return typeof val === 'number' && isFinite(val);
}

function inRange(val: number, min: number, max: number): boolean {
  return val >= min && val <= max;
}

// ============================================
// Core validation
// ============================================

/**
 * Validate a single Sensitivity object.
 */
export function validateSensitivity(s: unknown, index: number): { errors: string[]; warnings: string[]; sanitized?: Sensitivity } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!s || typeof s !== 'object') {
    return { errors: [`sensitivity[${index}]: must be an object`], warnings };
  }

  const raw = s as Record<string, unknown>;

  // variable — required, non-empty string
  if (!isString(raw.variable) || raw.variable.trim().length === 0) {
    errors.push(`sensitivity[${index}].variable: required non-empty string`);
  } else if (raw.variable.length > MAX_VARIABLE_LENGTH) {
    errors.push(`sensitivity[${index}].variable: exceeds ${MAX_VARIABLE_LENGTH} chars`);
  }

  // direction — required, valid enum
  if (!isString(raw.direction) || !VALID_DIRECTIONS.has(raw.direction)) {
    errors.push(`sensitivity[${index}].direction: must be one of ${[...VALID_DIRECTIONS].join(', ')}`);
  }

  // trigger — required, non-empty string
  if (!isString(raw.trigger) || raw.trigger.trim().length === 0) {
    errors.push(`sensitivity[${index}].trigger: required non-empty string`);
  } else if (raw.trigger.length > MAX_TRIGGER_LENGTH) {
    warnings.push(`sensitivity[${index}].trigger: exceeds ${MAX_TRIGGER_LENGTH} chars, will be truncated`);
  }

  // expectedDelta — optional number
  if (raw.expectedDelta !== undefined && !isNumber(raw.expectedDelta)) {
    errors.push(`sensitivity[${index}].expectedDelta: must be a number if present`);
  }

  // confidence — required, 0..1
  if (!isNumber(raw.confidence) || !inRange(raw.confidence, 0, 1)) {
    errors.push(`sensitivity[${index}].confidence: required number in [0, 1]`);
  } else if (raw.confidence < 0.3) {
    warnings.push(`sensitivity[${index}].confidence: very low (${raw.confidence.toFixed(2)}), may be unreliable`);
  }

  // rationale — required, non-empty string
  if (!isString(raw.rationale) || raw.rationale.trim().length === 0) {
    errors.push(`sensitivity[${index}].rationale: required non-empty string`);
  } else if (raw.rationale.length > MAX_RATIONALE_LENGTH) {
    warnings.push(`sensitivity[${index}].rationale: exceeds ${MAX_RATIONALE_LENGTH} chars, will be truncated`);
  }

  // risk — optional, valid enum
  if (raw.risk !== undefined && (!isString(raw.risk) || !VALID_SEVERITIES.has(raw.risk))) {
    errors.push(`sensitivity[${index}].risk: must be one of ${[...VALID_SEVERITIES].join(', ')} if present`);
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  // Build sanitized object
  const sanitized: Sensitivity = {
    variable: redactStringField((raw.variable as string).trim().substring(0, MAX_VARIABLE_LENGTH)),
    direction: raw.direction as SensitivityDirection,
    trigger: redactStringField((raw.trigger as string).trim().substring(0, MAX_TRIGGER_LENGTH)),
    confidence: raw.confidence as number,
    rationale: redactStringField((raw.rationale as string).trim().substring(0, MAX_RATIONALE_LENGTH)),
  };

  if (raw.expectedDelta !== undefined) {
    sanitized.expectedDelta = raw.expectedDelta as number;
  }
  if (raw.risk !== undefined) {
    sanitized.risk = raw.risk as RiskSeverity;
  }

  return { errors: [], warnings, sanitized };
}

/**
 * Validate an AgentDecision object.
 */
export function validateDecision(d: unknown): { errors: string[]; warnings: string[]; sanitized?: AgentDecision } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!d || typeof d !== 'object') {
    return { errors: ['decision: must be an object'], warnings };
  }

  const raw = d as Record<string, unknown>;

  if (!isString(raw.type) || raw.type.trim().length === 0) {
    errors.push('decision.type: required non-empty string');
  }

  if (raw.value === undefined || raw.value === null) {
    errors.push('decision.value: required');
  }

  if (!isNumber(raw.confidence) || !inRange(raw.confidence, 0, 1)) {
    errors.push('decision.confidence: required number in [0, 1]');
  }

  if (raw.rationale !== undefined && !isString(raw.rationale)) {
    errors.push('decision.rationale: must be a string if present');
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  const sanitized: AgentDecision = {
    type: (raw.type as string).trim(),
    value: raw.value,
    confidence: raw.confidence as number,
  };

  if (raw.rationale !== undefined) {
    sanitized.rationale = redactStringField((raw.rationale as string).trim().substring(0, MAX_RATIONALE_LENGTH));
  }

  return { errors, warnings, sanitized };
}

/**
 * Validate a complete CoordinationSignal.
 *
 * Returns the validation result with a sanitized copy if valid.
 */
export function validateCoordinationSignal(signal: unknown): SignalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!signal || typeof signal !== 'object') {
    return { valid: false, errors: ['Signal must be an object'], warnings };
  }

  const raw = signal as Record<string, unknown>;

  // Required string fields
  for (const field of ['id', 'runId', 'agentId', 'modelId', 'providerId'] as const) {
    if (!isString(raw[field]) || (raw[field] as string).trim().length === 0) {
      errors.push(`${field}: required non-empty string`);
    }
  }

  // round — required positive integer
  if (!isNumber(raw.round) || !Number.isInteger(raw.round) || raw.round < 1) {
    errors.push('round: required positive integer');
  }

  // createdAt — required ISO string
  if (!isString(raw.createdAt)) {
    errors.push('createdAt: required ISO date string');
  } else if (isNaN(Date.parse(raw.createdAt))) {
    errors.push('createdAt: invalid ISO date string');
  }

  // decision
  const decisionResult = validateDecision(raw.decision);
  errors.push(...decisionResult.errors);
  warnings.push(...decisionResult.warnings);

  // sensitivities — required array with bounds
  if (!Array.isArray(raw.sensitivities)) {
    errors.push('sensitivities: required array');
  } else if (raw.sensitivities.length < MIN_SENSITIVITIES) {
    errors.push(`sensitivities: must have at least ${MIN_SENSITIVITIES} sensitivity`);
  } else if (raw.sensitivities.length > MAX_SENSITIVITIES) {
    warnings.push(`sensitivities: ${raw.sensitivities.length} exceeds max ${MAX_SENSITIVITIES}, extras will be dropped`);
  }

  const sanitizedSensitivities: Sensitivity[] = [];
  if (Array.isArray(raw.sensitivities)) {
    const toProcess = (raw.sensitivities as unknown[]).slice(0, MAX_SENSITIVITIES);
    for (let i = 0; i < toProcess.length; i++) {
      const result = validateSensitivity(toProcess[i], i);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      if (result.sanitized) {
        sanitizedSensitivities.push(result.sanitized);
      }
    }
  }

  // metrics — optional but if present must have valid fields
  if (raw.metrics !== undefined) {
    const m = raw.metrics as Record<string, unknown>;
    for (const key of ['latencyMs', 'inputTokens', 'outputTokens', 'estimatedCost'] as const) {
      if (m[key] !== undefined && !isNumber(m[key])) {
        errors.push(`metrics.${key}: must be a number if present`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Build sanitized signal
  const sanitized: CoordinationSignal = {
    id: (raw.id as string).trim(),
    runId: (raw.runId as string).trim(),
    round: raw.round as number,
    agentId: (raw.agentId as string).trim(),
    modelId: (raw.modelId as string).trim(),
    providerId: (raw.providerId as string).trim(),
    decision: decisionResult.sanitized!,
    sensitivities: sanitizedSensitivities,
    createdAt: raw.createdAt as string,
  };

  if (isString(raw.role) && raw.role.trim().length > 0) {
    sanitized.role = (raw.role as string).trim();
  }

  if (raw.metrics) {
    const m = raw.metrics as Record<string, unknown>;
    sanitized.metrics = {
      latencyMs: (m.latencyMs as number) ?? 0,
      inputTokens: (m.inputTokens as number) ?? 0,
      outputTokens: (m.outputTokens as number) ?? 0,
      estimatedCost: (m.estimatedCost as number) ?? 0,
    };
  }

  return { valid: true, errors: [], warnings, sanitized };
}

/**
 * Quick check if a raw LLM response looks like it contains a valid signal structure.
 * Used for early rejection before full parsing.
 */
export function looksLikeSignalResponse(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  // Check for JSON structure
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return true;

  // Check for markdown code block with JSON
  if (trimmed.includes('```json') || trimmed.includes('```')) return true;

  // Check for key fields in text
  if (trimmed.includes('"decision"') && trimmed.includes('"sensitivities"')) return true;

  return false;
}
