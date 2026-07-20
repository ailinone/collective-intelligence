// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Featherless AI Adapter — OAI-compatible long-tail model marketplace.
 *
 * Featherless serves thousands of open-weight Hugging Face models behind a
 * single bearer-auth OpenAI-compatible surface at `https://api.featherless.ai/v1`.
 * The value proposition is breadth: the catalog rotates constantly as new
 * community fine-tunes appear. Hardcoding any model list would be wrong within
 * days — so this adapter carries ZERO model identifiers and delegates all
 * model resolution to the model-catalog service / dynamic discovery pipeline
 * (Featherless supports `GET /v1/models`).
 *
 * ### Why a dedicated class and not bare hub
 *
 *   1. **Named identity** — logs/metrics/circuit-breaker scope get
 *      `provider: featherless` instead of a generic hub bucket. Essential for
 *      per-provider SLO tracking (Featherless has particularly volatile
 *      latency; conflating it with other hubs would corrupt the histograms).
 *   2. **GCP secret binding** — the factory auto-loads `FEATHERLESS_AI_API_KEY`
 *      from Secret Manager (`ailin-featherless-key`). Without a dedicated
 *      class the registration plumbing has nowhere to hang.
 *   3. **Future headroom** — Featherless has shipped experimental features
 *      (speculative decoding toggles, session caching hints) that will need
 *      adapter-specific hooks. Having the class in place now avoids a
 *      cross-cutting refactor when those features promote to GA.
 *
 * ### Wire contract
 *
 * Chat and streaming are pure OpenAI-compat — no request/response transforms
 * are needed at this tier. Embeddings are not documented by Featherless as a
 * first-class surface; callers should route embedding work elsewhere, but if
 * the upstream adds it, the hub's path-forwarding will pick it up without
 * code changes.
 *
 * Docs: https://featherless.ai/docs/completions
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type FeatherlessAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class FeatherlessAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: FeatherlessAdapterConfig) {
    super({
      ...config,
      providerName: 'featherless-ai',
      displayName: config.displayName || 'Featherless AI',
    });
  }
}
