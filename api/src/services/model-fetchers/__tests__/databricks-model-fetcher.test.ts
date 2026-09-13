// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-AK-6 (structuralByDesign) — Databricks workspace enumeration.
 *
 * The fixture below is a structurally faithful sample of the documented
 * Serving Endpoints API response (`GET /api/2.0/serving-endpoints`): the
 * `endpoints[]` envelope, `state.ready`, `task`, `endpoint_type`, and the
 * `config.served_entities[].foundation_model` block.
 *
 * NOT LIVE-VALIDATED. No Databricks workspace host + token exists in this
 * environment, so nothing here proves the real API answers this shape today —
 * only that the fetcher maps that shape correctly and refuses to invent
 * anything the response does not carry. This limitation is recorded in
 * GAP-AK-6 in reports/provider-integration-gap-register.json.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { DatabricksModelFetcher } from '@/services/model-fetchers/databricks-model-fetcher';

const WORKSPACE_RESPONSE = {
  endpoints: [
    {
      name: 'databricks-meta-llama-3-3-70b-instruct',
      creator: 'someone@example.com',
      state: { ready: 'READY', config_update: 'NOT_UPDATING' },
      task: 'llm/v1/chat',
      endpoint_type: 'FOUNDATION_MODEL_API',
      config: {
        served_entities: [
          {
            name: 'meta_llama_v3_3_70b_instruct-3',
            entity_name: 'system.ai.meta_llama_v3_3_70b_instruct',
            entity_version: '3',
            foundation_model: {
              name: 'meta-llama-3.3-70b-instruct',
              display_name: 'Meta Llama 3.3 70B Instruct',
            },
          },
        ],
      },
    },
    {
      name: 'databricks-bge-large-en',
      state: { ready: 'READY' },
      task: 'llm/v1/embeddings',
      endpoint_type: 'FOUNDATION_MODEL_API',
      config: {
        served_entities: [
          { entity_name: 'system.ai.bge_large_en_v1_5', entity_version: '2' },
        ],
      },
    },
    {
      // A CUSTOM endpoint — exactly the kind of workspace-private model the
      // removed pinnedFallback could never have known about.
      name: 'acme-internal-support-bot',
      state: { ready: 'READY' },
      task: 'llm/v1/chat',
      endpoint_type: 'CUSTOM_MODEL',
      config: { served_entities: [{ entity_name: 'acme.models.support_bot' }] },
    },
    {
      name: 'still-provisioning',
      state: { ready: 'NOT_READY' },
      task: 'llm/v1/chat',
      endpoint_type: 'CUSTOM_MODEL',
    },
    {
      name: 'some-future-task-type',
      state: { ready: 'READY' },
      task: 'llm/v9/telepathy',
    },
  ],
};

function mockFetch(impl: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => impl(url, init))
  );
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DatabricksModelFetcher — workspace endpoint enumeration', () => {
  it('calls the documented workspace control-plane route with a bearer token', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return okResponse(WORKSPACE_RESPONSE);
    });

    await new DatabricksModelFetcher({
      host: 'my-co.cloud.databricks.com',
      token: 'dapi-secret',
    }).getModels();

    expect(seenUrl).toBe('https://my-co.cloud.databricks.com/api/2.0/serving-endpoints');
    expect(seenAuth).toBe('Bearer dapi-secret');
  });

  it('normalises a host pasted with scheme and/or trailing slash', async () => {
    let seenUrl = '';
    mockFetch((url) => {
      seenUrl = url;
      return okResponse({ endpoints: [] });
    });

    await new DatabricksModelFetcher({
      host: 'https://my-co.cloud.databricks.com/',
      token: 't',
    }).getModels();

    expect(seenUrl).toBe('https://my-co.cloud.databricks.com/api/2.0/serving-endpoints');
  });

  it('returns the workspace-private endpoints, including custom ones', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();

    expect(models.map((m) => m.id)).toEqual([
      'databricks-meta-llama-3-3-70b-instruct',
      'databricks-bge-large-en',
      'acme-internal-support-bot',
    ]);
  });

  it('derives capabilities from the declared `task`, not from the endpoint name', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));

    expect(byId['databricks-meta-llama-3-3-70b-instruct']?.capabilities).toEqual([
      'chat',
      'text_generation',
      'streaming',
    ]);
    expect(byId['databricks-bge-large-en']?.capabilities).toEqual(['embedding', 'embeddings']);
    // Nothing in 'acme-internal-support-bot' hints at chat except its task.
    expect(byId['acme-internal-support-bot']?.capabilities).toContain('chat');
  });

  it('skips endpoints that are not READY (they 4xx on invoke)', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    expect(models.map((m) => m.id)).not.toContain('still-provisioning');
  });

  it('drops an unrecognised task rather than guessing capabilities for it', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    expect(models.map((m) => m.id)).not.toContain('some-future-task-type');
  });

  it('does not invent a context window or pricing Databricks never reports', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    for (const m of models) {
      expect(m.contextWindow, m.id).toBe(0);
      expect(m.maxOutputTokens, m.id).toBe(0);
      expect(m.pricing.inputCostPer1M, m.id).toBe(0);
      expect(m.pricing.outputCostPer1M, m.id).toBe(0);
    }
  });

  it('marks its capability list as declared so HCRA does not demote it to a guess', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const [model] = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    // `metadata.capabilities` is the corroboration the discovery assertion
    // emitter requires before it will call something `provider-declared`.
    expect(model?.metadata?.capabilities).toEqual(['chat', 'text_generation', 'streaming']);
  });

  it('prefers the foundation model display name when the API supplies one', async () => {
    mockFetch(() => okResponse(WORKSPACE_RESPONSE));
    const [model] = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    expect(model?.displayName).toBe('Meta Llama 3.3 70B Instruct');
  });

  it('returns [] — never a fabricated roster — when the workspace rejects us', async () => {
    mockFetch(() => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response);
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    expect(models).toEqual([]);
  });

  it('returns [] when the request throws', async () => {
    mockFetch(() => {
      throw new Error('ENOTFOUND');
    });
    const models = await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels();
    expect(models).toEqual([]);
  });

  it('does not call the network at all without a host or token', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await new DatabricksModelFetcher({ host: '', token: 't' }).getModels()).toEqual([]);
    expect(await new DatabricksModelFetcher({ host: 'h', token: '' }).getModels()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('tolerates a response with no endpoints array', async () => {
    mockFetch(() => okResponse({}));
    expect(await new DatabricksModelFetcher({ host: 'h', token: 't' }).getModels()).toEqual([]);
  });
});
