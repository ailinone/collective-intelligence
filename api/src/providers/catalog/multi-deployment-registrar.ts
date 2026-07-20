// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Deployment Registrar — Batch 8.2
 *
 * Consumes the typed spec arrays produced by
 * {@link ../catalog/multi-deployment-parser | multi-deployment-parser}
 * and registers one concrete {@link ProviderAdapter} per deployment
 * against the live {@link ProviderRegistry}.
 *
 * ### Architectural placement
 *
 * The registrar is called as a **post-step** of
 * `initializeProviderRegistry()` in
 * `ci/api/src/providers/provider-registry.ts`. It runs AFTER the static
 * switch-case loop has built the single-instance `azure-openai` /
 * `databricks` / `aws-sagemaker` adapters (when their standalone env
 * vars are present).
 *
 * A registered adapter instance's `getName()` becomes the unique
 * registry key. The registrar synthesizes names as
 * `<parent>-<alias>` (e.g. `azure-openai-<alias>`). Collisions with
 * the single-instance name are handled by **replacement** (the hub's
 * existing `register()` warns + replaces). Operators who want BOTH
 * should NOT use the same alias as the parent (e.g. don't set
 * `alias: 'azure-openai'` — that would collide; pick a distinct
 * kebab-case alias).
 *
 * Note: specific model identifiers are NEVER hardcoded here. The
 * adapter's `getModels()` always reads through the model-catalog
 * service — deployments are infrastructure handles, not model lists.
 *
 * ### Why not the catalog bridge?
 *
 * The catalog bridge (`loadProviderCatalog()`) is currently test-only
 * in this repo — production wires providers through
 * `config/index.ts::providers[]` and the big switch in
 * `initializeProviderRegistry()`. Shoe-horning multi-deployment into
 * the catalog would require either (a) synthesizing catalog entries
 * that pass the strict Zod schema (possible but heavy), or (b) an
 * extra loader call into `loadProviderCatalog` that isn't wired into
 * production yet. The direct-registration path is minimal, safe, and
 * ready for migration later when the catalog bridge becomes the
 * primary wiring path.
 *
 * ### Contract
 *
 *   - `buildAzureAdaptersFromSpecs(specs, sharedConfig)` →
 *     `AzureOpenAIAdapter[]`
 *   - `buildDatabricksAdaptersFromSpecs(specs, sharedConfig)` →
 *     `DatabricksAdapter[]`
 *   - `buildSageMakerAdaptersFromSpecs(specs, sharedConfig)` →
 *     `AWSSageMakerAdapter[]`
 *   - `registerMultiDeploymentProviders(registry)` reads all three env
 *     vars, calls each parser+builder pair, and registers every
 *     successful adapter.
 *
 * Builders do NOT throw on per-spec failures — an adapter constructor
 * that throws yields a warning log and the offending spec is skipped.
 * Other specs in the same batch still register.
 */

import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '../provider-registry';
import type { ProviderAdapter } from '../base/provider-adapter';
import {
  AzureOpenAIAdapter,
  type AzureOpenAIAdapterConfig,
} from '../azure/azure-openai-adapter';
import {
  DatabricksAdapter,
  type DatabricksAdapterConfig,
} from '../databricks/databricks-adapter';
import {
  AWSSageMakerAdapter,
  type AWSSageMakerAdapterConfig,
} from '../aws-sagemaker/aws-sagemaker-adapter';
import {
  parseAzureDeployments,
  parseDatabricksEndpoints,
  parseSageMakerEndpoints,
  synthesizeDeploymentProviderId,
  type AzureDeploymentSpec,
  type DatabricksEndpointSpec,
  type SageMakerEndpointSpec,
} from './multi-deployment-parser';

const log = logger.child({ component: 'multi-deployment-registrar' });

/**
 * Minimal shared config envelope used by every builder. Matches the
 * fields every `ProviderConfig`-like shape requires (`name`, `enabled`,
 * `apiKey`) plus per-provider customizations.
 *
 * The `enabled` flag is ALWAYS `true` here — the registrar never runs
 * unless the operator set the corresponding JSON env var (intent is
 * already expressed).
 */
interface SharedProviderConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

// ─── Azure OpenAI ────────────────────────────────────────────────────────

export function buildAzureAdaptersFromSpecs(
  specs: readonly AzureDeploymentSpec[],
  shared: SharedProviderConfig,
): AzureOpenAIAdapter[] {
  const adapters: AzureOpenAIAdapter[] = [];
  for (const spec of specs) {
    const providerName = synthesizeDeploymentProviderId('azure-openai', spec.alias);
    try {
      // Spec-level apiKey overrides the shared key (e.g. a different
      // subscription per deployment). Falls back to shared when absent.
      const apiKey = spec.apiKey && spec.apiKey.length > 0 ? spec.apiKey : shared.apiKey;
      const config: AzureOpenAIAdapterConfig = {
        name: providerName,
        enabled: true,
        apiKey,
        baseUrl: shared.baseUrl, // Usually undefined — adapter composes the URL itself.
        providerName,
        providerNameOverride: providerName,
        resourceName: spec.resourceName,
        deployment: spec.deployment,
        apiVersion: spec.apiVersion,
        endpoint: spec.endpoint,
      };
      adapters.push(new AzureOpenAIAdapter(config));
      log.info(
        { providerName, deployment: spec.deployment, hasResourceName: Boolean(spec.resourceName) },
        'Built multi-deployment AzureOpenAIAdapter',
      );
    } catch (err) {
      log.warn(
        {
          providerName,
          alias: spec.alias,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to build Azure adapter from spec — skipping',
      );
    }
  }
  return adapters;
}

// ─── Databricks ──────────────────────────────────────────────────────────

export function buildDatabricksAdaptersFromSpecs(
  specs: readonly DatabricksEndpointSpec[],
  shared: SharedProviderConfig,
): DatabricksAdapter[] {
  const adapters: DatabricksAdapter[] = [];
  for (const spec of specs) {
    const providerName = synthesizeDeploymentProviderId('databricks', spec.alias);
    try {
      const apiKey = spec.apiKey && spec.apiKey.length > 0 ? spec.apiKey : shared.apiKey;
      const config: DatabricksAdapterConfig = {
        name: providerName,
        enabled: true,
        apiKey,
        baseUrl: shared.baseUrl,
        providerName,
        providerNameOverride: providerName,
        workspaceHost: spec.workspaceHost,
        endpoint: spec.endpoint,
      };
      adapters.push(new DatabricksAdapter(config));
      log.info(
        {
          providerName,
          endpoint: spec.endpoint,
          hasWorkspaceHost: Boolean(spec.workspaceHost),
        },
        'Built multi-deployment DatabricksAdapter',
      );
    } catch (err) {
      log.warn(
        {
          providerName,
          alias: spec.alias,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to build Databricks adapter from spec — skipping',
      );
    }
  }
  return adapters;
}

// ─── AWS SageMaker ───────────────────────────────────────────────────────

export function buildSageMakerAdaptersFromSpecs(
  specs: readonly SageMakerEndpointSpec[],
  shared: SharedProviderConfig,
): AWSSageMakerAdapter[] {
  const adapters: AWSSageMakerAdapter[] = [];
  for (const spec of specs) {
    const providerName = synthesizeDeploymentProviderId('aws-sagemaker', spec.alias);
    try {
      // SageMaker credentials come from the AWS SDK chain (env vars); the
      // `apiKey` field is just a synonym the adapter accepts. We still
      // thread it to preserve the single-instance config parity.
      const config: AWSSageMakerAdapterConfig = {
        name: providerName,
        enabled: true,
        apiKey: shared.apiKey,
        providerNameOverride: providerName,
        displayNameOverride: `AWS SageMaker — ${spec.alias}`,
        endpointName: spec.endpointName,
        payloadSchema: spec.payloadSchema,
        region: spec.region,
        customAttributes: spec.customAttributes,
      };
      adapters.push(new AWSSageMakerAdapter(config));
      log.info(
        {
          providerName,
          endpointName: spec.endpointName,
          payloadSchema: spec.payloadSchema ?? 'openai',
        },
        'Built multi-deployment AWSSageMakerAdapter',
      );
    } catch (err) {
      log.warn(
        {
          providerName,
          alias: spec.alias,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to build SageMaker adapter from spec — skipping',
      );
    }
  }
  return adapters;
}

// ─── Top-level registrar ─────────────────────────────────────────────────

export interface RegisterMultiDeploymentResult {
  readonly azure: readonly string[];
  readonly databricks: readonly string[];
  readonly sagemaker: readonly string[];
  readonly totalRegistered: number;
}

/**
 * Shared-config sniffers — read the per-provider API key + (optional)
 * baseUrl from `process.env`. Kept as functions so tests can pass
 * sniffer-free shared configs directly to the builders.
 */
function sniffAzureSharedConfig(): SharedProviderConfig {
  return {
    apiKey: process.env.AZURE_OPENAI_API_KEY || '',
    baseUrl: process.env.AZURE_OPENAI_BASE_URL || undefined,
  };
}

function sniffDatabricksSharedConfig(): SharedProviderConfig {
  return {
    apiKey: process.env.DATABRICKS_API_KEY || process.env.DATABRICKS_TOKEN || '',
    baseUrl: process.env.DATABRICKS_BASE_URL || undefined,
  };
}

function sniffSageMakerSharedConfig(): SharedProviderConfig {
  return {
    apiKey: process.env.AWS_ACCESS_KEY_ID || '',
    baseUrl: undefined, // SageMaker doesn't use a simple baseUrl.
  };
}

/**
 * Top-level entry — call once from `initializeProviderRegistry()` after
 * the static switch-case loop has run. No-ops when none of the three
 * JSON env vars are set.
 *
 * Returns a summary so the caller (and tests) can assert on which
 * provider names were added.
 */
export async function registerMultiDeploymentProviders(
  registry: ProviderRegistry,
): Promise<RegisterMultiDeploymentResult> {
  const azureSpecs = parseAzureDeployments(process.env.AZURE_OPENAI_DEPLOYMENTS);
  const databricksSpecs = parseDatabricksEndpoints(process.env.DATABRICKS_SERVING_ENDPOINTS);
  const sagemakerSpecs = parseSageMakerEndpoints(process.env.AWS_SAGEMAKER_ENDPOINTS);

  if (
    azureSpecs.length === 0 &&
    databricksSpecs.length === 0 &&
    sagemakerSpecs.length === 0
  ) {
    log.debug('No multi-deployment env vars set — skipping multi-deployment registration');
    return {
      azure: [],
      databricks: [],
      sagemaker: [],
      totalRegistered: 0,
    };
  }

  const azureAdapters = buildAzureAdaptersFromSpecs(azureSpecs, sniffAzureSharedConfig());
  const databricksAdapters = buildDatabricksAdaptersFromSpecs(
    databricksSpecs,
    sniffDatabricksSharedConfig(),
  );
  const sagemakerAdapters = buildSageMakerAdaptersFromSpecs(
    sagemakerSpecs,
    sniffSageMakerSharedConfig(),
  );

  const azureNames = registerAdapters(registry, azureAdapters);
  const databricksNames = registerAdapters(registry, databricksAdapters);
  const sagemakerNames = registerAdapters(registry, sagemakerAdapters);

  const totalRegistered =
    azureNames.length + databricksNames.length + sagemakerNames.length;

  log.info(
    {
      azure: azureNames,
      databricks: databricksNames,
      sagemaker: sagemakerNames,
      totalRegistered,
    },
    'Multi-deployment registration complete',
  );

  return {
    azure: azureNames,
    databricks: databricksNames,
    sagemaker: sagemakerNames,
    totalRegistered,
  };
}

/**
 * Register a batch of adapters. Never throws — errors are logged per
 * adapter so one bad instance can't block the rest.
 */
function registerAdapters(
  registry: ProviderRegistry,
  adapters: readonly ProviderAdapter[],
): string[] {
  const names: string[] = [];
  for (const adapter of adapters) {
    try {
      registry.register(adapter);
      names.push(adapter.getName());
    } catch (err) {
      log.warn(
        {
          name: adapter.getName(),
          err: err instanceof Error ? err.message : String(err),
        },
        'Multi-deployment adapter registration threw — skipping',
      );
    }
  }
  return names;
}
