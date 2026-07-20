// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Volcano ARK Adapter — ByteDance/Volcengine inference endpoints.
 *
 * Volcano ARK (`https://ark.cn-beijing.volces.com/api/v3`) is ByteDance's
 * public inference platform hosting Doubao and partnered open-source models.
 * The wire protocol is OpenAI-compatible for chat/embeddings — but the
 * **model identifier** is NOT a model name. It is an "endpoint id" that the
 * customer provisioned in the ARK console, typically formatted as
 * `ep-<YYYYMMDDHHMMSS>-<random>`. For example: `ep-20240611071234-abc12`.
 *
 * ### Documented API surface
 * (Source: https://www.volcengine.com/docs/82379/1099455,
 *          https://www.volcengine.com/docs/82379/1298454)
 *
 *   POST /api/v3/chat/completions
 *     Body: standard OpenAI chat.
 *     Field `model`: the endpoint id (ep-xxxxx). NOT the family name
 *     "doubao-pro-128k" etc.
 *
 *   POST /api/v3/embeddings
 *     Same endpoint-id convention.
 *
 *   GET /api/v3/models/{endpoint_id}
 *     Retrieve one endpoint by id. The platform does NOT expose a bulk
 *     `/models` list — discovery relies on the ARK Console API (separate
 *     from the inference API) or catalog-declared endpoints.
 *
 *   Headers:
 *     Authorization: Bearer <VOLCANO_API_KEY>
 *
 * ### Why dedicated
 *
 *   - Discovery. Without this class, discovery falls through to the hub
 *     fetcher which probes `/v1/models`. Volcano serves 404 there. Dedicated
 *     getModels returns an empty list explicitly rather than letting the
 *     fetcher retry + log errors.
 *
 *   - Model-id validation. The ARK docs warn explicitly: "If you pass a
 *     Doubao model name instead of the endpoint id, the API returns 404."
 *     This adapter surfaces a typed guard (`isVolcanoEndpointId`) so
 *     callers/capability-resolvers can validate before dispatch.
 *
 *   - Regional endpoint awareness. ARK has both a Beijing
 *     (`ark.cn-beijing.volces.com`) and a Shanghai endpoint. The baseUrl
 *     is env-overridable (`VOLCANO_BASE_URL`) — this adapter doesn't
 *     hardcode a region.
 *
 * ### What this class does NOT do
 *
 *   - It does NOT translate family names ("doubao-pro-128k") to endpoint
 *     ids. Endpoint provisioning is an out-of-band ARK Console operation.
 *   - It does NOT list available endpoints. There's no public inference-
 *     API route to enumerate them. The catalog/registry must be seeded
 *     externally with the customer's endpoint ids.
 */

import type { Model } from '@/types';
import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

/** Matches `ep-<timestamp>-<random>` per Volcano's documented endpoint id format. */
const ENDPOINT_ID_PATTERN = /^ep-\d{14}-[a-z0-9]+$/i;

export class VolcanoAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'volcano',
      displayName: config.displayName || 'Volcano Engine (ARK)',
    });
  }

  /**
   * ARK does not expose a bulk `/models` route on the inference API.
   * Return an empty list rather than let the hub fetcher probe and log
   * a 404 every discovery cycle. The catalog-declared `staticModels` path
   * is the correct way to seed endpoint ids for this provider.
   */
  override async getModels(): Promise<Model[]> {
    return [];
  }

  /**
   * Quick check — used by the capability merger and the router to flag
   * when a request against Volcano ships a family name instead of an
   * endpoint id. Catches a class of easy-to-make mistakes early.
   */
  static isVolcanoEndpointId(modelId: string): boolean {
    return ENDPOINT_ID_PATTERN.test(modelId);
  }
}
