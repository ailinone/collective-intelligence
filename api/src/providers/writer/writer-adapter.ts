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

export class WriterAdapter extends OpenAICompatibleHubAdapter {
  static readonly PROVIDER_NAME = 'writer';
  static readonly DEFAULT_BASE_URL = 'https://api.writer.com/v1';

  constructor(config: WriterAdapterConfig) {
    const hubConfig: OpenAICompatibleHubAdapterConfig = {
      ...config,
      name: config.name ?? WriterAdapter.PROVIDER_NAME,
      enabled: config.enabled ?? true,
      providerName: WriterAdapter.PROVIDER_NAME,
      displayName: config.displayName ?? 'Writer',
      baseUrl: config.baseUrl || WriterAdapter.DEFAULT_BASE_URL,
      metadata: config.metadata,
    };
    super(hubConfig);
  }
}

export interface WriterAdapterConfig {
  apiKey: string;
  name?: string;
  baseUrl?: string;
  displayName?: string;
  enabled?: boolean;
  metadata?: OpenAICompatibleHubAdapterConfig['metadata'];
}
