// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bytez Native Model Fetcher
 *
 * Bytez exposes its ~100k model surface via a NON-OpenAI-compatible endpoint
 *   GET https://api.bytez.com/models/v2/list/models
 *   { error: null, output: [{ modelId, task, ... }] }
 *
 * The shared OpenAICompatibleHubModelFetcher cannot consume that shape because
 * it expects { data: [{ id, ... }] }. Hence this dedicated transform.
 *
 * The OAI-compat router at /models/v2/openai/v1 only routes a small subset
 * (chat + embeddings). Native discovery is the only way to expose the full
 * inferenceable Bytez catalog (image/speech/etc.) to downstream selection.
 *
 * Pricing is intentionally 0 with metadata.pricingSource = 'unknown'; Bytez
 * pricing depends on backing model + modality and is not surfaced in the
 * listing endpoint.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface BytezModel {
  modelId: string;
  task?: string;
  modality?: string;
  family?: string;
  [k: string]: unknown;
}

interface BytezListResponse {
  error?: string | null;
  output?: BytezModel[];
}

const TASK_TO_CAPABILITIES: Record<string, ModelCapability[]> = {
  'text-generation': ['chat', 'completions'],
  'text2text-generation': ['chat', 'completions'],
  'conversational': ['chat'],
  'question-answering': ['chat'],
  'summarization': ['chat'],
  'translation': ['chat'],
  'fill-mask': ['completions'],
  'feature-extraction': ['embedding'],
  'sentence-similarity': ['embedding'],
  'text-to-image': ['image_generation'],
  'image-to-image': ['image_generation'],
  'text-to-video': ['video_generation'],
  'text-to-speech': ['text_to_speech'],
  'automatic-speech-recognition': ['speech_to_text', 'transcription'],
  'audio-classification': ['speech_to_text'],
  'image-classification': ['vision'],
  'object-detection': ['vision'],
  'image-segmentation': ['vision'],
  'image-to-text': ['vision'],
  'visual-question-answering': ['vision', 'chat'],
};

export class BytezNativeModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'bytez';
  private apiKey: string;
  private baseUrl: string;
  private maxModels: number;
  private requestTimeoutMs: number;
  private log = logger.child({ component: 'bytez-native-fetcher' });

  constructor(
    apiKey: string,
    baseUrl = 'https://api.bytez.com/models/v2/list/models',
    maxModels = Number(process.env.BYTEZ_DISCOVERY_MAX_MODELS || '100000'),
    requestTimeoutMs = Number(process.env.BYTEZ_DISCOVERY_TIMEOUT_MS || '30000'),
  ) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxModels = maxModels;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiKey || this.isMockKey(this.apiKey)) {
      this.log.warn({ keyPresent: Boolean(this.apiKey) }, 'Bytez native discovery skipped: no/mock API key');
      return [];
    }

    const start = Date.now();
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'ailin-ci/discovery (bytez-native)',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        this.log.warn({ status: response.status }, 'Bytez native list non-OK');
        return [];
      }

      const body = (await response.json()) as BytezListResponse;
      if (body.error) {
        this.log.warn({ error: body.error }, 'Bytez native list returned error field');
        return [];
      }

      const list = Array.isArray(body.output) ? body.output : [];
      const truncated = list.length > this.maxModels ? list.slice(0, this.maxModels) : list;
      const out = truncated
        .filter(m => typeof m.modelId === 'string' && m.modelId.length > 0)
        .map(m => this.transform(m));

      this.log.info(
        {
          received: list.length,
          emitted: out.length,
          capped: list.length > this.maxModels,
          durationMs: Date.now() - start,
        },
        'Bytez native discovery completed',
      );
      return out;
    } catch (error) {
      this.log.error({ error }, 'Bytez native discovery failed');
      return [];
    }
  }

  private transform(model: BytezModel): ProviderModel {
    const capabilities = this.mapCapabilities(model.task);

    const metadata: Record<string, unknown> = {
      task: model.task,
      modality: model.modality,
      family: model.family,
      pricingSource: 'unknown',
      priceConfidence: 'low',
      hubInventoryClass: 'aggregated_index',
    };

    return {
      id: model.modelId,
      name: model.modelId,
      displayName: model.modelId,
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities,
      pricing: {
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        currency: 'USD',
      },
      metadata,
    };
  }

  private mapCapabilities(task?: string): ModelCapability[] {
    if (task && TASK_TO_CAPABILITIES[task]) return TASK_TO_CAPABILITIES[task];
    return ['chat'];
  }

  private isMockKey(key: string): boolean {
    const lc = key.toLowerCase();
    return lc.includes('mock') || lc.includes('test') || lc.includes('xxx') || lc === 'changeme';
  }
}
