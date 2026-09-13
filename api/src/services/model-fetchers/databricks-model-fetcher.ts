// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Databricks Model Serving Fetcher (GAP-AK-6 · structuralByDesign)
 *
 * Databricks is account-scoped, not catalog-scoped: there is no global model
 * list, only the serving endpoints a given workspace has provisioned. The
 * adapter's own comment records why generic discovery was switched off —
 * "Databricks doesn't expose /v1/models on serving endpoints (the endpoint IS
 * the model)" — which is true of `/serving-endpoints/{name}` (the inference
 * baseUrl), but NOT of the workspace-level control-plane route one level up.
 *
 *   GET https://{host}/api/2.0/serving-endpoints
 *   Authorization: Bearer {DATABRICKS_TOKEN}
 *
 * enumerates exactly the endpoints this workspace can invoke, which is the
 * only honest inventory for this provider. That is what this fetcher calls,
 * replacing a hand-curated 9-model `pinnedFallback` that could only ever be
 * right for the workspace it was copied from.
 *
 * ## Capability evidence
 *
 * Each endpoint declares a `task` (`llm/v1/chat`, `llm/v1/completions`,
 * `llm/v1/embeddings`). That is a real provider declaration, not a guess from
 * the endpoint name, so it is what drives capabilities here. Nothing is
 * inferred from the endpoint's name.
 *
 * ## What is deliberately NOT invented
 *
 * The response carries no context window, no max output tokens and no
 * pricing — Databricks bills serving by DBU, not per token, and does not
 * expose per-endpoint token limits on this route. Those fields are therefore
 * emitted as 0 ("not reported"), never estimated. See the same reasoning in
 * aws-bedrock-model-fetcher.ts's `UNKNOWN_SPECS`: a fabricated number in
 * `models.input_cost_per_1k` is indistinguishable downstream from a real one.
 *
 * ## Live validation
 *
 * NOT live-validated: no Databricks workspace host + token is available in
 * this environment. The request shape, auth header and response mapping follow
 * the documented Serving Endpoints API, and the unit suite exercises a
 * structurally faithful fixture of it — but this has never been run against a
 * real workspace. See GAP-AK-6 in reports/provider-integration-gap-register.json.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

const REQUEST_TIMEOUT_MS = 10_000;

/** Databricks reports no token economics on this route — do not invent any. */
const UNKNOWN_SPECS = Object.freeze({
  contextWindow: 0,
  maxOutputTokens: 0,
  pricing: Object.freeze({ inputCostPer1M: 0, outputCostPer1M: 0, currency: 'USD' }),
});

/**
 * `task` → capabilities. The ONLY capability source used by this fetcher,
 * because it is the only one Databricks actually declares.
 */
const TASK_CAPABILITIES: Readonly<Record<string, readonly ModelCapability[]>> = Object.freeze({
  'llm/v1/chat': ['chat', 'text_generation', 'streaming'],
  'llm/v1/completions': ['completions', 'text_generation'],
  'llm/v1/embeddings': ['embedding', 'embeddings'],
});

interface ServedEntity {
  entity_name?: string;
  entity_version?: string;
  foundation_model?: { name?: string; display_name?: string };
}

interface ServingEndpoint {
  name?: string;
  task?: string;
  endpoint_type?: string;
  state?: { ready?: string };
  config?: { served_entities?: ServedEntity[] };
}

export class DatabricksModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'databricks';
  private log = logger.child({ component: 'databricks-fetcher' });
  private readonly host: string;
  private readonly token: string;

  constructor(config: { host: string; token: string }) {
    super();
    // Accept `host`, `https://host` or a trailing slash — operators paste all three.
    this.host = config.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.token = config.token;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.host || !this.token) {
      this.log.warn(
        'Databricks host/token not provided — returning empty model list (no pinned fallback by design)'
      );
      return [];
    }

    const url = `https://${this.host}/api/2.0/serving-endpoints`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        // Never fabricate an inventory to paper over an auth/permission
        // problem — an empty list is the truthful answer, and the operability
        // layer classifies the provider from the HTTP status separately.
        this.log.warn(
          { status: response.status, host: this.host },
          'Databricks serving-endpoints enumeration failed'
        );
        return [];
      }

      const payload = (await response.json()) as { endpoints?: unknown };
      const endpoints = Array.isArray(payload?.endpoints)
        ? (payload.endpoints as ServingEndpoint[])
        : [];

      const models: ProviderModel[] = [];
      let skippedNotReady = 0;
      let skippedUnknownTask = 0;

      for (const endpoint of endpoints) {
        if (!endpoint || typeof endpoint !== 'object' || !endpoint.name) continue;

        // A non-READY endpoint 4xxs on invoke, so advertising it would create
        // exactly the "advertise-then-react" failure this repo already moved
        // away from. `state` is absent on some endpoint types — absence is not
        // evidence of not-ready, so only an explicit non-READY is skipped.
        const ready = endpoint.state?.ready;
        if (ready !== undefined && ready !== 'READY') {
          skippedNotReady += 1;
          continue;
        }

        const declared = endpoint.task ? TASK_CAPABILITIES[endpoint.task] : undefined;
        if (!declared) {
          // Unknown/absent task: we have no declared evidence and refuse to
          // guess from the endpoint name. Counted so a new Databricks task
          // type shows up in logs rather than silently dropping models.
          skippedUnknownTask += 1;
          continue;
        }

        const entity = endpoint.config?.served_entities?.[0];
        const displayName =
          entity?.foundation_model?.display_name ??
          entity?.foundation_model?.name ??
          endpoint.name;

        const capabilities = [...declared];
        const metadata = {
          endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
          source: 'databricks-serving-endpoints',
          workspaceHost: this.host,
          task: endpoint.task,
          endpointType: endpoint.endpoint_type,
          servedEntity: entity?.entity_name,
          servedEntityVersion: entity?.entity_version,
          // Marks this list as provider-declared for the HCRA assertion
          // emitter, which otherwise (correctly) treats a fetcher capability
          // list as unsubstantiated.
          capabilities,
        };

        models.push({
          // The endpoint NAME is the invocation identity
          // (POST /serving-endpoints/{name}/invocations).
          id: endpoint.name,
          name: endpoint.name,
          displayName,
          ...UNKNOWN_SPECS,
          capabilities,
          metadata,
        });
      }

      this.log.info(
        {
          count: models.length,
          host: this.host,
          skippedNotReady,
          skippedUnknownTask,
        },
        'Successfully enumerated Databricks serving endpoints'
      );
      return models;
    } catch (error) {
      this.log.warn(
        { host: this.host, error: error instanceof Error ? error.message : String(error) },
        'Databricks serving-endpoints enumeration threw'
      );
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
