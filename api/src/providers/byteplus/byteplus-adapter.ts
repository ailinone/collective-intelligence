// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BytePlus ModelArk Adapter — the full multimodal data-plane surface.
 *
 * ModelArk is ByteDance's *international* (non-China) inference platform.
 * It is a SEPARATE deployment from Volcengine Ark (`volcano` in this
 * catalog): different host, different TLD, different control plane,
 * different model catalog, and provably non-interchangeable credentials
 * ("a ModelArk API Key is not resolvable from the Volcengine entry and
 * authentication fails outright — and the reverse is equally true").
 * Hence a fully independent adapter, and `volcano` is left untouched.
 *
 * ### Connection facts that bite (all live-verified 2026-08-02)
 *
 *  - Base URL is `https://ark.ap-southeast.bytepluses.com/api/v3`.
 *    Three separate traps in that one string:
 *      · version prefix is `/api/v3`, NOT `/v1`;
 *      · TLD is `bytepluses.com` — PLURAL (docs/console are `byteplus.com`);
 *      · region token is `ap-southeast` with NO `-1` (the AK/SK control
 *        plane, a different host entirely, is the one that says
 *        `ap-southeast-1.byteplusapi.com`).
 *  - Auth is `Authorization: Bearer <key>`. Verified: a request with no
 *    Authorization header and a request with a malformed key both return
 *    HTTP 401 with distinct messages ("...is missing or invalid" vs
 *    "The API key format is incorrect"), while the real key returns 200.
 *  - `GET /ping` lives at the HOST ROOT, not under `/api/v3`, and IS
 *    auth-gated. Live: 200 `{"message":"pong"}`.
 *
 * ### The 200-empty-body trap (why the capability matrix below is trustworthy)
 *
 * ModelArk's gateway does NOT 404 an unknown route. It answers **HTTP 200
 * with a zero-length body**. Verified with a deliberately bogus path
 * (`POST /api/v3/definitely-not-a-route` → 200, len 0). So "route absent"
 * and "route present" are distinguished by whether a JSON envelope comes
 * back at all, NOT by status code. Every NOT-SUPPORTED verdict below was
 * established against that baseline rather than assumed from the docs.
 *
 *   Route present (returned a real JSON envelope):
 *     /models · /ping · /chat/completions · /responses · /images/generations
 *     /contents/generations/tasks (POST+GET+list) · /embeddings
 *     /embeddings/multimodal · /tokenization · /files
 *     /batch/chat/completions · /context/create · /bots/chat/completions
 *
 *   Route ABSENT (200 + empty body, same as the bogus-path control):
 *     /images/edits · /audio/transcriptions · /audio/speech · /moderations
 *     /rerank · /bot/chat/completions (singular) · /models/{id}
 *
 * ### Account state at time of writing — READ THIS BEFORE DEBUGGING
 *
 * The provisioned key authenticates correctly, but account 3003814011 has
 * **zero models activated**. Every model-invoking endpoint returns
 * HTTP 404 `{"error":{"code":"ModelNotOpen","message":"Your account
 * 3003814011 has not activated the model <id>. Please activate the model
 * service in the Ark Console."}}` — for all 20 chat models tried, plus
 * image, video, embeddings, responses and batch.
 *
 * That is an OPERATOR CONSOLE ACTION, not an integration defect. The
 * contrast proving it: a genuinely unknown model id returns a DIFFERENT
 * error (`InvalidEndpointOrModel.NotFound`, "does not exist or you do not
 * have access to it"), so `ModelNotOpen` means the platform resolved the
 * model, matched it to this account, and refused on entitlement alone.
 * `classifyArkError` surfaces this as an actionable message instead of a
 * generic model-not-found.
 *
 * ### Deviations from the pre-implementation research spec
 *
 *  1. **`GET /api/v3/models` EXISTS.** The spec concluded discovery was
 *     impossible without AK/SK request signing and that `getModels()` must
 *     return `[]` with a pinned catalog. Live probe disproves that: the
 *     route returns 200 with 52 models and RICHER metadata than OpenAI's
 *     (`domain`, `task_type[]`, `modalities.{input,output}_modalities`,
 *     `token_limits`, `features.{tools,structured_outputs,batch,cache}`,
 *     `status`). So this adapter does real dynamic discovery, the catalog
 *     row is `discovery+execution`, and there is no `pinnedFallback`.
 *  2. **A plain `POST /api/v3/embeddings` exists** (spec marked UNCERTAIN).
 *     It routes — but its RESPONSE contract is unverifiable while every
 *     model is gated, so `generateEmbeddings` deliberately targets
 *     `/embeddings/multimodal`, whose response shape IS documented. See
 *     that method for the reasoning.
 *  3. **Bot-chat path conflict resolved**: PLURAL `/bots/chat/completions`
 *     is the real route (400 InvalidParameter = reached); singular
 *     `/bot/chat/completions` is the 200-empty absent-route signal.
 *     Recorded for completeness — bots are out of ci's contract.
 *
 * ### Capabilities NOT implemented, and why (no silent drops)
 *
 *  - **textToSpeech** — ModelArk has no speech-synthesis endpoint at all
 *    (`/audio/speech` is an absent route). Seedance's `generate_audio`
 *    produces an audio track *inside a generated video*; it is not TTS and
 *    cannot be driven from `AudioTTSRequest`. Overridden to throw with that
 *    explanation rather than inherit the generic base message.
 *  - **imageVariation** — no variation endpoint and no prompt-free
 *    image-to-image mode. Synthesizing a "make a variation" prompt would be
 *    inventing an API contract, so this throws.
 *  - **moderate** — no `/moderations` route. ModelArk's moderation is
 *    output-side metadata only (`choices[].moderation_hit_type` ∈
 *    {severe_violation, violence} plus `finish_reason: 'content_filter'`),
 *    gated on an out-of-band console setting, and returned only by
 *    visual-understanding models. ci's `ModerationResponse.categories` is a
 *    closed 11-key record; that 2-value taxonomy cannot fill it without
 *    fabricating classifications. Throws. The signal IS still surfaced —
 *    `chatCompletion` preserves `finish_reason: 'content_filter'` and puts
 *    `moderation_hit_type` in the choice, so a refusal is never mistaken
 *    for a real answer.
 *  - **webSearch** — no request-level web-search parameter was recovered
 *    for either chat API. Left as the base-class throw rather than
 *    emulating search through chat and calling it provider-grounded.
 *  - **checkBalance** — no balance endpoint on the data plane (usage
 *    metering lives on the AK/SK control plane and reports token counts,
 *    not credits). Base default `null` = "unable to check" is correct.
 *
 * ### Capabilities ModelArk HAS that ci's ProviderAdapter cannot express
 *
 * These are real, routable, and deliberately NOT smuggled through an
 * unrelated method. Where no base-contract slot exists, the precedent set
 * by {@link countTokens} is followed: a plain public method, named for what
 * it is, rather than a guessed mapping onto an unrelated contract method.
 *   · **rerank** — genuinely absent from ModelArk (the Rerank API belongs
 *     to the separate Knowledge-Base/RAG product on another host with
 *     AK/SK signing), so there is nothing to express.
 *   · **tokenization** (`POST /tokenization`) — works TODAY, unauthenticated
 *     by model entitlement (returns real `token_ids` + `offset_mapping`
 *     even for non-activated models). No `ProviderAdapter` method maps to
 *     it, so it is exposed as {@link countTokens} for direct callers. NB:
 *     `healthCheck` does NOT call it — the health probe is `GET /ping` and
 *     nothing else (an earlier revision of this comment claimed otherwise).
 *   · **batch chat** (`POST /batch/chat/completions`) — same Bearer auth,
 *     byte-identical request/response contract to `/chat/completions`, only
 *     the `model` must be a batch endpoint id `ep-bi-…`. Exposed as
 *     {@link batchChatCompletion}.
 *   · **file upload** (`POST /files`, multipart) — the prerequisite for any
 *     media above the 64 MB body limit and for the `file_id` form of every
 *     document/video/audio content part. Exposed as {@link uploadFile}.
 *   · **3D generation** — runs on the SAME `/contents/generations/tasks`
 *     route as video; the modality is selected by `model` alone, and the
 *     result arrives at `content.file_url` instead of `content.video_url`.
 *     Exposed as {@link generateAsset3D}.
 *   · **context caching / managed agents / bots / structured-output-as-a-
 *     typed-surface** — no base method exists and no ci caller needs them
 *     today. Documented here and in the catalog row's notes; not
 *     implemented against a guessed contract.
 *   · **remote MCP tools** — SUPPORTED upstream but **Responses-API only**
 *     (`POST /responses` + header `ark-beta-mcp: true` +
 *     `tools:[{type:'mcp',server_label,server_url,require_approval,…}]`,
 *     with a documented two-round approval handshake). This adapter is
 *     Chat-API-only: `/chat/completions` has no `mcp` tool type, so there
 *     is no way to reach it from here. NOT implemented, and deliberately
 *     NOT declared — ci's `ModelCapability` union does contain `'mcp'`, and
 *     emitting it off a route this adapter never calls would be a false
 *     claim. Implementing it means implementing `/responses` first.
 *   · **streaming image generation** (`stream: true` on
 *     `/images/generations`, doc 1824137 — SSE with typed
 *     `image_generation.partial_succeeded` / `partial_failed` / `completed`
 *     events and NO `[DONE]` sentinel, on 5-0-lite / 4-5 / 4-0) — ci has no
 *     streaming-image method to map it onto, so it is not implemented.
 *     Recorded here so it is a known gap rather than an omission.
 *   · **document (PDF) understanding** and **video understanding** — these
 *     ARE reachable. `mapMessage` forwards unknown-but-typed content parts
 *     verbatim, so a caller willing to cast can send
 *     `{type:'video_url',video_url:{url,fps}}` today. PDF needed more than
 *     pass-through and got it: ci's `PDFService` ships a PDF as an
 *     `image_url` part carrying a `data:application/pdf` URI, which
 *     ModelArk's `image_url` rejects (jpeg/png/webp/… only), so
 *     {@link mapMessage} TRANSLATES that part into ModelArk's
 *     `{type:'file',file:{file_data,filename}}` shape and `toCiModel` emits
 *     the `pdf_understanding` capability that `/v1/pdf/analyze` selects on.
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  ModelCapability,
  Provider,
} from '@/types';
import { narrowAs } from '@/utils/type-guards';
import type {
  AudioSTTRequest,
  AudioSTTResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
  VideoGenRequest,
  VideoGenResponse,
  VisionRequest,
  VisionResponse,
} from '@/types/model-client';

export const BYTEPLUS_DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';

/**
 * `tools[].type` and `tool_choice.type` are DIFFERENT fields with different
 * evidence, so they are two constants rather than one shared value. Coupling
 * them meant a defensible guess on the ambiguous field silently overrode the
 * one field the vendor documents unambiguously.
 *
 * **`tools[].type` → `"function"`.** The vendor doc CONTRADICTS ITSELF here:
 * the field table on doc 1494384 says `tools.type` … "set it to
 * `function_call`", but the deep-reasoning tool-calling guide (doc 1449737)
 * prints a complete, copy-pasteable `curl` against
 * `/api/v3/chat/completions` whose `tools[]` entry is literally
 * `{"type": "function", "function": {…}}` — twice, for both the Chat-API
 * round-1 and round-2 requests. A working example outranks a field-table
 * sentence. It also matches the RESPONSE side
 * (`choices[].message.tool_calls[].type` is documented as "Currently only
 * `function` is supported"), ci's own `Tool` type (`{type:'function', …}`),
 * and the platform's stated OpenAI compatibility.
 *
 * **`tool_choice.type` → `"function_call"`.** Here the doc is explicit and
 * has no counter-example anywhere in the corpus: doc 1494384, verbatim,
 * `tool_choice.type` — "Type of the call. In this case, set it to
 * `function_call`." Nothing contradicts it, so it is sent as documented.
 *
 * Neither could be settled by probe: tool calls need an activated model and
 * this account has none (every model 404s `ModelNotOpen` before request-body
 * validation is reached). {@link buildChatBody} therefore pairs these with a
 * ONE-SHOT ADAPTIVE RETRY — see {@link isToolDiscriminatorError} — so a 400
 * naming `tools`/`tool_choice`/`type` re-sends once with both discriminators
 * flipped and remembers whichever won for the life of the adapter instance.
 * Whichever way the platform actually resolves it, tool calling works.
 */
const CHAT_TOOLS_TYPE = 'function' as const;
const CHAT_TOOLS_TYPE_ALT = 'function_call' as const;
/** @see CHAT_TOOLS_TYPE — the doc is explicit and uncontradicted for this one. */
const CHAT_TOOL_CHOICE_TYPE = 'function_call' as const;
const CHAT_TOOL_CHOICE_TYPE_ALT = 'function' as const;

/**
 * Async video-generation poll cadence. Read lazily from the environment
 * rather than captured at module load, so an operator (or a test) can tune
 * it without a rebuild.
 *
 * Defaults follow the vendor's own guidance: a 3s first interval growing
 * 1.5x up to 30s, under a 600s total budget (the docs' Python sample uses
 * `max_wait = 600`). 1080p/4K Seedance jobs queue — 4K is rate-limited to
 * concurrency 1 — so a shorter budget will time out on real work.
 */
function videoPollConfig(): { timeoutMs: number; initialMs: number; maxMs: number } {
  const num = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs: num(process.env.BYTEPLUS_VIDEO_POLL_TIMEOUT_MS, 600_000),
    initialMs: num(process.env.BYTEPLUS_VIDEO_POLL_INTERVAL_MS, 3_000),
    maxMs: num(process.env.BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS, 30_000),
  };
}

/**
 * `reasoning_effort`'s documented closed enum. `none`/`xhigh` are
 * glm-5-2-260617 only and `max` is glm-5-2 / deepseek-v4-{pro,flash} only;
 * they are accepted here and left for the API to reject on the wrong model,
 * because silently downgrading a caller's explicit effort request would be
 * the same class of bug as coercing `xhigh` image detail away.
 */
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Terminal task statuses (lowercase, exactly as the API emits them). */
const VIDEO_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/**
 * 429 error codes that genuinely warrant a retry. ModelArk splits 429 by
 * model generation and NOT every 429 is retryable:
 *   · `ServerOverloaded`     (seed-1-8 and earlier) — "retry later"     → retry
 *   · `RequestBurstTooFast`  (seed-2-0 and later)   — "slow down"       → retry
 *   · `SetLimitExceeded`     (Free-Tokens-Only account pause)           → do NOT
 * A classifier keyed only on HTTP 429 conflates these; a naive backoff
 * loop on `SetLimitExceeded` spins forever, and ModelArk counts failed
 * requests against the per-minute limit, so retrying actively worsens it.
 */
const RETRYABLE_429_CODES = new Set(['ServerOverloaded', 'RequestBurstTooFast']);

export interface BytePlusAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
}

// ─── Upstream wire shapes ────────────────────────────────────────────────

interface ArkErrorEnvelope {
  error?: { code?: string; message?: string; param?: string; type?: string };
}

/**
 * `GET /api/v3/models` item — richer than OpenAI's `{id, object, created}`.
 *
 * ⚠ **PROVENANCE: single live probe, NOT documentation.** There is no
 * data-plane list-models reference anywhere in ModelArk's published docs —
 * the API index and the doc content API were both searched and neither
 * describes this route or this payload. Every field name below
 * (`domain`, `status`, `task_type[]`, `modalities.*`, `token_limits.*`,
 * `features.*`) and every `task_type` string literal consumed in
 * {@link BytePlusModelArkAdapter.toCiModel} was read off ONE 200 response
 * captured 2026-08-02. They are accurate as observed and nothing here is
 * guessed, but they are also unratified: a renamed field or a task token
 * minted after that date degrades silently rather than failing loudly.
 *
 * Containment, deliberate: `getModels()` fails soft to `[]` (an empty
 * inventory, not a crash), capability derivation reads BOTH `task_type` and
 * `modalities` so one wrong literal cannot erase a model's capabilities,
 * and the `id` field — the only one whose absence would be fatal — is
 * validated before use. RE-PROBE THIS once models are activated on the
 * account.
 */
interface ArkModelRecord {
  id: string;
  name?: string;
  version?: string;
  object?: string;
  created?: number;
  /** 'LLM' | 'VLM' | 'ImageGeneration' | 'VideoGeneration' | '3DGeneration' | '' */
  domain?: string;
  /** Absent for generally-available models; 'Retiring' | 'Shutdown' otherwise. */
  status?: string;
  task_type?: string[];
  modalities?: { input_modalities?: string[]; output_modalities?: string[] };
  token_limits?: {
    context_window?: number;
    max_input_token_length?: number;
    max_output_token_length?: number;
    max_reasoning_token_length?: number;
  };
  features?: {
    tools?: { function_calling?: boolean };
    structured_outputs?: { json_object?: boolean; json_schema?: boolean };
    batch?: { batch_chat?: boolean; batch_job?: boolean };
    cache?: { prefix_cache?: boolean; session_cache?: boolean };
  };
}

interface ArkChatMessage {
  role?: string;
  content?: string | unknown[] | null;
  /** Non-OpenAI: chain-of-thought text. */
  reasoning_content?: string | null;
  /** Non-OpenAI: signature-checked opaque reasoning blob; outranks reasoning_content. */
  encrypted_content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

interface ArkChatChoice {
  index?: number;
  message?: ArkChatMessage;
  delta?: ArkChatMessage;
  finish_reason?: string | null;
  /** Non-OpenAI: 'severe_violation' | 'violence' | null. */
  moderation_hit_type?: string | null;
}

interface ArkChatCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  service_tier?: string;
  choices?: ArkChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: Record<string, number>;
    completion_tokens_details?: Record<string, number>;
  };
}

interface ArkImageItem {
  url?: string;
  b64_json?: string;
  size?: string;
  output_format?: string;
  error?: { code?: string; message?: string };
}

interface ArkImageResponse {
  model?: string;
  created?: number;
  data?: ArkImageItem[];
  usage?: Record<string, number>;
  error?: { code?: string; message?: string };
}

interface ArkVideoTask {
  id?: string;
  model?: string;
  status?: string;
  content?: { video_url?: string; last_frame_url?: string; file_url?: string };
  error?: { code?: string; message?: string } | null;
  usage?: { completion_tokens?: number; total_tokens?: number };
  /** NB: one word, no separators — easy to mistype as frames_per_second. */
  framespersecond?: number;
  [k: string]: unknown;
}

interface ArkEmbeddingResponse {
  id?: string;
  model?: string;
  created?: number;
  /**
   * A single OBJECT, not an array — the whole typed `input[]` collapses to
   * ONE vector. Tolerated as an array too: the docs' own field table
   * disagrees with its example, so both are accepted.
   */
  data?: { embedding?: number[]; object?: string } | Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface ArkTokenizationResponse {
  id?: string;
  model?: string;
  created?: number;
  data?: Array<{ index?: number; total_tokens?: number; token_ids?: number[] }>;
}

/** Error carrying the upstream HTTP status so `isClientError` can classify it. */
class ArkHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.name = 'ArkHttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class BytePlusModelArkAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  /** Host root — `/ping` is NOT under `/api/v3`. */
  private readonly hostRoot: string;
  private readonly blog = logger.child({ provider: 'byteplus' });
  /**
   * Set once, at runtime, if the alternate `tools[].type` /
   * `tool_choice.type` discriminator turns out to be the accepted one.
   * See {@link CHAT_TOOLS_TYPE} and {@link sendChatBody}.
   */
  private toolDiscriminatorFlipped = false;

  constructor(config: BytePlusAdapterConfig) {
    super('byteplus', 'BytePlus ModelArk', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || BYTEPLUS_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.hostRoot = (() => {
      try {
        return new URL(this.baseUrl).origin;
      } catch {
        return 'https://ark.ap-southeast.bytepluses.com';
      }
    })();
  }

  // ─── Identity / discovery ──────────────────────────────────────────────

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'byteplus',
      name: 'byteplus',
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  /**
   * REAL dynamic discovery. `GET /api/v3/models` returns 200 with the full
   * account-visible catalog (52 entries live-verified) and richer metadata
   * than OpenAI's listing — enough to derive capabilities from the vendor's
   * own declaration instead of regex-guessing off model names.
   *
   * `status` is absent for generally-available models and set to
   * `'Retiring'` / `'Shutdown'` otherwise. Shutdown entries are filtered
   * out because they are listed but NOT callable — verified:
   * `seedream-3-0-t2i-250415` appears in the listing yet POSTing it returns
   * `InvalidEndpointOrModel.NotFound`, a different error from the
   * entitlement gate. Retiring entries are kept (still callable) so a
   * caller can migrate off them deliberately.
   *
   * Fails soft: discovery must not take the provider registry down. The
   * central discovery service records the empty round.
   */
  async getModels(): Promise<Model[]> {
    try {
      const payload = await this.request<{ data?: ArkModelRecord[] }>('/models', {
        method: 'GET',
      });
      const records = Array.isArray(payload?.data) ? payload.data : [];
      return records
        .filter((r) => typeof r.id === 'string' && r.id.length > 0 && r.status !== 'Shutdown')
        .map((r) => this.toCiModel(r));
    } catch (error) {
      this.blog.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'byteplus: GET /models failed — returning empty inventory for this round'
      );
      return [];
    }
  }

  /**
   * Maps ModelArk's vendor-declared metadata onto ci capabilities. Every
   * capability here is asserted BY THE VENDOR in the listing payload
   * (`task_type`, `modalities`, `features`) — nothing is inferred from the
   * model's name.
   *
   * Capabilities are derived from `task_type` AND `modalities` rather than
   * `task_type` alone. `task_type` is an open string list whose vocabulary
   * is undocumented (see {@link ArkModelRecord}); a model whose `task_type`
   * is empty, or uses a token minted after this file was written, would
   * otherwise get NO capability at all and become router-invisible.
   * `output_modalities` is the independent second signal that catches it,
   * and is the only signal for audio output, for which ModelArk currently
   * ships no model and therefore no known `task_type` token.
   */
  private toCiModel(record: ArkModelRecord): Model {
    const tasks = new Set(record.task_type ?? []);
    const inputs = new Set(record.modalities?.input_modalities ?? []);
    const outputs = new Set(record.modalities?.output_modalities ?? []);
    const caps = new Set<ModelCapability>();

    const isTextOut = outputs.has('text');
    if (tasks.has('TextGeneration') || tasks.has('VisualQuestionAnswering') || isTextOut) {
      caps.add('chat');
      caps.add('text_generation');
      // Every ModelArk chat model serves SSE off the same route.
      caps.add('streaming');
    }
    if (tasks.has('VisualQuestionAnswering')) caps.add('visual_question_answering');
    if (inputs.has('image') && isTextOut) {
      caps.add('vision');
      caps.add('image_captioning');
      // Document understanding rides the SAME chat route as vision — the
      // PDF is rasterised page-by-page into images upstream, which is
      // exactly why an image-input text-output model can do it ("Currently,
      // only PDF files are supported"). Without this tag no BytePlus model
      // is ever selectable by ci's /v1/pdf/analyze, which searches on
      // ['pdf_understanding','multimodal']. `mapMessage` handles the other
      // half: rewriting ci's `data:application/pdf` image_url part into
      // ModelArk's `file` part.
      caps.add('pdf_understanding');
    }
    if (inputs.has('video') && isTextOut) caps.add('video_understanding');
    if (inputs.has('audio')) caps.add('audio_input');
    if (inputs.size > 1) caps.add('multimodal');
    if (tasks.has('SpeechToText')) caps.add('speech_to_text');
    if (record.features?.tools?.function_calling) {
      caps.add('tool_use');
      caps.add('function_calling');
    }
    if (
      record.features?.structured_outputs?.json_object ||
      record.features?.structured_outputs?.json_schema
    ) {
      caps.add('json_mode');
    }
    if (
      tasks.has('TextEmbedding') ||
      tasks.has('ImageEmbedding') ||
      tasks.has('MultimodalEmbedding')
    ) {
      caps.add('embeddings');
    }
    // `task_type` first (precise), `output_modalities` as the backstop so an
    // unrecognised or absent task token cannot erase the capability.
    if (tasks.has('TextToImage') || outputs.has('image')) caps.add('image_generation');
    if (tasks.has('ImageToImage')) caps.add('image_editing');
    if (
      tasks.has('TextToVideo') ||
      tasks.has('ImageToVideo') ||
      tasks.has('MultimodalToVideo') ||
      outputs.has('video')
    ) {
      caps.add('video_generation');
    }
    if (tasks.has('VideoEditing') || tasks.has('VideoExtension')) caps.add('video_editing');
    // No ModelArk model declares audio output today and there is no
    // synthesis endpoint, so this branch is currently unreachable — it
    // exists so that a future audio model is classified as something rather
    // than as nothing.
    if (outputs.has('audio')) caps.add('audio_output');
    if ((record.token_limits?.max_reasoning_token_length ?? 0) > 0) caps.add('reasoning');
    if ((record.token_limits?.context_window ?? 0) >= 128_000) caps.add('long_context');

    return narrowAs<Model>({
      id: record.id,
      name: record.id,
      displayName: record.name ? `${record.name} (${record.version ?? record.id})` : record.id,
      provider: 'byteplus',
      contextWindow: record.token_limits?.context_window ?? 0,
      maxOutputTokens: record.token_limits?.max_output_token_length ?? 0,
      capabilities: [...caps],
      // 'Retiring' is a real, still-callable state; map it to ci's closest
      // lifecycle token rather than pretending it is fully active.
      status: record.status === 'Retiring' ? 'deprecated' : 'active',
    });
  }

  // ─── Chat ──────────────────────────────────────────────────────────────

  /**
   * `POST /chat/completions` — OpenAI-shaped, with ModelArk's non-OpenAI
   * defaults corrected. See {@link buildChatBody} for each override and why.
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildChatBody(request, false);
    const payload = await this.withRetry(
      () => this.sendChatBody(body, 'chat completion'),
      'chat completion'
    );
    return this.toChatResponse(payload, String(body.model));
  }

  /**
   * POSTs a composed chat body, with the one-shot tool-discriminator retry.
   *
   * `tools[].type` and `tool_choice.type` are the only two request fields on
   * this API whose correct value could not be established (see
   * {@link CHAT_TOOLS_TYPE}). Without a fallback, guessing wrong means EVERY
   * tool call fails for a capability the catalog declares
   * (`supports.tools: true`, derived for 20 of the discovered models) with
   * no recovery short of a redeploy. So: if the request carried tools and
   * came back 400 with a message naming `tools` / `tool_choice` / `type`,
   * flip both discriminators, resend ONCE, and remember the winner for the
   * life of this adapter instance so the cost is paid at most once.
   *
   * Deliberately narrow: only 400, only when tools were sent, only one
   * extra attempt, and never on a streaming submit (a stream is consumed
   * incrementally and cannot be transparently restarted from here).
   */
  private async sendChatBody(
    body: Record<string, unknown>,
    context: string
  ): Promise<ArkChatCompletion> {
    try {
      return await this.request<ArkChatCompletion>('/chat/completions', {
        method: 'POST',
        body,
      });
    } catch (error) {
      if (!this.isToolDiscriminatorError(error, body)) throw error;
      const flipped = this.flipToolDiscriminators(body);
      this.blog.warn(
        { context },
        'byteplus: 400 on a tool-shaped request — retrying once with the alternate ' +
          'tools[].type/tool_choice.type discriminator (the vendor docs contradict themselves)'
      );
      const payload = await this.request<ArkChatCompletion>('/chat/completions', {
        method: 'POST',
        body: flipped,
      });
      this.toolDiscriminatorFlipped = true;
      this.blog.info(
        { toolsType: flipped.tools ? CHAT_TOOLS_TYPE_ALT : undefined },
        'byteplus: alternate tool discriminator ACCEPTED — pinning it for this adapter instance'
      );
      return payload;
    }
  }

  /** 400 + tools were sent + the message blames the tool schema. */
  private isToolDiscriminatorError(error: unknown, body: Record<string, unknown>): boolean {
    if (this.toolDiscriminatorFlipped) return false;
    if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
    if (!(error instanceof ArkHttpError) || error.status !== 400) return false;
    return /tool_choice|tools|\btype\b/i.test(error.message);
  }

  private flipToolDiscriminators(body: Record<string, unknown>): Record<string, unknown> {
    const flipped: Record<string, unknown> = { ...body };
    if (Array.isArray(body.tools)) {
      flipped.tools = body.tools.map((t): unknown =>
        t && typeof t === 'object' ? { ...(t as object), type: CHAT_TOOLS_TYPE_ALT } : t
      );
    }
    const choice = body.tool_choice;
    if (choice && typeof choice === 'object') {
      flipped.tool_choice = { ...(choice as object), type: CHAT_TOOL_CHOICE_TYPE_ALT };
    }
    return flipped;
  }

  /**
   * Streaming chat. Plain SSE `data: {…}` chunks terminated by
   * `data: [DONE]` — identical framing to OpenAI.
   *
   * Deliberately does NOT skip "empty" deltas: ModelArk delivers
   * `delta.encrypted_content` in a chunk where BOTH `content` and
   * `reasoning_content` are empty strings. The common
   * `if (!delta.content) continue` loop drops exactly that chunk and
   * silently breaks multi-turn reasoning continuity, because
   * `encrypted_content` is what a follow-up turn must echo back.
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const body = this.buildChatBody(request, true);
    const model = String(body.model);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.streamTimeoutMs()),
    });

    if (!response.ok || !response.body) {
      throw await this.toArkError(response, 'chat completion (stream)');
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const frame: { done: boolean; value?: Uint8Array } = await reader.read();
        if (frame.done) break;
        buffer += decoder.decode(frame.value, { stream: true });

        // SSE frames are newline-delimited; keep the trailing partial line.
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          if (!data) continue;
          let chunk: ArkChatCompletion;
          try {
            chunk = JSON.parse(data) as ArkChatCompletion;
          } catch {
            this.blog.warn({ sample: data.slice(0, 120) }, 'byteplus: unparseable SSE frame');
            continue;
          }
          yield this.toChatResponse(chunk, model, true);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * ModelArk's chat defaults differ from OpenAI's in ways that silently
   * cost money or change behaviour. Each override below is deliberate:
   *
   *  - `thinking` defaults to `{"type":"enabled"}` SERVER-SIDE. Left alone,
   *    every call burns chain-of-thought tokens and returns a
   *    `reasoning_content` field ci callers don't expect. Sent as
   *    `disabled` unless the caller opted in via `thinking_budget`.
   *  - `max_tokens` and `max_completion_tokens` are MUTUALLY EXCLUSIVE —
   *    sending both is an immediate error. Exactly ONE is ever sent, and
   *    which one depends on whether reasoning is on:
   *      · reasoning OFF (the default): `max_tokens`, which caps the answer.
   *        There is no CoT to bound.
   *      · reasoning ON: `max_completion_tokens`, which is the ONLY
   *        parameter that bounds answer + chain-of-thought together
   *        (range [1, 65536]). Sending `max_tokens` here would cap the
   *        answer and leave billed CoT tokens completely unbounded, which
   *        is a real cost hazard on a platform whose CoT is on by default.
   *        The value is the caller's answer budget plus the thinking budget
   *        they explicitly asked for — a composition of the two numbers the
   *        caller supplied, not an invented one.
   *  - `top_p` defaults to 0.7 upstream (not OpenAI's 1.0); forwarded only
   *    when the caller set it explicitly, so we never silently re-anchor it.
   *  - `frequency_penalty` / `presence_penalty` are REJECTED outright on
   *    visual-understanding requests ("there is no frequency_penalty
   *    parameter") and unsupported on the Seed-1.8 / Dola-Seed-2.x
   *    families. Stripped in those cases instead of letting the whole
   *    request fail.
   *  - `stop` accepts at most 4 strings, and deep-reasoning models reject it
   *    entirely — see {@link stopUnsupported}.
   *  - `reasoning_effort` is pinned to `minimal` on the two models whose
   *    documented default would otherwise hard-error against
   *    `thinking: disabled` (see {@link reasoningEffortForDisabledThinking}),
   *    and otherwise forwarded from `metadata.reasoning_effort` when
   *    thinking is enabled and the value is in the documented enum.
   *  - `service_tier` is forwarded from `metadata.service_tier` when the
   *    caller set a documented value.
   *  - `n` does not exist on this API at all; ci's ChatRequest has no such
   *    field, so there is nothing to strip.
   */
  private buildChatBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const model = this.normalizeModelName(request.model ?? '');
    if (!model) throw new Error('byteplus: chatCompletion requires a model id');

    const messages = request.messages.map((m) => this.mapMessage(m));
    const hasNonTextPart = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => this.isNonTextPart(p))
    );

    const reasoning = this.wantsReasoning(request);
    const body: Record<string, unknown> = {
      model,
      messages,
      // Explicit rather than relying on the server default, which is `enabled`.
      thinking: { type: reasoning ? 'enabled' : 'disabled' },
    };

    // `thinking: {type: 'disabled'}` + a model whose `reasoning_effort`
    // DEFAULT is not `minimal` is a documented HARD ERROR ("if
    // thinking.type == 'disabled', only `minimal` is accepted"). Two models
    // ship such a default: glm-5-2-260617 (`max`) and
    // dola-seed-2-1-turbo-260628 (`high`). Sending `minimal` alongside the
    // disable is the doc's own stated remedy. Scoped to exactly those
    // families rather than sent unconditionally, because `reasoning_effort`
    // is not documented as universally accepted.
    if (!reasoning) {
      const effort = this.reasoningEffortForDisabledThinking(model);
      if (effort) body.reasoning_effort = effort;
    } else if (REASONING_EFFORTS.has(String(request.metadata?.reasoning_effort))) {
      // Documented closed enum; only meaningful with thinking enabled (with
      // it disabled the API accepts nothing but 'minimal', handled above).
      body.reasoning_effort = request.metadata?.reasoning_effort;
    }

    if (stream) {
      body.stream = true;
      // Emits one final chunk carrying `usage` with an empty `choices` array.
      body.stream_options = { include_usage: true };
    }
    if (reasoning) {
      // See the doc comment: max_completion_tokens is the only cap that
      // covers CoT, and it cannot be sent alongside max_tokens.
      const answerBudget = typeof request.max_tokens === 'number' ? request.max_tokens : 4096;
      const budget = answerBudget + (request.thinking_budget ?? 0);
      body.max_completion_tokens = Math.max(1, Math.min(65_536, Math.round(budget)));
    } else if (typeof request.max_tokens === 'number') {
      body.max_tokens = request.max_tokens;
    }
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (typeof request.top_p === 'number') body.top_p = request.top_p;

    if (!hasNonTextPart && !this.penaltiesUnsupported(model)) {
      if (typeof request.frequency_penalty === 'number') {
        body.frequency_penalty = request.frequency_penalty;
      }
      if (typeof request.presence_penalty === 'number') {
        body.presence_penalty = request.presence_penalty;
      }
    }

    if (request.stop !== undefined && !this.stopUnsupported(reasoning)) {
      const stops = Array.isArray(request.stop) ? request.stop : [request.stop];
      if (stops.length > 0) body.stop = stops.slice(0, 4);
    }

    if (request.response_format) body.response_format = request.response_format;

    // `service_tier` (`fast` | `auto` | `default`) is a documented request
    // field with no ChatRequest slot. Read from the free-form `metadata` bag
    // rather than fabricated. NB the docs default it to `auto` and then say
    // `auto` is not supported, and the RESPONSE can carry `scale`, which is
    // never a valid request value — so only the three request values pass.
    const serviceTier = request.metadata?.service_tier;
    if (serviceTier === 'fast' || serviceTier === 'auto' || serviceTier === 'default') {
      body.service_tier = serviceTier;
    }

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: this.toolsType(),
        function: {
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          parameters: t.function.parameters,
        },
      }));
      if (request.tool_choice !== undefined) {
        body.tool_choice =
          typeof request.tool_choice === 'string'
            ? request.tool_choice
            : {
                type: this.toolChoiceType(),
                function: { name: request.tool_choice.function.name },
              };
      }
    }

    return body;
  }

  /** @see CHAT_TOOLS_TYPE */
  private toolsType(): string {
    return this.toolDiscriminatorFlipped ? CHAT_TOOLS_TYPE_ALT : CHAT_TOOLS_TYPE;
  }

  /** @see CHAT_TOOLS_TYPE */
  private toolChoiceType(): string {
    return this.toolDiscriminatorFlipped ? CHAT_TOOL_CHOICE_TYPE_ALT : CHAT_TOOL_CHOICE_TYPE;
  }

  /** Reasoning is opt-in here (upstream default is ON — see buildChatBody). */
  private wantsReasoning(request: ChatRequest): boolean {
    return typeof request.thinking_budget === 'number' && request.thinking_budget > 0;
  }

  /**
   * Models whose documented `reasoning_effort` DEFAULT is above `minimal`,
   * which collides with `thinking: {type: 'disabled'}` ("only `minimal` is
   * accepted"). Prefix-matched because both ship dated variants.
   */
  private reasoningEffortForDisabledThinking(model: string): string | undefined {
    return /^(glm-5-2|dola-seed-2-1-turbo)/.test(model) ? 'minimal' : undefined;
  }

  /**
   * `stop` is documented as unsupported by "deep reasoning models". The docs
   * link that phrase to the model-list page rather than enumerating ids, and
   * the listing exposes no boolean for it — `token_limits
   * .max_reasoning_token_length > 0` is the closest vendor signal, but
   * `buildChatBody` only has the model id string, not the listing record.
   *
   * So the proxy used is the REQUEST's reasoning mode: `stop` is dropped
   * only when the caller opted into thinking. This never strips `stop` on
   * the default (thinking-disabled) path, and drops it exactly in the case
   * where the model is being driven as a deep-reasoning model. Conservative
   * on purpose — an over-broad strip is the failure this replaced elsewhere
   * in this file.
   */
  private stopUnsupported(reasoningEnabled: boolean): boolean {
    return reasoningEnabled;
  }

  /**
   * Model families that reject the OpenAI penalty parameters outright.
   *
   * SCOPE IS DOC-EXACT, and narrower than it once was. Doc 1494384 says
   * verbatim: "Not supported by Seed 1.8 and Dola Seed 2.0 series." That is
   * `seed-1-8*` and `dola-seed-2*` — and NOT the un-prefixed `seed-2-0-*`
   * family, which the model-list page (1330310) shows as a distinct, current
   * flagship line (`seed-2-0-lite-260428`, `seed-2-0-mini-260428`,
   * `seed-2-0-pro-*`) separate from `dola-seed-2-1-turbo-260628`. An earlier
   * revision matched `seed-2-0` too, silently dropping a caller's
   * frequency/presence penalty on the platform's main models with no error
   * and no log line, while the comment above it claimed only the two
   * documented families were affected. Do not re-widen this without a
   * quoted doc line or a real 400.
   *
   * Matching on family prefix (not exact id) because every family ships
   * dated variants (`seed-1-8-251228`, `dola-seed-2-1-turbo-260628`, …).
   */
  private penaltiesUnsupported(model: string): boolean {
    return /^(seed-1-8|dola-seed-2)/.test(model);
  }

  private isNonTextPart(part: unknown): boolean {
    if (!part || typeof part !== 'object') return false;
    const descriptor = Object.getOwnPropertyDescriptor(part, 'type');
    const type: unknown = descriptor?.value;
    return typeof type === 'string' && type !== 'text';
  }

  /**
   * Message mapping is pass-through by design, with ONE translation.
   *
   * Pass-through: ModelArk's Chat API content parts are byte-identical to
   * OpenAI's for `text` and `image_url`, and its EXTRA part types
   * (`video_url` with `fps`, `input_audio`, `file`) are shapes ci's
   * `MessageContent` union cannot name yet. Unknown typed parts are
   * forwarded verbatim rather than dropped, which is what makes video
   * understanding reachable for a caller willing to cast — and is what
   * {@link speechToText} relies on internally.
   *
   * The translation: **PDF**. ci's `PDFService` sends a document as
   * `{type:'image_url', image_url:{url:'data:application/pdf;base64,…'}}`,
   * which is the shape OpenAI/Gemini accept. ModelArk's `image_url` accepts
   * only real image MIME types (jpeg/png/webp/bmp/tiff/gif/heic/heif); a
   * PDF must arrive as `{type:'file', file:{file_data, filename}}`, where
   * `filename` is REQUIRED whenever `file_data` is used. Forwarding the
   * caller's part verbatim here would 400 on every `/v1/pdf/analyze` call
   * routed to BytePlus, so the part is rewritten. The other half of that
   * route — the `pdf_understanding` capability tag ci selects on — is
   * emitted by {@link toCiModel}.
   */
  private mapMessage(message: ChatMessage): Record<string, unknown> {
    const content = Array.isArray(message.content)
      ? message.content.map((part) => this.mapContentPart(part))
      : message.content;
    const mapped: Record<string, unknown> = { role: message.role, content };
    if (message.name) mapped.name = message.name;
    if (message.tool_call_id) mapped.tool_call_id = message.tool_call_id;
    if (message.tool_calls) mapped.tool_calls = message.tool_calls;
    return mapped;
  }

  /**
   * Identity for every part except an `image_url` that is actually a PDF —
   * see {@link mapMessage}. Detection is on the payload, not on a caller
   * flag: a `data:application/pdf` URI, or an http(s) URL whose path ends
   * `.pdf`. Anything else is returned untouched (same object identity), so
   * this cannot perturb the verbatim pass-through contract.
   */
  private mapContentPart(part: unknown): unknown {
    if (!part || typeof part !== 'object') return part;
    const typed = part as { type?: unknown; image_url?: { url?: unknown } };
    if (typed.type !== 'image_url') return part;
    const url = typed.image_url?.url;
    if (typeof url !== 'string') return part;

    const isDataPdf = url.startsWith('data:application/pdf');
    const isUrlPdf = /^https?:\/\//i.test(url) && /\.pdf(?:$|[?#])/i.test(url);
    if (!isDataPdf && !isUrlPdf) return part;

    if (isDataPdf) {
      // `filename` is REQUIRED alongside `file_data`. There is no filename
      // in ci's part, so a stable synthetic one is used — the API uses it
      // only for display/extension sniffing, and inventing a *name* is not
      // inventing a *contract*.
      return { type: 'file', file: { file_data: url, filename: 'document.pdf' } };
    }
    const filename = url.split(/[?#]/)[0].split('/').pop() || 'document.pdf';
    return { type: 'file', file: { file_url: url, filename } };
  }

  /**
   * Response mapping. Non-OpenAI extras are preserved rather than dropped:
   * `reasoning_content` / `encrypted_content` ride along on the message
   * (a follow-up turn must echo `encrypted_content` back — it is
   * signature-checked, and tampering yields `Invalid signature`), and
   * `moderation_hit_type` rides along on the choice.
   *
   * `finish_reason: 'content_filter'` is passed through UNCHANGED and this
   * matters: ModelArk returns a content-filtered refusal as HTTP 200 with a
   * plausible-looking assistant message ("Let's talk about something
   * else"). Collapsing it to `'stop'` would make a refusal indistinguishable
   * from a real answer. ci's `ChatChoice.finish_reason` already admits
   * `'content_filter'`, so no fabrication is needed.
   */
  private toChatResponse(
    payload: ArkChatCompletion,
    requestedModel: string,
    isChunk = false
  ): ChatResponse {
    const choices = (payload.choices ?? []).map((choice, index) => {
      const source = isChunk ? choice.delta : choice.message;
      const message = this.toCiMessage(source);
      const mapped: Record<string, unknown> = {
        index: choice.index ?? index,
        finish_reason: this.mapFinishReason(choice.finish_reason),
      };
      if (isChunk) mapped.delta = message;
      else mapped.message = message;
      if (choice.moderation_hit_type) mapped.moderation_hit_type = choice.moderation_hit_type;
      return narrowAs<ChatResponse['choices'][number]>(mapped);
    });

    const response: ChatResponse = {
      id: payload.id ?? '',
      object: isChunk ? 'chat.completion.chunk' : 'chat.completion',
      created: payload.created ?? Math.floor(Date.now() / 1000),
      model: payload.model ?? requestedModel,
      choices,
    };

    if (payload.usage) {
      response.usage = {
        prompt_tokens: payload.usage.prompt_tokens ?? 0,
        completion_tokens: payload.usage.completion_tokens ?? 0,
        total_tokens: payload.usage.total_tokens ?? 0,
      };
    }
    return response;
  }

  private toCiMessage(source: ArkChatMessage | undefined): ChatMessage {
    const message: Record<string, unknown> = {
      role: source?.role ?? 'assistant',
      content: source?.content ?? '',
    };
    if (source?.reasoning_content) message.reasoning_content = source.reasoning_content;
    if (source?.encrypted_content) message.encrypted_content = source.encrypted_content;
    if (source?.tool_calls) message.tool_calls = source.tool_calls;
    return narrowAs<ChatMessage>(message);
  }

  private mapFinishReason(reason: string | null | undefined): ChatResponse['choices'][number]['finish_reason'] {
    if (reason === 'stop' || reason === 'length' || reason === 'tool_calls') return reason;
    if (reason === 'content_filter') return 'content_filter';
    return null;
  }

  // ─── Vision ────────────────────────────────────────────────────────────

  /**
   * Overrides the base implementation for one reason: ModelArk accepts a
   * fourth `detail` level, `"xhigh"`, plus a non-OpenAI
   * `image_pixel_limit` object that overrides `detail` outright. The base
   * class clamps `detail` to low/high/auto and would silently coerce
   * `xhigh` to `auto`, quietly downgrading the caller's requested fidelity.
   *
   * Constraints worth knowing: images ≤ 10 MB, request body ≤ 64 MB,
   * width and height each > 14 px, w*h ∈ [196, 36_000_000], aspect ratio
   * within [1/150, 150].
   */
  async vision(model: Model, request: VisionRequest): Promise<VisionResponse> {
    const detail = request.options?.detail;
    const imageUrl: Record<string, unknown> = { url: this.toImageDataUrl(request.image) };
    if (detail === 'low' || detail === 'high' || detail === 'auto' || detail === 'xhigh') {
      imageUrl.detail = detail;
    }
    const pixelLimit = request.options?.image_pixel_limit;
    if (pixelLimit && typeof pixelLimit === 'object') imageUrl.image_pixel_limit = pixelLimit;

    const response = await this.chatCompletion({
      model: model.name || model.id,
      messages: [
        narrowAs<ChatMessage>({
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            { type: 'image_url', image_url: imageUrl },
          ],
        }),
      ],
      temperature:
        typeof request.options?.temperature === 'number' ? request.options.temperature : 0.2,
      max_tokens:
        typeof request.options?.max_tokens === 'number' ? request.options.max_tokens : 1024,
    });

    return {
      content: this.extractTextFromChatContent(response.choices?.[0]?.message?.content),
      raw: response,
    };
  }

  // ─── Embeddings ────────────────────────────────────────────────────────

  /**
   * `POST /embeddings/multimodal`. Three structural mismatches with the
   * OpenAI shape ci's `EmbeddingRequest`/`EmbeddingResponse` assumes:
   *
   *  1. `input` is an array of TYPED PARTS (`{type:'text',text}`), not
   *     strings.
   *  2. The ENTIRE array collapses to exactly ONE vector. An OpenAI-shaped
   *     caller passing N strings expects N vectors, so this fans out into N
   *     concurrent single-input requests and reassembles them in order.
   *  3. `data` comes back as a single OBJECT, not an array. The parser
   *     below accepts both because the vendor's own field table and its own
   *     example disagree on this.
   *
   * Endpoint choice (deliberate): a plain `POST /api/v3/embeddings` DOES
   * exist — live-verified, it routes and reaches the model gate. It was
   * NOT used, because its response contract is unverifiable while every
   * model on this account is entitlement-gated, and building the parser
   * against a guessed shape is exactly the failure mode this integration is
   * meant to avoid. `/embeddings/multimodal` has a documented, verbatim
   * response shape. Switch if a real 200 ever proves the plain route is
   * OpenAI-shaped.
   *
   * Also live-observed: BOTH routes resolved a requested version
   * (`…-250615`, `…-250328`) to `skylark-embedding-vision-251215` in their
   * error messages, i.e. the gateway resolves an embedding model FAMILY to
   * a preset endpoint at its own chosen version. Do not assume the version
   * you asked for is the version that served you — read `response.model`.
   *
   * ### Reaching the multimodal half of a multimodal endpoint
   *
   * `input[]` also accepts `{type:'image_url',image_url:{url}}` and
   * `{type:'video_url',video_url:{url}}` — the entire reason the
   * `skylark-embedding-vision-*` family exists, and live discovery found
   * three such models. ci's `EmbeddingRequest.input` is typed `string |
   * string[]`, so the media form is expressed the only way it can be
   * without inventing a contract: by READING the caller's own data. An
   * entry that is an `http(s)` URL or a `data:` URI with an image/video
   * MIME is emitted as the matching typed part; everything else stays
   * `{type:'text'}`. A caller who genuinely wants a URL embedded AS TEXT
   * can force it with `options.input_type: 'text'`.
   *
   * `instructions` is forwarded when supplied and NEVER fabricated. The
   * docs are emphatic that it "directly determines model inference
   * performance" and that the default degrades quality — but the adapter
   * has no idea what a good instruction is for an arbitrary caller's
   * corpus, and inventing one would silently change every vector ci ever
   * stores. Surfaced through `options.instructions` so the caller decides;
   * only `skylark-embedding-vision-251215` and later accept it.
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.normalizeModelName(request.model);
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    if (inputs.length === 0) throw new Error('byteplus: generateEmbeddings requires input');

    const opts = request.options ?? {};
    const forceText = opts.input_type === 'text';
    // ci's EmbeddingRequest already carries encoding_format; ModelArk
    // supports base64 as well as float, so honour it instead of pinning.
    const encodingFormat = request.encoding_format === 'base64' ? 'base64' : 'float';

    const extras: Record<string, unknown> = {};
    // `dimensions` is a VERSION THRESHOLD, not one bad build: the docs say
    // it is supported by "skylark-embedding-vision-250615 and subsequent
    // versions". A blacklist of `-250328` would happily send it to any
    // OTHER pre-250615 build and get it rejected. See isAtLeastVersion().
    if (typeof request.dimensions === 'number' && this.isAtLeastVersion(model, 250615)) {
      extras.dimensions = request.dimensions;
    }
    // `instructions` landed in 251215; sending it to an older build errors.
    if (typeof opts.instructions === 'string' && this.isAtLeastVersion(model, 251215)) {
      extras.instructions = opts.instructions;
    }
    // `{"type":"enabled"}` adds sparse vectors alongside the dense one.
    // Text-only input, per the docs. ci's EmbeddingResponse has no slot for
    // the sparse vector, so it is reachable only via the upstream payload —
    // sending it without a consumer would just cost tokens, hence opt-in.
    if (opts.sparse_embedding === true) {
      extras.sparse_embedding = { type: 'enabled' };
    }

    const results = await Promise.all(
      inputs.map((text, index) =>
        this.withRetry(
          () =>
            this.request<ArkEmbeddingResponse>('/embeddings/multimodal', {
              method: 'POST',
              body: {
                model,
                input: [forceText ? { type: 'text', text } : this.toEmbeddingInputPart(text)],
                encoding_format: encodingFormat,
                ...extras,
              },
            }),
          `embeddings[${index}]`
        ).then((payload) => ({ index, payload }))
      )
    );

    let promptTokens = 0;
    let totalTokens = 0;
    const data = results
      .sort((a, b) => a.index - b.index)
      .map(({ index, payload }) => {
        promptTokens += payload.usage?.prompt_tokens ?? 0;
        totalTokens += payload.usage?.total_tokens ?? 0;
        return {
          object: 'embedding' as const,
          index,
          embedding: this.extractEmbedding(payload),
        };
      });

    return {
      object: 'list',
      data,
      model: results[0]?.payload.model ?? model,
      usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
    };
  }

  /**
   * ModelArk versions every model with a trailing `-YYMMDD` build stamp, and
   * several parameters are gated on "version X and subsequent versions".
   * Parses that stamp and compares numerically.
   *
   * Returns TRUE when no stamp is present: an unversioned family alias (or a
   * custom endpoint id `ep-…`) is resolved SERVER-side to whatever version
   * the gateway currently presets — live-observed doing exactly that — and
   * that preset is the newest build, not the oldest. Withholding a supported
   * parameter from the current model to protect a legacy one the caller did
   * not name would be the wrong default.
   */
  private isAtLeastVersion(model: string, minimum: number): boolean {
    const stamp = /-(\d{6})$/.exec(model)?.[1];
    if (!stamp) return true;
    return Number(stamp) >= minimum;
  }

  /**
   * Classifies one ci `input[]` entry into a ModelArk typed part. See the
   * `generateEmbeddings` doc comment for why detection is on the payload.
   */
  private toEmbeddingInputPart(value: string): Record<string, unknown> {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (/^data:image\//i.test(trimmed)) return { type: 'image_url', image_url: { url: trimmed } };
    if (/^data:video\//i.test(trimmed)) return { type: 'video_url', video_url: { url: trimmed } };
    if (/^https?:\/\//i.test(trimmed)) {
      const path = trimmed.split(/[?#]/)[0];
      if (/\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif)$/i.test(path)) {
        return { type: 'image_url', image_url: { url: trimmed } };
      }
      // Only the three container extensions the docs name are treated as
      // video; anything else stays text rather than being guessed at.
      if (/\.(mp4|avi|mov)$/i.test(path)) {
        return { type: 'video_url', video_url: { url: trimmed } };
      }
    }
    return { type: 'text', text: value };
  }

  /** Accepts both the documented object form and the array form (doc bug). */
  private extractEmbedding(payload: ArkEmbeddingResponse): number[] {
    const data = payload.data;
    if (Array.isArray(data)) {
      const vector = data[0]?.embedding;
      if (Array.isArray(vector)) return vector;
    } else if (data && Array.isArray(data.embedding)) {
      return data.embedding;
    }
    throw new Error('byteplus: embeddings response contained no vector');
  }

  // ─── Image generation & editing ────────────────────────────────────────

  /**
   * `POST /images/generations`.
   *
   * Two upstream defaults are corrected here:
   *
   *  - **`watermark` defaults to TRUE server-side.** Every generated image
   *    ships with a visible "AI generated" mark bottom-right unless `false`
   *    is sent explicitly. This is the single most likely production
   *    surprise on this API, so `false` is the adapter default and turning
   *    it back on is an explicit `options.watermark: true`.
   *  - **`size` has per-model total-pixel FLOORS**, and ci's habitual
   *    `"1024x1024"` sits BELOW the floor for `seedream-4-5-251128` and
   *    `seedream-5-0-lite-260128` (both need ≥ 3,686,400 px) — it would be
   *    rejected. The default is therefore the tier token `"2K"`, which
   *    every current image model accepts. Explicit `WIDTHxHEIGHT` from the
   *    caller is forwarded untouched.
   *
   * There is no `n` parameter; batch count is expressed through
   * `sequential_image_generation` + `max_images`, and NOT on
   * `dola-seedream-5-0-pro-260628`, which errors if either field is present.
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const modelId = this.normalizeModelName(model.name || model.id);
    const body = this.buildImageBody(modelId, request.prompt, request.size, request.options);
    const payload = await this.withRetry(
      () => this.request<ArkImageResponse>('/images/generations', { method: 'POST', body }),
      'image generation'
    );
    return this.parseImageResponse(payload, body.output_format);
  }

  /**
   * Image EDITING uses the SAME `/images/generations` route with an `image`
   * field, as a JSON body. There is no `/images/edits` on ModelArk —
   * live-verified: that path returns the 200-empty absent-route signal, and
   * the hub's generic multipart-to-`/images/edits` implementation would
   * therefore post into a void.
   *
   * `mask` has NO mapping and this THROWS rather than ignoring it. ModelArk
   * has no mask parameter at all; the only spatially-targeted editing it
   * offers is `<point>`/`<bbox>` tags embedded in the prompt string, on
   * `dola-seedream-5-0-pro-260628` only — a fundamentally different
   * interface that cannot be driven from a raster mask. Silently dropping
   * the mask would return a globally-edited image while the caller believes
   * the edit was confined to the masked region, which is worse than failing.
   *
   * **Multi-reference is supported.** ModelArk's `image` field accepts a
   * string ARRAY — up to 10 reference images on `dola-seedream-5-0-pro-260628`
   * and 14 on 5-0-lite / 4-5 / 4-0 — which is a headline Seedream
   * capability. `ImageEditRequest.image` is a single Buffer, so extra
   * references come from `options.images`: Buffers, `data:` URIs or public
   * URLs, appended after the primary image in caller order.
   *
   * **The uploaded bytes are SNIFFED, not assumed.** The data URI must be
   * `data:image/<format>;base64,…` with the format matching the real
   * payload; announcing a JPEG as PNG is a validation error waiting to
   * happen. See {@link sniffImageMime}.
   */
  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    if (request.mask) {
      throw new Error(
        'byteplus: imageEdit does not support `mask` — ModelArk has no mask parameter. ' +
          'Its only spatial editing is <point>/<bbox> prompt tags on dola-seedream-5-0-pro-260628. ' +
          'Re-issue without a mask, or encode the region in the prompt for that model.'
      );
    }
    const modelId = this.normalizeModelName(model.name || model.id);
    // seedream-3-0-t2i is text-to-image ONLY — the docs state plainly that it
    // "does not support this parameter" for `image`. Failing here names the
    // real problem; letting it through returns an unedited generation from
    // the prompt alone, which looks like a bad edit rather than a bad model
    // choice.
    if (this.isTextToImageOnly(modelId)) {
      throw new Error(
        `byteplus: imageEdit is not available on ${modelId} — that model rejects the \`image\` ` +
          'parameter (text-to-image only). Use seedream-4-0/4-5/5-0-lite or dola-seedream-5-0-pro.'
      );
    }
    const body = this.buildImageBody(modelId, request.prompt, request.size, {
      ...(request.options ?? {}),
      ...(typeof request.n === 'number' ? { n: request.n } : {}),
      ...(request.response_format ? { response_format: request.response_format } : {}),
    });

    const inputFormat =
      typeof request.options?.input_format === 'string'
        ? String(request.options.input_format).toLowerCase()
        : undefined;
    const primary = `data:image/${inputFormat ?? this.sniffImageMime(request.image)};base64,${request.image.toString('base64')}`;
    const extra = this.toReferenceImages(request.options?.images);
    body.image = extra.length > 0 ? [primary, ...extra] : primary;

    const payload = await this.withRetry(
      () => this.request<ArkImageResponse>('/images/generations', { method: 'POST', body }),
      'image edit'
    );
    return this.parseImageResponse(payload, body.output_format);
  }

  /** `options.images` → additional `image[]` entries (Buffer | data: | URL). */
  private toReferenceImages(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      if (Buffer.isBuffer(item)) {
        out.push(`data:image/${this.sniffImageMime(item)};base64,${item.toString('base64')}`);
      } else if (typeof item === 'string' && item.trim()) {
        out.push(item.trim());
      }
    }
    return out;
  }

  /**
   * `seedream-3-0-t2i` is the one image model with neither `image` input nor
   * `size` tier tokens. Matched by family prefix — it ships dated variants
   * (`seedream-3-0-t2i-250415`).
   */
  private isTextToImageOnly(modelId: string): boolean {
    return /^seedream-3-0-t2i/.test(modelId);
  }

  private buildImageBody(
    modelId: string,
    prompt: string,
    size: string | undefined,
    options: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const opts = options ?? {};
    const body: Record<string, unknown> = {
      model: modelId,
      prompt,
      // b64_json avoids a second round-trip AND avoids depending on a URL
      // that expires 24h after generation.
      response_format: opts.response_format === 'url' ? 'url' : 'b64_json',
      watermark: opts.watermark === true,
    };
    // The "2K" default exists because ci's habitual "1024x1024" is BELOW the
    // total-pixel floor for seedream-4-5 / 5-0-lite. seedream-3-0-t2i has no
    // tier tokens AT ALL (pixel range only, default 1024x1024), so the tier
    // default must not be applied to it — its own default is correct.
    const resolvedSize = size ?? (this.isTextToImageOnly(modelId) ? undefined : '2K');
    if (resolvedSize) body.size = resolvedSize;

    if (typeof opts.output_format === 'string') body.output_format = opts.output_format;
    if (typeof opts.seed === 'number') body.seed = opts.seed;
    if (typeof opts.guidance_scale === 'number') body.guidance_scale = opts.guidance_scale;

    const n = typeof opts.n === 'number' ? opts.n : 1;
    // dola-seedream-5-0-pro-260628 ERRORS if either sequential field is
    // present at all — it has no batch output.
    if (n > 1 && modelId !== 'dola-seedream-5-0-pro-260628') {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: Math.min(n, 15) };
    }
    return body;
  }

  /**
   * Magic-byte sniff for the formats ModelArk accepts as image INPUT
   * (jpeg, png, webp, bmp, tiff, gif, heic, heif). The data URI it is used
   * to build must declare the real format, lowercase.
   *
   * Falls back to `jpeg`, not `png`: jpeg is both the API's own default
   * `output_format` and by far the likeliest thing an unrecognised buffer
   * actually is. A wrong guess is a validation error either way — this just
   * makes the common case right instead of the rare one.
   */
  private sniffImageMime(buffer: Buffer): string {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpeg';
    }
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return 'png';
    }
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'webp';
    }
    if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
    if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
    // TIFF: 0x49 0x49 0x2A 0x00 (little-endian) or 0x4D 0x4D 0x00 0x2A (big).
    if (buffer.length >= 4) {
      const tiffLe =
        buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
      const tiffBe =
        buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
      if (tiffLe || tiffBe) return 'tiff';
    }
    // ISO-BMFF brand box: ....ftyp{heic|heix|hevc|mif1|heif|msf1}
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12);
      if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'heic';
      if (brand === 'heif') return 'heif';
    }
    return 'jpeg';
  }

  /**
   * Partial failure on this API is INLINE and arrives with HTTP 200: an
   * individual `data[i]` can be `{"error":{…}}` instead of an image while
   * the request still succeeds. Checking `data[0].error` before assuming an
   * image is present is mandatory.
   *
   * Lossiness worth stating: ci's contract exposes exactly ONE image
   * (`image: Buffer`). With `max_images > 1` the extra images are reachable
   * only through `raw`.
   *
   * ### `format` is resolved, not assumed
   *
   * `ImageGenResponse.format` is what downstream consumers pick a file
   * extension, a Content-Type and a decoder from, so getting it wrong
   * corrupts everything after it. Three sources, in order:
   *
   *  1. `data[i].output_format` when the model echoes it. Per doc 1541523
   *     only `seedream-5-0-pro` does.
   *  2. The `output_format` this adapter SENT, when the caller supplied
   *     `options.output_format`. If the API accepted the request, that is
   *     what the bytes are.
   *  3. Otherwise the API's own documented request default: **`jpeg`**.
   *     Not `png`. `seedream-4-5-251128` and `seedream-4-0-250828` are
   *     JPEG-ONLY, and every model defaults to jpeg when `output_format` is
   *     omitted — which is the common case, because the adapter only sends
   *     the field when the caller asks for it. An earlier revision returned
   *     `'png'` here, so every image from every model except 5-0-pro was
   *     handed to callers with a lie attached.
   *
   * `ImageGenResponse['format']` is `'png'|'jpg'|'webp'|string`, so `'jpeg'`
   * is a legal value.
   */
  private async parseImageResponse(
    payload: ArkImageResponse,
    requestedFormat?: unknown
  ): Promise<ImageGenResponse> {
    if (payload.error?.code) {
      throw new Error(`byteplus: image generation failed — ${payload.error.code}: ${payload.error.message ?? ''}`);
    }
    const first = payload.data?.[0];
    if (!first) throw new Error('byteplus: image response contained no data entries');
    if (first.error?.code) {
      throw new Error(
        `byteplus: image item failed inline (HTTP 200) — ${first.error.code}: ${first.error.message ?? ''}`
      );
    }

    const echoed = typeof first.output_format === 'string' ? first.output_format : undefined;
    const requested = typeof requestedFormat === 'string' ? requestedFormat : undefined;
    const format = (echoed ?? requested ?? 'jpeg') as ImageGenResponse['format'];
    if (first.b64_json) {
      return { image: Buffer.from(first.b64_json, 'base64'), format, raw: payload };
    }
    if (first.url) {
      const res = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        throw new Error(`byteplus: failed to download generated image (HTTP ${res.status})`);
      }
      return {
        image: Buffer.from(await res.arrayBuffer()),
        format,
        raw: payload,
      };
    }
    throw new Error('byteplus: image response had neither b64_json nor url');
  }

  /**
   * No variation endpoint exists, and no prompt-free image-to-image mode.
   * The nearest behaviour would be calling `/images/generations` with the
   * source image plus a synthesised prompt like "a variation of this
   * image" — that is inventing an API contract and the output would not be
   * a variation in OpenAI's sense.
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'byteplus: imageVariation is not supported — ModelArk has no image-variation endpoint ' +
        'and no prompt-free image-to-image mode. Use imageEdit with an explicit prompt instead.'
    );
  }

  // ─── Video generation (async submit → poll) ────────────────────────────

  /**
   * `POST /contents/generations/tasks` then poll
   * `GET /contents/generations/tasks/{id}`.
   *
   * This MUST be hand-written; a generic OpenAI-style video helper cannot
   * drive it, for two independent reasons:
   *
   *  1. The submit response is EXACTLY `{"id":"cgt-…"}` — there is no
   *     `status` field. Generic helpers that only accept a task id when a
   *     status accompanies it never enter the poll loop and hand back a
   *     handle with no video, every time.
   *  2. The result lives at `content.video_url` — an OBJECT — while generic
   *     extractors scan array shapes (`data[]`, `generations[]`, …) and
   *     never reach it.
   *
   * The submit is issued with NO retry, on purpose: it enqueues an
   * asynchronous PAID job, so retrying after an ambiguous failure (timeout,
   * dropped connection) can start two or more billed generations. Polling
   * is separately retryable and cheap.
   *
   * `expired` and `cancelled` are terminal FAILURES, not silent successes.
   *
   * NOTE on the sibling DELETE route (intentionally not wired): `DELETE
   * /contents/generations/tasks/{id}` is overloaded and destructive — on a
   * `queued` task it cancels, but on `succeeded`/`failed`/`expired` it
   * PERMANENTLY DELETES the record. It must never back a generic "cancel"
   * button without a status check first.
   */
  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const modelId = this.normalizeModelName(model.name || model.id);
    const task = await this.submitAndPollGenerationTask(
      modelId,
      this.buildVideoBody(modelId, request),
      'video generation'
    );
    const taskId = String(task.id ?? '');

    const url = task.content?.video_url;
    if (!url) {
      throw new Error(`byteplus: video task ${taskId} succeeded but content.video_url is absent`);
    }
    // `return_last_frame: true` adds `content.last_frame_url`. It is a
    // second, separately-useful asset (the seed for a continuation shot),
    // so it is surfaced as its own entry rather than left buried in `raw`.
    const video: Array<{ id?: string; url?: string }> = [{ id: taskId, url }];
    if (task.content?.last_frame_url) {
      video.push({ id: `${taskId}:last_frame`, url: task.content.last_frame_url });
    }
    return {
      // Result URLs expire 24 hours after generation — re-host promptly.
      video,
      format: 'mp4',
      raw: task,
    };
  }

  /**
   * The shared submit→poll engine for `/contents/generations/tasks`. Video
   * and 3D generation are the SAME route with different models; only the
   * result field differs (`content.video_url` vs `content.file_url`), so
   * only the extraction is per-modality.
   *
   * Returns the terminal task record with `status === 'succeeded'`; every
   * other terminal status throws.
   */
  private async submitAndPollGenerationTask(
    modelId: string,
    body: Record<string, unknown>,
    context: string
  ): Promise<ArkVideoTask> {
    const submission = await this.request<{ id?: string }>('/contents/generations/tasks', {
      method: 'POST',
      body,
    });
    const taskId = submission?.id;
    if (!taskId) {
      throw new Error(`byteplus: ${context} submit returned no task id`);
    }
    this.blog.info({ taskId, model: modelId, context }, 'byteplus: generation task submitted');

    const poll = videoPollConfig();
    const deadline = Date.now() + poll.timeoutMs;
    let interval = poll.initialMs;

    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(
          `byteplus: ${context} task ${taskId} did not reach a terminal status within ${poll.timeoutMs}ms ` +
            '(4K/1080p jobs queue at concurrency 1 — raise BYTEPLUS_VIDEO_POLL_TIMEOUT_MS if this recurs)'
        );
      }
      await this.sleep(interval);
      interval = Math.min(Math.round(interval * 1.5), poll.maxMs);

      const task = await this.request<ArkVideoTask>(
        `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        { method: 'GET' }
      );
      const status = task.status ?? '';
      if (!VIDEO_TERMINAL_STATUSES.has(status)) continue;

      if (status !== 'succeeded') {
        throw new Error(
          `byteplus: video task ${taskId} ended '${status}'` +
            (task.error?.code ? ` — ${task.error.code}: ${task.error.message ?? ''}` : '')
        );
      }
      return { ...task, id: task.id ?? taskId };
    }
  }

  /**
   * ci's `VideoGenRequest` → ModelArk's `content[]` + top-level params.
   *
   * `size` has NO mapping: ModelArk selects output geometry with
   * `resolution` (`480p`/`720p`/`1080p`/`4K`), not pixel dimensions. It is
   * read from `options.resolution` instead of being fabricated from `size`.
   * `aspectRatio` maps to `ratio`, which is a CLOSED enum — a free-form
   * value would be rejected, so unknown values are dropped rather than
   * forwarded.
   *
   * Everything else comes off the open `options` bag, validated against the
   * documented domain before it is sent (ModelArk validates BODY params
   * strictly — a bad value is an error, not a silent default).
   */
  private buildVideoBody(modelId: string, request: VideoGenRequest): Record<string, unknown> {
    const opts = request.options ?? {};
    const content: Array<Record<string, unknown>> = [];

    if (request.prompt) content.push({ type: 'text', text: request.prompt });

    const firstFrame = request.startImage ?? request.image;
    if (firstFrame) {
      content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
    }
    if (request.endImage) {
      content.push({ type: 'image_url', image_url: { url: request.endImage }, role: 'last_frame' });
    }
    // Reference images (0–9) are a distinct role from first/last frame and
    // are how Seedance is told "use these subjects". Prompts must refer to
    // them positionally as "Image n", 1-based per type.
    for (const ref of this.toStringArray(opts.reference_images)) {
      content.push({ type: 'image_url', image_url: { url: ref }, role: 'reference_image' });
    }
    if (request.video) {
      content.push({ type: 'video_url', video_url: { url: request.video }, role: 'reference_video' });
    }
    if (request.audio) {
      content.push({ type: 'audio_url', audio_url: { url: request.audio }, role: 'reference_audio' });
    }
    // A draft task is UPGRADED into a full render by referencing its id —
    // this is the second half of the Seedance 1.5 Pro `draft` flow and the
    // only way to avoid paying twice for the same shot.
    if (typeof opts.draft_task_id === 'string' && opts.draft_task_id) {
      content.push({ type: 'draft_task', draft_task: { id: opts.draft_task_id } });
    }
    if (content.length === 0) {
      throw new Error('byteplus: videoGenerate requires a prompt or at least one media input');
    }

    const body: Record<string, unknown> = { model: modelId, content };

    const ratio = request.aspectRatio;
    const RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']);
    if (ratio && RATIOS.has(ratio)) body.ratio = ratio;

    const resolution = opts.resolution;
    const RESOLUTIONS = new Set(['480p', '720p', '1080p', '4K']);
    if (typeof resolution === 'string' && RESOLUTIONS.has(resolution)) body.resolution = resolution;

    // `frames` TAKES PRECEDENCE over `duration` upstream. Sending both is
    // therefore ambiguous to a reader even though the API resolves it, so
    // `duration` is omitted when an explicit frame count is given. Domain:
    // [29, 289] on the 25+4n lattice.
    const frames = opts.frames;
    const framesValid =
      typeof frames === 'number' &&
      Number.isInteger(frames) &&
      frames >= 29 &&
      frames <= 289 &&
      (frames - 25) % 4 === 0;
    if (framesValid) body.frames = frames;
    else if (typeof request.duration === 'number') body.duration = Math.round(request.duration);

    if (typeof opts.seed === 'number') body.seed = opts.seed;
    if (typeof opts.camera_fixed === 'boolean') body.camera_fixed = opts.camera_fixed;
    if (typeof opts.generate_audio === 'boolean') body.generate_audio = opts.generate_audio;
    if (typeof opts.return_last_frame === 'boolean') body.return_last_frame = opts.return_last_frame;
    if (typeof opts.callback_url === 'string') body.callback_url = opts.callback_url;
    // Seedance 1.5 Pro preview mode: forces 480p, no last-frame return, no
    // offline inference — cheap iteration before the real render.
    if (typeof opts.draft === 'boolean') body.draft = opts.draft;
    // Priority 0–9, Seedance 2.0 only, and NOT combinable with
    // service_tier: 'flex'. The mutual exclusion is enforced here rather
    // than left to a 400.
    if (
      typeof opts.priority === 'number' &&
      Number.isInteger(opts.priority) &&
      opts.priority >= 0 &&
      opts.priority <= 9 &&
      opts.service_tier !== 'flex'
    ) {
      body.priority = opts.priority;
    }
    // Seconds the queued task stays executable: [3600, 259200], default 48h.
    if (
      typeof opts.execution_expires_after === 'number' &&
      opts.execution_expires_after >= 3600 &&
      opts.execution_expires_after <= 259_200
    ) {
      body.execution_expires_after = Math.round(opts.execution_expires_after);
    }
    if (typeof opts.safety_identifier === 'string' && opts.safety_identifier.length <= 64) {
      body.safety_identifier = opts.safety_identifier;
    }
    // Video watermarking already defaults to FALSE upstream (the OPPOSITE
    // of image generation), so it is only sent when explicitly requested.
    if (opts.watermark === true) body.watermark = true;
    if (opts.service_tier === 'flex' || opts.service_tier === 'default') {
      body.service_tier = opts.service_tier;
    }

    return body;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }

  // ─── Speech-to-text ────────────────────────────────────────────────────

  /**
   * There is no `/audio/transcriptions` on ModelArk — live-verified as an
   * absent route (200 + empty body). Transcription is an LLM UNDERSTANDING
   * task instead: a chat completion carrying an `input_audio` content part.
   *
   * Honest caveat, stated plainly: this is NOT a drop-in Whisper
   * equivalent. Output formatting is prompt-dependent rather than
   * schema-guaranteed, and the advertised extras (word/sentence timestamps,
   * speaker diarization, speech translation) are all driven by prompt
   * wording, not by parameters. `supports.speechToText` is deliberately NOT
   * declared in the catalog row for that reason — the capability is
   * implemented and callable, but not advertised to the router until its
   * quality is measured against a real ASR provider.
   *
   * `format` is REQUIRED by the API whenever inline `data` is used and must
   * match the real file. Accepted: mp3 (audio/mpeg), wav, aac, m4a.
   * Limits: ≤ 25 MB and ≤ 120 minutes per request.
   *
   * ### The advertised ASR surface IS reachable — through the prompt
   *
   * ModelArk advertises 19-language ASR, word/sentence timestamps, subtitle
   * alignment, multi-speaker diarization (`[spkN][start-end] text`) and
   * speech translation across 15 languages, and states outright that "all of
   * it is prompt-driven, not parameter-driven". A single hardcoded
   * "transcribe verbatim" prompt therefore makes most of the capability
   * unreachable. `options` opens it up without inventing anything:
   *
   *   · `options.prompt`       — replaces the built-in instruction outright.
   *   · `options.timestamps`   — ask for sentence/word timings.
   *   · `options.diarize`      — ask for `[spkN][start-end] …` speaker turns.
   *   · `options.translateTo`  — transcribe AND translate into that language.
   *
   * The composed default remains "verbatim, transcript only" so existing
   * callers see no behaviour change.
   *
   * ### Audio source
   *
   * `input_audio` accepts `data` (inline base64), `url`, or `file_id`.
   * `AudioSTTRequest.audio` is a Buffer, so inline is the default — but
   * `options.audio_url` / `options.file_id` let a caller point at audio that
   * is already in ModelArk storage instead of re-uploading it inline (and
   * `format` is only required for the inline form).
   */
  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const opts = request.options ?? {};
    const inputAudio: Record<string, unknown> =
      typeof opts.file_id === 'string' && opts.file_id
        ? { file_id: opts.file_id }
        : typeof opts.audio_url === 'string' && opts.audio_url
          ? { url: opts.audio_url }
          : {
              data: request.audio.toString('base64'),
              format: this.resolveAudioFormat(request.options),
            };

    const response = await this.chatCompletion({
      model: model.name || model.id,
      messages: [
        narrowAs<ChatMessage>({
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: inputAudio },
            { type: 'text', text: this.buildTranscriptionPrompt(request) },
          ],
        }),
      ],
      max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : 4096,
    });

    return {
      text: this.extractTextFromChatContent(response.choices?.[0]?.message?.content),
      raw: response,
    };
  }

  /** @see speechToText — every ASR extra on this platform is prompt-driven. */
  private buildTranscriptionPrompt(request: AudioSTTRequest): string {
    const opts = request.options ?? {};
    if (typeof opts.prompt === 'string' && opts.prompt.trim()) return opts.prompt;

    const parts: string[] = ['Transcribe this audio verbatim.'];
    if (request.language) parts.push(`The spoken language is ${request.language}.`);
    if (opts.diarize === true) {
      parts.push(
        'There are multiple speakers: label every turn as [spkN][start-end] followed by that ' +
          "speaker's words."
      );
    } else if (opts.timestamps === true) {
      parts.push('Prefix each sentence with its [start-end] timestamp.');
    }
    if (typeof opts.translateTo === 'string' && opts.translateTo.trim()) {
      parts.push(`Then translate the transcript into ${opts.translateTo}.`);
    }
    // Only claim "transcript only" when nothing extra was asked for —
    // otherwise it contradicts the instruction directly above it.
    if (opts.diarize !== true && opts.timestamps !== true && !opts.translateTo) {
      parts.push('Return only the transcript text.');
    }
    return parts.join(' ');
  }

  private resolveAudioFormat(options: Record<string, unknown> | undefined): string {
    const ALLOWED = new Set(['mp3', 'wav', 'aac', 'm4a']);
    const explicit = options?.format;
    if (typeof explicit === 'string' && ALLOWED.has(explicit.toLowerCase())) {
      return explicit.toLowerCase();
    }
    const filename = options?.filename;
    if (typeof filename === 'string') {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext && ALLOWED.has(ext)) return ext;
    }
    const mime = options?.mimeType;
    if (typeof mime === 'string') {
      if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
      if (mime.includes('wav')) return 'wav';
      if (mime.includes('aac')) return 'aac';
      if (mime.includes('m4a') || mime.includes('mp4')) return 'm4a';
    }
    return 'mp3';
  }

  /**
   * Not supported, and not a gap that can be closed by code. ~253 pages of
   * official documentation contain no speech-synthesis endpoint and no
   * voice ids, and `/audio/speech` is an absent route on the live API.
   * Seedance's `generate_audio: true` produces an audio track INSIDE a
   * generated video — it is not text-to-speech and cannot be driven from
   * an `AudioTTSRequest`.
   */
  async textToSpeech(_model: Model, _request: AudioTTSRequest): Promise<AudioTTSResponse> {
    throw new Error(
      'byteplus: textToSpeech is not supported — ModelArk publishes no speech-synthesis ' +
        'endpoint or voice catalog. Seedance `generate_audio` is a video soundtrack, not TTS.'
    );
  }

  /**
   * Not supported as a standalone call. ModelArk exposes moderation only as
   * OUTPUT-side metadata on visual-understanding responses
   * (`moderation_hit_type` ∈ {severe_violation, violence} plus
   * `finish_reason: 'content_filter'`), gated on an out-of-band console
   * setting. ci's `ModerationResponse.categories` is a closed 11-key
   * record; a two-value taxonomy cannot fill it without inventing
   * classifications, and `severe_violation` has no corresponding key at
   * all. `chatCompletion` surfaces both signals instead.
   */
  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error(
      'byteplus: moderation is not supported — ModelArk has no /moderations endpoint. ' +
        'Moderation surfaces only as choices[].moderation_hit_type and finish_reason=content_filter ' +
        'on chat responses, which chatCompletion() preserves.'
    );
  }

  // ─── Tokenization (no base-contract method — exposed for direct callers) ─

  /**
   * `POST /tokenization`. Not part of `ProviderAdapter`, so it is offered
   * as a plain method rather than smuggled through an unrelated one.
   *
   * Notable: this is the ONE model-scoped endpoint that works on this
   * account today — it does not check model entitlement, so it returns real
   * `token_ids` and `offset_mapping` even for models that 404 `ModelNotOpen`
   * on inference. That makes it viable as a deeper health probe than
   * `GET /ping`, but {@link healthCheck} does NOT currently use it: the
   * health path is `/ping` and nothing else. Wiring it in would mean picking
   * a model id to probe with, which `healthCheck` has no way to choose.
   *
   * Text only ("The current interface only supports text messages"), and the
   * token ids are ModelArk's own — NOT OpenAI's tokenizer. They are the ids
   * `logit_bias` expects.
   */
  async countTokens(model: string, text: string | string[]): Promise<number[]> {
    const payload = await this.request<ArkTokenizationResponse>('/tokenization', {
      method: 'POST',
      body: { model: this.normalizeModelName(model), text },
    });
    return (payload.data ?? []).map((d) => d.total_tokens ?? 0);
  }

  /**
   * `POST /batch/chat/completions` — Bearer-auth, live-confirmed present,
   * and a byte-identical request/response contract to `/chat/completions`.
   * The ONLY difference is that `model` must be a BATCH ENDPOINT id
   * (`ep-bi-…`), which is provisioned in the Ark Console; a plain model id
   * is rejected. It is synchronous but long-blocking (the queue is served at
   * a lower priority in exchange for ~50% pricing), so it gets the stream
   * timeout rather than the request timeout.
   *
   * Offered as a plain public method for the same reason as
   * {@link countTokens}: `ProviderAdapter` has no batch contract, and
   * smuggling it through `chatCompletion` would silently change a caller's
   * latency profile by an order of magnitude.
   */
  async batchChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildChatBody(request, false);
    const model = String(body.model);
    if (!model.startsWith('ep-bi-')) {
      throw new Error(
        `byteplus: batchChatCompletion requires a BATCH endpoint id (ep-bi-…), got '${model}'. ` +
          'Create one in the Ark Console — plain model ids are rejected on /batch/chat/completions.'
      );
    }
    const response = await fetch(`${this.baseUrl}/batch/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
      // Batch is deliberately slow; the standard request timeout would abort
      // a job that was going to succeed.
      signal: AbortSignal.timeout(this.streamTimeoutMs()),
    });
    if (!response.ok) throw await this.toArkError(response, 'batch chat completion');
    const payload = (await response.json()) as ArkChatCompletion;
    return this.toChatResponse(payload, model);
  }

  /**
   * `POST /files` (multipart) — the prerequisite for the `file_id` form of
   * every document / video / audio content part, and the only way past the
   * 64 MB request-body ceiling.
   *
   * `purpose` is REQUIRED and the documented data-plane value is
   * `user_data` — NOT OpenAI's `assistants`/`batch`. `file` and `url` are
   * mutually exclusive ("cannot be passed at the same time").
   *
   * Returns the raw upstream record; `id` is the `file_id` to quote in a
   * content part. No `ProviderAdapter` contract covers uploads, so this is a
   * plain method (see {@link countTokens}).
   */
  async uploadFile(
    file: { data: Buffer; filename: string; contentType?: string } | { url: string },
    options: { purpose?: string; preprocessVideoFps?: number } = {}
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('purpose', options.purpose ?? 'user_data');
    if ('url' in file) {
      form.append('url', file.url);
    } else {
      form.append(
        'file',
        new Blob([new Uint8Array(file.data)], {
          type: file.contentType ?? 'application/octet-stream',
        }),
        file.filename
      );
    }
    if (typeof options.preprocessVideoFps === 'number') {
      form.append('preprocess_configs[video][fps]', String(options.preprocessVideoFps));
    }

    // NB: no Content-Type header — fetch must set the multipart boundary.
    const headers = this.buildHeaders(false);
    delete headers['Content-Type'];

    const response = await fetch(`${this.baseUrl}/files`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(this.streamTimeoutMs()),
    });
    if (!response.ok) throw await this.toArkError(response, 'file upload');
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * 3D asset generation. It runs on the SAME `/contents/generations/tasks`
   * submit→poll route as video — the modality is chosen by `model` alone —
   * and the only real difference is where the result lands: `content
   * .file_url` instead of `content.video_url`. That field was already typed
   * on {@link ArkVideoTask} and never read.
   *
   * Kept separate from {@link videoGenerate} rather than folded into it:
   * `VideoGenResponse.format` is `'mp4'|'webm'|string` and a 3D asset is
   * neither, so returning one through the video contract would mislabel it.
   * Returns the terminal task record, with `file_url` promoted for
   * convenience.
   */
  async generateAsset3D(
    model: Model,
    request: VideoGenRequest
  ): Promise<{ id: string; url: string; raw: ArkVideoTask }> {
    const modelId = this.normalizeModelName(model.name || model.id);
    const task = await this.submitAndPollGenerationTask(
      modelId,
      this.buildVideoBody(modelId, request),
      '3D generation'
    );
    const url = task.content?.file_url;
    if (!url) {
      throw new Error(
        `byteplus: 3D task ${String(task.id)} succeeded but content.file_url is absent`
      );
    }
    return { id: String(task.id ?? ''), url, raw: task };
  }

  // ─── Health / cost / naming ────────────────────────────────────────────

  /**
   * `GET {hostRoot}/ping` — the documented connectivity probe. It sits at
   * the HOST ROOT, not under `/api/v3`, so it cannot be expressed as a
   * catalog `paths.health` entry (those are joined onto the versioned
   * base). Live-verified: 200 `{"message":"pong"}` with a valid key, 401
   * without one — so it is a genuine auth probe, not an anonymous liveness
   * check, and it costs nothing and bills nothing.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: 'BYTEPLUS_API_KEY is not configured',
      };
    }
    try {
      const res = await fetch(`${this.hostRoot}/ping`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: `byteplus HTTP ${res.status} — BYTEPLUS_API_KEY rejected`,
        };
      }
      return { healthy: res.ok, checkedAt: new Date(), latency: Date.now() - start };
    } catch (error) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Catalog `pricingMode: 'none'`. ModelArk publishes pricing, but no
   * per-model unit prices were extracted, and fabricating rates is worse
   * than reporting zero. Two notes for whoever adds real pricing: image
   * billing is on `usage.generated_images`, and video/3D billing is on
   * `usage.completion_tokens` with input tokens always 0.
   */
  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  /**
   * Identity. Deliberately does NOT string-munge: the platform normalises
   * dotted forms to dashed ones SERVER-side (`doubao-1.5-pro-32k 250115` →
   * `doubao-1-5-pro-32k-250115`) and its own docs print both spellings for
   * the same model. Echo what the API returned rather than constructing
   * ids. Endpoint ids (`ep-…`, `ep-m-…`, `ep-bi-…`) are equally valid in
   * the `model` field and pass through untouched — unlike China-Ark,
   * BytePlus accepts plain model ids everywhere.
   */
  normalizeModelName(modelName: string): string {
    return (modelName ?? '').trim();
  }

  // ─── HTTP plumbing ─────────────────────────────────────────────────────

  private buildHeaders(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      // Caller-supplied correlation id. BytePlus support matches logs on
      // this, and it costs nothing to always send.
      'X-Client-Request-Id': `ailin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /** Deep-reasoning models can stall between packets; docs recommend >30min. */
  private streamTimeoutMs(): number {
    return Math.max(this.config.timeout ?? 60_000, 1_800_000);
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<T> {
    const hasBody = init.body !== undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: this.buildHeaders(hasBody),
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(this.config.timeout ?? 60_000),
    });

    const text = await response.text();
    if (!response.ok) throw this.buildArkError(response.status, text, path);

    // The 200-empty-body absent-route signal (see the class doc comment).
    // Treating it as "success with no data" would let a nonexistent route
    // masquerade as an empty result set forever.
    if (text.length === 0) {
      throw new Error(
        `byteplus: ${init.method} ${path} returned HTTP 200 with an EMPTY body — on ModelArk that is ` +
          'the signature of a route that does not exist, not an empty result.'
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `byteplus: ${init.method} ${path} returned unparseable JSON: ${text.slice(0, 200)}`
      );
    }
  }

  private async toArkError(response: Response, context: string): Promise<Error> {
    const text = await response.text().catch(() => '');
    return this.buildArkError(response.status, text, context);
  }

  /**
   * ModelArk's error envelope is `{"error":{code,message,param,type}}`
   * where `type` carries the HTTP-ish class (`Unauthorized`, `Not Found`)
   * and `code` the specific name (`AuthenticationError`, `ModelNotOpen`).
   * Messages embed a `Request id:0217…` — always logged, because BytePlus
   * support keys off it.
   *
   * `ModelNotOpen` gets an explicitly actionable message: it is NOT a
   * model-not-found and NOT a code defect. The platform resolved the model
   * and matched it to the account, then refused on entitlement. An unknown
   * model id returns `InvalidEndpointOrModel.NotFound` instead — that
   * contrast is what makes the distinction reliable.
   */
  private buildArkError(status: number, text: string, context: string): Error {
    let code = '';
    let message = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as ArkErrorEnvelope;
      code = parsed.error?.code ?? '';
      message = parsed.error?.message ?? message;
    } catch {
      /* non-JSON body — keep the raw prefix */
    }

    const requestId = /[Rr]equest id[:\s]+([0-9a-f]+)/.exec(message)?.[1];

    let hint = '';
    if (code === 'ModelNotOpen') {
      hint =
        ' [OPERATOR ACTION REQUIRED: the key is valid and the model exists, but this BytePlus ' +
        'account has not activated it. Enable the model service in the Ark Console ' +
        '(console.byteplus.com → ModelArk → Model Activation). This is not an integration defect.]';
    } else if (code === 'InvalidEndpointOrModel.ModelIDAccessDisabled') {
      hint =
        ' [OPERATOR ACTION REQUIRED: this account forbids calling by model ID. Use a custom ' +
        'endpoint id (ep-…) as the model field instead.]';
    } else if (code === 'InvalidEndpointOrModel.NotFound') {
      hint = ' [The model id does not exist in this region — check GET /models for valid ids.]';
    } else if (code === 'SetLimitExceeded') {
      hint = ' [NOT retryable: Free-Tokens-Only account pause. Backing off will not clear it.]';
    } else if (status === 400 && /tool_choice|tools\b/i.test(message)) {
      // The one request field whose correct value is genuinely unsettled.
      // sendChatBody() already retries once with the alternate discriminator;
      // this hint is for the case where BOTH were rejected, so the operator
      // is not left guessing.
      hint =
        ` [If this names the tool schema: tools[].type is sent as '${CHAT_TOOLS_TYPE}' and ` +
        `tool_choice.type as '${CHAT_TOOL_CHOICE_TYPE}' — the vendor doc's field table and its own ` +
        'worked example disagree, so one retry with the flipped discriminator has already been ' +
        'attempted. See CHAT_TOOLS_TYPE in byteplus-adapter.ts.]';
    }

    this.blog.warn({ status, code, requestId, context }, 'byteplus: upstream error');
    return new ArkHttpError(`byteplus ${context} HTTP ${status} [${code}]: ${message}${hint}`, status, code, requestId);
  }

  /**
   * Refines the base 4xx-means-do-not-retry rule for ModelArk's split 429
   * taxonomy. Without this, either every 429 is retried (spinning forever
   * on the non-retryable `SetLimitExceeded` account pause, while failed
   * requests keep counting against the per-minute limit) or none is (giving
   * up immediately on a transient `ServerOverloaded`).
   */
  protected override isClientError(error: unknown): boolean {
    if (error instanceof ArkHttpError && error.status === 429) {
      return !RETRYABLE_429_CODES.has(error.code);
    }
    return super.isClientError(error);
  }

  /**
   * Buffer/base64/URL → the `data:image/<format>;base64,…` form ModelArk
   * requires, with the format SNIFFED from the bytes rather than hardcoded.
   * The base class hardcodes `png` here; ModelArk validates the declared
   * format against the payload and accepts jpeg/png/webp/bmp/tiff/gif/
   * heic/heif, so announcing a JPEG as PNG is a real failure mode.
   */
  private toImageDataUrl(image: Buffer | string): string {
    if (Buffer.isBuffer(image)) {
      return `data:image/${this.sniffImageMime(image)};base64,${image.toString('base64')}`;
    }
    const trimmed = image.trim();
    if (!trimmed) throw new Error('byteplus: vision request image is empty');
    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      return trimmed;
    }
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 32) {
      const compact = trimmed.replace(/\s+/g, '');
      const mime = this.sniffImageMime(Buffer.from(compact, 'base64'));
      return `data:image/${mime};base64,${compact}`;
    }
    return trimmed;
  }
}
