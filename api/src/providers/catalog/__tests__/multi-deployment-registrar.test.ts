// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * multi-deployment-registrar — builder + registrar contract tests.
 *
 * Covers the non-parser side of the Batch 8.2 multi-deployment pipeline:
 *
 *   - `buildAzureAdaptersFromSpecs` yields N `AzureOpenAIAdapter` with
 *     distinct `getName()` values.
 *   - `buildDatabricksAdaptersFromSpecs` yields N `DatabricksAdapter`.
 *   - `buildSageMakerAdaptersFromSpecs` yields N `AWSSageMakerAdapter`
 *     each with distinct provider/display names.
 *   - `registerMultiDeploymentProviders(registry)` reads env vars,
 *     routes through parsers + builders, and populates the registry.
 *   - The no-op path — no env vars set — returns `totalRegistered = 0`
 *     and leaves the registry untouched.
 *
 * ### AWS SDK mocking
 *
 * `AWSSageMakerAdapter` instantiates `SageMakerRuntimeClient` +
 * `SageMakerClient` at construction time. We mock both so tests don't
 * require actual AWS credentials or network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── AWS SDK mocks (module-scoped — hoisted by vitest) ───────────────────
vi.mock('@aws-sdk/client-sagemaker-runtime', () => {
  const SageMakerRuntimeClient = vi.fn(() => ({ send: vi.fn() }));
  class InvokeEndpointCommand {
    constructor(public readonly input: unknown) {}
  }
  return { SageMakerRuntimeClient, InvokeEndpointCommand };
});

vi.mock('@aws-sdk/client-sagemaker', () => {
  const SageMakerClient = vi.fn(() => ({ send: vi.fn() }));
  class ListEndpointsCommand {
    constructor(public readonly input: unknown) {}
  }
  return { SageMakerClient, ListEndpointsCommand };
});

// The model catalog service is used by SageMaker's getModels(); stub it
// so tests don't pull in a DB dependency.
vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(async () => []),
}));

import {
  buildAzureAdaptersFromSpecs,
  buildDatabricksAdaptersFromSpecs,
  buildSageMakerAdaptersFromSpecs,
  registerMultiDeploymentProviders,
} from '../multi-deployment-registrar';
import { ProviderRegistry } from '../../provider-registry';
import type {
  AzureDeploymentSpec,
  DatabricksEndpointSpec,
  SageMakerEndpointSpec,
} from '../multi-deployment-parser';

// ─── Env isolation ───────────────────────────────────────────────────────

const ENV_KEYS_TO_ISOLATE = [
  'AZURE_OPENAI_DEPLOYMENTS',
  'DATABRICKS_SERVING_ENDPOINTS',
  'AWS_SAGEMAKER_ENDPOINTS',
  'AZURE_OPENAI_API_KEY',
  'DATABRICKS_API_KEY',
  'DATABRICKS_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SAGEMAKER_REGION',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_RESOURCE',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'DATABRICKS_HOST',
  'DATABRICKS_SERVING_ENDPOINT',
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS_TO_ISOLATE) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearAllEnv(): void {
  for (const key of ENV_KEYS_TO_ISOLATE) {
    delete process.env[key];
  }
}

// ─── buildAzureAdaptersFromSpecs ─────────────────────────────────────────

describe('buildAzureAdaptersFromSpecs', () => {
  const shared = { apiKey: 'az-shared-key' };
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAllEnv();
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('yields one adapter per spec with unique provider names', () => {
    // Fixture strings are deliberately generic — no hardcoded model IDs.
    // Aliases and deployment names are operator-chosen handles; the
    // catalog/discovery service is the sole source of truth for models.
    const specs: AzureDeploymentSpec[] = [
      { alias: 'prod-chat', deployment: 'chat-deployment', resourceName: 'my-aoai' },
      { alias: 'prod-fallback', deployment: 'fallback-deployment', resourceName: 'my-aoai' },
      { alias: 'dev-embed', deployment: 'embed-deployment', resourceName: 'dev-aoai' },
    ];
    const adapters = buildAzureAdaptersFromSpecs(specs, shared);
    expect(adapters).toHaveLength(3);
    const names = adapters.map((a) => a.getName());
    expect(names).toEqual([
      'azure-openai-prod-chat',
      'azure-openai-prod-fallback',
      'azure-openai-dev-embed',
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it('honors spec.deployment on each instance', () => {
    const specs: AzureDeploymentSpec[] = [
      { alias: 'one', deployment: 'deploy-one', resourceName: 'r' },
      { alias: 'two', deployment: 'deploy-two', resourceName: 'r' },
    ];
    const adapters = buildAzureAdaptersFromSpecs(specs, shared);
    expect(adapters[0]?.getDeployment()).toBe('deploy-one');
    expect(adapters[1]?.getDeployment()).toBe('deploy-two');
  });

  it('handles empty spec array', () => {
    expect(buildAzureAdaptersFromSpecs([], shared)).toEqual([]);
  });

  it('accepts spec-level apiKey override without throwing', () => {
    const specs: AzureDeploymentSpec[] = [
      { alias: 'with-key', deployment: 'd1', resourceName: 'r', apiKey: 'spec-specific' },
      { alias: 'no-key', deployment: 'd2', resourceName: 'r' },
    ];
    expect(() => buildAzureAdaptersFromSpecs(specs, shared)).not.toThrow();
  });
});

// ─── buildDatabricksAdaptersFromSpecs ────────────────────────────────────

describe('buildDatabricksAdaptersFromSpecs', () => {
  const shared = { apiKey: 'db-shared-key' };
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAllEnv();
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('yields one adapter per spec with unique provider names', () => {
    // Generic endpoint slugs — real Databricks endpoints come from the
    // operator's workspace, never from this codebase.
    const specs: DatabricksEndpointSpec[] = [
      { alias: 'primary', endpoint: 'chat-endpoint-primary', workspaceHost: 'org.databricks.com' },
      { alias: 'secondary', endpoint: 'chat-endpoint-secondary', workspaceHost: 'org.databricks.com' },
    ];
    const adapters = buildDatabricksAdaptersFromSpecs(specs, shared);
    expect(adapters).toHaveLength(2);
    expect(adapters.map((a) => a.getName())).toEqual([
      'databricks-primary',
      'databricks-secondary',
    ]);
  });

  it('honors endpoint binding per instance', () => {
    const specs: DatabricksEndpointSpec[] = [
      { alias: 'one', endpoint: 'ep-one', workspaceHost: 'h.databricks.com' },
      { alias: 'two', endpoint: 'ep-two', workspaceHost: 'h.databricks.com' },
    ];
    const adapters = buildDatabricksAdaptersFromSpecs(specs, shared);
    expect(adapters[0]?.getEndpoint()).toBe('ep-one');
    expect(adapters[1]?.getEndpoint()).toBe('ep-two');
  });

  it('handles empty specs', () => {
    expect(buildDatabricksAdaptersFromSpecs([], shared)).toEqual([]);
  });
});

// ─── buildSageMakerAdaptersFromSpecs ─────────────────────────────────────

describe('buildSageMakerAdaptersFromSpecs', () => {
  const shared = { apiKey: 'AKIA-TEST' };
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAllEnv();
    // SageMaker adapter requires AWS creds in env OR config.
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-TEST';
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('yields one adapter per spec with unique names + display names', () => {
    // Generic endpoint names — SageMaker endpoints are infra handles, not
    // model IDs. The model catalog service resolves which model lives behind
    // each endpoint at runtime.
    const specs: SageMakerEndpointSpec[] = [
      { alias: 'chat-oai', endpointName: 'oai-compat-endpoint', payloadSchema: 'openai' },
      { alias: 'legacy-gen', endpointName: 'legacy-endpoint', payloadSchema: 'jumpstart' },
    ];
    const adapters = buildSageMakerAdaptersFromSpecs(specs, shared);
    expect(adapters).toHaveLength(2);
    expect(adapters.map((a) => a.getName())).toEqual([
      'aws-sagemaker-chat-oai',
      'aws-sagemaker-legacy-gen',
    ]);
    expect(adapters[0]?.getDisplayName()).toBe('AWS SageMaker — chat-oai');
    expect(adapters[1]?.getDisplayName()).toBe('AWS SageMaker — legacy-gen');
  });

  it('threads payloadSchema into each adapter', () => {
    const specs: SageMakerEndpointSpec[] = [
      { alias: 'default', endpointName: 'e1' }, // adapter default 'openai'
      { alias: 'tgi', endpointName: 'e2', payloadSchema: 'hf-tgi' },
    ];
    const adapters = buildSageMakerAdaptersFromSpecs(specs, shared);
    expect(adapters[0]?.getPayloadSchema()).toBe('openai');
    expect(adapters[1]?.getPayloadSchema()).toBe('hf-tgi');
  });

  it('propagates region override per spec', () => {
    const specs: SageMakerEndpointSpec[] = [
      { alias: 'west', endpointName: 'e1', region: 'us-west-2' },
    ];
    const adapters = buildSageMakerAdaptersFromSpecs(specs, shared);
    expect(adapters[0]?.getRegion()).toBe('us-west-2');
  });

  it('empty specs → empty adapters', () => {
    expect(buildSageMakerAdaptersFromSpecs([], shared)).toEqual([]);
  });
});

// ─── registerMultiDeploymentProviders (integration) ──────────────────────

describe('registerMultiDeploymentProviders', () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAllEnv();
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('no-op path: returns all empty when env vars unset', async () => {
    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);
    expect(result.totalRegistered).toBe(0);
    expect(result.azure).toEqual([]);
    expect(result.databricks).toEqual([]);
    expect(result.sagemaker).toEqual([]);
    expect(registry.getProviderNames()).toEqual([]);
  });

  it('registers Azure deployments when AZURE_OPENAI_DEPLOYMENTS is set', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'az-key';
    process.env.AZURE_OPENAI_DEPLOYMENTS = JSON.stringify([
      // Generic deployment handles — operators pick real names in Azure Portal.
      { alias: 'prod', deployment: 'prod-chat-deployment', resourceName: 'my-aoai' },
      { alias: 'dev', deployment: 'dev-chat-deployment', resourceName: 'my-aoai' },
    ]);

    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);

    expect(result.totalRegistered).toBe(2);
    expect(result.azure).toEqual(['azure-openai-prod', 'azure-openai-dev']);
    expect(registry.has('azure-openai-prod')).toBe(true);
    expect(registry.has('azure-openai-dev')).toBe(true);
  });

  it('registers Databricks endpoints when DATABRICKS_SERVING_ENDPOINTS is set', async () => {
    process.env.DATABRICKS_TOKEN = 'dapi-abc';
    process.env.DATABRICKS_SERVING_ENDPOINTS = JSON.stringify([
      { alias: 'primary', endpoint: 'chat-endpoint-primary', workspaceHost: 'org.databricks.com' },
    ]);

    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);

    expect(result.totalRegistered).toBe(1);
    expect(result.databricks).toEqual(['databricks-primary']);
    expect(registry.has('databricks-primary')).toBe(true);
  });

  it('registers SageMaker endpoints when AWS_SAGEMAKER_ENDPOINTS is set', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SAGEMAKER_ENDPOINTS = JSON.stringify([
      { alias: 'primary', endpointName: 'chat-endpoint', payloadSchema: 'openai' },
    ]);

    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);

    expect(result.totalRegistered).toBe(1);
    expect(result.sagemaker).toEqual(['aws-sagemaker-primary']);
    expect(registry.has('aws-sagemaker-primary')).toBe(true);
  });

  it('registers across multiple providers simultaneously', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'az';
    process.env.DATABRICKS_TOKEN = 'db';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA';
    process.env.AWS_SECRET_ACCESS_KEY = 'sec';

    process.env.AZURE_OPENAI_DEPLOYMENTS = JSON.stringify([
      { alias: 'a1', deployment: 'd1', resourceName: 'r' },
      { alias: 'a2', deployment: 'd2', resourceName: 'r' },
    ]);
    process.env.DATABRICKS_SERVING_ENDPOINTS = JSON.stringify([
      { alias: 'b1', endpoint: 'e1', workspaceHost: 'h.databricks.com' },
    ]);
    process.env.AWS_SAGEMAKER_ENDPOINTS = JSON.stringify([
      { alias: 'c1', endpointName: 'e1' },
      { alias: 'c2', endpointName: 'e2' },
      { alias: 'c3', endpointName: 'e3' },
    ]);

    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);

    expect(result.azure).toHaveLength(2);
    expect(result.databricks).toHaveLength(1);
    expect(result.sagemaker).toHaveLength(3);
    expect(result.totalRegistered).toBe(6);
  });

  it('malformed JSON produces 0 registrations — no crash', async () => {
    process.env.AZURE_OPENAI_DEPLOYMENTS = '{not: valid json';
    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);
    expect(result.totalRegistered).toBe(0);
  });

  it('duplicate aliases within one env var — first wins', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'az';
    process.env.AZURE_OPENAI_DEPLOYMENTS = JSON.stringify([
      { alias: 'same', deployment: 'first-wins', resourceName: 'r' },
      { alias: 'same', deployment: 'second-discarded', resourceName: 'r' },
      { alias: 'different', deployment: 'also-kept', resourceName: 'r' },
    ]);
    const registry = new ProviderRegistry();
    const result = await registerMultiDeploymentProviders(registry);
    expect(result.azure).toEqual(['azure-openai-same', 'azure-openai-different']);
  });

  it('is idempotent across repeated calls with the same env', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'az';
    process.env.AZURE_OPENAI_DEPLOYMENTS = JSON.stringify([
      { alias: 'only', deployment: 'd1', resourceName: 'r' },
    ]);
    const registry = new ProviderRegistry();

    const first = await registerMultiDeploymentProviders(registry);
    const second = await registerMultiDeploymentProviders(registry);

    // Re-registering overwrites (documented in ProviderRegistry.register).
    // Summary must be stable on both calls.
    expect(first.totalRegistered).toBe(1);
    expect(second.totalRegistered).toBe(1);
    expect(registry.getProviderNames()).toContain('azure-openai-only');
  });
});
