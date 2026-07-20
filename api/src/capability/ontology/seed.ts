// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Ontology Seed (ADR-022, Sprint 1)
 *
 * Maps the 60 capabilities from the legacy `ModelCapability` union (types/index.ts)
 * to URI-keyed ontology entries with synonyms, broader/narrower (SKOS-style),
 * and category. Idempotent: re-runnable via `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * Categories:
 *   modality — input/output channels (vision, audio, video, ...)
 *   task     — what the model does (chat, code_generation, translation, ...)
 *   tool     — affordances exposed to callers (function_calling, mcp, ...)
 *   safety   — safety/policy capabilities (none yet — placeholder for future)
 *   language — language-specific capabilities (none yet — placeholder for future)
 *   meta     — model-level meta capabilities (streaming, json_mode, ...)
 *
 * Why this lives in TypeScript (not pure SQL): the seed needs to stay in sync
 * with the legacy `ModelCapability` union for the migration window. After the
 * union is dropped, seed becomes pure data (YAML).
 */

import type { PrismaClient } from '@/generated/prisma';

const URI_PREFIX = 'http://ailin.dev/cap/v1/';
const uri = (slug: string): string => `${URI_PREFIX}${slug}`;

interface OntologyEntry {
  slug: string;
  preferredLabel: string;
  labels: Record<string, string>;
  synonyms: string[];
  description: string;
  category: 'modality' | 'task' | 'safety' | 'language' | 'tool' | 'meta';
  broader: string[];
  narrower: string[];
}

/**
 * Seed entries. Order matters only for readability — broader/narrower are
 * resolved by URI so forward references are fine.
 */
export const ONTOLOGY_SEED: ReadonlyArray<OntologyEntry> = [
  // ── modality (input/output channels) ──────────────────────────────────────
  {
    slug: 'vision',
    preferredLabel: 'Vision (image input)',
    labels: { en: 'Vision', pt: 'Visão' },
    synonyms: ['image-input', 'image_input', 'multimodal-image', 'image-understanding'],
    description: 'Model accepts image inputs (single or multi-image).',
    category: 'modality',
    broader: [],
    narrower: [uri('image_captioning'), uri('visual_question_answering'), uri('pdf_understanding')],
  },
  {
    slug: 'multimodal',
    preferredLabel: 'Multimodal',
    labels: { en: 'Multimodal', pt: 'Multimodal' },
    synonyms: ['multi-modal', 'mixed-modality'],
    description: 'Accepts more than one input modality (e.g., text + image, text + audio).',
    category: 'modality',
    broader: [],
    narrower: [uri('vision'), uri('audio_input'), uri('video_understanding')],
  },
  {
    slug: 'audio_input',
    preferredLabel: 'Audio input',
    labels: { en: 'Audio input', pt: 'Entrada de áudio' },
    synonyms: ['audio-in', 'speech-input'],
    description: 'Accepts audio inputs (waveform, mp3, etc).',
    category: 'modality',
    broader: [uri('multimodal')],
    narrower: [uri('speech_to_text'), uri('transcription'), uri('diarization'), uri('listen')],
  },
  {
    slug: 'audio_output',
    preferredLabel: 'Audio output',
    labels: { en: 'Audio output', pt: 'Saída de áudio' },
    synonyms: ['audio-out', 'speech-output'],
    description: 'Produces audio outputs.',
    category: 'modality',
    broader: [],
    narrower: [uri('text_to_speech'), uri('audio_generation')],
  },
  {
    slug: 'audio',
    preferredLabel: 'Audio (any direction)',
    labels: { en: 'Audio', pt: 'Áudio' },
    synonyms: ['sound'],
    description: 'Aggregate label: model handles audio in or out. Prefer audio_input/audio_output when known.',
    category: 'modality',
    broader: [],
    narrower: [uri('audio_input'), uri('audio_output')],
  },
  {
    slug: 'audio_to_audio',
    preferredLabel: 'Audio-to-audio',
    labels: { en: 'Audio-to-audio', pt: 'Áudio para áudio' },
    synonyms: ['voice-conversion', 'speech-to-speech'],
    description: 'Audio in, audio out (voice cloning, style transfer, conversational speech).',
    category: 'modality',
    broader: [uri('audio_input'), uri('audio_output')],
    narrower: [uri('realtime_audio')],
  },
  {
    slug: 'video_understanding',
    preferredLabel: 'Video understanding',
    labels: { en: 'Video understanding', pt: 'Compreensão de vídeo' },
    synonyms: ['video-input', 'video-analysis'],
    description: 'Accepts video as input for understanding tasks.',
    category: 'modality',
    broader: [uri('multimodal')],
    narrower: [uri('video_to_text'), uri('video_transcription')],
  },

  // ── task (what the model does) ────────────────────────────────────────────
  {
    slug: 'chat',
    preferredLabel: 'Chat / conversational',
    labels: { en: 'Chat', pt: 'Chat' },
    synonyms: ['conversation', 'dialogue', 'instruct'],
    description: 'General chat / instruction-following conversational interface.',
    category: 'task',
    broader: [uri('text_generation')],
    narrower: [],
  },
  {
    slug: 'completions',
    preferredLabel: 'Text completions',
    labels: { en: 'Completions', pt: 'Completações' },
    synonyms: ['text-completion', 'completion'],
    description: 'Legacy /completions style continuation API.',
    category: 'task',
    broader: [uri('text_generation')],
    narrower: [],
  },
  {
    slug: 'text_generation',
    preferredLabel: 'Text generation',
    labels: { en: 'Text generation', pt: 'Geração de texto' },
    synonyms: ['text-gen', 'nlg'],
    description: 'Produces natural-language text outputs.',
    category: 'task',
    broader: [],
    narrower: [uri('chat'), uri('completions'), uri('translation'), uri('documentation')],
  },
  {
    slug: 'code_generation',
    preferredLabel: 'Code generation',
    labels: { en: 'Code generation', pt: 'Geração de código' },
    synonyms: ['codegen', 'code-gen'],
    description: 'Generates source code from natural-language specs.',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'code_completion',
    preferredLabel: 'Code completion',
    labels: { en: 'Code completion', pt: 'Completação de código' },
    synonyms: ['fim', 'fill-in-the-middle', 'autocomplete'],
    description: 'Inline / fill-in-the-middle code completion (IDE assistant style).',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'coding',
    preferredLabel: 'Coding (umbrella)',
    labels: { en: 'Coding', pt: 'Programação' },
    synonyms: ['programming', 'software-engineering'],
    description: 'Umbrella for code-related tasks (gen, completion, review, debug, refactor, test).',
    category: 'task',
    broader: [],
    narrower: [
      uri('code_generation'), uri('code_completion'), uri('code_review'),
      uri('debugging'), uri('refactoring'), uri('code_interpreter'),
      uri('testing'),
    ],
  },
  {
    slug: 'code_review',
    preferredLabel: 'Code review',
    labels: { en: 'Code review', pt: 'Revisão de código' },
    synonyms: ['pr-review'],
    description: 'Reviews code for bugs, style, security.',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'debugging',
    preferredLabel: 'Debugging',
    labels: { en: 'Debugging', pt: 'Depuração' },
    synonyms: ['debug'],
    description: 'Identifies and fixes bugs in code.',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'refactoring',
    preferredLabel: 'Refactoring',
    labels: { en: 'Refactoring', pt: 'Refatoração' },
    synonyms: ['refactor'],
    description: 'Restructures code without changing behavior.',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'code_interpreter',
    preferredLabel: 'Code interpreter',
    labels: { en: 'Code interpreter', pt: 'Interpretador de código' },
    synonyms: ['python-execution', 'sandbox-execution'],
    description: 'Executes code in a sandbox and reasons about results.',
    category: 'task',
    broader: [uri('coding'), uri('tool_use')],
    narrower: [],
  },
  {
    slug: 'documentation',
    preferredLabel: 'Documentation generation',
    labels: { en: 'Documentation', pt: 'Documentação' },
    synonyms: ['doc-gen', 'docstrings'],
    description: 'Generates documentation, docstrings, README content.',
    category: 'task',
    broader: [uri('text_generation')],
    narrower: [],
  },
  {
    slug: 'testing',
    preferredLabel: 'Test generation',
    labels: { en: 'Testing', pt: 'Testes' },
    synonyms: ['test-gen', 'unit-tests'],
    description: 'Generates tests (unit, integration, property-based).',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    slug: 'analysis',
    preferredLabel: 'Analysis',
    labels: { en: 'Analysis', pt: 'Análise' },
    synonyms: ['data-analysis'],
    description: 'Analyses inputs (data, text, code) and produces structured findings.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'qa',
    preferredLabel: 'Question answering',
    labels: { en: 'QA', pt: 'Perguntas e respostas' },
    synonyms: ['question-answering'],
    description: 'Answers questions over a corpus or context.',
    category: 'task',
    broader: [],
    narrower: [uri('visual_question_answering')],
  },
  {
    slug: 'reasoning',
    preferredLabel: 'Reasoning',
    labels: { en: 'Reasoning', pt: 'Raciocínio' },
    synonyms: ['o1-style', 'cot', 'chain-of-thought'],
    description: 'Extended chain-of-thought / multi-step reasoning capability.',
    category: 'task',
    broader: [],
    narrower: [uri('thinking_mode'), uri('deep_compute'), uri('deep_research')],
  },
  {
    slug: 'thinking_mode',
    preferredLabel: 'Thinking mode',
    labels: { en: 'Thinking mode', pt: 'Modo de pensamento' },
    synonyms: ['extended-thinking'],
    description: 'Exposes a "thinking" budget separate from output (Anthropic-style).',
    category: 'task',
    broader: [uri('reasoning')],
    narrower: [],
  },
  {
    slug: 'research',
    preferredLabel: 'Research',
    labels: { en: 'Research', pt: 'Pesquisa' },
    synonyms: [],
    description: 'Multi-step investigation across sources.',
    category: 'task',
    broader: [],
    narrower: [uri('deep_research'), uri('deep_search')],
  },
  {
    slug: 'deep_research',
    preferredLabel: 'Deep research',
    labels: { en: 'Deep research', pt: 'Pesquisa profunda' },
    synonyms: ['agentic-research'],
    description: 'Long-horizon research with planning, browsing, citation.',
    category: 'task',
    broader: [uri('research'), uri('reasoning')],
    narrower: [],
  },
  {
    slug: 'deep_search',
    preferredLabel: 'Deep search',
    labels: { en: 'Deep search', pt: 'Busca profunda' },
    synonyms: [],
    description: 'Multi-hop search with synthesis (xAI Grok / Perplexity style).',
    category: 'task',
    broader: [uri('research'), uri('web_search')],
    narrower: [],
  },
  {
    slug: 'deep_compute',
    preferredLabel: 'Deep compute',
    labels: { en: 'Deep compute', pt: 'Computação profunda' },
    synonyms: [],
    description: 'Heavy compute mode for complex reasoning (provider-defined).',
    category: 'task',
    broader: [uri('reasoning')],
    narrower: [],
  },
  {
    slug: 'translation',
    preferredLabel: 'Translation',
    labels: { en: 'Translation', pt: 'Tradução' },
    synonyms: ['mt', 'machine-translation'],
    description: 'Translates between natural languages.',
    category: 'task',
    broader: [uri('text_generation')],
    narrower: [],
  },
  {
    // ── Retrieval / rerank surfaces (Cohere `endpoints: ['rerank']`,
    //    Voyage rerank-2/2.5, Jina rerank). Distinct endpoint from chat
    //    AND from embedding — capability-search needs to route "rerank"
    //    queries explicitly so it doesn't mis-rank chat models.
    slug: 'reranking',
    preferredLabel: 'Reranking',
    labels: { en: 'Reranking', pt: 'Reordenação' },
    synonyms: ['rerank', 're-ranking', 'cross-encoder'],
    description: 'Re-orders a candidate list by relevance to a query (cross-encoder style).',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'retrieval',
    preferredLabel: 'Retrieval',
    labels: { en: 'Retrieval', pt: 'Recuperação' },
    synonyms: ['search', 'document-retrieval', 'semantic-search'],
    description: 'Returns candidate documents/passages for a query (typically embedding-backed).',
    category: 'task',
    broader: [],
    narrower: [uri('reranking')],
  },
  {
    // ── Specialty code-edit surface — Relace `apply-3` family and Morph
    //    expose structured-edit application. Distinct from `coding` (which
    //    covers code generation/completion) because edit-application is
    //    sandboxed inside an existing file's diff context.
    slug: 'code_edit',
    preferredLabel: 'Code edit application',
    labels: { en: 'Code edit', pt: 'Edição de código' },
    synonyms: ['code-edit', 'apply-edit', 'structured-edit', 'patch-application'],
    description: 'Applies a structured edit (diff/patch) to an existing source file.',
    category: 'task',
    broader: [uri('coding')],
    narrower: [],
  },
  {
    // ── Moderation classifiers (omni-moderation, llamaguard,
    //    text-moderation). Pure classifiers, distinct from generative
    //    chat. Routing layer must NOT default-route chat workloads here.
    slug: 'moderation',
    preferredLabel: 'Moderation',
    labels: { en: 'Moderation', pt: 'Moderação' },
    synonyms: ['safety-classifier', 'harm-detection', 'policy-classifier'],
    description: 'Classifies content against a safety/policy taxonomy (harassment, violence, etc.).',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'health',
    preferredLabel: 'Health / medical',
    labels: { en: 'Health', pt: 'Saúde' },
    synonyms: ['medical', 'clinical'],
    description: 'Trained or specialised on medical/clinical content.',
    category: 'task',
    broader: [],
    narrower: [],
  },

  // Vision-derived tasks
  {
    slug: 'image_captioning',
    preferredLabel: 'Image captioning',
    labels: { en: 'Image captioning', pt: 'Legenda de imagem' },
    synonyms: ['caption-generation'],
    description: 'Generates natural-language captions describing an image.',
    category: 'task',
    broader: [uri('vision')],
    narrower: [],
  },
  {
    slug: 'visual_question_answering',
    preferredLabel: 'Visual QA',
    labels: { en: 'Visual QA', pt: 'Pergunta-resposta visual' },
    synonyms: ['vqa'],
    description: 'Answers questions about an image.',
    category: 'task',
    broader: [uri('vision'), uri('qa')],
    narrower: [],
  },
  {
    slug: 'pdf_understanding',
    preferredLabel: 'PDF understanding',
    labels: { en: 'PDF understanding', pt: 'Compreensão de PDF' },
    synonyms: ['document-understanding', 'pdf-input'],
    description: 'Accepts PDF documents (text + layout) as input.',
    category: 'task',
    broader: [uri('vision')],
    narrower: [],
  },

  // Generation tasks (image / video / audio)
  {
    slug: 'image_generation',
    preferredLabel: 'Image generation',
    labels: { en: 'Image generation', pt: 'Geração de imagem' },
    synonyms: ['text-to-image', 't2i'],
    description: 'Generates images from text prompts.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'image_editing',
    preferredLabel: 'Image editing',
    labels: { en: 'Image editing', pt: 'Edição de imagem' },
    synonyms: ['inpainting', 'image-to-image'],
    description: 'Edits or transforms existing images.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'video_generation',
    preferredLabel: 'Video generation',
    labels: { en: 'Video generation', pt: 'Geração de vídeo' },
    synonyms: ['text-to-video', 't2v'],
    description: 'Generates video clips from text prompts.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'video_editing',
    preferredLabel: 'Video editing',
    labels: { en: 'Video editing', pt: 'Edição de vídeo' },
    synonyms: [],
    description: 'Edits or transforms video.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'image_to_video',
    preferredLabel: 'Image-to-video',
    labels: { en: 'Image-to-video', pt: 'Imagem para vídeo' },
    synonyms: ['i2v'],
    description: 'Animates a still image into video.',
    category: 'task',
    broader: [uri('video_generation')],
    narrower: [],
  },
  {
    slug: 'video_to_video',
    preferredLabel: 'Video-to-video',
    labels: { en: 'Video-to-video', pt: 'Vídeo para vídeo' },
    synonyms: ['v2v'],
    description: 'Transforms an input video (style transfer, motion edit).',
    category: 'task',
    broader: [uri('video_editing')],
    narrower: [],
  },
  {
    slug: 'video_to_text',
    preferredLabel: 'Video-to-text',
    labels: { en: 'Video-to-text', pt: 'Vídeo para texto' },
    synonyms: ['video-captioning'],
    description: 'Generates text descriptions from video.',
    category: 'task',
    broader: [uri('video_understanding')],
    narrower: [],
  },
  {
    slug: 'video_transcription',
    preferredLabel: 'Video transcription',
    labels: { en: 'Video transcription', pt: 'Transcrição de vídeo' },
    synonyms: [],
    description: 'Transcribes spoken content from video.',
    category: 'task',
    broader: [uri('video_understanding'), uri('transcription')],
    narrower: [],
  },
  {
    slug: 'audio_generation',
    preferredLabel: 'Audio generation',
    labels: { en: 'Audio generation', pt: 'Geração de áudio' },
    synonyms: ['music-generation', 'sound-generation'],
    description: 'Generates audio (music, SFX, ambient).',
    category: 'task',
    broader: [uri('audio_output')],
    narrower: [],
  },
  {
    slug: 'speech_to_text',
    preferredLabel: 'Speech-to-text',
    labels: { en: 'Speech-to-text', pt: 'Fala para texto' },
    synonyms: ['stt', 'asr'],
    description: 'Converts spoken audio to text.',
    category: 'task',
    broader: [uri('audio_input')],
    narrower: [],
  },
  {
    slug: 'text_to_speech',
    preferredLabel: 'Text-to-speech',
    labels: { en: 'Text-to-speech', pt: 'Texto para fala' },
    synonyms: ['tts'],
    description: 'Converts text to spoken audio.',
    category: 'task',
    broader: [uri('audio_output')],
    narrower: [],
  },
  {
    slug: 'tts',
    preferredLabel: 'TTS (alias)',
    labels: { en: 'TTS', pt: 'TTS' },
    synonyms: ['text-to-speech'],
    description: 'Alias for text_to_speech (legacy provider label).',
    category: 'task',
    broader: [uri('text_to_speech')],
    narrower: [],
  },
  {
    slug: 'transcription',
    preferredLabel: 'Transcription',
    labels: { en: 'Transcription', pt: 'Transcrição' },
    synonyms: [],
    description: 'Transcribes audio to text (broader than STT — includes formatting).',
    category: 'task',
    broader: [uri('audio_input')],
    narrower: [uri('video_transcription'), uri('diarization')],
  },
  {
    slug: 'diarization',
    preferredLabel: 'Speaker diarization',
    labels: { en: 'Diarization', pt: 'Diarização' },
    synonyms: ['speaker-identification'],
    description: 'Identifies "who spoke when" in audio.',
    category: 'task',
    broader: [uri('transcription')],
    narrower: [],
  },
  {
    slug: 'listen',
    preferredLabel: 'Listen (audio understanding)',
    labels: { en: 'Listen', pt: 'Ouvir' },
    synonyms: ['audio-understanding'],
    description: 'Understands audio content (semantic, not just transcription).',
    category: 'task',
    broader: [uri('audio_input')],
    narrower: [],
  },
  {
    slug: 'realtime_audio',
    preferredLabel: 'Realtime audio',
    labels: { en: 'Realtime audio', pt: 'Áudio em tempo real' },
    synonyms: ['voice-mode'],
    description: 'Bidirectional realtime voice conversation (low latency).',
    category: 'task',
    broader: [uri('audio_to_audio'), uri('realtime')],
    narrower: [],
  },
  {
    slug: 'embeddings',
    preferredLabel: 'Embeddings',
    labels: { en: 'Embeddings', pt: 'Embeddings' },
    synonyms: ['embedding', 'vector-encoding'],
    description: 'Produces vector embeddings of inputs.',
    category: 'task',
    broader: [],
    narrower: [],
  },
  {
    slug: 'embedding',
    preferredLabel: 'Embedding (alias)',
    labels: { en: 'Embedding', pt: 'Embedding' },
    synonyms: ['embeddings'],
    description: 'Singular alias for embeddings (legacy provider label).',
    category: 'task',
    broader: [uri('embeddings')],
    narrower: [],
  },

  // ── tool (affordances) ────────────────────────────────────────────────────
  {
    slug: 'function_calling',
    preferredLabel: 'Function calling',
    labels: { en: 'Function calling', pt: 'Chamada de função' },
    synonyms: ['tools', 'function-call', 'tool-calling'],
    description: 'Model can emit structured function-call requests.',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [],
  },
  {
    slug: 'tool_use',
    preferredLabel: 'Tool use',
    labels: { en: 'Tool use', pt: 'Uso de ferramentas' },
    synonyms: ['tool-use', 'agentic-tool-use'],
    description: 'Model invokes external tools as part of its reasoning.',
    category: 'tool',
    broader: [],
    narrower: [
      uri('function_calling'), uri('web_search'), uri('file_search'),
      uri('code_interpreter'), uri('mcp'), uri('computer_use'),
      uri('agents'),
    ],
  },
  {
    slug: 'web_search',
    preferredLabel: 'Web search',
    labels: { en: 'Web search', pt: 'Busca web' },
    synonyms: ['browsing', 'web-browsing'],
    description: 'Built-in web search tool.',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [uri('deep_search')],
  },
  {
    slug: 'file_search',
    preferredLabel: 'File search',
    labels: { en: 'File search', pt: 'Busca em arquivos' },
    synonyms: ['retrieval', 'rag'],
    description: 'Built-in file/document retrieval tool.',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [],
  },
  {
    slug: 'computer_use',
    preferredLabel: 'Computer use',
    labels: { en: 'Computer use', pt: 'Uso de computador' },
    synonyms: ['screen-control'],
    description: 'Controls a virtual computer (screenshot + actions).',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [],
  },
  {
    slug: 'mcp',
    preferredLabel: 'MCP (Model Context Protocol)',
    labels: { en: 'MCP', pt: 'MCP' },
    synonyms: ['model-context-protocol'],
    description: 'Native support for Anthropic Model Context Protocol servers.',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [],
  },
  {
    slug: 'agents',
    preferredLabel: 'Agentic',
    labels: { en: 'Agents', pt: 'Agentes' },
    synonyms: ['agent', 'agentic'],
    description: 'Optimised for agentic loops (long horizon, tool-heavy).',
    category: 'tool',
    broader: [uri('tool_use')],
    narrower: [],
  },

  // ── safety (policy/content tags) ──────────────────────────────────────────
  {
    // Partner-tag for `moderation`. The `moderation` task identifies a
    // CLASSIFIER; the `safety` tag groups models that are safety-rated for
    // generative use (e.g. assistance refusal, harm detection during
    // generation). Routing layers can request `safety` to filter to
    // policy-aware models even when those models also do generic chat.
    slug: 'safety',
    preferredLabel: 'Safety-rated',
    labels: { en: 'Safety-rated', pt: 'Avaliado por segurança' },
    synonyms: ['safety-tuned', 'guard', 'policy-aware'],
    description: 'Carries an explicit safety/policy training surface (used for routing or filtering).',
    category: 'safety',
    broader: [],
    narrower: [],
  },

  // ── meta (model-level affordances) ────────────────────────────────────────
  {
    slug: 'streaming',
    preferredLabel: 'Streaming',
    labels: { en: 'Streaming', pt: 'Streaming' },
    synonyms: ['sse', 'server-sent-events'],
    description: 'Supports token-by-token streamed responses.',
    category: 'meta',
    broader: [],
    narrower: [],
  },
  {
    slug: 'json_mode',
    preferredLabel: 'JSON mode',
    labels: { en: 'JSON mode', pt: 'Modo JSON' },
    synonyms: ['structured-output', 'json-output'],
    description: 'Constrains output to valid JSON.',
    category: 'meta',
    broader: [],
    narrower: [],
  },
  {
    slug: 'realtime',
    preferredLabel: 'Realtime',
    labels: { en: 'Realtime', pt: 'Tempo real' },
    synonyms: ['low-latency'],
    description: 'Realtime / low-latency interaction (websocket-style).',
    category: 'meta',
    broader: [],
    narrower: [uri('realtime_audio')],
  },
  {
    // ── Long-context family — Moonshot Kimi (k2 line, 200k tokens),
    //    Claude sonnet-4 (200k), GPT-4-turbo (128k), Gemini Pro (1M).
    //    The `contextWindow` numeric is comparable across providers but
    //    quality of attention at the high end is not. This tag carries
    //    the operator/family signal that the model is *intended* for
    //    long-input workloads, not just nominally large.
    slug: 'long_context',
    preferredLabel: 'Long context',
    labels: { en: 'Long context', pt: 'Contexto longo' },
    synonyms: ['long-context', 'extended-context', 'large-window'],
    description: 'Designed for long-input workloads (typically ≥128k usable tokens with retained attention).',
    category: 'meta',
    broader: [],
    narrower: [],
  },
];

/**
 * Idempotent upsert. Run on app boot (after migration), or via a one-shot script.
 *
 * Notes:
 * - Two-phase write: insert all rows first, then patch broader/narrower edges.
 *   This avoids forward-reference failures if SQL ordered the inserts oddly.
 * - `embedding` is left NULL — Sprint 2 worker fills it from preferred_label
 *   + description with BGE-small.
 * - `ON CONFLICT (uri) DO UPDATE` makes this safe to re-run after edits.
 */
export async function seedCapabilityOntology(prisma: PrismaClient): Promise<{ upserted: number; edges: number }> {
  // Phase 1: upsert rows without edges. Two-phase to dodge forward-reference order.
  for (const entry of ONTOLOGY_SEED) {
    await prisma.$executeRaw`
      INSERT INTO capability_ontology (
        uri, schema_version, preferred_label, labels, synonyms,
        description, broader, narrower, category, status, updated_at
      )
      VALUES (
        ${uri(entry.slug)}, 1, ${entry.preferredLabel}, ${entry.labels}::jsonb,
        ${entry.synonyms}::text[], ${entry.description},
        ARRAY[]::text[], ARRAY[]::text[],
        ${entry.category}, 'active', NOW()
      )
      ON CONFLICT (uri) DO UPDATE SET
        preferred_label = EXCLUDED.preferred_label,
        labels          = EXCLUDED.labels,
        synonyms        = EXCLUDED.synonyms,
        description     = EXCLUDED.description,
        category        = EXCLUDED.category,
        updated_at      = NOW();
    `;
  }

  // Phase 2: set broader/narrower edges. All target URIs now exist.
  let edges = 0;
  for (const entry of ONTOLOGY_SEED) {
    edges += entry.broader.length + entry.narrower.length;
    await prisma.$executeRaw`
      UPDATE capability_ontology
      SET broader  = ${entry.broader}::text[],
          narrower = ${entry.narrower}::text[],
          updated_at = NOW()
      WHERE uri = ${uri(entry.slug)};
    `;
  }

  return { upserted: ONTOLOGY_SEED.length, edges };
}

/** Map from legacy ModelCapability slug → ontology URI. Used by the backfill. */
export const LEGACY_CAPABILITY_TO_URI: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ONTOLOGY_SEED.map((entry) => [entry.slug, uri(entry.slug)])),
);
