// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GitHub Models Adapter — GitHub-hosted inference, auth via GitHub PAT.
 *
 * GitHub Models (https://github.com/marketplace/models) is Microsoft's
 * hosted inference aggregator that surfaces OpenAI, Meta (Llama),
 * Mistral, Cohere, and a few others under a single endpoint:
 *
 *   https://models.github.ai/inference/chat/completions
 *
 * The key distinguishing feature is **auth**: it accepts a GitHub Personal
 * Access Token (or a fine-grained token with the "Models" permission), NOT
 * a provider-specific key. This is how GitHub's Copilot team ships
 * "bring-your-own-GH-account" AI to developers who already have a GitHub
 * login — no separate billing signup, no OpenAI quota management.
 *
 * ### Model naming
 *
 * Models follow the `{publisher}/{name}` convention, e.g.
 * `openai/gpt-4o`, `meta/Meta-Llama-3.1-70B-Instruct`, `mistral-ai/Mistral-Large-2411`.
 * The hub passes through unchanged.
 *
 * ### Rate limits — aggressive and per-PAT
 *
 * GitHub Models is positioned as a developer playground, not a production
 * substrate. The free tier caps at roughly 50 requests/day and 8K
 * requests/month per PAT for the cheap models, with stricter caps for
 * frontier models (e.g. o1). A 429 here usually means the developer's PAT
 * hit the daily cap — NOT that the upstream provider is unavailable. The
 * circuit breaker should treat GitHub Models 429s as CALLER quota, not
 * PROVIDER health.
 *
 * ### Billing
 *
 * Billed to the GitHub account that owns the PAT. No cost tracking is
 * available via API; operators must check the GitHub UI.
 *
 * Docs: https://docs.github.com/en/github-models
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type GitHubModelsAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class GitHubModelsAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: GitHubModelsAdapterConfig) {
    super({
      ...config,
      providerName: 'github-models',
      displayName: config.displayName || 'GitHub Models',
      baseUrl: config.baseUrl || 'https://models.github.ai/inference',
      metadata: {
        // GitHub PATs use the standard `Authorization: Bearer <PAT>` header.
        authHeaderName: 'Authorization',
        authScheme: 'Bearer',
        // GitHub Models exposes a catalog list at `/catalog/models` (NOT
        // `/v1/models`). Override so discovery hits the right path.
        modelListPath: '/catalog/models',
        ...config.metadata,
      },
    });
  }
}
