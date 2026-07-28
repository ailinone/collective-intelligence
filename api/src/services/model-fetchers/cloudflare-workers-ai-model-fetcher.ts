// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cloudflare Workers AI Model Fetcher
 *
 * Cloudflare's OpenAI-compat surface (accounts/{id}/ai/v1) has NO /models
 * discovery route — it only serves chat/embeddings execution. The actual
 * catalog lives on Cloudflare's own v4 API envelope, a different response
 * shape entirely:
 *
 *   GET https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search
 *   { success: true, result: [{ name, task: { name }, description, ... }] }
 *
 * The shared OpenAICompatibleHubModelFetcher expects an OpenAI-shaped
 * { data: [{ id, ... }] } body and only ever tries paths relative to the
 * OAI-compat baseUrl (.../ai/v1/models, .../ai/v1/v1/models, etc.), none of
 * which exist — hence this dedicated fetcher, following the same pattern as
 * BytezNativeModelFetcher for a non-OAI-compat discovery surface.
 *
 * Requires BOTH env vars — a valid CLOUDFLARE_API_TOKEN alone is not
 * sufficient, the account-scoped path segment must also be set:
 *   CLOUDFLARE_API_TOKEN   — needs the "Workers AI" permission
 *   CLOUDFLARE_ACCOUNT_ID  — the tenant account id (not a secret; plain env)
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface CloudflareModelTask {
  id?: string;
  name?: string;
  description?: string;
}

interface CloudflareModelEntry {
  id?: string;
  name?: string;
  description?: string;
  task?: CloudflareModelTask;
  [k: string]: unknown;
}

interface CloudflareModelsSearchResponse {
  success?: boolean;
  result?: CloudflareModelEntry[];
  errors?: Array<{ code?: number; message?: string }>;
}

const TASK_NAME_TO_CAPABILITIES: Record<string, ModelCapability[]> = {
  'text generation': ['chat', 'completions'],
  'text-generation': ['chat', 'completions'],
  'summarization': ['chat'],
  'translation': ['chat'],
  'text embeddings': ['embedding'],
  'text-embeddings': ['embedding'],
  'text-to-image': ['image_generation'],
  'image-to-text': ['vision'],
  'text-to-speech': ['text_to_speech'],
  'automatic-speech-recognition': ['speech_to_text', 'transcription'],
  'image classification': ['vision'],
  'object detection': ['vision'],
};

export class CloudflareWorkersAIModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'cloudflare-workers-ai';
  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly requestTimeoutMs: number;
  private readonly log = logger.child({ component: 'cloudflare-workers-ai-fetcher' });

  constructor(
    apiToken: string,
    accountId: string,
    requestTimeoutMs = Number(process.env.CLOUDFLARE_DISCOVERY_TIMEOUT_MS || '15000'),
  ) {
    super();
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiToken || this.isMockKey(this.apiToken)) {
      this.log.warn({ tokenPresent: Boolean(this.apiToken) }, 'Cloudflare Workers AI discovery skipped: no/mock token');
      return [];
    }
    if (!this.accountId || !this.accountId.trim()) {
      this.log.warn('Cloudflare Workers AI discovery skipped: CLOUDFLARE_ACCOUNT_ID not set');
      return [];
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId.trim())}/ai/models/search`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        this.log.warn({ status: response.status }, 'Cloudflare Workers AI models/search non-OK');
        return [];
      }

      const body = (await response.json()) as CloudflareModelsSearchResponse;
      if (body.success === false) {
        this.log.warn({ errors: body.errors }, 'Cloudflare Workers AI models/search returned success:false');
        return [];
      }

      const list = Array.isArray(body.result) ? body.result : [];
      const out = list
        .filter((m) => typeof m.name === 'string' && m.name.length > 0)
        .map((m) => this.transform(m));

      this.log.info({ received: list.length, emitted: out.length }, 'Cloudflare Workers AI discovery completed');
      return out;
    } catch (error) {
      this.log.error({ error }, 'Cloudflare Workers AI discovery failed');
      return [];
    }
  }

  private transform(model: CloudflareModelEntry): ProviderModel {
    const modelId = (model.name ?? model.id ?? '') as string;
    const taskName = model.task?.name?.trim().toLowerCase();
    const capabilities = (taskName && TASK_NAME_TO_CAPABILITIES[taskName]) || ['chat'];

    return {
      id: modelId,
      name: modelId,
      displayName: modelId,
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities,
      pricing: {
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        currency: 'USD',
      },
      metadata: {
        task: model.task?.name,
        description: model.description,
        pricingSource: 'unknown',
        priceConfidence: 'low',
      },
    };
  }

  private isMockKey(key: string): boolean {
    const lc = key.toLowerCase();
    return lc.includes('mock') || lc.includes('test') || lc.includes('xxx') || lc === 'changeme';
  }
}
