// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DatabricksAdapter — workspace + endpoint-scoped URL composition.
 * Pattern mirrors Azure: one instance per serving endpoint, baseUrl
 * synthesized at construction from workspace host + endpoint name.
 *
 * The URL shape is non-trivial because Databricks deployments live on
 * per-customer subdomains that look very similar (`abc.cloud.databricks.com`,
 * `dbc-abc123de-f456.cloud.databricks.com`) — a regression here ships
 * traffic to the wrong tenant.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabricksAdapter, buildDatabricksBaseUrl } from '../databricks-adapter';

const ENV_KEYS = ['DATABRICKS_HOST', 'DATABRICKS_SERVING_ENDPOINT'] as const;
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

function getResolvedBaseUrl(adapter: DatabricksAdapter): string {
  return (adapter as unknown as { config: { baseUrl: string } }).config.baseUrl;
}

describe('buildDatabricksBaseUrl helper', () => {
  it('composes a canonical workspace + endpoint URL', () => {
    expect(
      buildDatabricksBaseUrl({
        workspaceHost: 'my-co.cloud.databricks.com',
        endpoint: 'databricks-llama-3-70b-instruct',
      }),
    ).toBe(
      'https://my-co.cloud.databricks.com/serving-endpoints/databricks-llama-3-70b-instruct',
    );
  });

  it('handles the dbc-* workspace hostname format', () => {
    expect(
      buildDatabricksBaseUrl({
        workspaceHost: 'dbc-abc123de-f456.cloud.databricks.com',
        endpoint: 'prod-llm',
      }),
    ).toBe('https://dbc-abc123de-f456.cloud.databricks.com/serving-endpoints/prod-llm');
  });

  it('strips an accidental https:// prefix from workspaceHost', () => {
    // Common operator mistake: pasting the full URL from the Databricks UI.
    expect(
      buildDatabricksBaseUrl({
        workspaceHost: 'https://my-co.cloud.databricks.com/',
        endpoint: 'ep',
      }),
    ).toBe('https://my-co.cloud.databricks.com/serving-endpoints/ep');
  });

  it('throws when workspaceHost is missing', () => {
    expect(() => buildDatabricksBaseUrl({ endpoint: 'x' })).toThrow(/workspaceHost is required/);
  });

  it('throws when endpoint is missing', () => {
    expect(() => buildDatabricksBaseUrl({ workspaceHost: 'x' })).toThrow(
      /endpoint \(serving endpoint name\) is required/,
    );
  });
});

describe('DatabricksAdapter — URL resolution', () => {
  it('synthesizes baseUrl from explicit config', () => {
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'dapi_token',
      workspaceHost: 'prod.cloud.databricks.com',
      endpoint: 'databricks-llama-3-70b-instruct',
    });
    expect(getResolvedBaseUrl(adapter)).toBe(
      'https://prod.cloud.databricks.com/serving-endpoints/databricks-llama-3-70b-instruct',
    );
  });

  it('falls back to DATABRICKS_HOST + DATABRICKS_SERVING_ENDPOINT env vars', () => {
    process.env.DATABRICKS_HOST = 'env.cloud.databricks.com';
    process.env.DATABRICKS_SERVING_ENDPOINT = 'env-endpoint';

    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'dapi',
    });
    expect(getResolvedBaseUrl(adapter)).toBe(
      'https://env.cloud.databricks.com/serving-endpoints/env-endpoint',
    );
  });

  it('prefers explicit baseUrl over composition (gateway/proxy override)', () => {
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'dapi',
      workspaceHost: 'ignored',
      endpoint: 'ignored',
      baseUrl: 'https://gateway.corp/databricks/serving-endpoints/custom',
    });
    expect(getResolvedBaseUrl(adapter)).toBe(
      'https://gateway.corp/databricks/serving-endpoints/custom',
    );
  });

  it('explicit config preserved when env is also set', () => {
    process.env.DATABRICKS_HOST = 'env-would-lose.cloud.databricks.com';
    process.env.DATABRICKS_SERVING_ENDPOINT = 'env-would-lose';

    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'dapi',
      workspaceHost: 'config-wins.cloud.databricks.com',
      endpoint: 'config-wins-endpoint',
    });
    expect(getResolvedBaseUrl(adapter)).toContain('config-wins.cloud.databricks.com');
    expect(getResolvedBaseUrl(adapter)).toContain('config-wins-endpoint');
    expect(getResolvedBaseUrl(adapter)).not.toContain('env-would-lose');
  });

  it('falls back to sentinel URL (not a throw) when both host and endpoint are missing', () => {
    // Same rationale as Azure + Cloudflare: Databricks may be an OPTIONAL
    // provider in a deploy that also uses OpenAI + Anthropic. Throwing here
    // would block boot for operators who never intended to use Databricks.
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'dapi',
    });
    const baseUrl = getResolvedBaseUrl(adapter);
    expect(baseUrl).toContain('MISSING_DATABRICKS_HOST');
    expect(baseUrl).toContain('MISSING_ENDPOINT');
  });
});

describe('DatabricksAdapter — identity + introspection', () => {
  it('providerName is "databricks"', () => {
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'k',
      workspaceHost: 'h.cloud.databricks.com',
      endpoint: 'e',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('databricks');
  });

  it('default displayName embeds the endpoint name', () => {
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'k',
      workspaceHost: 'h.cloud.databricks.com',
      endpoint: 'databricks-dbrx-instruct',
    });
    expect(adapter.displayName).toBe('Databricks (databricks-dbrx-instruct)');
  });

  it('caller-supplied displayName wins', () => {
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      displayName: 'Contoso DBRX (prod)',
      apiKey: 'k',
      workspaceHost: 'h.cloud.databricks.com',
      endpoint: 'e',
    });
    expect(adapter.displayName).toBe('Contoso DBRX (prod)');
  });

  it('getEndpoint() returns resolved endpoint (or "unconfigured")', () => {
    const ok = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'k',
      workspaceHost: 'h.cloud.databricks.com',
      endpoint: 'resolved-endpoint',
    });
    expect(ok.getEndpoint()).toBe('resolved-endpoint');

    const missing = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'k',
    });
    expect(missing.getEndpoint()).toBe('unconfigured');
  });
});
