// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Apertis Adapter — OpenAI-compatible gateway with provider-side fallback.
 *
 * Apertis re-serves 400+ models from 30+ upstream vendors (GPT, Claude,
 * Gemini, Grok, Qwen, DeepSeek, ...) behind one OpenAI-compatible surface —
 * a gateway, not first-party inference. The wire shape is a faithful
 * `/v1/chat/completions`, so this is a thin extension of the hub adapter.
 *
 * The one real quirk this class encodes: Apertis supports its OWN automatic
 * model fallback (`fallback_models` / `fallback_enabled`) at the gateway
 * level. Left on, a request that fails on model A can silently succeed on
 * model B *inside Apertis* — hiding the real failure (and the substitute
 * model actually billed) from ci's own cost/quality-aware fallback and
 * operability tracking. We disable it so failures surface to our
 * orchestrator, which already owns fallback decisions across providers.
 *
 * Docs: https://docs.apertis.ai/api/utilities/fallback-models
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type { ChatRequest } from '@/types';

export class ApertisAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'apertis',
      displayName: config.displayName || 'Apertis',
    });
  }

  protected override getExtraChatPayloadFields(
    _resolvedModel: string,
    _request: ChatRequest,
  ): Record<string, unknown> {
    return { fallback_enabled: false };
  }
}
