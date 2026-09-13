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
 *
 * AUTH HEADER FORMAT (root-caused 2026-09-09, production investigation):
 * `BYTEZ_API_KEY` IS present and loaded in production (confirmed via
 * candidate-trace logs: `credential_validated reason=env_present` and
 * `catalog-provider-plugin apiKeyPresent=true` on every boot) — the
 * long-standing "Bytez has no live API key in production today" assumption
 * in this file's history was never verified against a real request and was
 * false. The real, log-confirmed symptom is that this endpoint returns
 * HTTP 500 on most discovery cycles and HTTP 200 with an empty `output: []`
 * on the rest — never a clean success, and never 401/429 either.
 *
 * Bytez's own docs for this exact endpoint
 * (https://docs.bytez.com/http-reference/list/models.md) show the auth
 * header WITHOUT a `Bearer ` prefix (`Authorization: YOUR_KEY_HERE`) and
 * document 401 as the "wrong key" response — which we never observed. This
 * class was sending `Authorization: Bearer <key>` (the OAI-compat
 * convention used elsewhere in this codebase, e.g. bytez-adapter.ts's chat
 * endpoint), which does not match this native endpoint's documented format.
 * The catalog's own header comment flagged this exact risk back on
 * 2026-04-22 ("verify during first live probe") but no one had until now.
 * The header below was changed to the documented bare-token format; the
 * 500/empty-output pattern is consistent with Bytez's backend mishandling
 * a malformed Authorization value rather than cleanly rejecting it.
 *
 * PRODUCTION 500 INVESTIGATION (2026-09-10, follow-up on PR #544): live
 * probes directly against `GET https://api.bytez.com/models/v2/list/models`
 * (real key, `<prefix>-bytez-key` GCP secret) show the same 500
 * `{"error":"Expected parameter(s): modelId","output":[]}` — or, on other
 * attempts, a clean 200 with `output: []` — REGARDLESS of whether the
 * `Authorization` header sends `Bearer <key>` (this file's current code) or
 * the bare token PR #544 switches to. The sibling `/models/v2/list/tasks`
 * endpoint returns 200 for both header formats with the exact same key
 * (confirming the key itself is valid and auth is not being rejected), and
 * an unauthenticated request correctly gets a clean 401 (confirming auth IS
 * being checked, just not what's failing here). Adding `?modelId=<anything
 * non-empty, even a bogus value>` makes the 500 go away — but the response
 * is then always `{"error":null,"output":[]}` no matter what task/modelId is
 * passed. Bytez's own current OpenAPI spec for this exact endpoint
 * (github.com/Bytez-com/docs `docs/http-reference/openapi.yaml`, operationId
 * `getModels`) documents only an optional `task` query param — no `modelId`
 * — and only 401/429 as error responses, not 500. Conclusion: PR #544's
 * bare-token fix is still correct per that spec's `apiKeyAuth` scheme
 * (`Authorization: YOUR_KEY_HERE`, no `Bearer` prefix) and should still
 * land, but it does NOT fix the empty-catalog symptom by itself — the
 * `/models/v2/list/models` endpoint is misbehaving on Bytez's side,
 * demanding an undocumented `modelId` param and never actually returning
 * model rows even when that demand is satisfied. This is a vendor-side bug,
 * not something fixable from a request header on our end.
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
  conversational: ['chat'],
  'question-answering': ['chat'],
  summarization: ['chat'],
  translation: ['chat'],
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
    // LANDMINE AVOIDED (2026-09-08, same shape as the HF Hub fetcher's fixed
    // 60k cap — see hf-hub-model-fetcher.ts): this used to default to
    // `100000`, exactly at parity with this file's own header comment
    // ("~100k model surface"). A cap set at parity with the documented
    // catalog size has zero headroom — the moment Bytez's real surface grows
    // even slightly past the estimate that produced the "~100k" figure, this
    // single-response `list.slice(0, maxModels)` would start silently
    // dropping the tail with no signal, exactly like HF's pre-fix 60k cap did
    // for 97% of its zero-capability backlog. As of 2026-09-08 the live
    // catalog was still 0 rows (see the class-level doc comment for the
    // 2026-09-09 root-cause finding — a live key IS present; the cap was
    // never actually exercised), so this was preemptive, not a reaction to
    // an observed truncation — the point is to not ship the same bug shape a
    // second time. Raised far above any plausible real size; a limit here is
    // a runaway safety valve, not a routine truncation point.
    maxModels = Number(process.env.BYTEZ_DISCOVERY_MAX_MODELS || '500000'),
    requestTimeoutMs = Number(process.env.BYTEZ_DISCOVERY_TIMEOUT_MS || '30000')
  ) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxModels = maxModels;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiKey || this.isMockKey(this.apiKey)) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Bytez native discovery skipped: no/mock API key'
      );
      return [];
    }

    const start = Date.now();
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET',
        headers: {
          // Bare token, NOT `Bearer <token>` — see the class-level doc
          // comment. This is the documented format for this specific native
          // endpoint (confirmed via docs.bytez.com/http-reference/list/models),
          // distinct from the OAI-compat chat/embeddings endpoints elsewhere
          // in this codebase, which do use the Bearer convention.
          Authorization: this.apiKey,
          Accept: 'application/json',
          'User-Agent': 'ailin-ci/discovery (bytez-native)',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        // Capture the response body on failure — a bare `status: 500` with no
        // body was exactly the visibility gap that made the 2026-09
        // production incident ambiguous (vendor bug vs. our auth/payload
        // format) until someone manually re-probed the live endpoint. Bytez
        // returns a small `{error, output}` JSON body even on 500s (see the
        // class-level doc comment above), so this is cheap and always safe
        // to log at warn level going forward.
        const bodyText = await response.text().catch(() => '<unreadable>');
        this.log.warn(
          { status: response.status, body: bodyText.slice(0, 2000) },
          'Bytez native list non-OK'
        );
        return [];
      }

      const body = (await response.json()) as BytezListResponse;
      if (body.error) {
        this.log.warn({ error: body.error }, 'Bytez native list returned error field');
        return [];
      }

      const list = Array.isArray(body.output) ? body.output : [];
      const capped = list.length > this.maxModels;
      const truncated = capped ? list.slice(0, this.maxModels) : list;
      const out = truncated
        .filter((m) => typeof m.modelId === 'string' && m.modelId.length > 0)
        .map((m) => this.transform(m));

      const summary = {
        received: list.length,
        emitted: out.length,
        capped,
        durationMs: Date.now() - start,
      };
      // Landmine guard (mirrors the HF Hub fetcher fix, 2026-09-08): `capped:
      // true` means this single unpaginated response actually exceeded
      // maxModels and the tail was silently sliced off. That must be loud,
      // not routine info, so a future truncation is visible instead of
      // repeating the zero-headroom bug this default was raised to avoid.
      if (capped) {
        this.log.warn(
          summary,
          'Bytez native discovery hit maxModels — the response exceeded the safety ceiling ' +
            'and the tail was truncated; raise BYTEZ_DISCOVERY_MAX_MODELS'
        );
      } else {
        this.log.info(summary, 'Bytez native discovery completed');
      }
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
