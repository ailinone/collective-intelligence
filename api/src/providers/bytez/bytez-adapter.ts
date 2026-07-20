// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bytez Adapter — multi-modality hub with an OAI-compatible chat/embeddings
 * surface.
 *
 * Bytez (https://bytez.com) runs a marketplace of HuggingFace + custom models
 * behind a single bearer-auth API. The chat / embeddings paths are OAI-shaped;
 * image and audio modalities ride on native (non-OAI) endpoints, which we
 * defer to the base hub's passthrough handling until there's real demand.
 *
 * ### Why a dedicated class and not bare hub
 *
 *   1. **Named identity** — logs/metrics/circuit-breaker scope get `provider:
 *      bytez` instead of the generic hub scope. Critical for per-provider SLO
 *      tracking in the SOTA benchmarking pipeline.
 *   2. **GCP secret binding** — the factory auto-loads `BYTEZ_API_KEY` from
 *      Secret Manager (`ailin-bytez-key`) via `load-secrets-into-env.ts`.
 *      Without a dedicated class the registration plumbing has nowhere to
 *      hang.
 *   3. **Future headroom** — Bytez occasionally ships experimental modalities
 *      (OCR, classification, segmentation) that won't fit the OAI shape and
 *      will need adapter-specific methods. Having the class in place now
 *      avoids a cross-cutting refactor later.
 *
 * The wire shape for chat/embed is otherwise identical to OpenAI; no
 * request/response transforms are needed at this tier.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type BytezAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class BytezAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: BytezAdapterConfig) {
    super({
      ...config,
      providerName: 'bytez',
      displayName: config.displayName || 'Bytez',
    });
  }
}
