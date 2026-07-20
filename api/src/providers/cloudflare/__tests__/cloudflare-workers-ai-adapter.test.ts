// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CloudflareWorkersAIAdapter — account-scoped URL composition is the
 * whole reason this class exists. Every test below is a contract on that
 * URL construction. Regress any of them and we ship traffic to the wrong
 * tenant (worst case) or to a literal-template URL that 404s (best case).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CloudflareWorkersAIAdapter,
  buildWorkersAIBaseUrl,
} from '../cloudflare-workers-ai-adapter';

const ORIG_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

afterEach(() => {
  if (ORIG_ACCOUNT_ID === undefined) {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  } else {
    process.env.CLOUDFLARE_ACCOUNT_ID = ORIG_ACCOUNT_ID;
  }
});

beforeEach(() => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

describe('buildWorkersAIBaseUrl helper', () => {
  it('builds the canonical Workers AI v1 URL from an account id', () => {
    expect(buildWorkersAIBaseUrl('abc123')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    );
  });

  it('trims whitespace from the account id', () => {
    expect(buildWorkersAIBaseUrl('  xyz789  ')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/xyz789/ai/v1',
    );
  });

  it('throws on empty account id', () => {
    expect(() => buildWorkersAIBaseUrl('')).toThrow(/accountId is required/);
    expect(() => buildWorkersAIBaseUrl('   ')).toThrow(/accountId is required/);
  });
});

/** Pull the resolved baseUrl off the constructed instance for assertions. */
function getResolvedBaseUrl(adapter: CloudflareWorkersAIAdapter): string {
  return (adapter as unknown as { config: { baseUrl: string } }).config.baseUrl;
}

describe('CloudflareWorkersAIAdapter — URL resolution', () => {
  it('substitutes accountId from explicit config into the baseUrl', () => {
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf_token',
      accountId: 'acct_explicit',
    });
    expect(getResolvedBaseUrl(adapter)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_explicit/ai/v1',
    );
  });

  it('falls back to CLOUDFLARE_ACCOUNT_ID env var when config omits it', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_from_env';
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf_token',
    });
    expect(getResolvedBaseUrl(adapter)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_from_env/ai/v1',
    );
  });

  it('prefers explicit baseUrl over accountId substitution (operator override path)', () => {
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf_token',
      accountId: 'acct_ignored',
      baseUrl: 'https://gateway.example.com/ai/v1',
    });
    expect(getResolvedBaseUrl(adapter)).toBe('https://gateway.example.com/ai/v1');
  });

  it('falls back to sentinel URL (not a throw) when accountId is missing entirely', () => {
    // Deliberate: Cloudflare may be an OPTIONAL provider in many deploys;
    // throwing at construction would block boot for operators who never
    // intend to use Workers AI but still have the catalog row present.
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf_token',
    });
    expect(getResolvedBaseUrl(adapter)).toContain('MISSING_CLOUDFLARE_ACCOUNT_ID');
  });

  it('preserves explicit config.accountId even when env is also set', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_env_would_lose';
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf_token',
      accountId: 'acct_config_wins',
    });
    expect(getResolvedBaseUrl(adapter)).toContain('acct_config_wins');
    expect(getResolvedBaseUrl(adapter)).not.toContain('acct_env_would_lose');
  });
});

describe('CloudflareWorkersAIAdapter — identity', () => {
  it('providerName is "cloudflare-workers-ai"', () => {
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf',
      accountId: 'x',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe(
      'cloudflare-workers-ai',
    );
  });

  it('default displayName is "Cloudflare Workers AI"', () => {
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      apiKey: 'cf',
      accountId: 'x',
    });
    expect(adapter.displayName).toBe('Cloudflare Workers AI');
  });

  it('honors caller-supplied displayName override', () => {
    const adapter = new CloudflareWorkersAIAdapter({
      name: 'cloudflare-workers-ai',
      enabled: true,
      providerName: 'cloudflare-workers-ai',
      displayName: 'CF Edge AI',
      apiKey: 'cf',
      accountId: 'x',
    });
    expect(adapter.displayName).toBe('CF Edge AI');
  });
});
