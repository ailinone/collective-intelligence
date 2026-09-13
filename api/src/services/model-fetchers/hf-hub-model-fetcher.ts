// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HuggingFace Hub Model Fetcher
 *
 * Discovers the inference-routable subset of the HuggingFace Hub
 * (https://huggingface.co/models?inference_provider=all) by paginating
 * https://huggingface.co/api/models with cursor-based Link headers.
 *
 * Why this exists alongside the catalog-bridge huggingface source:
 * - The bridge hits https://router.huggingface.co/v1/models, the OpenAI-compatible
 *   router, which exposes only the subset of models with at least one configured
 *   inference provider behind the router (~hundreds, not tens of thousands).
 * - The Hub API exposes the full inference-enabled surface (~58k at time of
 *   writing), giving downstream selection layers a much larger candidate pool.
 *
 * Pricing is intentionally 0 with metadata.pricingSource = 'unknown' because the
 * Hub does not surface pricing; cost-aware components should treat these rows as
 * pricing-unknown rather than free.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface HfHubModel {
  _id: string;
  id: string;
  modelId?: string;
  likes?: number;
  trendingScore?: number;
  private?: boolean;
  downloads?: number;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  createdAt?: string;
  inferenceProviderMapping?: HfInferenceProviderMapping[];
}

/** Per-provider serving info from the HF API when ?expand[]=inferenceProviderMapping
 *  is requested. status:'live' = the provider is actually serving the model right
 *  now (HF's own prove-before-advertise signal), callable via the HF router
 *  `router.huggingface.co/v1` as `<id>:<provider>`. */
interface HfInferenceProviderMapping {
  provider: string;
  providerId: string;
  status?: string;
  task?: string;
  providerDetails?: {
    context_length?: number;
    pricing?: { input?: number; output?: number };
  };
  performance?: { tokensPerSecond?: number; firstTokenLatencyMs?: number };
  // Per-provider tool/structured-output support, present on the SAME
  // `expand[]=inferenceProviderMapping` response we already fetch (confirmed
  // live, e.g. `"features":{"structuredOutput":false,"toolCalling":true}` on
  // novita/deepinfra entries) — the official hub-api doc documents these as
  // `supports_tools`/`supports_structured_output`. Reading them here lets a
  // model's REAL, HF-attested tool/JSON-mode support flow into capabilities
  // instead of falling back to the weak name/keyword heuristics in
  // model-capability-inference.ts for the ~60k models this fetcher covers.
  features?: { toolCalling?: boolean; structuredOutput?: boolean };
}

const PIPELINE_TAG_TO_CAPABILITIES: Record<string, ModelCapability[]> = {
  'text-generation': ['chat', 'completions'],
  'text2text-generation': ['chat', 'completions'],
  conversational: ['chat'],
  // question-answering/summarization were previously mapped to ['chat'], but
  // HF's own documented contract for these two tasks is extractive/pipeline
  // I/O (`{context, question} → {answer, score, start, end}` and
  // `string → {summary_text}`), NOT `messages`/`choices` chat completions —
  // and the doc's own example models (e.g. deepset/roberta-base-squad2) are
  // extractive BERT heads with no generation head, so a chatCompletion() call
  // against them would fail outright. Left unmapped (falls through to `[]`)
  // rather than fabricating a capability the model cannot actually serve —
  // consistent with this map's own "do NOT assume" rule (see mapCapabilities
  // branch 3 below). Revisit if a dedicated extractive-QA/summarization
  // capability + adapter route is ever added.
  translation: ['translation'],
  'fill-mask': ['completions'],
  'feature-extraction': ['embedding'],
  'sentence-similarity': ['embedding'],
  'text-to-image': ['image_generation'],
  // image-to-image REQUIRES an existing input image (HF's own doc examples —
  // Qwen/Qwen-Image-Edit, FLUX.1-Kontext-dev — are editors, not generators;
  // request shape adds `parameters.target_size`/`prompt` on TOP OF an input
  // image). Mapping this to bare image_generation let edit-only models be
  // selected for from-scratch text→image requests that carry no input image
  // at all. image_editing is the capability this system already uses to keep
  // that distinction meaningful (see images-orchestration-service.ts).
  'image-to-image': ['image_editing'],
  'text-to-video': ['video_generation'],
  'text-to-speech': ['text_to_speech'],
  'automatic-speech-recognition': ['speech_to_text', 'transcription'],
  //
  // The following two task families are DELIBERATELY absent from this map
  // (they fall through mapCapabilities' branch 3 to `capabilities: []`
  // rather than being fabricated):
  //   - audio-classification (doc: `inputs` audio → `[{label, score}]`, e.g.
  //     speaker-id/command/genre classifiers) is not transcription — no text
  //     output exists in its contract at all. Previously mapped to
  //     ['speech_to_text'], which would send a transcription request to a
  //     model that only ever returns labels.
  //   - image-classification/object-detection/image-segmentation (doc:
  //     `inputs` image → `[{label, score}]` / `[{label, score, box}]` /
  //     `[{label, mask, score}]`) are dedicated single-purpose vision
  //     models, not chat. Every execution path for the 'vision' capability
  //     in this codebase (OpenAICompatibleHubAdapter.vision(), which
  //     HuggingFaceInferenceAdapter inherits unmodified) issues a
  //     chatCompletion() with an image_url content part — a contract these
  //     three tasks never implement. Previously mapped to ['vision'], which
  //     would route them into VQA-style chat calls destined to fail.
  'image-to-text': ['vision'],
  'visual-question-answering': ['vision', 'chat'],
  'image-text-to-text': ['chat', 'vision'],
  'image-to-video': ['video_generation'],
  // Added 2026-09-08 after a production audit of huggingface's zero-capability
  // backlog: direct SQL against the live catalog found 530 rows (of 74,038)
  // with capabilities: [] that ALL had a LIVE inference-provider `task` this
  // map did not cover — text-classification (351 rows), token-classification
  // (116), zero-shot-classification (41), image-text-to-video (23),
  // image-text-to-image (3), table-question-answering (2), audio-to-audio (1).
  // These are real, currently-served pipeline_tag/task values from HF's own
  // finite, documented taxonomy (https://huggingface.co/docs/hub/models-tasks),
  // not per-model hardcoding. `text-to-audio` is in the same enum (non-speech
  // audio synthesis, e.g. sound-effect/music models) and had zero live rows in
  // the sample but is added for the same reason the others were: it is a real
  // HF task this table should recognize, not a guess.
  'text-classification': ['analysis'],
  'token-classification': ['analysis'],
  'zero-shot-classification': ['analysis'],
  'table-question-answering': ['qa'],
  'image-text-to-video': ['video_generation'],
  'image-text-to-image': ['image_generation', 'image_editing'],
  'audio-to-audio': ['audio_to_audio'],
  'text-to-audio': ['audio_generation'],
};

// HF's own doc (register-as-a-provider.md) is explicit that a live provider's
// `task: 'conversational'` collapses BOTH `text-generation` and
// `image-text-to-text` models — confirmed live: VLMs report
// `task: 'conversational'` on every live provider identically to a
// text-only LLM, while still carrying `pipeline_tag: 'image-text-to-text'`
// at the Hub (model) level. See the `mapCapabilities` step that reads this.
const VISION_PIPELINE_TAGS = new Set(['image-text-to-text']);

export class HfHubModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'huggingface';
  private token: string | undefined;
  private baseUrl: string;
  private maxModels: number;
  private pageSize: number;
  private requestTimeoutMs: number;
  private log = logger.child({ component: 'hf-hub-fetcher' });

  constructor(
    token?: string,
    baseUrl = 'https://huggingface.co/api/models',
    // LANDMINE FIXED (2026-09-08): this was `60000`. The HF Hub API sorts
    // `inference_provider=all` results by trendingScore DESC (confirmed live —
    // the pagination cursor encodes `{$or:[{trendingScore:X,_id:{$gt:...}}, ...]}`),
    // so every discovery run starts at the SAME highest-trending model and walks
    // the SAME order every time. Once the live catalog grows past the cap, the
    // long tail below the cutoff is not merely delayed — it is NEVER reached by
    // ANY future run, because the walk always restarts from the top and stops at
    // the same count. A production audit confirmed this: of huggingface's 74,038
    // catalog rows, 59,620 had a `last_synced_at` timestamp (reached by the
    // current discovery path) and 14,025 had `last_synced_at IS NULL` — never
    // once touched by discovery since the row was created, accounting for 97% of
    // huggingface's 14,418 empty-`capability_uris` rows. 59,620 is within
    // rounding of the old 60,000 cap (the gap is `private` rows filtered out
    // client-side). `inference_provider=all` already bounds this to the
    // inference-routable subset (tens of thousands, not the full multi-million
    // Hub) — a page limit here is not needed for correctness, only as a runaway
    // safety valve, so the default is now a ceiling far above any realistic
    // near/mid-term catalog size rather than a routine truncation point.
    maxModels = Number(process.env.HF_HUB_DISCOVERY_MAX_MODELS || '500000'),
    pageSize = Number(process.env.HF_HUB_DISCOVERY_PAGE_SIZE || '1000'),
    requestTimeoutMs = Number(process.env.HF_HUB_DISCOVERY_TIMEOUT_MS || '15000')
  ) {
    super();
    this.token = token && token.length > 0 ? token : undefined;
    this.baseUrl = baseUrl;
    this.maxModels = maxModels;
    this.pageSize = pageSize;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    const start = Date.now();
    const out: ProviderModel[] = [];
    // expand[]=inferenceProviderMapping returns, per model, WHICH providers serve
    // it + their status (live/staging) + pricing + context + perf. This is HF's
    // own proof-of-operability: we mark serverless_callable from status:'live'
    // (prove-before-advertise) instead of assuming, and capture real pricing.
    //
    // CRITICAL (2026-06-29): the HF list API switches to a RESTRICTED projection
    // (id + only the expanded fields) as soon as ANY expand[] is present — so
    // downloads/likes/trendingScore came back `undefined` for ~95% of models
    // (measured: only 3,097/63,572 populated). These are the ONLY dynamic
    // legitimacy signal that lets the selector's cold-start prior tell a 2M-download
    // model from a 0-download fine-tune (no static model pin). They MUST be
    // expanded explicitly here, or the popularity prior has no data to rank on.
    //
    // FIXED (2026-09-08): the same restricted-projection rule silently dropped
    // `pipeline_tag`/`tags`/`library_name` too, because they were never in this
    // expand[] list. Confirmed live against huggingface.co/api/models: the exact
    // same rows return `pipeline_tag` when it is expanded and omit it when it is
    // not — this was our own query shape, not missing HF data. A production audit
    // found only 250/74,038 (0.34%) huggingface rows carried a `pipeline_tag` key
    // at all before this fix, which made the `mapCapabilities` pipeline_tag
    // fallback below (branch 2, used when a model has no LIVE inference provider —
    // confirmed to occur on live data) structurally unreachable in practice.
    let nextUrl: string | null =
      `${this.baseUrl}?inference_provider=all` +
      `&expand[]=inferenceProviderMapping&expand[]=downloads&expand[]=likes&expand[]=trendingScore` +
      `&expand[]=pipeline_tag&expand[]=tags&expand[]=library_name` +
      `&limit=${this.pageSize}`;
    let pages = 0;
    // Auto-re-enable bug (2026-09-09): a model this codebase auto-disabled only
    // self-heals back to 'active' when a discovery run's output actually
    // INCLUDES it (bulkUpsertModels/updateExistingModel already re-enable
    // unconditionally on every successful upsert — see central-model-discovery-
    // service.ts). Before this fix, a single transient page failure (a 5xx, a
    // 429 rate-limit, or this fetcher's own 15s-per-page AbortSignal.timeout
    // firing under slower network conditions than the ~18s a full, healthy walk
    // takes) silently `break`/`catch`-and-`return`'d whatever had been
    // collected SO FAR, logged at 'HF Hub discovery completed' — identical to
    // a genuinely exhaustive walk. Pagination always restarts at page 1 of the
    // SAME trendingScore-DESC order (see the `maxModels` comment above), so a
    // failure that reliably lands around the same page every run (a
    // consistently slower egress path, e.g. from the scheduled/worker process
    // vs. an ad-hoc admin-triggered run) permanently truncates the SAME
    // low-trending tail forever, every run, with no observable signal that
    // anything was wrong — that tail is exactly where an auto-disabled,
    // no-longer-trending model is likely to sit. Retrying a failed page a few
    // times absorbs a one-off blip instead of truncating the whole walk over
    // it, and — when a page genuinely never recovers — the run is now logged
    // as an honest partial failure instead of a clean 'completed', so this
    // stops being invisible.
    let truncatedEarly = false;

    try {
      while (nextUrl && out.length < this.maxModels) {
        const response = await this.fetchPageWithRetries(nextUrl, pages);
        if (!response) {
          truncatedEarly = true;
          break;
        }

        const page = (await response.json()) as HfHubModel[];
        if (!Array.isArray(page) || page.length === 0) break;

        for (const m of page) {
          if (out.length >= this.maxModels) break;
          if (m.private) continue;
          out.push(this.transform(m));
        }

        pages++;
        nextUrl = this.parseNextLink(response.headers.get('link'));
      }

      const capped = out.length >= this.maxModels;
      const summary = {
        models: out.length,
        pages,
        durationMs: Date.now() - start,
        capped,
        truncatedEarly,
      };
      // Landmine guard: `capped: true` here means the SAME truncation bug fixed
      // 2026-09-08 is recurring at the new (much higher) ceiling — the long tail
      // of the catalog below the cutoff will never be reached by any future run
      // (see the `maxModels` constructor comment). This must be loud, not info.
      if (capped) {
        this.log.warn(
          summary,
          'HF Hub discovery hit maxModels — the catalog now exceeds the safety ceiling, ' +
            'and everything below the cutoff will NEVER be reached by future runs ' +
            '(pagination always restarts at the top of the trending-sorted list); raise HF_HUB_DISCOVERY_MAX_MODELS'
        );
      } else if (truncatedEarly) {
        // Deliberately NOT logged as 'completed' — this run's `out` is a
        // PARTIAL snapshot (same low-trending tail excluded every time, see
        // the comment above `truncatedEarly`'s declaration), even though it
        // is still returned so the models that WERE reached still get
        // persisted rather than discarding real, successfully-fetched work.
        this.log.warn(
          summary,
          'HF Hub discovery pagination failed to reach the end of the catalog after retries — ' +
            'returning a PARTIAL result (models below this point were not reconfirmed this run)'
        );
      } else {
        this.log.info(summary, 'HF Hub discovery completed');
      }
      return out;
    } catch (error) {
      this.log.error({ error, pages, partial: out.length }, 'HF Hub discovery failed');
      return out;
    }
  }

  /**
   * Fetches one pagination page, retrying a transient failure (non-OK HTTP
   * status, network error, or the per-request AbortSignal.timeout firing)
   * before giving up on it. Returns `null` only once every attempt has been
   * exhausted — see the `truncatedEarly` comment in getModels() for why a
   * single un-retried failure here used to silently truncate the whole walk.
   */
  private async fetchPageWithRetries(
    url: string,
    pageIndex: number,
    maxAttempts = 3,
    backoffMs = 300
  ): Promise<Response | null> {
    let lastStatus: number | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        if (response.ok) return response;

        lastStatus = response.status;
        this.log.warn(
          { status: response.status, url, page: pageIndex, attempt, maxAttempts },
          attempt < maxAttempts
            ? 'HF Hub API non-OK response, retrying page'
            : 'HF Hub API non-OK response, giving up on this page after retries'
        );
      } catch (error) {
        lastError = error;
        this.log.warn(
          { error, url, page: pageIndex, attempt, maxAttempts },
          attempt < maxAttempts
            ? 'HF Hub API request failed, retrying page'
            : 'HF Hub API request failed, giving up on this page after retries'
        );
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }

    this.log.error(
      { url, page: pageIndex, maxAttempts, lastStatus, lastError },
      'HF Hub discovery: exhausted retries for one page — stopping pagination early'
    );
    return null;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'ailin-ci/discovery (huggingface-hub)',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  private transform(model: HfHubModel): ProviderModel {
    const capabilities = this.mapCapabilities(model);

    // Derive operability + pricing + context from HF's inferenceProviderMapping.
    // status:'live' providers prove the model is callable NOW via the HF router
    // (`<id>:<provider>`). No live provider ⇒ not serverless_callable, so it stays
    // out of the hot path (prove-before-advertise — no static assumption).
    const mapping = Array.isArray(model.inferenceProviderMapping)
      ? model.inferenceProviderMapping
      : [];
    const liveProviders = mapping.filter((p) => p.status === 'live');
    const serverlessCallable = liveProviders.length > 0;
    // Best live provider = lowest input price (cost-aware), else first.
    const bestProvider = liveProviders
      .slice()
      .sort(
        (a, b) =>
          (a.providerDetails?.pricing?.input ?? Number.POSITIVE_INFINITY) -
          (b.providerDetails?.pricing?.input ?? Number.POSITIVE_INFINITY)
      )[0];
    // Context window MUST come from the SAME provider record as the advertised
    // price. Fixed 2026-09 audit: this used to be `Math.max()` over EVERY live
    // provider's context_length, independent of which one `bestProvider` was —
    // so a model with e.g. novita (cheap, 12k context) and together (pricier,
    // 131k context) advertised together's 131k window at novita's price, a
    // combination no single real provider actually offers. Confirmed live
    // against huggingface.co/api/models on meta-llama/Llama-3.3-70B-Instruct
    // (novita $0.135/$0.40 @ 12,288 vs. together $1.04/$1.04 @ 131,072): the
    // old code emitted $0.135/$0.40 @ 131,072 — a context window over 10x what
    // the quoted price actually buys. `bestProvider` may still lack a reported
    // context_length (some live entries carry pricing but no providerDetails
    // field for it); 0 there is honest "unknown" under this fetcher's own
    // convention, not a borrowed number from an unrelated provider.
    const contextLength = bestProvider?.providerDetails?.context_length ?? 0;
    const inputPrice = bestProvider?.providerDetails?.pricing?.input;
    const outputPrice = bestProvider?.providerDetails?.pricing?.output;
    const hasPricing = typeof inputPrice === 'number' || typeof outputPrice === 'number';

    const metadata: Record<string, unknown> = {
      pipeline_tag: model.pipeline_tag,
      library_name: model.library_name,
      tags: model.tags,
      downloads: model.downloads,
      likes: model.likes,
      trendingScore: model.trendingScore,
      createdAt: model.createdAt,
      // HF integration / Camada 4: proven operability from HF's own live status,
      // the served-provider list (for `<id>:<provider>` routing), and real pricing.
      serverless_callable: serverlessCallable,
      inferenceProviders: liveProviders.map((p) => ({
        provider: p.provider,
        providerId: p.providerId,
        status: p.status,
        task: p.task,
        tokensPerSecond: p.performance?.tokensPerSecond,
      })),
      pricingSource: hasPricing ? 'hf_inference_providers' : 'unknown',
      priceConfidence: hasPricing ? 'high' : 'low',
      hubInventoryClass: 'aggregated_index',
    };

    return {
      id: model.id,
      name: model.id,
      displayName: model.id,
      contextWindow: contextLength,
      maxOutputTokens: 0,
      capabilities,
      pricing: {
        inputCostPer1M: typeof inputPrice === 'number' ? inputPrice : 0,
        outputCostPer1M: typeof outputPrice === 'number' ? outputPrice : 0,
        currency: 'USD',
      },
      metadata,
    };
  }

  private mapCapabilities(model: HfHubModel): ModelCapability[] {
    // 1. Prefer the LIVE inference provider's `task` — what is ACTUALLY being served
    //    right now. Critical because, before the 2026-09-08 expand[] fix above,
    //    ~60k/62k HF rows had NO pipeline_tag (and no tags) in the list response
    //    even though HF has that data for them — our own query never asked for
    //    it — so the provider mapping's `task` was the only reliable signal
    //    (conversational, text-to-image, automatic-speech-recognition, …).
    //    The old `return ['chat']` default mislabeled all ~60k of them as chat.
    const mapping = Array.isArray(model.inferenceProviderMapping)
      ? model.inferenceProviderMapping
      : [];
    const caps = new Set<ModelCapability>();
    for (const p of mapping) {
      if (p.status !== 'live' || !p.task) continue;
      for (const c of PIPELINE_TAG_TO_CAPABILITIES[p.task] ?? []) caps.add(c);
    }

    // 1b. Recover `vision` for VLMs collapsed under `task: 'conversational'`
    //     (see VISION_PIPELINE_TAGS doc comment above). Without this, a VLM
    //     whose live provider(s) all report `conversational` returns early
    //     from this branch with only `chat` — the pipeline_tag fallback in
    //     branch 2 below is never reached, because it only runs when branch 1
    //     produced NOTHING. This is not a rare edge case: it is HF's
    //     documented default behavior for the entire image-text-to-text
    //     model family once at least one provider actually serves it.
    if (caps.has('chat') && !caps.has('vision') && VISION_PIPELINE_TAGS.has(model.pipeline_tag ?? '')) {
      caps.add('vision');
    }

    // 1c. Tool-calling / structured-output support the HF Hub API reports
    //     per live provider (`features.toolCalling`/`features.structuredOutput`
    //     — see the `HfInferenceProviderMapping.features` doc comment above)
    //     is a real, HF-attested signal on the SAME response this loop
    //     already reads. Only applied to already-chat-capable models (tool
    //     calling / structured output are chat-completion features; gating
    //     on `chat` avoids attaching them to an unrelated task family).
    if (caps.has('chat')) {
      for (const p of mapping) {
        if (p.status !== 'live') continue;
        if (p.features?.toolCalling) {
          caps.add('function_calling');
          caps.add('tool_use');
        }
        if (p.features?.structuredOutput) caps.add('json_mode');
      }
    }

    if (caps.size > 0) return [...caps];

    // 2. Fall back to the model's own pipeline_tag when present.
    const tag = model.pipeline_tag;
    if (tag && PIPELINE_TAG_TO_CAPABILITIES[tag]) {
      return PIPELINE_TAG_TO_CAPABILITIES[tag];
    }

    // 3. Genuinely unknown task — do NOT assume chat. Empty so the row only ever
    //    joins the pool whose capability is actually known/served.
    return [];
  }
}
