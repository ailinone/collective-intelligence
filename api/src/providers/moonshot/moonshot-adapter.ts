// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export class MoonshotAdapter extends OpenAICompatibleHubAdapter {
  static readonly PROVIDER_NAME = 'moonshot';
  static readonly DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

  constructor(config: MoonshotAdapterConfig) {
    const hubConfig: OpenAICompatibleHubAdapterConfig = {
      ...config,
      name: config.name ?? MoonshotAdapter.PROVIDER_NAME,
      enabled: config.enabled ?? true,
      providerName: MoonshotAdapter.PROVIDER_NAME,
      displayName: config.displayName ?? 'Moonshot AI',
      baseUrl: config.baseUrl || MoonshotAdapter.DEFAULT_BASE_URL,
      metadata: config.metadata,
    };
    super(hubConfig);
  }
}

export interface MoonshotAdapterConfig {
  apiKey: string;
  name?: string;
  baseUrl?: string;
  displayName?: string;
  enabled?: boolean;
  metadata?: OpenAICompatibleHubAdapterConfig['metadata'];
}
