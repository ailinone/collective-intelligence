// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Deployment JSON Env Parser — Batch 8.2
 *
 * ### Problem
 *
 * A single customer often has **multiple deployments** of the same
 * provider — e.g. an operator running Azure OpenAI with:
 *
 *   - `prod-chat`        (primary production chat deployment)
 *   - `prod-fallback`    (cheaper fallback chat deployment)
 *   - `dev-embeddings`   (embedding deployment for dev)
 *
 * Each deployment is a distinct URL → distinct adapter instance (the
 * "one adapter = one immutable baseUrl" invariant of every
 * `OpenAICompatibleHubAdapter` subclass; see the design block at the top
 * of `azure/azure-openai-adapter.ts`). The single-deployment env-var
 * convention (`AZURE_OPENAI_DEPLOYMENT=<deployment-name>`) only covers
 * the one-shot case.
 *
 * Note: aliases above are illustrative — operators pick any kebab-case
 * short names. Specific model identifiers are NEVER hardcoded here;
 * the catalog/discovery service is the sole source of truth for which
 * models each deployment serves.
 *
 * ### Solution
 *
 * Operators set **one** JSON env var per provider with an array of
 * deployment specs. This module parses and validates those specs so the
 * registrar can build N adapter instances.
 *
 * ### Env-var wire format
 *
 * **`AZURE_OPENAI_DEPLOYMENTS`** — JSON array (aliases + deployment
 * names are operator-chosen; placeholders shown as `<…>`):
 * ```json
 * [
 *   { "alias": "prod-chat",     "deployment": "<chat-deployment>",     "resourceName": "my-aoai" },
 *   { "alias": "prod-fallback", "deployment": "<fallback-deployment>", "resourceName": "my-aoai",
 *     "apiVersion": "2024-10-21", "apiKey": "${AZURE_OPENAI_API_KEY_ALT}" }
 * ]
 * ```
 *
 * **`DATABRICKS_SERVING_ENDPOINTS`** — JSON array:
 * ```json
 * [
 *   { "alias": "chat-primary", "endpoint": "<chat-endpoint>",       "workspaceHost": "myorg.cloud.databricks.com" },
 *   { "alias": "chat-small",   "endpoint": "<small-chat-endpoint>" }
 * ]
 * ```
 *
 * **`AWS_SAGEMAKER_ENDPOINTS`** — JSON array:
 * ```json
 * [
 *   { "alias": "chat-oai",   "endpointName": "<oai-compat-endpoint>", "payloadSchema": "openai" },
 *   { "alias": "legacy-gen", "endpointName": "<legacy-endpoint>",     "payloadSchema": "jumpstart" }
 * ]
 * ```
 *
 * ### Design rules
 *
 *   - **Tolerant of absent input.** Undefined / empty / whitespace-only
 *     returns `[]` — the registrar then does nothing. Operators who
 *     never set the env var are unaffected.
 *   - **Tolerant of partial malformation.** An array with 3 entries and
 *     1 invalid entry yields the 2 valid entries plus a warning log
 *     describing what was dropped. One bad JSON object must not abort
 *     a whole multi-deployment batch.
 *   - **Fails loudly on TOP-LEVEL malformation.** If the JSON itself is
 *     syntactically invalid, or the root is not an array, the parser
 *     logs an error and returns `[]`. This surfaces operator mistakes
 *     without crashing boot.
 *   - **Aliases drive providerId synthesis.** The `alias` field is
 *     mandatory — it's what becomes the adapter's unique provider name
 *     (e.g. `azure-openai-<alias>`). Aliases must be lowercase
 *     kebab-case (same regex as catalog providerId).
 *   - **`${VAR}` env-var interpolation** inside string values is
 *     supported for secrets. Unresolved variables resolve to the empty
 *     string with a warning — the adapter's health check later rejects
 *     the empty key, so the failure mode is still loud.
 *
 * ### What this module does NOT do
 *
 *   - It does NOT construct adapters. That's `multi-deployment-registrar.ts`.
 *   - It does NOT touch the `ProviderRegistry`. That's the registrar.
 *   - It does NOT synthesize catalog entries. The multi-deployment path
 *     bypasses the catalog bridge entirely (the catalog-loader flow
 *     is still test-only in this repo) and registers adapters directly.
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'multi-deployment-parser' });

// ─── Shared validation primitives ────────────────────────────────────────

/**
 * Provider-ID-compatible slug regex. Deliberately identical to the
 * catalog's Zod rule (`provider-catalog.schema.ts` line ~144) so an
 * alias can safely be suffixed onto a parent providerId and still pass
 * any downstream kebab-case validator.
 */
const ALIAS_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ALIAS_MAX_LEN = 32;

/**
 * True if `s` is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate an alias string. Returns `true` only if it matches the
 * kebab-case alias pattern and fits in the length budget. Short names
 * (2 chars) are fine — downstream suffixing never drops below
 * `<parent>-<2-char>`.
 */
export function isValidAlias(alias: unknown): alias is string {
  if (typeof alias !== 'string') return false;
  if (alias.length < 2 || alias.length > ALIAS_MAX_LEN) return false;
  return ALIAS_PATTERN.test(alias);
}

/**
 * Expand `${VAR_NAME}` occurrences inside a string with `process.env`
 * values. Missing / empty vars yield an empty string and a warning.
 *
 * Supports a subset that is safe for ops: no shell-style fallbacks
 * (`${VAR:-default}`), no command substitution. Deliberately minimal.
 */
export function expandEnvInString(
  raw: string,
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  return raw.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, varName: string) => {
    const v = envSource[varName];
    if (v === undefined || v === '') {
      log.warn(
        { varName },
        'multi-deployment-parser: interpolation failed — env var unresolved or empty',
      );
      return '';
    }
    return v;
  });
}

// ─── Public spec types ───────────────────────────────────────────────────

/**
 * One Azure OpenAI deployment, parsed from `AZURE_OPENAI_DEPLOYMENTS`.
 *
 * `deployment` is the Azure admin-chosen name that appears in the URL
 * path. `alias` is the operator-chosen short name that becomes the
 * providerId suffix (`azure-openai-<alias>`).
 *
 * When two deployments share a `resourceName` they MUST still have
 * distinct `alias` values — the alias is the primary key.
 */
export interface AzureDeploymentSpec {
  readonly alias: string;
  readonly deployment: string;
  readonly resourceName?: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly apiKey?: string;
}

/**
 * One Databricks serving endpoint, parsed from
 * `DATABRICKS_SERVING_ENDPOINTS`. The endpoint field carries the
 * Databricks-chosen serving-endpoint slug, already configured in the
 * Databricks workspace.
 */
export interface DatabricksEndpointSpec {
  readonly alias: string;
  readonly endpoint: string;
  readonly workspaceHost?: string;
  readonly apiKey?: string;
}

/**
 * One AWS SageMaker runtime endpoint, parsed from
 * `AWS_SAGEMAKER_ENDPOINTS`. `endpointName` matches the AWS console
 * endpoint name. `payloadSchema` mirrors the three schemas the
 * `AWSSageMakerAdapter` knows about (`openai` | `jumpstart` | `hf-tgi`).
 */
export interface SageMakerEndpointSpec {
  readonly alias: string;
  readonly endpointName: string;
  readonly payloadSchema?: 'openai' | 'jumpstart' | 'hf-tgi';
  readonly region?: string;
  readonly customAttributes?: string;
}

/**
 * Union of all spec shapes — used only for the generic
 * `parseMultiDeploymentEnv` helper.
 */
export type DeploymentSpec =
  | AzureDeploymentSpec
  | DatabricksEndpointSpec
  | SageMakerEndpointSpec;

// ─── Generic top-level parser ────────────────────────────────────────────

/**
 * Read and validate raw JSON from an env var into an array of typed
 * specs. The per-entry validator returns a typed spec on success or
 * `null` on failure (the error is logged inside the validator).
 *
 * Returns `[]` for absent / malformed / empty input. Duplicates — same
 * alias twice — are filtered out here; first-occurrence wins, and the
 * subsequent entries are logged.
 */
export function parseMultiDeploymentEnv<T extends DeploymentSpec>(
  raw: string | undefined,
  envVarName: string,
  validate: (entry: unknown, index: number) => T | null,
): readonly T[] {
  if (!isNonEmptyString(raw)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error(
      { envVarName, err: err instanceof Error ? err.message : String(err) },
      'multi-deployment-parser: JSON.parse failed — ignoring env var',
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.error(
      { envVarName, typeOfRoot: typeof parsed },
      'multi-deployment-parser: root is not an array — ignoring env var',
    );
    return [];
  }

  const results: T[] = [];
  const seenAliases = new Set<string>();
  for (let i = 0; i < parsed.length; i += 1) {
    const validated = validate(parsed[i], i);
    if (!validated) continue;
    if (seenAliases.has(validated.alias)) {
      log.warn(
        { envVarName, alias: validated.alias, index: i },
        'multi-deployment-parser: duplicate alias — keeping first occurrence, dropping this one',
      );
      continue;
    }
    seenAliases.add(validated.alias);
    results.push(validated);
  }

  return results;
}

// ─── Azure OpenAI ────────────────────────────────────────────────────────

/**
 * Parse `AZURE_OPENAI_DEPLOYMENTS`. See module-header block for the
 * wire format. Entries missing a valid `alias` or `deployment` are
 * discarded with a warning.
 *
 * `resourceName` / `endpoint` are BOTH optional at parse time — the
 * adapter builder picks up the process-wide defaults
 * (`AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_ENDPOINT`) as fallback
 * when the spec doesn't specify them. Either the spec or the env
 * default must resolve by adapter construction time, or the adapter
 * ships its "MISSING_AZURE_OPENAI_CONFIG" sentinel URL (loud failure).
 */
export function parseAzureDeployments(
  raw: string | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): readonly AzureDeploymentSpec[] {
  return parseMultiDeploymentEnv<AzureDeploymentSpec>(
    raw,
    'AZURE_OPENAI_DEPLOYMENTS',
    (entry, index) => {
      if (!entry || typeof entry !== 'object') {
        log.warn({ index }, 'Azure deployment entry is not an object — skipping');
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const alias = obj.alias;
      if (!isValidAlias(alias)) {
        log.warn(
          { index, alias: typeof alias === 'string' ? alias : typeof alias },
          'Azure deployment: invalid/missing alias (kebab-case, 2-32 chars) — skipping',
        );
        return null;
      }
      if (!isNonEmptyString(obj.deployment)) {
        log.warn(
          { index, alias },
          'Azure deployment: missing "deployment" field — skipping',
        );
        return null;
      }
      return {
        alias,
        deployment: obj.deployment.trim(),
        resourceName: isNonEmptyString(obj.resourceName)
          ? obj.resourceName.trim()
          : undefined,
        endpoint: isNonEmptyString(obj.endpoint)
          ? obj.endpoint.trim()
          : undefined,
        apiVersion: isNonEmptyString(obj.apiVersion)
          ? obj.apiVersion.trim()
          : undefined,
        apiKey: isNonEmptyString(obj.apiKey)
          ? expandEnvInString(obj.apiKey.trim(), envSource)
          : undefined,
      };
    },
  );
}

// ─── Databricks serving endpoints ────────────────────────────────────────

/**
 * Parse `DATABRICKS_SERVING_ENDPOINTS`. Entries missing a valid `alias`
 * or `endpoint` are discarded with a warning. `workspaceHost` falls
 * back to `DATABRICKS_HOST` at adapter-build time when not specified.
 */
export function parseDatabricksEndpoints(
  raw: string | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): readonly DatabricksEndpointSpec[] {
  return parseMultiDeploymentEnv<DatabricksEndpointSpec>(
    raw,
    'DATABRICKS_SERVING_ENDPOINTS',
    (entry, index) => {
      if (!entry || typeof entry !== 'object') {
        log.warn({ index }, 'Databricks endpoint entry is not an object — skipping');
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const alias = obj.alias;
      if (!isValidAlias(alias)) {
        log.warn(
          { index, alias: typeof alias === 'string' ? alias : typeof alias },
          'Databricks endpoint: invalid/missing alias (kebab-case, 2-32 chars) — skipping',
        );
        return null;
      }
      if (!isNonEmptyString(obj.endpoint)) {
        log.warn(
          { index, alias },
          'Databricks endpoint: missing "endpoint" field — skipping',
        );
        return null;
      }
      return {
        alias,
        endpoint: obj.endpoint.trim(),
        workspaceHost: isNonEmptyString(obj.workspaceHost)
          ? obj.workspaceHost.trim()
          : undefined,
        apiKey: isNonEmptyString(obj.apiKey)
          ? expandEnvInString(obj.apiKey.trim(), envSource)
          : undefined,
      };
    },
  );
}

// ─── AWS SageMaker runtime endpoints ─────────────────────────────────────

const SAGEMAKER_SCHEMA_VALUES = new Set<SageMakerEndpointSpec['payloadSchema']>([
  'openai',
  'jumpstart',
  'hf-tgi',
]);

/**
 * Parse `AWS_SAGEMAKER_ENDPOINTS`. Entries missing a valid `alias` or
 * `endpointName` are discarded. `payloadSchema` defaults to `"openai"`
 * (the modern vLLM / TGI default) when absent, but when present MUST
 * be one of the three known values — unknown schemas are discarded
 * (not silently coerced) so typos become loud errors.
 */
export function parseSageMakerEndpoints(
  raw: string | undefined,
): readonly SageMakerEndpointSpec[] {
  return parseMultiDeploymentEnv<SageMakerEndpointSpec>(
    raw,
    'AWS_SAGEMAKER_ENDPOINTS',
    (entry, index) => {
      if (!entry || typeof entry !== 'object') {
        log.warn({ index }, 'SageMaker endpoint entry is not an object — skipping');
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const alias = obj.alias;
      if (!isValidAlias(alias)) {
        log.warn(
          { index, alias: typeof alias === 'string' ? alias : typeof alias },
          'SageMaker endpoint: invalid/missing alias (kebab-case, 2-32 chars) — skipping',
        );
        return null;
      }
      if (!isNonEmptyString(obj.endpointName)) {
        log.warn(
          { index, alias },
          'SageMaker endpoint: missing "endpointName" field — skipping',
        );
        return null;
      }
      let payloadSchema: SageMakerEndpointSpec['payloadSchema'];
      if (obj.payloadSchema !== undefined) {
        if (!SAGEMAKER_SCHEMA_VALUES.has(obj.payloadSchema as never)) {
          log.warn(
            { index, alias, payloadSchema: obj.payloadSchema },
            'SageMaker endpoint: unknown payloadSchema — must be "openai" | "jumpstart" | "hf-tgi" — skipping entry',
          );
          return null;
        }
        payloadSchema = obj.payloadSchema as SageMakerEndpointSpec['payloadSchema'];
      }
      return {
        alias,
        endpointName: obj.endpointName.trim(),
        payloadSchema,
        region: isNonEmptyString(obj.region) ? obj.region.trim() : undefined,
        customAttributes: isNonEmptyString(obj.customAttributes)
          ? obj.customAttributes.trim()
          : undefined,
      };
    },
  );
}

// ─── ProviderId synthesis ────────────────────────────────────────────────

/**
 * Synthesize a unique providerId from a parent name + alias.
 *
 * The result is ALWAYS `<parent>-<alias>` with the parent kept intact
 * (no further normalization) and the alias already guaranteed kebab-
 * case by `isValidAlias`. Max length is capped to keep downstream
 * callers that assume ≤ 40 chars (the catalog Zod limit) safe.
 */
export function synthesizeDeploymentProviderId(
  parent: string,
  alias: string,
): string {
  const combined = `${parent}-${alias}`;
  if (combined.length > 40) {
    log.warn(
      { parent, alias, combined },
      'multi-deployment-parser: synthesized providerId exceeds 40 chars — truncating',
    );
    return combined.slice(0, 40);
  }
  return combined;
}
