// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Privacy Redactor — Pure functions for TraceEnvelope redaction.
 *
 * See ADR-016 (Privacy Mode Enforced at Serializer).
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Compliance posture: Privacy by Default (GDPR Art. 25, LGPD Art. 6 III).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * We adopt a THREE-TIER data classification (ISO 27001 A.5.12):
 *   T1 — Direct Identifier    → pseudonymize (GDPR Art. 32(1)(a) safeguard)
 *   T2 — Quasi-Identifier     → redact
 *   T3 — Operational          → pass (about caller's system, not their users)
 *   T4 — Technical            → pass (metrics have no PII)
 *
 * This follows a DENY-BY-DEFAULT model for `custom.*`: anything not in the
 * operational allow-list is treated as T2 (redacted). Direct identifiers
 * known to the schema (userId, sessionId) are pseudonymized instead of
 * redacted so per-destination correlation is preserved without revealing
 * the raw value (GDPR Recital 26 still treats pseudonymous data as PII,
 * but allows lighter processing restrictions).
 *
 * Design invariants (verified by property tests):
 *   1. IDEMPOTENCE   — redact(redact(e, p), p) === redact(e, p)
 *   2. MONOTONICITY  — stricter policies never leak more data than looser ones
 *   3. COMPLETENESS  — T1/T2 fields never appear in cleartext when redaction is on
 *   4. PURITY        — input envelope is never mutated
 *   5. DETERMINISM   — pseudonymization is stable per (destinationId, value)
 */

import { createHmac } from 'node:crypto';
import { narrowAs } from '@/utils/type-guards';
import type {
  TraceEnvelope,
  Content,
  CustomTraceMetadata,
  TenantContext,
  Routing,
} from './trace-envelope';

// ─── Field redaction modes ───────────────────────────────────────────────

/**
 * Per-field treatment.
 *
 *   'pass'         — emit the value as-is
 *   'redact'       — replace with [REDACTED] placeholder (irreversible, no correlation)
 *   'pseudonymize' — replace with HMAC-SHA256(destinationKey, value) hex prefix
 *                    (deterministic per destination → preserves per-destination
 *                    correlation; GDPR Art. 32(1)(a) recognized safeguard)
 */
export type FieldMode = 'pass' | 'redact' | 'pseudonymize';

// ─── Policy ──────────────────────────────────────────────────────────────

export interface PrivacyPolicy {
  /** Treatment for message content and choice content (GDPR Art. 5(1)(b) purpose limitation). */
  contentMode: FieldMode;

  /** Treatment for tool_call arguments (often contain prompt fragments / user data). */
  toolArgumentsMode: FieldMode;

  /** Treatment for error messages (may embed prompt content in stack traces). */
  errorMessageMode: FieldMode;

  /**
   * Treatment for OUR internal tenant identifiers (organizationId, userId, apiKeyId).
   * Under GDPR Recital 26, UUIDs linkable to natural persons ARE personal data,
   * even when opaque. Pseudonymization preserves per-destination correlation
   * (e.g., "all traces from this anonymous user") without leaking our internal IDs.
   */
  tenantIdentifiersMode: FieldMode;

  /**
   * Treatment for routing decision free-text fields (reason, exclusion messages).
   * These are code-generated but may embed PII via interpolation
   * (e.g., "skipped: user X exceeded quota"). Conservative default is redact.
   */
  routingFreeTextMode: FieldMode;

  /** Explicit per-key treatment for `custom.*` fields. Keys here override defaults. */
  customFieldModes: Readonly<Record<string, FieldMode>>;

  /**
   * Deny-by-default behavior: any `custom.*` key NOT listed in `customFieldModes`
   * AND NOT in this allow-list gets `defaultCustomMode`.
   *
   * Per ISO 27001 A.5.12, fields must be explicitly classified. Defaulting to
   * T3 (pass) for unknown keys violates data-minimization (GDPR Art. 5(1)(c)).
   */
  operationalAllowList: ReadonlySet<string>;

  /** Treatment applied to custom.* keys not in allowList and not in customFieldModes. */
  defaultCustomMode: FieldMode;

  /**
   * Destination-scoped secret used as HMAC key for pseudonymization.
   * A per-destination key ensures that pseudonyms in destination A cannot be
   * joined to pseudonyms in destination B, reducing correlation-attack surface.
   */
  pseudonymizationKey?: Buffer;
}

// ─── Classification — T3 (Operational) fields ────────────────────────────

/**
 * T3 Operational fields. These describe the CALLER'S system, not their users,
 * and carry no inherent PII risk. Pass through by default.
 *
 * Decisions explicitly documented:
 *   - environment    : deployment env ("production" / "staging"). Operational.
 *   - feature        : feature flag name. Operational.
 *   - version        : caller app version. Operational.
 *   - parentSpanId   : OTEL span linkage (16-char hex). Technical topology, not PII.
 *
 * Explicitly EXCLUDED (considered T1/T2):
 *   - userId         : direct end-user identifier. T1 → pseudonymize.
 *   - sessionId      : pseudonymous identifier (GDPR Recital 26). T1 → pseudonymize.
 *   - traceId        : external correlation ID; may embed user/tenant identifiers. T2 → redact.
 *   - traceName,
 *     spanName,
 *     generationName : caller-supplied display labels; often embed user context. T2 → redact.
 *   - tags           : free-form array; unbounded PII risk. T2 → redact.
 */
export const DEFAULT_OPERATIONAL_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set<string>(['environment', 'feature', 'version', 'parentSpanId'])
);

/** Direct identifiers (T1) that are pseudonymized rather than dropped. */
export const DEFAULT_T1_IDENTIFIER_MODES: Readonly<Record<string, FieldMode>> = Object.freeze({
  userId: 'pseudonymize',
  sessionId: 'pseudonymize',
});

// ─── Predefined policies ─────────────────────────────────────────────────

/**
 * PRIVACY_POLICY_PASSTHROUGH — sends everything verbatim.
 * Use only for debugging destinations in private/non-production environments.
 * NOT the default. NOT compliant with GDPR Art. 25 "by default".
 */
export const PRIVACY_POLICY_PASSTHROUGH: PrivacyPolicy = Object.freeze<PrivacyPolicy>({
  contentMode: 'pass',
  toolArgumentsMode: 'pass',
  errorMessageMode: 'pass',
  tenantIdentifiersMode: 'pass',
  routingFreeTextMode: 'pass',
  customFieldModes: {},
  operationalAllowList: new Set<string>(),
  defaultCustomMode: 'pass',
});

/**
 * PRIVACY_POLICY_SOTA — the enterprise default.
 *
 * Compliance:
 *   ✅ GDPR Art. 25   (Privacy by Default)
 *   ✅ GDPR Art. 5(1)(c) (Data Minimisation)
 *   ✅ GDPR Art. 32(1)(a) (Pseudonymisation as safeguard)
 *   ✅ LGPD Art. 6 III (Necessidade)
 *   ✅ ISO 27001 A.5.12 (Classification) / A.8.11 (Data masking)
 *
 * Behavior:
 *   - Messages / choices / tool args: REDACTED
 *   - Error messages: REDACTED (may embed prompt content)
 *   - custom.userId, custom.sessionId: PSEUDONYMIZED (correlation preserved per destination)
 *   - custom.environment / feature / version / parentSpanId: PASS (operational)
 *   - All other custom.* keys: REDACTED (deny-by-default)
 */
export const PRIVACY_POLICY_SOTA: PrivacyPolicy = Object.freeze<PrivacyPolicy>({
  contentMode: 'redact',
  toolArgumentsMode: 'redact',
  errorMessageMode: 'redact',
  // Our own tenant UUIDs are PII under GDPR Recital 26. Pseudonymize so
  // per-destination correlation survives (e.g., "traces from this user") while
  // the raw UUID never leaves us. Supports Right to Erasure (ADR-021): we
  // deterministically recompute the pseudonym for a given user and delete.
  tenantIdentifiersMode: 'pseudonymize',
  // Routing free-text is generated by our code, not by users, but may embed
  // interpolated values (model names, tenant info). Redact is the safe default.
  routingFreeTextMode: 'redact',
  customFieldModes: DEFAULT_T1_IDENTIFIER_MODES,
  operationalAllowList: DEFAULT_OPERATIONAL_ALLOWLIST,
  defaultCustomMode: 'redact',
});

// ─── Placeholders ────────────────────────────────────────────────────────

export const REDACTED_STRING = '[REDACTED]';
export const REDACTED_ARGS = '{}';
export const PSEUDONYM_PREFIX = 'pseu_';

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Produce a redacted copy of the envelope according to the policy.
 * Pure function — input is never mutated.
 */
export function redactEnvelope(envelope: TraceEnvelope, policy: PrivacyPolicy): TraceEnvelope {
  const tenant = redactTenant(envelope.tenant, policy);
  const routing = redactRouting(envelope.routing, policy);
  const content = redactContent(envelope.content, policy);
  const custom = redactCustom(envelope.custom, policy);
  const status = redactStatus(envelope.status, policy);

  // Marker attribute: downstream auditors can detect redacted envelopes.
  const applied = isRedactingAnything(policy);
  const markedCustom: CustomTraceMetadata = applied
    ? (narrowAs<CustomTraceMetadata>({ ...custom, 'broadcast.privacy_mode_applied': true }))
    : custom;

  return {
    ...envelope,
    tenant,
    routing,
    content,
    custom: markedCustom,
    status,
  };
}

/**
 * Build an effective policy for a given destination.
 *
 * A destination stores:
 *   - privacy_mode: boolean       (toggle)
 *   - privacy_custom_fields: []   (per-key overrides)
 *
 * If privacy_mode is OFF → PRIVACY_POLICY_PASSTHROUGH (but still strips multimodal, etc.).
 * If privacy_mode is ON  → PRIVACY_POLICY_SOTA + per-destination overrides.
 */
export function buildDefaultPrivacyPolicy(
  destination: {
    privacyMode: boolean;
    pseudonymizationKey?: Buffer;
    customFieldOverrides?: Readonly<Record<string, FieldMode>>;
  }
): PrivacyPolicy {
  if (!destination.privacyMode) {
    return { ...PRIVACY_POLICY_PASSTHROUGH, pseudonymizationKey: destination.pseudonymizationKey };
  }

  return {
    ...PRIVACY_POLICY_SOTA,
    customFieldModes: {
      ...PRIVACY_POLICY_SOTA.customFieldModes,
      ...(destination.customFieldOverrides ?? {}),
    },
    pseudonymizationKey: destination.pseudonymizationKey,
  };
}

export function isRedactingAnything(policy: PrivacyPolicy): boolean {
  if (policy.contentMode !== 'pass') return true;
  if (policy.toolArgumentsMode !== 'pass') return true;
  if (policy.errorMessageMode !== 'pass') return true;
  if (policy.tenantIdentifiersMode !== 'pass') return true;
  if (policy.routingFreeTextMode !== 'pass') return true;
  if (policy.defaultCustomMode !== 'pass') return true;
  for (const mode of Object.values(policy.customFieldModes)) {
    if (mode !== 'pass') return true;
  }
  return false;
}

// ─── Internal helpers ────────────────────────────────────────────────────

function applyMode(
  value: string,
  mode: FieldMode,
  policy: PrivacyPolicy,
  fieldNameForSalt: string
): string {
  switch (mode) {
    case 'pass':
      return value;
    case 'redact':
      return REDACTED_STRING;
    case 'pseudonymize':
      return pseudonymize(value, policy.pseudonymizationKey, fieldNameForSalt);
  }
}

/**
 * Pseudonymize a value using HMAC-SHA256 keyed by the destination.
 * Returns first 16 chars of hex digest, prefixed so it's recognizably a pseudonym.
 *
 * Properties:
 *   - Deterministic per (key, field, value) — enables correlation within one destination
 *   - Non-reversible without the key (GDPR Art. 32(1)(a) safeguard)
 *   - Salted by field name to prevent cross-field collisions
 *   - If no key provided: falls back to redaction (fail-closed)
 */
export function pseudonymize(value: string, key?: Buffer, fieldName = ''): string {
  if (!key || key.length === 0) {
    // Fail-closed: without a key, we cannot safely pseudonymize.
    return REDACTED_STRING;
  }
  // Idempotence: if the value is already a pseudonym or a redaction marker,
  // re-hashing would produce a DIFFERENT pseudonym — violating invariant 1.
  // Treat both as fixed points.
  if (value === REDACTED_STRING || value.startsWith(PSEUDONYM_PREFIX)) {
    return value;
  }
  const hmac = createHmac('sha256', key);
  hmac.update(fieldName);
  hmac.update('\x1f'); // unit separator; avoids field-name/value collisions
  hmac.update(value);
  return PSEUDONYM_PREFIX + hmac.digest('hex').slice(0, 16);
}

function redactContent(content: Content, policy: PrivacyPolicy): Content {
  const passContent = policy.contentMode === 'pass';
  const passArgs = policy.toolArgumentsMode === 'pass';
  if (passContent && passArgs) return content;

  const redactBody = (raw: string | unknown[]): string | unknown[] => {
    if (passContent) return raw;
    if (policy.contentMode === 'redact') return REDACTED_STRING;
    // pseudonymize: hash the serialized form
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return pseudonymize(str, policy.pseudonymizationKey, 'content');
  };

  const redactArgs = (raw: string): string => {
    if (passArgs) return raw;
    if (policy.toolArgumentsMode === 'redact') return REDACTED_ARGS;
    return pseudonymize(raw, policy.pseudonymizationKey, 'tool_arguments');
  };

  return {
    ...content,
    messages: passContent
      ? content.messages
      : content.messages.map((m) => ({ ...m, content: redactBody(m.content) })),
    choices: content.choices.map((c) => ({
      ...c,
      message: passContent
        ? c.message
        : { ...c.message, content: redactBody(c.message.content) },
      toolCalls: c.toolCalls?.map((tc) => ({
        ...tc,
        function: { ...tc.function, arguments: redactArgs(tc.function.arguments) },
      })),
    })),
  };
}

function redactCustom(custom: CustomTraceMetadata, policy: PrivacyPolicy): CustomTraceMetadata {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(custom)) {
    const mode: FieldMode =
      policy.customFieldModes[key] ??
      (policy.operationalAllowList.has(key) ? 'pass' : policy.defaultCustomMode);

    if (mode === 'pass' || value == null) {
      out[key] = value;
      continue;
    }

    // For non-string values, serialize before applying mode.
    if (typeof value === 'string') {
      out[key] = applyMode(value, mode, policy, key);
    } else if (Array.isArray(value)) {
      out[key] =
        mode === 'redact'
          ? REDACTED_STRING
          : applyMode(JSON.stringify(value), mode, policy, key);
    } else if (typeof value === 'object') {
      out[key] =
        mode === 'redact'
          ? REDACTED_STRING
          : applyMode(JSON.stringify(value), mode, policy, key);
    } else {
      // number, boolean — low PII risk, but we respect the mode
      out[key] = mode === 'redact' ? REDACTED_STRING : applyMode(String(value), mode, policy, key);
    }
  }
  return out as CustomTraceMetadata;
}

function redactTenant(tenant: TenantContext, policy: PrivacyPolicy): TenantContext {
  if (policy.tenantIdentifiersMode === 'pass') return tenant;

  const transform = (value: string | null, field: string): string | null => {
    if (value === null) return null;
    if (policy.tenantIdentifiersMode === 'redact') return REDACTED_STRING;
    return pseudonymize(value, policy.pseudonymizationKey, `tenant.${field}`);
  };

  return {
    ...tenant,
    organizationId: transform(tenant.organizationId, 'organizationId'),
    userId: transform(tenant.userId, 'userId'),
    apiKeyId: transform(tenant.apiKeyId, 'apiKeyId'),
  };
}

function redactRouting(routing: Routing, policy: PrivacyPolicy): Routing {
  if (policy.routingFreeTextMode === 'pass') return routing;

  const transform = (value: string, field: string): string => {
    if (policy.routingFreeTextMode === 'redact') return REDACTED_STRING;
    return pseudonymize(value, policy.pseudonymizationKey, `routing.${field}`);
  };

  return {
    ...routing,
    reason: transform(routing.reason, 'reason'),
    candidatesConsidered: routing.candidatesConsidered.map((c) => ({
      ...c,
      excluded: c.excluded === undefined ? undefined : transform(c.excluded, 'excluded'),
    })),
  };
}

function redactStatus(status: TraceEnvelope['status'], policy: PrivacyPolicy): TraceEnvelope['status'] {
  if (policy.errorMessageMode === 'pass' || !status.errorMessage) return status;
  const redacted =
    policy.errorMessageMode === 'redact'
      ? REDACTED_STRING
      : pseudonymize(status.errorMessage, policy.pseudonymizationKey, 'error_message');
  return { ...status, errorMessage: redacted };
}
