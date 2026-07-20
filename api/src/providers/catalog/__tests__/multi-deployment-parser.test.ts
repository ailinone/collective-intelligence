// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * multi-deployment-parser — pure-parser contract tests.
 *
 * These tests exercise the JSON env-var parsing functions. They are
 * fully deterministic — no filesystem, no network, no mocked clients.
 * The only external is `process.env` for the `${VAR}` expansion test.
 *
 * The parser's job is narrow: turn a (possibly-missing, possibly-
 * malformed) JSON string into typed spec arrays with sane tolerance
 * for partial failures. These tests codify:
 *
 *   1. Happy-path parsing of each provider's JSON shape
 *   2. Absent / empty inputs → `[]`
 *   3. Syntactically invalid JSON → `[]` (not a throw)
 *   4. Non-array root → `[]`
 *   5. Per-entry partial failures leave valid entries intact
 *   6. Duplicate aliases — first wins, rest dropped
 *   7. Alias validation rules (kebab-case, length)
 *   8. `${VAR}` interpolation (success + miss)
 *   9. SageMaker payloadSchema enum validation
 *  10. `synthesizeDeploymentProviderId` shape + truncation
 */

import { describe, expect, it } from 'vitest';
import {
  expandEnvInString,
  isValidAlias,
  parseAzureDeployments,
  parseDatabricksEndpoints,
  parseMultiDeploymentEnv,
  parseSageMakerEndpoints,
  synthesizeDeploymentProviderId,
  type AzureDeploymentSpec,
} from '../multi-deployment-parser';

// ─── isValidAlias ────────────────────────────────────────────────────────

describe('isValidAlias', () => {
  it('accepts simple kebab-case', () => {
    expect(isValidAlias('prod')).toBe(true);
    expect(isValidAlias('prod-chat')).toBe(true);
    expect(isValidAlias('a-b-c-d')).toBe(true);
  });

  it('rejects too-short or too-long', () => {
    expect(isValidAlias('a')).toBe(false);
    expect(isValidAlias('x'.repeat(33))).toBe(false);
  });

  it('rejects uppercase, underscore, leading digit', () => {
    expect(isValidAlias('Prod')).toBe(false);
    expect(isValidAlias('prod_gpt')).toBe(false);
    expect(isValidAlias('1prod')).toBe(false);
  });

  it('rejects trailing dash / double dash', () => {
    expect(isValidAlias('prod-')).toBe(false);
    expect(isValidAlias('prod--chat')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidAlias(undefined)).toBe(false);
    expect(isValidAlias(42)).toBe(false);
    expect(isValidAlias({})).toBe(false);
  });
});

// ─── expandEnvInString ───────────────────────────────────────────────────

describe('expandEnvInString', () => {
  it('substitutes ${VAR} with process.env value', () => {
    expect(expandEnvInString('${FOO}', { FOO: 'bar' })).toBe('bar');
    expect(expandEnvInString('prefix-${KEY}', { KEY: 'abc' })).toBe('prefix-abc');
  });

  it('yields empty string and warns on missing var', () => {
    // Missing → "" replacement. The warning is a log side effect; we
    // don't assert on logs (they're implementation detail here) but the
    // return value is deterministic.
    expect(expandEnvInString('${MISSING_VAR}', {})).toBe('');
  });

  it('leaves non-interpolation text untouched', () => {
    expect(expandEnvInString('plain text', {})).toBe('plain text');
    expect(expandEnvInString('$FOO (no braces)', {})).toBe('$FOO (no braces)');
  });

  it('handles multiple substitutions in one string', () => {
    expect(
      expandEnvInString('${A}-${B}-${A}', { A: 'x', B: 'y' }),
    ).toBe('x-y-x');
  });
});

// ─── parseMultiDeploymentEnv — generic top-level ─────────────────────────

describe('parseMultiDeploymentEnv', () => {
  const passThroughValidator = (entry: unknown): AzureDeploymentSpec | null => {
    if (!entry || typeof entry !== 'object') return null;
    const obj = entry as Record<string, unknown>;
    if (!isValidAlias(obj.alias)) return null;
    if (typeof obj.deployment !== 'string') return null;
    return {
      alias: obj.alias as string,
      deployment: obj.deployment,
    };
  };

  it('returns [] for undefined', () => {
    expect(parseMultiDeploymentEnv(undefined, 'X', passThroughValidator)).toEqual([]);
  });

  it('returns [] for empty / whitespace', () => {
    expect(parseMultiDeploymentEnv('', 'X', passThroughValidator)).toEqual([]);
    expect(parseMultiDeploymentEnv('   ', 'X', passThroughValidator)).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    expect(parseMultiDeploymentEnv('{not json', 'X', passThroughValidator)).toEqual([]);
  });

  it('returns [] when root is an object (not array)', () => {
    expect(
      parseMultiDeploymentEnv('{"alias":"a","deployment":"d"}', 'X', passThroughValidator),
    ).toEqual([]);
  });

  it('returns [] when root is a primitive', () => {
    expect(parseMultiDeploymentEnv('42', 'X', passThroughValidator)).toEqual([]);
    expect(parseMultiDeploymentEnv('"string"', 'X', passThroughValidator)).toEqual([]);
  });

  it('drops invalid entries but keeps valid ones', () => {
    const raw = JSON.stringify([
      { alias: 'ok', deployment: 'd1' },
      { alias: 'BAD UPPER', deployment: 'd2' }, // invalid alias
      { alias: 'ok2', deployment: 'd3' },
      null, // non-object
      { alias: 'ok3' }, // missing deployment
    ]);
    const result = parseMultiDeploymentEnv(raw, 'X', passThroughValidator);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.alias)).toEqual(['ok', 'ok2']);
  });

  it('deduplicates by alias — first occurrence wins', () => {
    const raw = JSON.stringify([
      { alias: 'dup', deployment: 'first' },
      { alias: 'dup', deployment: 'second' },
      { alias: 'unique', deployment: 'third' },
    ]);
    const result = parseMultiDeploymentEnv(raw, 'X', passThroughValidator);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.deployment)).toEqual(['first', 'third']);
  });
});

// ─── parseAzureDeployments ───────────────────────────────────────────────

describe('parseAzureDeployments', () => {
  it('parses a single-entry happy path', () => {
    // Deliberately generic names — no hardcoded model IDs. The parser is
    // model-agnostic; fixture strings exist only to exercise field shape.
    const raw = JSON.stringify([
      {
        alias: 'prod-chat',
        deployment: 'chat-deployment',
        resourceName: 'my-aoai',
        apiVersion: '2024-10-21',
      },
    ]);
    const result = parseAzureDeployments(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      alias: 'prod-chat',
      deployment: 'chat-deployment',
      resourceName: 'my-aoai',
      endpoint: undefined,
      apiVersion: '2024-10-21',
      apiKey: undefined,
    });
  });

  it('parses multi-entry with mixed endpoint/resourceName', () => {
    const raw = JSON.stringify([
      { alias: 'by-resource', deployment: 'd1', resourceName: 'my-aoai' },
      { alias: 'by-endpoint', deployment: 'd2', endpoint: 'https://sovereign.azure.us' },
    ]);
    const result = parseAzureDeployments(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.resourceName).toBe('my-aoai');
    expect(result[0]?.endpoint).toBeUndefined();
    expect(result[1]?.endpoint).toBe('https://sovereign.azure.us');
    expect(result[1]?.resourceName).toBeUndefined();
  });

  it('expands ${VAR} in apiKey field', () => {
    const raw = JSON.stringify([
      { alias: 'secret-key', deployment: 'd1', apiKey: '${MY_AZURE_KEY}' },
    ]);
    const result = parseAzureDeployments(raw, { MY_AZURE_KEY: 'abc123' });
    expect(result[0]?.apiKey).toBe('abc123');
  });

  it('trims whitespace from string fields', () => {
    const raw = JSON.stringify([
      {
        alias: 'trim-test',
        deployment: '  trimmed  ',
        resourceName: '  resource  ',
      },
    ]);
    const result = parseAzureDeployments(raw);
    expect(result[0]?.deployment).toBe('trimmed');
    expect(result[0]?.resourceName).toBe('resource');
  });

  it('drops entry when alias is invalid', () => {
    const raw = JSON.stringify([
      { alias: 'UPPER', deployment: 'd1' },
      { alias: 'ok', deployment: 'd2' },
    ]);
    const result = parseAzureDeployments(raw);
    expect(result.map((r) => r.alias)).toEqual(['ok']);
  });

  it('drops entry when deployment field is missing', () => {
    const raw = JSON.stringify([
      { alias: 'no-deploy' },
      { alias: 'ok', deployment: 'd1' },
    ]);
    const result = parseAzureDeployments(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.alias).toBe('ok');
  });
});

// ─── parseDatabricksEndpoints ────────────────────────────────────────────

describe('parseDatabricksEndpoints', () => {
  it('parses a single-entry happy path', () => {
    // Generic endpoint slug — real endpoint names come from the operator's
    // Databricks workspace, never from this codebase.
    const raw = JSON.stringify([
      {
        alias: 'chat-primary',
        endpoint: 'chat-endpoint',
        workspaceHost: 'myorg.cloud.databricks.com',
      },
    ]);
    const result = parseDatabricksEndpoints(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      alias: 'chat-primary',
      endpoint: 'chat-endpoint',
      workspaceHost: 'myorg.cloud.databricks.com',
      apiKey: undefined,
    });
  });

  it('parses multi-entry, workspaceHost can be omitted for shared default', () => {
    const raw = JSON.stringify([
      { alias: 'ep-a', endpoint: 'ep-a', workspaceHost: 'org1.databricks.com' },
      { alias: 'ep-b', endpoint: 'ep-b' }, // no workspaceHost — shared default
    ]);
    const result = parseDatabricksEndpoints(raw);
    expect(result).toHaveLength(2);
    expect(result[1]?.workspaceHost).toBeUndefined();
  });

  it('interpolates ${VAR} in apiKey', () => {
    const raw = JSON.stringify([
      { alias: 'ep', endpoint: 'ep', apiKey: '${DB_TOKEN}' },
    ]);
    const result = parseDatabricksEndpoints(raw, { DB_TOKEN: 'dapi-abc' });
    expect(result[0]?.apiKey).toBe('dapi-abc');
  });

  it('drops entry with missing endpoint', () => {
    const raw = JSON.stringify([
      { alias: 'ok', endpoint: 'e1' },
      { alias: 'bad' },
    ]);
    const result = parseDatabricksEndpoints(raw);
    expect(result.map((r) => r.alias)).toEqual(['ok']);
  });
});

// ─── parseSageMakerEndpoints ─────────────────────────────────────────────

describe('parseSageMakerEndpoints', () => {
  it('parses happy-path with payloadSchema omitted', () => {
    // `endpointName` is an operator-chosen SageMaker infra handle — NOT a
    // model ID. The catalog/discovery service is the sole source of truth
    // for which model each endpoint serves.
    const raw = JSON.stringify([
      { alias: 'chat-a', endpointName: 'chat-endpoint-a' },
    ]);
    const result = parseSageMakerEndpoints(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      alias: 'chat-a',
      endpointName: 'chat-endpoint-a',
      payloadSchema: undefined,
      region: undefined,
      customAttributes: undefined,
    });
  });

  it('accepts all three schema values', () => {
    const raw = JSON.stringify([
      { alias: 'aa', endpointName: 'e1', payloadSchema: 'openai' },
      { alias: 'bb', endpointName: 'e2', payloadSchema: 'jumpstart' },
      { alias: 'cc', endpointName: 'e3', payloadSchema: 'hf-tgi' },
    ]);
    const result = parseSageMakerEndpoints(raw);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.payloadSchema)).toEqual(['openai', 'jumpstart', 'hf-tgi']);
  });

  it('drops entries with unknown payloadSchema', () => {
    const raw = JSON.stringify([
      { alias: 'bad', endpointName: 'e1', payloadSchema: 'vllm-mine' },
      { alias: 'good', endpointName: 'e2', payloadSchema: 'openai' },
    ]);
    const result = parseSageMakerEndpoints(raw);
    expect(result.map((r) => r.alias)).toEqual(['good']);
  });

  it('captures region + customAttributes when present', () => {
    const raw = JSON.stringify([
      {
        alias: 'reg',
        endpointName: 'e1',
        region: 'us-west-2',
        customAttributes: 'stream=true',
      },
    ]);
    const result = parseSageMakerEndpoints(raw);
    expect(result[0]?.region).toBe('us-west-2');
    expect(result[0]?.customAttributes).toBe('stream=true');
  });

  it('drops entry with missing endpointName', () => {
    const raw = JSON.stringify([
      { alias: 'ok', endpointName: 'e1' },
      { alias: 'bad' },
    ]);
    const result = parseSageMakerEndpoints(raw);
    expect(result.map((r) => r.alias)).toEqual(['ok']);
  });
});

// ─── synthesizeDeploymentProviderId ──────────────────────────────────────

describe('synthesizeDeploymentProviderId', () => {
  it('concatenates parent-alias with a dash', () => {
    expect(synthesizeDeploymentProviderId('azure-openai', 'prod-chat')).toBe(
      'azure-openai-prod-chat',
    );
    expect(synthesizeDeploymentProviderId('databricks', 'chat-b')).toBe(
      'databricks-chat-b',
    );
    expect(synthesizeDeploymentProviderId('aws-sagemaker', 'primary')).toBe(
      'aws-sagemaker-primary',
    );
  });

  it('truncates to 40 chars when combined length is excessive', () => {
    const longAlias = 'a-very-long-alias-that-should-truncate';
    const synthesized = synthesizeDeploymentProviderId('aws-sagemaker', longAlias);
    expect(synthesized.length).toBeLessThanOrEqual(40);
  });

  it('passes short aliases through unchanged', () => {
    expect(synthesizeDeploymentProviderId('x', 'yy')).toBe('x-yy');
    expect(synthesizeDeploymentProviderId('x', 'yy').length).toBe(4);
  });
});
