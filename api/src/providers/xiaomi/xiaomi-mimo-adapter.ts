// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Xiaomi MiMo Adapter — OpenAI-compatible wrapper for Xiaomi's MiMo platform.
 *
 * Xiaomi's MiMo (https://platform.xiaomimimo.com) exposes standard OpenAI
 * chat/completions + embeddings on a Bearer-authenticated endpoint. The wire
 * shape is pure OAI; the adapter exists for observable identity (metrics,
 * logs, circuit-breaker scoping) and future MiMo-specific extensions
 * (e.g. Chinese language optimization flags that may ship in later API
 * versions).
 *
 * Docs: https://platform.xiaomimimo.com/#/docs/welcome
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type XiaomiMimoAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class XiaomiMimoAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: XiaomiMimoAdapterConfig) {
    super({
      ...config,
      providerName: 'xiaomi-mimo',
      displayName: config.displayName || 'Xiaomi MiMo',
    });
  }
}
