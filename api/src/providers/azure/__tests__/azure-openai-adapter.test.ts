// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AzureOpenAIAdapter — URL composition is the load-bearing piece. Every test
 * below pins a specific slice of the resource/deployment/api-version triple.
 * Regress any of them and we either ship to the wrong tenant (worst case) or
 * emit a literal-template URL that 404s (best case).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AzureOpenAIAdapter,
  AZURE_OPENAI_DEFAULT_API_VERSION,
  buildAzureOpenAIBaseUrl,
} from '../azure-openai-adapter';
import type { ChatRequest } from '@/types';

// `chatCompletion()` normalizes the requested model against the catalog
// before sending — mock the DB-backed lookup so the new prompt_cache_key
// tests below don't need a live database (matches the pattern
// openai-compatible-hub-adapter's own cache-observability tests use).
vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn().mockResolvedValue([]),
}));

const ENV_KEYS = [
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_RESOURCE',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_ENDPOINT',
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIG_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIG_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIG_ENV[key];
    }
  }
});

/** Introspect the resolved baseUrl + metadata off the constructed instance. */
function getInternals(adapter: AzureOpenAIAdapter): {
  baseUrl: string;
  chatPath: string;
  authHeaderName: string;
  authScheme: string;
} {
  const internal = adapter as unknown as {
    config: { baseUrl: string };
    metadata: {
      chatCompletionsPath: string;
      authHeaderName: string;
      authScheme: string;
    };
  };
  return {
    baseUrl: internal.config.baseUrl,
    chatPath: internal.metadata.chatCompletionsPath,
    authHeaderName: internal.metadata.authHeaderName,
    authScheme: internal.metadata.authScheme,
  };
}

describe('buildAzureOpenAIBaseUrl helper', () => {
  it('composes a canonical Azure URL from resource + deployment', () => {
    expect(buildAzureOpenAIBaseUrl({ resourceName: 'my-aoai', deployment: 'gpt-4o-prod' })).toBe(
      'https://my-aoai.openai.azure.com/openai/deployments/gpt-4o-prod'
    );
  });

  it('honors an explicit endpoint over resourceName (sovereign cloud / private link)', () => {
    expect(
      buildAzureOpenAIBaseUrl({
        endpoint: 'https://my-aoai.openai.azure.us',
        deployment: 'gov-deployment',
        resourceName: 'ignored',
      })
    ).toBe('https://my-aoai.openai.azure.us/openai/deployments/gov-deployment');
  });

  it('does not double-add /openai when the operator already included it in endpoint', () => {
    // Common mistake — operators copy-paste the full path from the Azure UI.
    expect(
      buildAzureOpenAIBaseUrl({
        endpoint: 'https://my-aoai.openai.azure.com/openai/',
        deployment: 'gpt-4',
      })
    ).toBe('https://my-aoai.openai.azure.com/openai/deployments/gpt-4');
  });

  it('throws when deployment is missing (no silent fallback)', () => {
    expect(() =>
      buildAzureOpenAIBaseUrl({ resourceName: 'x' } as unknown as { resourceName: string })
    ).toThrow(/deployment is required/);
  });

  it('throws when neither resourceName nor endpoint is provided', () => {
    expect(() => buildAzureOpenAIBaseUrl({ deployment: 'x' })).toThrow(
      /resourceName \(or explicit endpoint\) is required/
    );
  });
});

describe('AzureOpenAIAdapter — URL resolution', () => {
  it('synthesizes baseUrl from explicit config (resource + deployment + apiVersion)', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_subscription_key',
      resourceName: 'prod-aoai',
      deployment: 'gpt-4o',
      apiVersion: '2024-10-21',
    });
    const internals = getInternals(adapter);
    expect(internals.baseUrl).toBe('https://prod-aoai.openai.azure.com/openai/deployments/gpt-4o');
    expect(internals.chatPath).toBe('/chat/completions?api-version=2024-10-21');
  });

  it('falls back to env vars when config omits resource + deployment', () => {
    process.env.AZURE_OPENAI_RESOURCE_NAME = 'env-resource';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'env-deployment';
    process.env.AZURE_OPENAI_API_VERSION = '2024-12-01-preview';

    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
    });

    const internals = getInternals(adapter);
    expect(internals.baseUrl).toBe(
      'https://env-resource.openai.azure.com/openai/deployments/env-deployment'
    );
    expect(internals.chatPath).toContain('api-version=2024-12-01-preview');
  });

  it('prefers explicit baseUrl (gateway/proxy override path)', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
      baseUrl: 'https://gateway.example.com/openai/deployments/custom',
      deployment: 'ignored',
    });
    expect(getInternals(adapter).baseUrl).toBe(
      'https://gateway.example.com/openai/deployments/custom'
    );
  });

  it('uses AZURE_OPENAI_DEFAULT_API_VERSION when apiVersion is unspecified', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
      resourceName: 'rsc',
      deployment: 'dep',
    });
    expect(getInternals(adapter).chatPath).toContain(
      `api-version=${encodeURIComponent(AZURE_OPENAI_DEFAULT_API_VERSION)}`
    );
    expect(adapter.getApiVersion()).toBe(AZURE_OPENAI_DEFAULT_API_VERSION);
  });

  it('falls back to sentinel URL (not a throw) when both deployment and resource are missing', () => {
    // Deliberate: Azure may be an OPTIONAL provider in many deploys. Throwing
    // at construction blocks boot for operators who never intend to use it.
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
    });
    const internals = getInternals(adapter);
    expect(internals.baseUrl).toContain('MISSING_AZURE_OPENAI_CONFIG');
    expect(internals.baseUrl).toContain('MISSING_DEPLOYMENT');
  });

  it('explicit config.deployment preserved even when env is also set', () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = 'env-would-lose';
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
      resourceName: 'rsc',
      deployment: 'config-wins',
    });
    expect(adapter.getDeployment()).toBe('config-wins');
    expect(getInternals(adapter).baseUrl).toContain('config-wins');
  });

  it('api-version query string is URL-encoded (preview versions contain dashes)', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
      resourceName: 'rsc',
      deployment: 'dep',
      apiVersion: '2024-12-01-preview',
    });
    // Dashes are safe in query strings; assert round-trippable.
    const path = getInternals(adapter).chatPath;
    const url = new URL(`https://example.com${path}`);
    expect(url.searchParams.get('api-version')).toBe('2024-12-01-preview');
  });
});

describe('AzureOpenAIAdapter — auth contract', () => {
  it('uses api-key header with empty scheme (subscription key path)', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'subscription_key_value',
      resourceName: 'rsc',
      deployment: 'dep',
    });
    const internals = getInternals(adapter);
    expect(internals.authHeaderName).toBe('api-key');
    expect(internals.authScheme).toBe('');
  });
});

describe('AzureOpenAIAdapter — identity + introspection', () => {
  it('providerName is "azure-openai"', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'k',
      resourceName: 'r',
      deployment: 'd',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('azure-openai');
  });

  it('default displayName embeds the deployment name', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'k',
      resourceName: 'r',
      deployment: 'gpt-4o-prod',
    });
    expect(adapter.displayName).toBe('Azure OpenAI (gpt-4o-prod)');
  });

  it('caller-supplied displayName wins', () => {
    const adapter = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      displayName: 'Contoso AOAI',
      apiKey: 'k',
      resourceName: 'r',
      deployment: 'd',
    });
    expect(adapter.displayName).toBe('Contoso AOAI');
  });

  it('getDeployment() returns the resolved deployment (or "unconfigured" when missing)', () => {
    const ok = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'k',
      resourceName: 'r',
      deployment: 'resolved-dep',
    });
    expect(ok.getDeployment()).toBe('resolved-dep');

    const missing = new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'k',
    });
    expect(missing.getDeployment()).toBe('unconfigured');
  });
});

/**
 * ADR-025 follow-up (2026-09-09): Azure OpenAI documents the same
 * `prompt_cache_key` request field and contract as OpenAI itself, but
 * `AzureOpenAIAdapter` extends the generic hub (not `openai-adapter.ts`), so
 * it does not inherit that adapter's own wiring — see the adapter's
 * `getExtraChatPayloadFields()` override for the citation.
 */
describe('AzureOpenAIAdapter — prompt_cache_key (ADR-025 follow-up)', () => {
  function jsonResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function makeAdapter(): AzureOpenAIAdapter {
    return new AzureOpenAIAdapter({
      name: 'azure-openai',
      enabled: true,
      providerName: 'azure-openai',
      apiKey: 'az_key',
      resourceName: 'rsc',
      deployment: 'gpt-4o',
    });
  }

  function baseRequest(): ChatRequest {
    return { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] };
  }

  it('sends a stable prompt_cache_key on every chat completion request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse());
    await makeAdapter().chatCompletion(baseRequest());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { prompt_cache_key?: string };
    expect(typeof body.prompt_cache_key).toBe('string');
    expect(body.prompt_cache_key).toMatch(/^(conv|prefix):/);
  });

  it('sends the SAME prompt_cache_key across two requests with the same prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(jsonResponse());
    const adapter = makeAdapter();

    await adapter.chatCompletion(baseRequest());
    await adapter.chatCompletion(baseRequest());

    const bodies = fetchSpy.mock.calls.map(
      ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { prompt_cache_key?: string })
        .prompt_cache_key
    );
    expect(bodies[0]).toBe(bodies[1]);
  });
});
