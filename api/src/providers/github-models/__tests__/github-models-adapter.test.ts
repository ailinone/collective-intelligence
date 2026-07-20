// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GitHubModelsAdapter — thin hub wrapper over the GH PAT-auth inference
 * aggregator. The interesting assertions are the modelListPath override
 * (GitHub uses /catalog/models, not /v1/models) and the baseUrl default.
 */

import { describe, expect, it } from 'vitest';
import { GitHubModelsAdapter } from '../github-models-adapter';

function getInternals(adapter: GitHubModelsAdapter): {
  baseUrl: string;
  modelListPath: string | undefined;
  authHeaderName: string;
  authScheme: string;
} {
  const internal = adapter as unknown as {
    config: { baseUrl: string };
    metadata: {
      modelListPath?: string;
      authHeaderName: string;
      authScheme: string;
    };
  };
  return {
    baseUrl: internal.config.baseUrl,
    modelListPath: internal.metadata.modelListPath,
    authHeaderName: internal.metadata.authHeaderName,
    authScheme: internal.metadata.authScheme,
  };
}

describe('GitHubModelsAdapter', () => {
  it('instantiates with a GitHub PAT', () => {
    expect(
      () =>
        new GitHubModelsAdapter({
          name: 'github-models',
          enabled: true,
          providerName: 'github-models',
          apiKey: 'ghp_abc123',
        }),
    ).not.toThrow();
  });

  it('default baseUrl is models.github.ai/inference', () => {
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
    });
    expect(getInternals(adapter).baseUrl).toBe('https://models.github.ai/inference');
  });

  it('overrides modelListPath to /catalog/models (NOT /v1/models)', () => {
    // GitHub Models exposes catalog discovery at /catalog/models, not the
    // OpenAI-standard /v1/models. Regressing this breaks auto-discovery on
    // first boot without warning — a silent failure mode where discovery
    // returns 404 and the model list is empty.
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
    });
    expect(getInternals(adapter).modelListPath).toBe('/catalog/models');
  });

  it('uses Bearer auth on the Authorization header', () => {
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
    });
    const internals = getInternals(adapter);
    expect(internals.authHeaderName).toBe('Authorization');
    expect(internals.authScheme).toBe('Bearer');
  });

  it('provider identity is "github-models"', () => {
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('github-models');
  });

  it('default displayName is "GitHub Models"', () => {
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
    });
    expect(adapter.displayName).toBe('GitHub Models');
  });

  it('honors explicit baseUrl override (enterprise GHES inference endpoint)', () => {
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
      baseUrl: 'https://ghes.contoso.com/api/models/inference',
    });
    expect(getInternals(adapter).baseUrl).toBe('https://ghes.contoso.com/api/models/inference');
  });

  it('caller metadata.modelListPath wins over the default override', () => {
    // Some enterprise Model Serving paths differ; operators should be able
    // to override without forking the adapter. Metadata spread order is
    // `...config.metadata` LAST, so the caller wins.
    const adapter = new GitHubModelsAdapter({
      name: 'github-models',
      enabled: true,
      providerName: 'github-models',
      apiKey: 'k',
      metadata: { modelListPath: '/v2/models' },
    });
    expect(getInternals(adapter).modelListPath).toBe('/v2/models');
  });
});
