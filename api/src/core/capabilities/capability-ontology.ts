// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-ontology.ts — single source of truth for capability identity.
 *
 * MVP 5A invariants:
 *   - Pure data + a tiny interface. No I/O, no provider call.
 *   - DOES NOT name any model family. The ontology is about CAPABILITIES
 *     (`chat`, `tools`, `vision`, …), not about MODELS (`gpt`, `claude`, …).
 *     The `model-capability-document-no-name-hardcode` lint asserts this.
 *   - Aliases here are CAPABILITY aliases (`function_calling` ≡ `tools`),
 *     never model aliases.
 *
 * Each capability has:
 *   - `id`: canonical key used everywhere downstream.
 *   - `aliases`: alternate forms tolerated on input (lowercased).
 *   - `routeFlag`: when present, names the boolean field on
 *     `ProviderModelRoute` that records support for this capability.
 *   - `canonicalUri`: the HCRA/ADR-022 ontology URI (`capability/ontology/seed.ts`).
 *
 * ─── Unification (LOTE AO, 2026-09-05) ──────────────────────────────────
 * This table used to carry 14 entries while THREE other vocabularies
 * described the same domain:
 *   1. `ModelCapability` / `MODEL_CAPABILITIES` (types/index.ts) — the
 *      catalog enum, now 78 entries.
 *   2. `ONTOLOGY_SEED` (capability/ontology/seed.ts) — the SKOS-style URI
 *      graph, kept 1:1 with (1) by `legacy-capability-uri.test.ts`.
 *   3. this file — the runtime identity/normalisation layer.
 * Everything in (1)/(2) now RESOLVES here (`capabilityOntology.has(x)` is
 * true for every `MODEL_CAPABILITIES` member), enforced by
 * `capability-ontology-coverage.test.ts`.
 *
 * Canonical id vs alias — the rule used below:
 *   - An entry is CANONICAL when it names a distinct capability.
 *   - An entry is an ALIAS only when it is a spelling/format variant or an
 *     exact synonym of a canonical id (`function_calling` ≡ `tools`,
 *     `embedding` ≡ `embeddings`, `completions` ≡ `chat`).
 *   - Semantic merges of DIFFERENT capabilities are forbidden. The previous
 *     table merged `text_to_speech` AND `speech_to_text` into a single
 *     `audio_generation` id, so nothing downstream could tell the two audio
 *     DIRECTIONS apart. That merge is undone here: `audio_generation` is
 *     output-only (TTS) and `speech_to_text` / `audio_input` are the input
 *     side.
 *
 * ─── `routeFlag` is coarse on purpose ───────────────────────────────────
 * `ProviderModelRoute` has ONE `supportsAudio` boolean, derived in
 * `registry-builder.ts` from any audio tag in either direction. Every audio
 * id below therefore keeps `routeFlag: 'supportsAudio'`: the flag is a
 * structural PRE-filter ("this route speaks audio at all"), never the
 * direction proof. Direction now lives in the canonical id, which is what
 * the document builder, capability search and the orchestration modality
 * gate read. Splitting `supportsAudio` into
 * `supportsAudioInput`/`supportsAudioOutput` is the follow-up that makes the
 * structural filter directional too; until then, DO NOT rely on the flag to
 * separate TTS from STT.
 *
 * ─── Relationship to `providers.catalog.ts#supports` ────────────────────
 * The provider catalog carries a FOURTH, deliberately coarser vocabulary:
 * ~16 provider-level modality booleans. It describes what a PROVIDER's API
 * surface offers, not what an individual model does, so it is not merged
 * into this table. The correspondence is formal and 1:1 —
 * `CATALOG_SUPPORTS_TO_CAPABILITY` below is the mapping, asserted by
 * `capability-ontology-coverage.test.ts` to resolve against this ontology.
 */

import type { ProviderModelRoute } from '../registry/model-route';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CapabilityDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly routeFlag?: keyof ProviderModelRoute;
  readonly canonicalUri?: string;
}

export interface CapabilityOntology {
  /** Normalises any input form to its canonical id (or returns lowercase input). */
  normalize(input: string): string;
  /** Returns the definition for the canonical id (or any of its aliases). */
  get(id: string): CapabilityDefinition | undefined;
  /** Returns true if the id (canonical or alias) is part of the ontology. */
  has(id: string): boolean;
  /** Returns the full list of canonical definitions. */
  all(): readonly CapabilityDefinition[];
}

// ─── Canonical URI helper (ADR-022) ─────────────────────────────────────

/**
 * Mirrors `CAPABILITY_URI_PREFIX` in `capability/legacy-capability-uri.ts`.
 * Duplicated as a literal (not imported) to keep this module dependency-free
 * per the MVP 5A "pure data" invariant; the two are asserted equal by
 * `capability-ontology-coverage.test.ts`.
 */
const URI_PREFIX = 'http://ailin.dev/cap/v1/';

/**
 * Canonical ids that exist ONLY in this runtime ontology — they are routing
 * / policy concepts, not catalog capability tags, so they have no
 * `ONTOLOGY_SEED` slug and therefore no canonical URI.
 */
const ONTOLOGY_ONLY_IDS: ReadonlySet<string> = new Set([
  'code',
  'local',
  'math',
  'multilingual',
  'self_hosted',
]);

/**
 * Canonical ids whose ONTOLOGY_SEED slug is spelled differently. Only one
 * case exists: this table's canonical name for tool use is `tools`, while
 * the catalog enum (and therefore the seed, and therefore every
 * `capability_uris` row) spells it `function_calling`. The URI must point at
 * the row that actually exists.
 */
const URI_SLUG_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  tools: 'function_calling',
});

// ─── Capability table ───────────────────────────────────────────────────

interface RawCapability {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly routeFlag?: keyof ProviderModelRoute;
}

/**
 * The canonical ontology table. Order is alphabetical for stability;
 * tests assert this order is preserved.
 *
 * Each `aliases` array MUST be lowercase and globally unique — an alias may
 * point at exactly one canonical id (asserted by the coverage test).
 */
const RAW_CAPABILITIES: readonly RawCapability[] = [
  {
    id: 'agents',
    aliases: ['agent', 'agentic', 'agentic_workflow', 'agentic-workflow'],
  },
  {
    id: 'analysis',
    aliases: ['analyze', 'analytical', 'data_analysis', 'data-analysis'],
  },
  {
    // Direction-UNSPECIFIED audio tag. Kept as its own id (rather than folded
    // into `audio_generation`, as it was pre-LOTE-AO) precisely because the
    // direction is unknown: folding it would have asserted "output".
    id: 'audio',
    aliases: ['audio_modality', 'audio-modality'],
    routeFlag: 'supportsAudio',
  },
  {
    // OUTPUT side only (TTS / speech synthesis). See the routeFlag note in
    // the module header.
    id: 'audio_generation',
    aliases: [
      'audio-generation',
      'audio_output',
      'audio-output',
      'tts',
      'text_to_speech',
      'text-to-speech',
      'speech_synthesis',
      'speech-synthesis',
      'voice_generation',
      'voice-generation',
    ],
    routeFlag: 'supportsAudio',
  },
  {
    // INPUT side, modality level ("accepts audio"). The TASK performed on
    // that audio is `speech_to_text` / `diarization` / `audio_to_audio`.
    id: 'audio_input',
    aliases: ['audio-input', 'audio_in', 'audio-in', 'listen', 'speech_input', 'speech-input'],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'audio_to_audio',
    aliases: [
      'audio-to-audio',
      'speech_to_speech',
      'speech-to-speech',
      'sts',
      'voice_conversion',
      'voice-conversion',
    ],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'chat',
    aliases: [
      'chat-completion',
      'chat_completion',
      'text_generation',
      'text-generation',
      'completion',
      'completions',
      'conversational',
    ],
  },
  {
    id: 'code',
    aliases: ['code-generation', 'code_generation', 'coding', 'programming', 'code_gen', 'code-gen'],
  },
  {
    id: 'code_completion',
    aliases: ['code-completion', 'fim', 'fill_in_middle', 'fill-in-middle', 'autocomplete'],
  },
  {
    id: 'code_edit',
    aliases: ['code-edit', 'apply_edit', 'apply-edit', 'structured_edit', 'structured-edit'],
  },
  {
    // Downloadable SOURCE FILE generation — NOT `code` (writing code in a
    // chat answer). The name collision that motivated the split is
    // documented in `capability-inference.ts`.
    id: 'code_file_generation',
    aliases: ['code-file-generation', 'source_file_generation'],
  },
  {
    id: 'code_interpreter',
    aliases: ['code-interpreter', 'code_execution', 'code-execution', 'sandbox_execution'],
  },
  {
    id: 'code_review',
    aliases: ['code-review', 'review_code', 'review-code'],
  },
  {
    id: 'computer_use',
    aliases: ['computer-use', 'gui_control', 'gui-control', 'browser_use', 'browser-use'],
  },
  {
    id: 'csv_generation',
    aliases: ['csv-generation', 'csv'],
  },
  {
    id: 'debugging',
    aliases: ['debug', 'bug_fixing', 'bug-fixing'],
  },
  {
    id: 'deep_compute',
    aliases: ['deep-compute', 'extended_compute', 'extended-compute'],
  },
  {
    id: 'deep_research',
    aliases: ['deep-research'],
  },
  {
    id: 'deep_search',
    aliases: ['deep-search'],
  },
  {
    id: 'diarization',
    aliases: ['speaker_diarization', 'speaker-diarization'],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'documentation',
    aliases: ['docs', 'technical_writing', 'technical-writing'],
  },
  {
    id: 'docx_generation',
    aliases: ['docx-generation', 'word_generation', 'word-generation'],
  },
  {
    id: 'embeddings',
    aliases: ['embedding', 'embed', 'vectorization', 'text_embedding', 'text-embedding'],
  },
  {
    id: 'file_generation',
    aliases: ['file-generation', 'generate_file', 'generate-file'],
  },
  {
    id: 'file_search',
    aliases: ['file-search'],
  },
  {
    id: 'health',
    aliases: ['health_domain', 'health-domain', 'medical'],
  },
  {
    id: 'image_captioning',
    aliases: ['image-captioning', 'captioning', 'alt_text', 'alt-text'],
  },
  {
    id: 'image_denoise',
    aliases: ['image-denoise', 'denoise', 'denoising'],
    routeFlag: 'supportsImages',
  },
  {
    // Split out of `image_generation` (where `image_edit` was an alias):
    // editing consumes an input image, generation does not.
    id: 'image_editing',
    aliases: ['image-editing', 'image_edit', 'image-edit', 'inpainting', 'outpainting', 'img2img'],
    routeFlag: 'supportsImages',
  },
  {
    id: 'image_generation',
    aliases: ['image-generation', 'image-gen', 'text_to_image', 'text-to-image', 'txt2img'],
    routeFlag: 'supportsImages',
  },
  {
    id: 'image_to_video',
    aliases: ['image-to-video', 'img2vid'],
  },
  {
    id: 'image_upscale',
    aliases: ['image-upscale', 'upscale', 'upscaling', 'super_resolution', 'super-resolution'],
    routeFlag: 'supportsImages',
  },
  {
    id: 'json_generation',
    aliases: ['json-generation'],
  },
  {
    id: 'json_mode',
    aliases: [
      'json',
      'json-mode',
      'json_output',
      'json-output',
      'json_object',
      'json_schema',
      'structured_output',
      'structured-output',
    ],
    routeFlag: 'supportsJson',
  },
  {
    id: 'local',
    aliases: ['on-device', 'on_device'],
  },
  {
    id: 'long_context',
    aliases: ['long-context', 'large-context', 'extended_context', 'extended-context'],
  },
  {
    id: 'markdown_generation',
    aliases: ['markdown-generation', 'md_generation', 'md-generation'],
  },
  {
    id: 'math',
    aliases: ['mathematics', 'numerical', 'math_reasoning', 'math-reasoning'],
  },
  {
    id: 'mcp',
    aliases: ['model_context_protocol', 'model-context-protocol'],
  },
  {
    id: 'moderation',
    aliases: [
      'content_moderation',
      'content-moderation',
      'safety_classifier',
      'safety-classifier',
      'harm_detection',
      'harm-detection',
    ],
  },
  {
    id: 'multilingual',
    aliases: ['multi-lingual', 'multilang', 'cross_lingual', 'cross-lingual'],
  },
  {
    id: 'multimodal',
    aliases: ['multi-modal', 'mixed-modality', 'mixed_modality'],
  },
  {
    // Music/soundtrack composition — distinct from `audio_generation` (TTS):
    // structured composition plans, minutes-long output, no "spoken text"
    // input. Added LOTE AX (2026-09-06), ElevenLabs Music onboarding.
    id: 'music_generation',
    aliases: [
      'music-generation',
      'music',
      'soundtrack_generation',
      'soundtrack-generation',
      'song_generation',
      'song-generation',
    ],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'pdf_generation',
    aliases: ['pdf-generation'],
  },
  {
    // Closest thing the catalog has to OCR — document/PDF understanding.
    id: 'pdf_understanding',
    aliases: [
      'pdf-understanding',
      'pdf',
      'document_understanding',
      'document-understanding',
      'ocr',
    ],
  },
  {
    id: 'pptx_generation',
    aliases: [
      'pptx-generation',
      'powerpoint_generation',
      'powerpoint-generation',
      'slide_generation',
      'slides_generation',
    ],
  },
  {
    id: 'qa',
    aliases: ['question_answering', 'question-answering', 'factual_qa', 'factual-qa'],
  },
  {
    id: 'realtime',
    aliases: ['real-time', 'real_time', 'live'],
  },
  {
    id: 'realtime_audio',
    aliases: ['realtime-audio', 'live_audio', 'live-audio', 'voice_live', 'voice-live'],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'reasoning',
    // `thinking` stays here (legacy alias predating `thinking_mode`); the
    // richer `thinking_mode` tag is its own id below.
    aliases: ['reasoner', 'chain_of_thought', 'chain-of-thought', 'thinking'],
  },
  {
    id: 'refactoring',
    aliases: ['refactor', 'code_refactoring', 'code-refactoring'],
  },
  {
    id: 'reranking',
    aliases: ['rerank', 're-ranking', 're_ranking', 'reranker'],
  },
  {
    id: 'research',
    aliases: ['research_assistant', 'research-assistant'],
  },
  {
    id: 'retrieval',
    aliases: ['rag', 'retrieval_augmented', 'retrieval-augmented'],
  },
  {
    id: 'safety',
    aliases: ['safety_rated', 'safety-rated', 'guardrails'],
  },
  {
    id: 'self_hosted',
    aliases: ['self-hosted', 'on-prem', 'on_prem'],
  },
  {
    // INPUT side, task level. Was an ALIAS of `audio_generation` before
    // LOTE AO — the merge that made STT indistinguishable from TTS.
    id: 'speech_to_text',
    aliases: [
      'speech-to-text',
      'stt',
      'asr',
      'automatic_speech_recognition',
      'automatic-speech-recognition',
      'transcription',
      'transcribe',
    ],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'streaming',
    aliases: ['stream', 'sse', 'incremental_output'],
    routeFlag: 'supportsStreaming',
  },
  {
    id: 'testing',
    aliases: ['test_generation', 'test-generation', 'unit_testing', 'unit-testing'],
  },
  {
    id: 'thinking_mode',
    aliases: ['thinking-mode', 'extended_thinking', 'extended-thinking'],
  },
  {
    id: 'tools',
    aliases: [
      'function_calling',
      'function-calling',
      'tool_use',
      'tool-use',
      'tool_calling',
      'tool-calling',
    ],
    routeFlag: 'supportsTools',
  },
  {
    id: 'translation',
    aliases: ['translate', 'machine_translation', 'machine-translation'],
  },
  {
    id: 'video_editing',
    aliases: ['video-editing'],
  },
  {
    id: 'video_generation',
    aliases: ['video-generation', 'text_to_video', 'text-to-video', 'txt2vid'],
  },
  {
    id: 'video_to_text',
    aliases: ['video-to-text'],
  },
  {
    id: 'video_to_video',
    aliases: ['video-to-video', 'vid2vid'],
  },
  {
    id: 'video_transcription',
    aliases: ['video-transcription'],
  },
  {
    id: 'video_understanding',
    aliases: ['video-understanding', 'video_input', 'video-input'],
  },
  {
    id: 'vision',
    aliases: [
      'image_understanding',
      'image-understanding',
      'visual',
      'multimodal_vision',
      'image_input',
      'image-input',
    ],
    routeFlag: 'supportsVision',
  },
  {
    id: 'visual_question_answering',
    aliases: ['visual-question-answering', 'vqa'],
  },
  {
    id: 'web_search',
    aliases: ['web-search', 'online_search', 'online-search', 'browse'],
  },
  {
    id: 'xlsx_generation',
    aliases: [
      'xlsx-generation',
      'excel_generation',
      'excel-generation',
      'spreadsheet_generation',
      'spreadsheet-generation',
    ],
  },
  {
    id: 'zip_generation',
    aliases: ['zip-generation', 'archive_generation', 'archive-generation'],
  },
];

const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze(
  RAW_CAPABILITIES.map((raw) =>
    Object.freeze({
      ...raw,
      ...(ONTOLOGY_ONLY_IDS.has(raw.id)
        ? {}
        : { canonicalUri: `${URI_PREFIX}${URI_SLUG_OVERRIDES[raw.id] ?? raw.id}` }),
    })
  )
);

// ─── Provider-catalog `supports` ↔ ontology mapping ─────────────────────

/**
 * Formal correspondence between `ProviderCatalogEntry.supports` (the
 * provider-level modality booleans in `providers.catalog.ts`) and the
 * capability ontology.
 *
 * Why a mapping and not a schema migration: `supports` describes a
 * PROVIDER's API surface (~230 rows declare it), while the ontology
 * describes a MODEL's capability. Rewriting the catalog field to ontology
 * ids would touch every provider row for no behavioural gain — the catalog
 * flags are already consumed as *hints* by the capability merger. This map
 * makes the relation explicit and testable instead of implicit.
 *
 * `responses` has no capability of its own: it is a WIRE PROTOCOL (the
 * OpenAI Responses API surface), not a capability, and maps to `chat`.
 */
export const CATALOG_SUPPORTS_TO_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  chat: 'chat',
  responses: 'chat',
  embeddings: 'embeddings',
  rerank: 'reranking',
  moderation: 'moderation',
  speechToText: 'speech_to_text',
  textToSpeech: 'audio_generation',
  imageGeneration: 'image_generation',
  imageEditing: 'image_editing',
  videoGeneration: 'video_generation',
  streaming: 'streaming',
  tools: 'tools',
  jsonMode: 'json_mode',
  vision: 'vision',
  reasoning: 'reasoning',
  realtime: 'realtime',
});

// ─── Implementation ─────────────────────────────────────────────────────

class CapabilityOntologyImpl implements CapabilityOntology {
  private readonly aliasIndex: ReadonlyMap<string, string>;
  private readonly defIndex: ReadonlyMap<string, CapabilityDefinition>;
  private readonly defs: readonly CapabilityDefinition[];

  constructor(definitions: readonly CapabilityDefinition[]) {
    this.defs = definitions;
    const aliasIndex = new Map<string, string>();
    const defIndex = new Map<string, CapabilityDefinition>();
    for (const def of definitions) {
      defIndex.set(def.id, def);
      aliasIndex.set(def.id.toLowerCase(), def.id);
      for (const a of def.aliases) {
        aliasIndex.set(a.toLowerCase(), def.id);
      }
    }
    this.aliasIndex = aliasIndex;
    this.defIndex = defIndex;
  }

  normalize(input: string): string {
    if (typeof input !== 'string') return '';
    const lc = input.toLowerCase();
    return this.aliasIndex.get(lc) ?? lc;
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.defIndex.get(this.normalize(id));
  }

  has(id: string): boolean {
    return this.defIndex.has(this.normalize(id));
  }

  all(): readonly CapabilityDefinition[] {
    return this.defs;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

export const capabilityOntology: CapabilityOntology = new CapabilityOntologyImpl(CAPABILITIES);

/** Test seam — build a custom ontology in tests without touching the singleton. */
export function buildCapabilityOntology(
  definitions: readonly CapabilityDefinition[]
): CapabilityOntology {
  return new CapabilityOntologyImpl(definitions);
}

/** Raw table — for tests that iterate the canonical set. */
export const __CAPABILITIES_TABLE: readonly CapabilityDefinition[] = CAPABILITIES;

/** The canonical URI prefix this table stamps onto `canonicalUri`. */
export const __CAPABILITY_URI_PREFIX = URI_PREFIX;
