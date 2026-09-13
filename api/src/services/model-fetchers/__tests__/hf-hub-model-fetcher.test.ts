// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HuggingFace Hub fetcher — zero-capability backlog root-cause regression
 * (2026-09-08).
 *
 * WHY THIS EXISTS
 * ────────────────
 * A production audit found 14,418 huggingface catalog rows (of 74,038) with a
 * completely empty `capability_uris` array — 64% of the platform-wide
 * zero-capability backlog. Direct read-only SQL against production narrowed
 * this to two independent, and very differently sized, causes:
 *
 * 1. THE BIG ONE (14,025 rows, 97% of huggingface's gap): `last_synced_at` is
 *    NULL for these rows — discovery has NEVER ONCE reached them since they
 *    were created. Root cause: the HF Hub `inference_provider=all` endpoint
 *    sorts results by `trendingScore` DESC (confirmed live — the pagination
 *    cursor literally encodes `{$or:[{trendingScore:X,_id:{$gt:...}}, ...]}`),
 *    so every discovery run starts at the SAME highest-trending model and
 *    walks the SAME order. The fetcher's `maxModels` cap defaulted to 60,000;
 *    once the live catalog grew past that (confirmed: 59,620 huggingface rows
 *    DO have `last_synced_at`, within rounding of the old cap once `private`
 *    rows are excluded), the long tail below the cutoff was not delayed, it
 *    was permanently unreachable — every run restarts at the top and stops at
 *    the same count. This is fixed by raising the default far above any
 *    realistic near/mid-term catalog size (see the `maxModels` tests below);
 *    it is a safety valve now, not a routine truncation point.
 *
 * 2. THE SMALL ONE (530 rows, 3.7% of huggingface's gap): these have a
 *    genuinely empty `capabilities` column too (not just `capability_uris`).
 *    ALL 530 had a LIVE inference-provider `task` value this fetcher's
 *    `PIPELINE_TAG_TO_CAPABILITIES` map did not cover: text-classification
 *    (351), token-classification (116), zero-shot-classification (41),
 *    image-text-to-video (23), image-text-to-image (3),
 *    table-question-answering (2), audio-to-audio (1) — all real,
 *    currently-served HF pipeline tags. Separately, only 250/74,038 (0.34%)
 *    rows carried a `pipeline_tag` key in metadata AT ALL, because the
 *    fetcher's own HTTP request never put `pipeline_tag`/`tags`/`library_name`
 *    in `expand[]` — the HF list API silently omits any field not explicitly
 *    expanded once ANY expand[] is present (confirmed live: the exact same
 *    models return `pipeline_tag` when expanded and omit it when not — it was
 *    our query, not missing HF data). This made the `mapCapabilities`
 *    pipeline_tag fallback (branch 2, used when a model has no LIVE
 *    provider — confirmed to occur on live data) structurally dead.
 *
 * The remaining ~13,888 huggingface rows (non-empty `capabilities`, empty
 * `capability_uris`) are a downstream capability-assertions/materialiser gap,
 * NOT a discovery/fetcher defect — out of scope here by design (a separate
 * in-flight task owns the materialiser).
 *
 * These tests fail on the pre-fix map/query/cap and pass on the fix.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HfHubModelFetcher } from '@/services/model-fetchers/hf-hub-model-fetcher';

function jsonResponse(payload: unknown, status = 200, linkHeader?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (linkHeader) headers.link = linkHeader;
  return new Response(JSON.stringify(payload), { status, headers });
}

function liveProvider(task: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: 'hf-inference',
    providerId: 'test/provider-id',
    status: 'live',
    task,
    ...overrides,
  };
}

describe('hf-hub-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests pipeline_tag, tags and library_name via expand[] (regression: these were silently omitted)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));

    await new HfHubModelFetcher().getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    const requestUrl = String(url);
    // The HF list API only returns a field if it appears in expand[] once ANY
    // expand[] param is present — omitting these silently drops the data.
    expect(requestUrl).toContain('expand[]=pipeline_tag');
    expect(requestUrl).toContain('expand[]=tags');
    expect(requestUrl).toContain('expand[]=library_name');
    // The pre-existing expand[] params must still be present (no regression).
    expect(requestUrl).toContain('expand[]=inferenceProviderMapping');
    expect(requestUrl).toContain('expand[]=downloads');
    expect(requestUrl).toContain('expand[]=likes');
    expect(requestUrl).toContain('expand[]=trendingScore');
  });

  describe('previously-uncovered live pipeline tags (real production zero-capability rows)', () => {
    const cases: Array<{
      id: string;
      task: string;
      expectIncludes: string[];
    }> = [
      // Real production ids sampled from the 530 zero-capability huggingface
      // rows via direct SQL, with their real live-provider task.
      {
        id: 'seara/rubert-base-cased-russian-emotion-detection-ru-go-emotions',
        task: 'text-classification',
        expectIncludes: ['analysis'],
      },
      {
        id: 'cmarkea/distilcamembert-base-ner',
        task: 'token-classification',
        expectIncludes: ['analysis'],
      },
      {
        id: 'cmarkea/distilcamembert-base-nli',
        task: 'zero-shot-classification',
        expectIncludes: ['analysis'],
      },
      { id: 'test/table-qa-model', task: 'table-question-answering', expectIncludes: ['qa'] },
      {
        id: 'PixelSmile/PixelSmile',
        task: 'image-text-to-image',
        expectIncludes: ['image_generation', 'image_editing'],
      },
      {
        id: 'test/image-text-to-video-model',
        task: 'image-text-to-video',
        expectIncludes: ['video_generation'],
      },
      { id: 'test/audio-to-audio-model', task: 'audio-to-audio', expectIncludes: ['audio_to_audio'] },
      {
        id: 'stabilityai/stable-audio-3-medium',
        task: 'text-to-audio',
        expectIncludes: ['audio_generation'],
      },
    ];

    for (const { id, task, expectIncludes } of cases) {
      it(`maps live task "${task}" (${id}) to a non-empty capability set instead of []`, async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          jsonResponse([{ _id: id, id, inferenceProviderMapping: [liveProvider(task)] }])
        );

        const models = await new HfHubModelFetcher().getModels();

        expect(models).toHaveLength(1);
        // This is the exact regression: before the fix, unmapped tasks fell
        // through every branch and produced capabilities: [].
        expect(models[0].capabilities.length).toBeGreaterThan(0);
        for (const cap of expectIncludes) {
          expect(models[0].capabilities).toContain(cap);
        }
      });
    }
  });

  it('falls back to pipeline_tag (now reliably populated) when no provider is live', async () => {
    // Simulates the "all staging/error" case confirmed to occur on live HF
    // data — the live-provider-task path (branch 1) yields nothing, so
    // mapCapabilities must fall back to model.pipeline_tag (branch 2). This
    // branch was structurally unreachable before the expand[] fix because
    // pipeline_tag was always undefined on the wire (0.34% populated in prod).
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        {
          _id: 'a',
          id: 'staging-only/zero-shot-model',
          pipeline_tag: 'zero-shot-classification',
          inferenceProviderMapping: [
            { provider: 'p1', providerId: 'x', status: 'staging', task: 'zero-shot-classification' },
          ],
        },
      ])
    );

    const models = await new HfHubModelFetcher().getModels();

    expect(models).toHaveLength(1);
    expect(models[0].capabilities).toEqual(['analysis']);
  });

  it('still returns an empty capability list (not a fabricated default) when there is genuinely no signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([{ _id: 'a', id: 'no-signal/model', inferenceProviderMapping: [] }])
    );

    const models = await new HfHubModelFetcher().getModels();

    expect(models).toHaveLength(1);
    expect(models[0].capabilities).toEqual([]);
  });

  it('still maps a well-covered pre-existing pipeline tag correctly (no regression)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        { _id: 'a', id: 'org/chat-model', inferenceProviderMapping: [liveProvider('conversational')] },
      ])
    );

    const models = await new HfHubModelFetcher().getModels();

    expect(models).toHaveLength(1);
    expect(models[0].capabilities).toEqual(['chat']);
  });

  it('carries pipeline_tag/tags/library_name through into metadata once present on the wire', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        {
          _id: 'a',
          id: 'org/model',
          pipeline_tag: 'text-classification',
          tags: ['transformers', 'text-classification'],
          library_name: 'transformers',
          inferenceProviderMapping: [liveProvider('text-classification')],
        },
      ])
    );

    const models = await new HfHubModelFetcher().getModels();

    expect(models[0].metadata?.pipeline_tag).toBe('text-classification');
    expect(models[0].metadata?.tags).toEqual(['transformers', 'text-classification']);
    expect(models[0].metadata?.library_name).toBe('transformers');
  });

  describe('context window / price must describe the SAME provider (2026-09 audit)', () => {
    // Root cause: `contextLength` was computed as Math.max() over EVERY live
    // provider's context_length, while price came from `bestProvider` (lowest
    // input price) — two independent selections over the same list, with no
    // guarantee they land on the same provider. Confirmed live against
    // huggingface.co/api/models on meta-llama/Llama-3.3-70B-Instruct: novita
    // ($0.135/$0.40, 12,288 context) was the cheapest live provider, while
    // together ($1.04/$1.04, 131,072 context) merely had the largest context
    // among live providers. The pre-fix code advertised novita's price at
    // together's context — $0.135/$0.40 @ 131,072 — a combination no real
    // provider actually offers (over 10x the context the quoted price buys).
    it('reports the cheapest live provider\'s own context_length, not the max across all live providers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'meta-llama/Llama-3.3-70B-Instruct',
            inferenceProviderMapping: [
              liveProvider('conversational', {
                provider: 'novita',
                providerDetails: { context_length: 12288, pricing: { input: 0.135, output: 0.4 } },
              }),
              liveProvider('conversational', {
                provider: 'together',
                providerDetails: { context_length: 131072, pricing: { input: 1.04, output: 1.04 } },
              }),
            ],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models).toHaveLength(1);
      // Price still picks the cheapest live provider (novita) — unchanged.
      expect(models[0].pricing.inputCostPer1M).toBe(0.135);
      expect(models[0].pricing.outputCostPer1M).toBe(0.4);
      // Context must be THAT SAME provider's context, not together's larger one.
      expect(models[0].contextWindow).toBe(12288);
    });

    it('reports context 0 (unknown) rather than borrowing a pricier provider\'s context_length when the cheapest provider does not report one', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'org/model',
            inferenceProviderMapping: [
              // Cheapest live provider — no providerDetails at all (some real
              // HF entries, e.g. featherless-ai, omit it entirely).
              liveProvider('conversational', { provider: 'featherless-ai' }),
              liveProvider('conversational', {
                provider: 'together',
                providerDetails: { context_length: 131072, pricing: { input: 5, output: 5 } },
              }),
            ],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models).toHaveLength(1);
      // featherless-ai has no price at all, so it sorts first only when no
      // other provider has a lower (i.e. any) price — together is the only
      // one with a real price, so it becomes bestProvider here.
      expect(models[0].pricing.inputCostPer1M).toBe(5);
      expect(models[0].contextWindow).toBe(131072);
    });

    it('still selects the lowest-price live provider as bestProvider when every provider reports a real price', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'org/model',
            inferenceProviderMapping: [
              liveProvider('conversational', {
                provider: 'expensive',
                providerDetails: { context_length: 8192, pricing: { input: 9, output: 9 } },
              }),
              liveProvider('conversational', {
                provider: 'cheap',
                providerDetails: { context_length: 4096, pricing: { input: 0.1, output: 0.2 } },
              }),
            ],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].pricing.inputCostPer1M).toBe(0.1);
      expect(models[0].pricing.outputCostPer1M).toBe(0.2);
      expect(models[0].contextWindow).toBe(4096);
    });
  });

  describe('maxModels ceiling (the 97%-of-the-gap landmine)', () => {
    it('the default ceiling no longer truncates at the old 60,000 cap', async () => {
      // Reproduces the production shape at a scale vitest can run quickly:
      // three pages whose combined total (61,000) is already past the OLD
      // default (60,000). The old default would have silently dropped the
      // last page (the "long tail" that, in production, only ever gets
      // reached at the very end of a trending-sorted walk and therefore never
      // gets revisited once the catalog outgrows the cap). We do not assert
      // the new number (500,000) directly — that would make the test a
      // change-detector — we assert the OLD landmine (60,000) does not
      // reproduce, which is the actual regression this closes.
      const PAGE_SIZE = 20500;
      const makePage = (offset: number) =>
        Array.from({ length: PAGE_SIZE }, (_, i) => ({
          _id: `id-${offset + i}`,
          id: `org/model-${offset + i}`,
          inferenceProviderMapping: [liveProvider('conversational')],
        }));

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(makePage(0), 200, '<https://huggingface.co/api/models?cursor=p2>; rel="next"')
      );
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(makePage(PAGE_SIZE), 200, '<https://huggingface.co/api/models?cursor=p3>; rel="next"')
      );
      fetchSpy.mockResolvedValueOnce(jsonResponse(makePage(PAGE_SIZE * 2)));

      const models = await new HfHubModelFetcher().getModels();

      expect(models.length).toBe(PAGE_SIZE * 3);
      expect(models.length).toBeGreaterThan(60000);
    });

    it('an explicit maxModels override is still honored (the safety valve stays configurable)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          Array.from({ length: 10 }, (_, i) => ({ _id: `id-${i}`, id: `org/model-${i}` })),
          200,
          '<https://huggingface.co/api/models?cursor=p2>; rel="next"'
        )
      );

      const fetcher = new HfHubModelFetcher(undefined, 'https://huggingface.co/api/models', 5, 10);
      const models = await fetcher.getModels();

      // Caps mid-page at the explicit override, and does not follow the next
      // link past it.
      expect(models).toHaveLength(5);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // Scale-target headroom guard (2026-09-09): the REAL production default
    // (no constructor override, no HF_HUB_DISCOVERY_MAX_MODELS env var) must
    // still accommodate at least 150,000 models — the platform's near/mid-term
    // catalog target. Fails immediately if a future change ever lowers the
    // default back toward (or below) that floor.
    it('the real default (no override) does not truncate at 150,000 models (scale-target headroom)', async () => {
      const COUNT = 150001;
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse(Array.from({ length: COUNT }, (_, i) => ({ _id: `id-${i}`, id: `org/model-${i}` })))
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models.length).toBe(COUNT);
      expect(models.length).toBeGreaterThan(150000);
    });
  });

  describe('auto-re-enable bug (2026-09-09): pagination must not silently truncate on a transient page failure', () => {
    // Root cause: bulkUpsertModels/updateExistingModel (central-model-discovery-
    // service.ts) already re-enable a disabled model UNCONDITIONALLY on every
    // successful upsert — that part was already correct. But a model can only
    // be re-enabled if it actually appears in a discovery run's output. Before
    // this fix, ANY single-page HTTP failure (a 5xx, a rate-limit, this
    // fetcher's own request timeout) silently stopped pagination and returned
    // whatever had been collected so far as though it were a complete,
    // healthy run — logged at 'HF Hub discovery completed', identical to a
    // genuinely exhaustive walk. Since pagination always restarts at page 1 of
    // the SAME trendingScore-DESC order, a failure that recurs around the same
    // page every run permanently starves the same low-trending tail — exactly
    // where an auto-disabled, no-longer-trending model is likely to sit.
    it('retries a failed page and still returns its models once the retry succeeds', async () => {
      const page1 = [{ _id: 'a', id: 'org/model-a', inferenceProviderMapping: [liveProvider('conversational')] }];
      const page2 = [{ _id: 'b', id: 'org/model-b', inferenceProviderMapping: [liveProvider('conversational')] }];

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(page1, 200, '<https://huggingface.co/api/models?cursor=p2>; rel="next"')
      );
      // Page 2's first attempt fails transiently (e.g. a momentary 503)...
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'upstream hiccup' }, 503));
      // ...but the retry succeeds.
      fetchSpy.mockResolvedValueOnce(jsonResponse(page2));

      const models = await new HfHubModelFetcher().getModels();

      expect(models.map((m) => m.id)).toEqual(['org/model-a', 'org/model-b']);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('does NOT drop the whole run after a single transient failure — it retries before giving up', async () => {
      // A network-level rejection (not just a non-OK response) must also be
      // retried, not treated as terminal on the first attempt.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([{ _id: 'a', id: 'org/model-a', inferenceProviderMapping: [liveProvider('conversational')] }])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns the partial result AND logs it as an honest partial failure (not "completed") once a page exhausts its retries', async () => {
      const page1 = [{ _id: 'a', id: 'org/model-a', inferenceProviderMapping: [liveProvider('conversational')] }];

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(page1, 200, '<https://huggingface.co/api/models?cursor=p2>; rel="next"')
      );
      // Page 2 fails on every attempt — retries are exhausted.
      fetchSpy.mockResolvedValue(jsonResponse({ error: 'still down' }, 500));

      const fetcher = new HfHubModelFetcher();
      const logWarnSpy = vi.spyOn(
        (fetcher as unknown as { log: { warn: (...args: unknown[]) => void } }).log,
        'warn'
      );

      const models = await fetcher.getModels();

      // Page 1's model is real, successfully-fetched work — it must still be
      // persisted rather than thrown away just because a LATER page failed.
      expect(models.map((m) => m.id)).toEqual(['org/model-a']);

      // The run must be logged as an honest partial failure, not silently
      // reported as a clean completion (the exact silent-truncation bug).
      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ truncatedEarly: true }),
        expect.stringContaining('PARTIAL')
      );
    }, 10000);
  });

  describe('doc-alignment audit fixes (2026-09-09)', () => {
    it('recovers `vision` for a VLM collapsed under live task "conversational" (register-as-a-provider.md: conversational covers text-generation AND image-text-to-text)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'Qwen/Qwen3.8-27B-VL',
            pipeline_tag: 'image-text-to-text',
            inferenceProviderMapping: [liveProvider('conversational')],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models).toHaveLength(1);
      expect(models[0].capabilities).toContain('chat');
      expect(models[0].capabilities).toContain('vision');
    });

    it('does NOT add `vision` to a plain conversational model with no image-text-to-text pipeline_tag (no regression)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'org/text-only-chat-model',
            pipeline_tag: 'text-generation',
            inferenceProviderMapping: [liveProvider('conversational')],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].capabilities).toEqual(['chat']);
    });

    it('surfaces HF-attested tool-calling/structured-output `features` as real capabilities (hub-api.md: supports_tools/supports_structured_output)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'org/tool-model',
            inferenceProviderMapping: [
              liveProvider('conversational', { features: { toolCalling: true, structuredOutput: true } }),
            ],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].capabilities).toEqual(
        expect.arrayContaining(['chat', 'function_calling', 'tool_use', 'json_mode'])
      );
    });

    it('does not fabricate function_calling from `features` when the provider is not live', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'org/staging-tool-model',
            inferenceProviderMapping: [
              {
                provider: 'p1',
                providerId: 'x',
                status: 'staging',
                task: 'conversational',
                features: { toolCalling: true },
              },
            ],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].capabilities).toEqual([]);
    });

    it.each([
      ['question-answering', 'deepset/roberta-base-squad2'],
      ['summarization', 'facebook/bart-large-cnn'],
      ['audio-classification', 'test/audio-classifier'],
      ['image-classification', 'google/vit-base-patch16-224'],
      ['object-detection', 'facebook/detr-resnet-50'],
      ['image-segmentation', 'facebook/mask2former-swin-large-coco-panoptic'],
    ])(
      'no longer fabricates a capability for "%s" (%s) — HF\'s own contract for this task is incompatible with every execution path this codebase has for the capability it used to claim',
      async (task, id) => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          jsonResponse([{ _id: id, id, inferenceProviderMapping: [liveProvider(task)] }])
        );

        const models = await new HfHubModelFetcher().getModels();

        expect(models[0].capabilities).toEqual([]);
      }
    );

    it('maps "translation" to the dedicated `translation` capability instead of fabricating `chat` (NLLB/opus-mt/T5 seq2seq models cannot serve chat completions)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'facebook/nllb-200-distilled-600M',
            inferenceProviderMapping: [liveProvider('translation')],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].capabilities).toEqual(['translation']);
    });

    it('maps "image-to-image" to `image_editing` instead of `image_generation` (doc example models — Qwen-Image-Edit, FLUX.1-Kontext-dev — require an existing input image)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse([
          {
            _id: 'a',
            id: 'Qwen/Qwen-Image-Edit',
            inferenceProviderMapping: [liveProvider('image-to-image')],
          },
        ])
      );

      const models = await new HfHubModelFetcher().getModels();

      expect(models[0].capabilities).toEqual(['image_editing']);
    });
  });
});
