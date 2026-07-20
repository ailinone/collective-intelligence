// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cloudflare Workers AI Adapter
 *
 * Cloudflare Workers AI exposes an OpenAI-compatible surface rooted at:
 *   https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1
 *
 * The `{account_id}` segment is per-tenant and is NOT a generic catalog URL
 * template — the hub's declarative `baseUrl` can't resolve it because there's
 * no generic substitution mechanism for tenant-scoped path params. This
 * dedicated adapter owns the URL composition: it reads CLOUDFLARE_ACCOUNT_ID
 * from env (or explicit config) and produces the fully-qualified baseUrl,
 * then delegates the rest of the wire shape to the hub base.
 *
 * ### Auth
 *
 * Bearer token via CLOUDFLARE_API_TOKEN. The token needs the "Workers AI"
 * permission enabled in the token's allowlist; otherwise Cloudflare returns
 * 403 with a message pointing operators to the dashboard.
 *
 * ### Model naming
 *
 * Cloudflare models use the `@cf/vendor/model` convention, e.g.
 * `@cf/meta/llama-3-8b-instruct`. The hub passes these through unchanged — no
 * normalization is needed, but model-name slashes must NOT be URL-encoded
 * (Cloudflare expects them raw in the POST body, not the path).
 *
 * ### Per-account failure modes
 *
 * Cloudflare's Workers AI has **per-account** rate limits that aren't shared
 * with other Cloudflare services. A 429 here is specific to Workers AI
 * neuron credits, not to the account's overall CF API quota — operators
 * should read the `cf-ray` + `x-ratelimit-*` headers on 429 responses for
 * diagnosis.
 *
 * Docs: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export interface CloudflareWorkersAIAdapterConfig extends OpenAICompatibleHubAdapterConfig {
  /**
   * Cloudflare account ID. Required — fail-fast construction if absent so
   * that misconfiguration surfaces at startup, not at first request.
   */
  accountId?: string;
}

/**
 * Build the fully-qualified Workers AI v1 base URL from an account id.
 * Exported for tests so the URL shape can be pinned without hitting the
 * constructor's env-var fallback path.
 */
export function buildWorkersAIBaseUrl(accountId: string): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('CloudflareWorkersAI: accountId is required');
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/v1`;
}

export class CloudflareWorkersAIAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: CloudflareWorkersAIAdapterConfig) {
    const accountId = (config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

    // Resolution priority:
    //   1. Explicit config.baseUrl — honored as-is (operator override).
    //   2. accountId-derived URL — computed fresh from accountId + env.
    //   3. Sentinel URL — signals misconfig; adapter still constructs so
    //      health check can surface the error without blocking server boot.
    let resolvedBaseUrl = config.baseUrl;
    if (!resolvedBaseUrl) {
      if (accountId) {
        resolvedBaseUrl = buildWorkersAIBaseUrl(accountId);
      } else {
        // A sentinel URL beats construction-time throws because Cloudflare
        // may be an optional provider in many deployments — failing boot is
        // too aggressive. The URL is syntactically valid but will 403 on
        // every request, making the misconfig immediately visible.
        resolvedBaseUrl =
          'https://api.cloudflare.com/client/v4/accounts/MISSING_CLOUDFLARE_ACCOUNT_ID/ai/v1';
      }
    }

    super({
      ...config,
      providerName: 'cloudflare-workers-ai',
      displayName: config.displayName || 'Cloudflare Workers AI',
      baseUrl: resolvedBaseUrl,
    });
  }
}
