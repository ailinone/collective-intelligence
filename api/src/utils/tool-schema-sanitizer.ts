// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool JSON-Schema sanitizer.
 *
 * Root cause context (2026-08-21 incident, requests Td9Rzv_2k4Bd0JJv0Cda3 et al):
 * a client emitted tool schemas whose `required` field was an OBJECT (`{}`)
 * instead of an array of strings. Upstream providers that validate JSON Schema
 * (notably OpenAI) reject the whole request with
 *   400 invalid_function_parameters
 *   "Invalid schema for function 'X': {} is not of type 'array'."
 * Because the offending tools array is shared by every candidate in the
 * fallback chain, ALL provider attempts fail with the same 400 and the request
 * surfaces as "Upstream provider error while streaming" — even though the pool
 * has ~100 healthy providers.
 *
 * The gateway cannot fix arbitrary schema corruption, but it CAN normalize the
 * narrow, well-defined class of violations that providers hard-reject:
 *   - `required` present but not an array of strings → drop the field
 *     (absent `required` is legal JSON Schema and accepted by providers);
 *   - `function.parameters` absent, `{}`, non-object, or not root-typed
 *     `object` → rewrite to `{ "type": "object", "properties": {} }`
 *     (or just fix the `type`, when the rest of the schema is usable); some
 *     emitters also send `type: ['object']` (array form) → 'object'.
 *
 * Sanitization is applied at request-normalization time so every downstream
 * path (single streaming chain, collectives, /v1/responses) sends clean tools.
 */

type UnknownRecord = Record<string, unknown>;

/** Canonical empty JSON Schema for function parameters (accepted by all
 * strict providers, incl. OpenAI's JSON-Schema validator). */
const EMPTY_OBJECT_PARAMETERS_SCHEMA: UnknownRecord = {
  type: 'object',
  properties: {},
};

export interface ToolSchemaNormalizationEvent {
  /** `function.name` of the tool whose schema was rewritten. */
  name: string;
  /** Which normalization was applied (for logging/telemetry). */
  reason:
    | 'parameters-absent'
    | 'parameters-empty'
    | 'parameters-invalid'
    | 'type-array'
    | 'type-missing'
    | 'type-not-object';
}

export interface SanitizeToolSchemasOptions {
  /** Invoked once per tool whose schema was rewritten (never for clean tools). */
  onNormalization?: (event: ToolSchemaNormalizationEvent) => void;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolFunctionName(tool: ToolLike): string {
  const name = tool?.function?.name;
  return typeof name === 'string' && name.length > 0 ? name : '(unnamed)';
}

/**
 * Normalize the ROOT `function.parameters` object itself: providers that
 * validate JSON Schema (OpenAI) hard-reject a request whose tool parameters
 * are absent, empty (`{}`), non-object, or not typed `object` at the root.
 * Returns a reason string when a rewrite happened, undefined otherwise.
 * `parameters` is already a cloned structure owned by the caller.
 */
function normalizeParametersShape(
  fn: { parameters?: unknown } | undefined,
  name: string,
  report: (reason: ToolSchemaNormalizationEvent['reason']) => void
): void {
  if (!fn) {
    return;
  }
  const params = fn.parameters;
  if (params === undefined || params === null) {
    fn.parameters = { ...EMPTY_OBJECT_PARAMETERS_SCHEMA };
    report('parameters-absent');
    return;
  }
  if (!isPlainObject(params)) {
    fn.parameters = { ...EMPTY_OBJECT_PARAMETERS_SCHEMA };
    report('parameters-invalid');
    return;
  }
  if (Object.keys(params).length === 0) {
    fn.parameters = { ...EMPTY_OBJECT_PARAMETERS_SCHEMA };
    report('parameters-empty');
    return;
  }
  if (!('type' in params)) {
    // Content-bearing schema missing the root type: guarantee `type: 'object'`
    // instead of dropping the (otherwise valid) properties.
    params.type = 'object';
    report('type-missing');
    return;
  }
  if (Array.isArray(params.type)) {
    // Some emitters send `type: ['object']` (valid JSON Schema 2020-12, but
    // OpenAI's validator only accepts a plain string here).
    params.type = 'object';
    report('type-array');
    return;
  }
  if (params.type !== 'object') {
    fn.parameters = { ...EMPTY_OBJECT_PARAMETERS_SCHEMA };
    report('type-not-object');
  }
}

/**
 * Recursively normalize `required` inside a JSON Schema node.
 * Mutates `node` in place — callers pass a structure they own (cloned here).
 */
function sanitizeSchemaNode(node: unknown, depth = 0): void {
  if (depth > 32 || !isPlainObject(node)) {
    return;
  }

  if ('required' in node) {
    const required = node.required;
    if (Array.isArray(required)) {
      const stringsOnly = required.filter((name): name is string => typeof name === 'string');
      if (stringsOnly.length !== required.length) {
        if (stringsOnly.length > 0) {
          node.required = stringsOnly;
        } else {
          delete node.required;
        }
      }
    } else {
      // `required: {}` (or any non-array) — the exact incident signature.
      delete node.required;
    }
  }

  const properties = node.properties;
  if (isPlainObject(properties)) {
    for (const prop of Object.values(properties)) {
      sanitizeSchemaNode(prop, depth + 1);
    }
  }

  for (const key of ['items', 'prefixItems'] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        sanitizeSchemaNode(item, depth + 1);
      }
    } else if (isPlainObject(value)) {
      sanitizeSchemaNode(value, depth + 1);
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        sanitizeSchemaNode(item, depth + 1);
      }
    }
  }

  for (const key of ['$defs', 'definitions'] as const) {
    const value = node[key];
    if (isPlainObject(value)) {
      for (const def of Object.values(value)) {
        sanitizeSchemaNode(def, depth + 1);
      }
    }
  }
}

export interface ToolLike {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

/**
 * Return a deep-clamped copy of `tools` with provider-hostile schema
 * violations normalized. `undefined`/empty input passes through unchanged.
 */
export function sanitizeToolSchemas<T extends ToolLike>(
  tools: T[] | undefined,
  options?: SanitizeToolSchemasOptions
): T[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }

  let changed = false;
  const sanitized = tools.map((tool) => {
    if (!tool || !isPlainObject(tool.function)) {
      return tool;
    }
    const fn = tool.function;
    const params = fn.parameters;
    const needsShapeFix =
      params === undefined ||
      params === null ||
      !isPlainObject(params) ||
      Object.keys(params as UnknownRecord).length === 0 ||
      !('type' in (params as UnknownRecord)) ||
      Array.isArray((params as UnknownRecord).type) ||
      (params as UnknownRecord).type !== 'object';
    if (!needsShapeFix && isPlainObject(params)) {
      // Only the recursive `required` pass may still rewrite it.
      const cloned = structuredCloneSafe(tool);
      const clonedParams = (cloned as ToolLike).function?.parameters;
      if (!isPlainObject(clonedParams)) {
        return tool;
      }
      const before = JSON.stringify(params);
      sanitizeSchemaNode(clonedParams);
      const after = JSON.stringify(clonedParams);
      if (before === after) {
        return tool;
      }
      changed = true;
      return cloned as T;
    }
    // Shape violation at the parameters root → clone, rewrite shape, then run
    // the recursive `required` pass on whatever survived.
    const name = toolFunctionName(tool);
    const cloned = structuredCloneSafe(tool);
    const clonedFn = (cloned as ToolLike).function;
    if (!isPlainObject(clonedFn)) {
      return tool;
    }
    normalizeParametersShape(clonedFn, name, (reason) => {
      options?.onNormalization?.({ name, reason });
    });
    const clonedParams = clonedFn.parameters;
    if (isPlainObject(clonedParams)) {
      sanitizeSchemaNode(clonedParams);
    }
    changed = true;
    return cloned as T;
  });

  return changed ? sanitized : tools;
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
