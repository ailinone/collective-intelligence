// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Inference Layer
 *
 * Analyzes incoming requests to determine task type, complexity,
 * required capabilities, risk profile, and cost sensitivity.
 * Uses heuristic analysis of prompt text — keyword matching, length
 * analysis, structural analysis (code blocks, math notation,
 * multi-step instructions) — to produce a CapabilityInferenceResult
 * that downstream routing and model selection can consume.
 *
 * No external dependencies beyond the project logger.
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'capability-inference' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Task categories the inference layer can detect. */
export type InferredTaskType =
  | 'reasoning'
  | 'coding'
  | 'creative'
  | 'factual_qa'
  | 'translation'
  | 'summarization'
  | 'tool_use'
  | 'multi_step'
  | 'general';

/** Complexity buckets. */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex' | 'expert';

/** Capability flags that may be required to serve a request well. */
export type RequiredCapability =
  | 'tool_use'
  | 'long_context'
  | 'groundedness'
  | 'safety_critical'
  | 'code_execution'
  | 'math_reasoning'
  | 'multilingual'
  | 'image_generation'
  | 'vision'
  | 'audio_generation'
  | 'video_generation'
  | 'csv_generation'
  | 'json_generation'
  | 'markdown_generation'
  | 'docx_generation'
  | 'xlsx_generation'
  | 'pdf_generation'
  | 'pptx_generation'
  | 'zip_generation'
  // Named `code_file_generation`, NOT `code_generation` — the latter string
  // is already a pre-existing catalog `ModelCapability` meaning "this model
  // is good at writing code" (1957 models tagged this way in production).
  // Reusing it here for "produce a downloadable code file" created a name
  // collision: an ordinary coding stage tagged ['code_generation','reasoning']
  // by the triage LLM (a legitimate thing to emit in the catalog sense) was
  // silently hijacked into a file-download stage by detectMediaGenerationModality's
  // unguarded `.some()` check. Confirmed exploitable by the 2026-07-16
  // architecture audit — this rename plus the single-purpose guard added at
  // the call site are the fix.
  | 'code_file_generation'
  | 'file_generation';

/** Risk classification of the request. */
export type RiskProfile = 'low' | 'medium' | 'high' | 'critical';

/** Estimated context window consumption. */
export type ContextNeed = 'short' | 'medium' | 'long' | 'very_long';

/** Cost sensitivity derived from request signals. */
export type CostSensitivity = 'low' | 'medium' | 'high';

/**
 * Complete result produced by {@link inferCapabilities}.
 */
export interface CapabilityInferenceResult {
  taskType: InferredTaskType;
  complexity: ComplexityLevel;
  requiredCapabilities: RequiredCapability[];
  riskProfile: RiskProfile;
  contextNeeds: ContextNeed;
  costSensitivity: CostSensitivity;
  /** 0-1 — how confident the heuristic engine is in this classification. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Keyword dictionaries (compiled once)
// ---------------------------------------------------------------------------

const CODING_KEYWORDS = /\b(function|class|implement|debug|refactor|compile|syntax|algorithm|api|endpoint|typescript|javascript|python|rust|java|golang|sql|html|css|react|regex|codebase|repository|git|pr|pull\s*request|bug\s*fix|unit\s*test|integration\s*test)\b/i;
const CODING_PHRASES = /\b(write\s+a\s+function|write\s+code|fix\s+(the|this|my)\s+(bug|error|issue)|implement\s+a|create\s+a\s+(class|module|component|service)|code\s+review|debug\s+(this|the|my))\b/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/;

const REASONING_KEYWORDS = /\b(explain\s+why|prove|derive|compare\s+and\s+contrast|step[\s-]by[\s-]step|analyze|evaluate|critical\s*thinking|logical|theorem|hypothesis|infer|deduce|syllogism|paradox|dilemma|trade[\s-]?offs?)\b/i;

const CREATIVE_KEYWORDS = /\b(write\s+a\s+(story|poem|essay|song|script|novel)|creative|brainstorm|imagine|fiction|narrative|metaphor|haiku|sonnet|limerick|short\s*story|world[\s-]?build)\b/i;

const FACTUAL_QA_KEYWORDS = /\b(what\s+is|who\s+is|when\s+did|where\s+is|how\s+many|how\s+much|define|definition\s+of|fact\s+check|true\s+or\s+false|is\s+it\s+true)\b/i;

const TRANSLATION_KEYWORDS = /\b(translate|translation|translat(e|ing)\s+(to|into|from)|in\s+(french|spanish|german|chinese|japanese|korean|arabic|hindi|portuguese|russian|italian|dutch|polish|turkish|swedish|norwegian|danish|finnish|greek|hebrew|thai|vietnamese|indonesian|malay))\b/i;

const SUMMARIZATION_KEYWORDS = /\b(summarize|summary|summarise|tldr|tl;?dr|key\s*points|main\s*points|brief\s*overview|condense|digest|recap|outline\s+the)\b/i;

const TOOL_USE_KEYWORDS = /\b(search|calculate|look\s*up|browse|fetch|retrieve|query|call\s+(the\s+)?api|run\s+(the\s+)?(tool|command|script)|execute|invoke|web\s*search|file\s*search)\b/i;

const MULTI_STEP_INDICATORS = /\b(first[\s,].*then|step\s*\d|phase\s*\d|part\s*\d|1\)|2\)|3\)|stage\s*\d|multi[\s-]?step|pipeline|workflow|chain|sequentially|afterwards|next[\s,]|finally[\s,])\b/i;
const NUMBERED_LIST_RE = /(?:^|\n)\s*(?:\d+[.)]\s+|[-*]\s+).*(?:\n\s*(?:\d+[.)]\s+|[-*]\s+)){2,}/;

const SAFETY_KEYWORDS = /\b(medical|diagnosis|diagnose|prescription|medication|dosage|symptom|disease|treatment|surgery|legal\s*advice|lawsuit|liability|court|attorney|financial\s*advice|invest|stock\s*pick|tax\s*advice|suicide|self[\s-]?harm|weapon|explosive|minor|child\s*safety|underage|drug\s*use|controlled\s*substance)\b/i;
const SAFETY_CRITICAL_KEYWORDS = /\b(suicide|self[\s-]?harm|weapon|explosive|child\s*exploitation|abuse|violence\s*against|bomb|poison|how\s+to\s+make\s+a\s+(bomb|weapon|drug))\b/i;

const MATH_KEYWORDS = /\b(integral|derivative|matrix|vector|equation|theorem|proof|factorial|probability|statistics|regression|calculus|algebra|geometry|trigonometry|eigenvalue|determinant|gradient|lagrangian|fourier|laplace)\b/i;
const MATH_NOTATION_RE = /[\u2200-\u22FF\u2A00-\u2AFF]|\\(?:frac|sqrt|sum|int|prod|lim|infty|alpha|beta|gamma|delta|epsilon|theta|lambda|sigma|omega)\b/;

// Major non-Latin script ranges (CJK, Hiragana, Katakana, Hangul, Arabic,
// Devanagari, Thai, Cyrillic). Use Unicode property escapes (`\p{Script=\u2026}`)
// instead of raw codepoint ranges so the regex semantically matches the
// script class and ESLint can verify there are no surrogate-pair or
// combining-character pitfalls (no-misleading-character-class).
const MULTILINGUAL_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Cyrillic}]/u;

// Multimodal capability detection (image, audio, video)
const IMAGE_GEN_KEYWORDS = /\b(gere|gerar|crie|criar|desenhe|desenhar|generate|create|draw|render|paint|design|make|produza|produzir)\s+.{0,30}\b(image[mn]|foto|picture|image|illustration|art|artwork|portrait|landscape|poster|banner|icon|logo|thumbnail|avatar|wallpaper|infographic|diagram|chart|graph|comic|cartoon|sketch|painting|drawing)\b/i;
const IMAGE_GEN_DIRECT = /\b(dall[\-·]?e|midjourney|stable[\s-]?diffusion|imagen|image[\s-]?generat|text[\s-]?to[\s-]?image|txt2img|img2img)\b/i;
const IMAGE_GEN_SIMPLE = /\b(gere|gerar|criar|crie|generate|create|make)\b.{0,10}\b(uma?\s+)?(image[mn]|foto|imagem|picture|image)\b/i;

// Unicode-aware word boundary. Plain `\b` is ASCII-only (`\w` = [A-Za-z0-9_]
// even under the `u` flag), so it never asserts a boundary immediately
// before a token whose FIRST character is itself an accented letter —
// confirmed dead code: `\báudio\b` can never match after a space, because
// space→'á' is non-word→non-word under ASCII \b semantics. Every other
// accented pt-BR token in this file (vídeo, música, animação, narração...)
// happens to start with a plain ASCII letter, so only "áudio" was affected —
// but it's worth using this boundary form everywhere new tokens are added,
// since the bug is invisible in code review (found only by execution,
// 2026-07-16 architecture audit).
const WB_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WB_AFTER = '(?![\\p{L}\\p{N}_])';

const AUDIO_GEN_KEYWORDS = new RegExp(
  `${WB_BEFORE}(?:generate|create|make|produce|synthesize|gere|gerar|crie|criar)${WB_AFTER}\\s+.{0,20}${WB_BEFORE}(?:audio|music|song|sound|voice|speech|narration|podcast|áudio|música|musica|som|voz|narração|narracao)${WB_AFTER}`,
  'iu',
);
const AUDIO_GEN_DIRECT = /\b(text[\s-]?to[\s-]?speech|tts|speech[\s-]?synth|voice[\s-]?gen|suno|elevenlabs|musicgen)\b/i;

const VIDEO_GEN_KEYWORDS = /\b(generate|create|make|produce|gere|gerar|crie|criar)\s+.{0,20}\b(video|animation|clip|movie|vídeo|animação|filme)\b/i;
const VIDEO_GEN_DIRECT = /\b(text[\s-]?to[\s-]?video|sora|runway|pika|kling|veo)\b/i;

// File-generation detection (2026-07-14, restructured 2026-07-16 per
// adversarial architecture audit). Requires a generation-intent verb paired
// with the format noun (same "verb + object within a bounded window" shape
// as the media-generation keyword sets above) — a bare format mention
// ("what's a csv file") must NOT trigger this, only an actual request to
// produce one.
//
// RESTRUCTURING RATIONALE (2026-07-16): the original design was 10
// hand-written, independently-evolved regexes. Eight rounds of adversarial
// review across the format-by-format PR series left them inconsistently
// hardened: the tool-noun exclusion guard below was retrofitted to
// xlsx/pdf/pptx/zip but never propagated to docx/csv/json/markdown (so
// "build a csv parser"/"create a json parser in rust" false-positived while
// their pdf/xlsx siblings correctly excluded the equivalent phrasing), and
// NONE of the 10 had Portuguese verb support despite the sibling
// image/audio/video regexes above having it from the start — 12/12 natural
// pt-BR file requests were confirmed (by execution) to silently produce zero
// file capability. Both gaps are now closed STRUCTURALLY: every standard
// format below is built by the SAME `buildStandardFileFormatRegex()` call,
// so a guard or a language added once applies to all of them — no more
// per-format copy/paste drift.
// Deliberately BASE/IMPERATIVE/INFINITIVE forms only — no past tense, no
// past participles, no 3rd-person -s, no gerunds. The first draft of this
// restructuring accepted inflected forms (made/created/generated/wrote/
// written/built/exports/criado/gerado...) and the adversarial review of
// this PR confirmed by execution that they fire on sentences DESCRIBING
// existing files or software behavior, not requesting generation:
// "summarize the changes I made to the pdf" -> pdf_generation, "the notes
// written in the pdf are unclear" -> pdf_generation, "the dashboard we
// built exports json" -> json_generation, "explique o erro no relatório
// criado em pdf" -> pdf_generation (14 executed examples, ALL clean before
// inflections were added). Per this codebase's standing risk calculus,
// false positives are strictly worse than false negatives here (a FP
// hijacks an ordinary chat; a FN falls back to the triage LLM on the
// primary path) — so descriptive-prone inflections stay out, and inflected
// generation requests ("creates a pdf from the notes") are an accepted,
// documented false negative of the fallback layer.
const GEN_VERBS_EN = 'generate|create|make|produce|export|write|build';
const GEN_VERBS_PT =
  'gere|gerar|crie|criar|faça|fazer|monte|montar|produza|produzir|exporte|exportar|escreva|escrever';
const GEN_VERBS = `${WB_BEFORE}(?:${GEN_VERBS_EN}|${GEN_VERBS_PT})${WB_AFTER}`;

// Conversion/re-export phrasings — confirmed (by execution) to be a
// family-wide miss in the original design: "convert this csv to xlsx",
// "save this as a pdf", "can I get this as a pdf?", and their pt-BR
// equivalents all produced zero file capability, because the only verb form
// accepted was the exact base form of generate/create/make/produce/export/
// write/build. These are phrase-shaped (verb ... particle ... noun), so they
// are a separate alternative rather than folded into GEN_VERBS above — a
// bare "turn"/"save"/"get" is too ambiguous to accept without its "into"/"as"
// companion.
// Every conversion verb carries the SAME tool-noun lookbehind as the
// verb+noun shape — without it, "create a tool to convert pptx to pdf" /
// "build a script that converts markdown to pdf" / "make a cli that
// converts csv to xlsx" re-enter through the conversion alternative the
// exact build-software false-positive class the guard exists to block
// (confirmed by execution, adversarial review of this PR; note the guard
// is declared below but only dereferenced when buildStandardFileFormatRegex
// CALLS this function, after the const initializes).
function conversionFragment(nounGroup: string): string {
  const noun = `${WB_BEFORE}(?:${nounGroup})${WB_AFTER}`;
  const guard = FILE_GEN_TOOL_NOUN_BEFORE;
  return (
    `${guard}\\bconvert(?:s|ed|ing)?\\s+.{0,40}\\b(?:to|into)\\b\\s+.{0,10}\\b(?:an?\\s+)?${noun}` +
    `|${guard}\\bturn\\s+.{0,40}\\binto\\b\\s+.{0,10}\\b(?:an?\\s+)?${noun}` +
    `|${guard}\\b(?:save|get)\\s+.{0,20}\\bas\\b\\s+.{0,10}\\b(?:an?\\s+)?${noun}` +
    `|${guard}\\bconvert(?:a|er|endo|ido|ida)?\\s+.{0,40}\\bem\\b\\s+.{0,10}\\b(?:um[a]?\\s+)?${noun}` +
    `|${guard}\\btransform(?:e|ar|ando|ado|ada)?\\s+.{0,40}\\bem\\b\\s+.{0,10}\\b(?:um[a]?\\s+)?${noun}`
  );
}

// Shared software/tool-noun exclusion for the standard formats below:
// requests to BUILD SOFTWARE that handles the format ("a pdf reader", "a
// tool to convert pptx to pdf", "a powerpoint-like app", "a csv parser", "a
// json parser") must not be treated as a request to generate a document in
// that format. The tool noun can sit on either side of the format keyword
// within the same clause, so this is checked both as a lookbehind (noun
// BEFORE, e.g. "a tool to export xlsx") and a lookahead (noun AFTER, e.g. "a
// pdf reader") — a one-sided exclusion (the original 2026-07-15 PDF/XLSX
// fix) was found by adversarial review of the PPTX PR to still false-positive
// on the other side ("create a tool to convert pptx to pdf") and on an
// incomplete noun list ("powerpoint clone/renderer/plugin/-like app"), and
// the 2026-07-16 audit confirmed the same gap in csv/json/markdown/docx,
// which never had this guard applied at all. V8's regex lookbehind supports
// variable-length quantifiers, so a bounded `.{0,20}` works the same looking
// backward as it does looking forward.
// The list mixes en and pt-BR nouns because GEN_VERBS accepts both
// languages — an English-only guard with pt verbs would block "create a pdf
// reader" but let "crie um leitor de pdf" through (confirmed by execution,
// adversarial review of this PR). "formula|fórmula" is here because a
// spreadsheet/planilha FORMULA request wants a formula in chat, not a
// workbook file ("crie uma fórmula de planilha que some os valores" was a
// confirmed pt-only false positive; the en sibling never fired only because
// bare "spreadsheet" isn't an accepted trigger noun while bare "planilha"
// deliberately is). Plural tolerance is appended programmatically — the
// review confirmed "create json endpoints"/"build csv parsers" escaped a
// singular-only guard.
const FILE_GEN_TOOL_NOUN_LIST =
  'reader|parser|viewer|library|libraries|tool|app|application|script|compressor|converter|component|generator|extractor|editor|module|package|sdk|util|utility|class|function|automation|clone|renderer|player|plugin|importer|exporter|engine|wrapper|api|cli|code|route|endpoint|handler|formula|' +
  'leitor|conversor|analisador|visualizador|biblioteca|ferramenta|aplicativo|aplicação|aplicacao|módulo|modulo|pacote|gerador|extrator|editor|componente|classe|função|funções|funcao|funcoes|fórmula|rota|código|codigo';
const FILE_GEN_TOOL_NOUNS = FILE_GEN_TOOL_NOUN_LIST.split('|')
  .map((noun) => `${noun}(?:e?s)?`)
  .join('|');
// The lookbehind window matches the verb->noun window (30) — when it was
// narrower (20), a tool noun could sit inside the verb window but outside
// the guard window and slip through ("make a cli that converts csv to
// xlsx": 'cli' is 22 chars before 'xlsx' — caught by the verb shape,
// missed by a 20-char guard; found by execution in this PR's adversarial
// review fix round).
const FILE_GEN_TOOL_NOUN_BEFORE = `(?<!\\b(?:${FILE_GEN_TOOL_NOUNS})\\b.{0,30})`;
const FILE_GEN_TOOL_NOUN_AFTER = `(?!\\s+(?:${FILE_GEN_TOOL_NOUNS})\\b)`;
const FILE_GEN_TOOL_NOUN_LIKE_AFTER = '(?!-?like\\b)';

/**
 * Build the standard "verb + format noun" + "conversion phrase" regex shared
 * by every file format below. Centralizing this is the structural fix for
 * the guard/language drift documented above: every caller gets the SAME
 * tool-noun guard and the SAME en+pt verb coverage by construction.
 *
 * `conversionNounGroup` lets a format use a STRICTER noun for the
 * conversion alternative than for the verb+noun one — json needs this:
 * "turn the data into json"/"convert this yaml to json" usually want the
 * json INLINE in chat (confirmed false positives by execution, adversarial
 * review of this PR), so json's conversion path requires the explicit
 * "json file"/"json export" phrasing while "generate a json" (verb shape)
 * stays accepted. Pass `null` to disable the conversion alternative
 * entirely for a format.
 */
function buildStandardFileFormatRegex(nounGroup: string, conversionNounGroup: string | null = nounGroup): RegExp {
  const noun = `${FILE_GEN_TOOL_NOUN_BEFORE}${WB_BEFORE}(?:${nounGroup})${WB_AFTER}${FILE_GEN_TOOL_NOUN_AFTER}${FILE_GEN_TOOL_NOUN_LIKE_AFTER}`;
  const verbShape = `${GEN_VERBS}\\s+.{0,30}${noun}`;
  if (conversionNounGroup === null) return new RegExp(verbShape, 'iu');
  return new RegExp(`${verbShape}|${conversionFragment(conversionNounGroup)}`, 'iu');
}

const DOCX_GEN_KEYWORDS = buildStandardFileFormatRegex(
  'docx|\\.docx\\s+file|word\\s+doc(?:ument)?|documento\\s+word|arquivo\\s+word',
);

// Unlike the other file-format patterns, "spreadsheet"/"workbook" alone are
// too ambiguous to trust as trigger nouns (a fitness "workbook", a math
// "workbook", "excel at X" as a verb) — require the unambiguous "xlsx" token
// or "excel" DIRECTLY paired with a file noun, mirroring how DOCX requires
// "docx"/"word doc(ument)" rather than a bare "document" (2026-07-15, found
// by adversarial review: "build a workbook of algebra exercises" and "make a
// routine to excel at swimming" both falsely matched the looser pattern). Bare
// pt-BR "planilha" IS accepted (unlike bare English "spreadsheet"/"workbook")
// because Portuguese doesn't share the "practice workbook" ambiguity — a
// paper practice workbook is "apostila"/"caderno de exercícios", never
// "planilha".
const XLSX_GEN_KEYWORDS = buildStandardFileFormatRegex(
  'xlsx|\\.xlsx\\s+file|excel\\s+(?:spreadsheet|file|workbook)|planilha(?:\\s+(?:excel|em\\s+excel))?|arquivo\\s+excel',
);
// Unlike docx/xlsx, "pdf" alone isn't safe as a bare trigger noun either — it's
// a very common qualifier for PDF-handling SOFTWARE requests ("build a pdf
// reader/parser/viewer/library"), not just document-generation requests
// (2026-07-15, found by adversarial review of this PR: "make a pdf reader app
// in Python" and "build a pdf parser library" both falsely matched the
// unqualified pattern). "pdf" is borrowed as-is into Portuguese, no separate
// pt noun needed.
const PDF_GEN_KEYWORDS = buildStandardFileFormatRegex('pdf|\\.pdf\\s+file');
// "presentation"/"slides" alone are too ambiguous (a verbal "presentation",
// playground "slides") — require the unambiguous "pptx"/"powerpoint"/"slide
// deck" token (accepting the hyphenated "slide-deck" spelling too — a plain
// `\s+` missed it, 2026-07-15 adversarial review), and apply the same shared
// tool-noun exclusion as pdf/xlsx above. "apresentação" alone is excluded for
// the same ambiguity reason as English "presentation" (a verbal presentation)
// — requires the "powerpoint"/"slides" companion, mirroring the English rule.
const PPTX_GEN_KEYWORDS = buildStandardFileFormatRegex(
  'pptx|\\.pptx\\s+file|powerpoint(?:\\s+(?:presentation|file|deck))?|slide[\\s-]+deck|' +
    'apresentação\\s+(?:powerpoint|em\\s+powerpoint|de\\s+slides)|arquivo\\s+powerpoint',
);
const CSV_GEN_KEYWORDS = buildStandardFileFormatRegex('csv|comma[\\s-]?separated\\s+values?');
// "returns json"/"sends json" API-building requests are excluded via the
// SAME tool-noun guard as the other formats (the guard list already
// includes "api", it just wasn't applied to json before) — confirmed by
// execution to fix "write an API that returns json" without any new list.
// The conversion alternative uses a STRICTER noun (see
// buildStandardFileFormatRegex doc): a conversion targeting bare "json"
// ("convert this yaml to json") wants the json inline in chat, not a .json
// download — only "…to a json file/export" converts to a file.
const JSON_GEN_KEYWORDS = buildStandardFileFormatRegex(
  'json(?:\\s+(?:file|payload|object|export))?',
  'json\\s+(?:file|export)',
);
const MARKDOWN_GEN_KEYWORDS = buildStandardFileFormatRegex(
  'markdown|readme|\\.md\\s+file|arquivo\\s+markdown',
);
// Unlike every sibling format above, "zip"/"bundle"/"archive" are also
// natural VERBS in everyday phrasing ("zip these files together", "bundle
// the reports into one download", "archive these files") — not just nouns
// following a separate generation verb — so this pattern has two
// alternatives: the usual verb+noun shape (e.g. "create a zip of these
// reports") AND zip/bundle/archive used directly as the verb with a
// file-ish object after it. Both sides reuse the shared tool-noun exclusion
// (a "tool to zip files" build-a-tool request must not trigger this), and
// the noun-shape alternative additionally excludes "zip code" so a
// postal-code question never false-positives.
//
// "archive" needed extra care in BOTH alternatives (2026-07-16, adversarial
// review): as a BARE noun/verb it's dangerously ambiguous with ordinary
// business/document-management English ("an archive service", "archive
// pipeline", "archive strategy document", "the national archive records",
// "archive the emails") that has nothing to do with generating a downloadable
// zip file — none of docx/xlsx/pdf/pptx have a bare trigger word this
// overloaded, so the fix here doesn't generalize from a sibling. As a noun,
// "archive" is only accepted when explicitly introducing a file-ish object
// ("archive of/containing/with ... files/documents/reports/data") — this is
// the same "unambiguous companion token" lesson already applied to xlsx's
// bare "workbook"/"spreadsheet" and pptx's bare "presentation". As a verb,
// it's included in the verb-as-object alternative for consistency with
// "zip"/"bundle" (a residual ambiguity with "move to cold storage" remains,
// same tradeoff every heuristic regex in this file accepts), but ONLY that
// alternative's already-strict object requirement below applies — never a
// bare "archive these" with no explicit files-ish noun.
//
// The verb-as-object alternative requires an explicit files-ish object
// (files/documents/reports) preceded by a determiner (the/my/your/our/
// these/those) with at most ONE adjective in between ("zip the exported
// files") — a bare "these"/"them"/"together" with NO files-ish noun was
// found to false-positive heavily on unrelated requests ("bundle my API
// calls together", "bundle these API requests together"), so those alone
// are no longer sufficient; "zip file"/"zip files" alone (no determiner) is
// still excluded since that's an extremely common bare mention (as in
// "what is a zip file"), and a bare "up" was excluded entirely since "zip
// up" is a common idiom unrelated to archives ("zip up your jacket").
// A build-tooling question ("bundle the javascript files with webpack",
// "bundle the css files together") is not a request to produce a
// downloadable zip archive. Confirmed by execution (2026-07-16 audit) that
// the verb-as-object alternative's single-adjective slot accepted ANY word,
// including source-code/asset type words that make the object phrase mean
// "the source files", not "files to archive" — critically, this false
// positive fires even with NO bundler tool name anywhere in the sentence
// ("bundle the css files together" alone is enough), so the fix excludes
// the adjective slot from being one of these words, rather than trying to
// detect a nearby tool name.
//
// The exclusion applies ONLY to the verb "bundle" — that's the build-tooling
// verb. "zip"/"archive" as verbs carry unambiguous archive intent regardless
// of the object's type: "zip the source files and let me download them" and
// "zip the html files for the designer" are genuine archive requests that a
// verb-agnostic exclusion regressed (confirmed by differential execution,
// adversarial review of this PR — both worked before this restructuring).
const ZIP_SOURCE_CODE_ADJECTIVES =
  'javascript|js|typescript|ts|jsx|tsx|css|scss|sass|html|source|asset|assets|style|styles|module|modules|component|components';
const ZIP_OBJECT_PHRASE = `\\s+.{0,25}\\b(?:the|my|your|our|these|those)\\s+`;
const ZIP_GEN_KEYWORDS = new RegExp(
  `${GEN_VERBS}\\s+.{0,30}${FILE_GEN_TOOL_NOUN_BEFORE}\\b(zip|\\.zip\\s+file|arquivo\\s+zip|arquivo\\s+compactado|arquivo\\s+compactada|` +
    `archive\\s+(?:of|containing|with)\\s+(?:(?:the|these|those|my|your|our|all(?:\\s+the)?)\\s+)?(?:\\w+\\s+)?(?:files?|documents?|reports?|data))\\b(?!\\s*codes?\\b)${FILE_GEN_TOOL_NOUN_AFTER}${FILE_GEN_TOOL_NOUN_LIKE_AFTER}` +
    `|` +
    `${FILE_GEN_TOOL_NOUN_BEFORE}\\b(zip|archive)${ZIP_OBJECT_PHRASE}(?:\\w+\\s+)?(?:files?|documents?|reports?)\\b` +
    `|` +
    `${FILE_GEN_TOOL_NOUN_BEFORE}\\bbundle${ZIP_OBJECT_PHRASE}(?:(?!(?:${ZIP_SOURCE_CODE_ADJECTIVES})\\b)\\w+\\s+)?(?:files?|documents?|reports?)\\b` +
    `|` +
    `${FILE_GEN_TOOL_NOUN_BEFORE}\\b(zipe|zipar|compacte|compactar)\\s+.{0,25}\\b(?:os|as|estes|estas|esses|essas|meus|minhas|nossos|nossas)\\s+(?:\\w+\\s+)?(?:arquivos|documentos|relat[óo]rios)\\b`,
  'iu'
);
// A conservative pattern for "materialize this code as a downloadable
// file" — deliberately NOT the same signal as CODING_KEYWORDS/CODING_PHRASES
// above (those detect "this is a coding question", for MODEL-SELECTION
// purposes, and fire on the vast majority of ordinary code requests). This
// capability must stay narrow: the overwhelming majority of "write me a
// function", "how do I do X in Python", "create a script that does Y"
// requests want an in-chat code block, NOT a downloadable file artifact —
// firing this on those would silently convert a normal coding answer into
// an unwanted file download, which would be a much worse regression than
// any format above (coding questions are one of the most common request
// types this system serves).
//
// 2026-07-16, adversarial review: the first draft of this regex accepted
// ANY generation verb (generate/create/make/produce/write) + language +
// "file" as sufficient, with no requirement for actual download intent —
// confirmed to false-positive on canonical ordinary requests like "write a
// python file to test this function" and "create a java file with a main
// method" (22/22 tested phrasings incorrectly matched). It also accepted
// bare "download" as a verb, which false-positived on troubleshooting
// questions about downloading an EXISTING third-party script ("how do I
// download a python script from github"), unrelated to generating new
// code. Both are now fixed by requiring the literal, deliberate word
// "downloadable" (a word essentially nobody uses unless explicitly
// describing a desired deliverable — the same reasoning already used by
// FILE_GEN_GENERIC_KEYWORDS below for the generic case), OR the specific
// "download ... as a LANGUAGE file/script" phrasing (requires "as a"
// literally, which none of the confirmed false-positive troubleshooting
// phrases contain).
//
// 2026-07-16 audit: also widened (not narrowed — the risk profile means
// widening must stay conservative) to accept common source-file EXTENSION
// tokens ("a .py file") alongside language names — the original design
// missed its own triage prompt's canonical example, "give me this as a .py
// file I can download", because extension tokens like ".py" weren't in
// CODE_LANGUAGE_NAMES, and that phrasing's word order ("as a X file" ...
// "download" appearing LATER) didn't fit any of the 3 original alternatives.
// The new 4th alternative below covers exactly that order, still gated on
// the literal word "download" appearing nearby (not just any generation verb).
//
// 2026-07-17: both lists widened to match FileGenerationService's
// CODE_LANGUAGE_EXTENSIONS 1:1 (that render-side map is the actual source
// of truth for what the system can produce) — every key it accepts as a
// `language` value is now also a recognized DETECTION token, and every
// value (extension) is in the dot-branch. Confirmed gaps before this fix
// (execution): "xml"/"toml"/"scss"/"sass"/"vue"/"yaml"/"ini" were entirely
// ABSENT from both lists — "generate a downloadable xml file" produced
// ZERO file capability (not even the generic fallback, since the bare word
// sits between "downloadable" and "file", breaking that pattern too).
// Short aliases (js/ts/py/rs/cs/...) are now accepted as bare LANGUAGE
// names too, not only as dotted extensions — safe to widen because the
// narrowness of this capability comes entirely from the required
// "downloadable"/"download…as a" signal word, not from restricting which
// language token fills the slot.
const CODE_LANGUAGE_NAMES =
  'python|py|javascript|js|typescript|ts|jsx|tsx|java|kotlin|kt|swift|golang|go|rust|rs|' +
  'c\\+\\+|cpp|cplusplus|csharp|c#|cs|ruby|rb|php|html|css|scss|sass|sql|' +
  'shell|bash|sh|zsh|powershell|ps1|yaml|yml|toml|xml|perl|pl|lua|r|scala|' +
  'haskell|hs|elixir|ex|erlang|erl|clojure|clj|dart|vue|graphql|gql|ini|c';
const CODE_FILE_EXTENSIONS =
  'py|js|jsx|ts|tsx|java|kt|swift|go|rs|c|cpp|cs|rb|php|html|css|scss|sass|sql|sh|ps1|pl|lua|hs|dart|scala|r|clj|ex|erl|yml|yaml|toml|xml|vue|graphql|gql|ini';
// Boundaries live INSIDE this group, per branch: language names take a
// plain leading \b, but the extension branch starts with a LITERAL DOT, and
// `\b` before a dot never asserts after whitespace (non-word -> non-word) —
// the exact ASCII-\b bug class this PR documents for "áudio", reintroduced
// here by the first draft and confirmed by execution ("create a
// downloadable .py script" matched nothing). The extension branch instead
// requires the char before the dot to not be word-ish (`(?<![\w.])`), so
// "downloadable .py script" matches while "v1.2.py"-style version noise and
// "main.py" interiors don't double-count.
const CODE_FILE_NOUN = `(?:\\b(?:${CODE_LANGUAGE_NAMES})|(?<![\\w.])\\.(?:${CODE_FILE_EXTENSIONS}))`;
// pt-BR alternatives mirror the same strength requirement as English
// ("downloadable"/"download … as a … file"): the literal download-intent
// words baixável/baixar/download are required — added after the adversarial
// review confirmed a pt-BR user explicitly asking "gere um script python
// para download, quero baixar como arquivo .py" got NO file capability
// while every other format had gained pt-BR support.
const CODE_FILE_GEN_KEYWORDS = new RegExp(
  `\\bdownloadable\\s+.{0,25}${CODE_FILE_NOUN}\\s+(?:source\\s+)?(?:file|script)\\b` +
    `|` +
    `${CODE_FILE_NOUN}\\s+(?:source\\s+)?(?:file|script)\\s+.{0,20}\\bdownloadable\\b` +
    `|` +
    `\\bdownload(?:able)?\\s+(?:this|it)?\\s*as\\s+an?\\s+${CODE_FILE_NOUN}\\s+(?:file|script)\\b` +
    `|` +
    `\\bas\\s+an?\\s+${CODE_FILE_NOUN}\\s+(?:file|script)\\b.{0,25}\\b(?:i|you)\\s+can\\s+download\\b` +
    `|` +
    `\\b(?:arquivo|script)\\s+${CODE_FILE_NOUN}\\s*.{0,20}\\b(?:baixável|baixavel|para\\s+(?:baixar|download))` +
    `|` +
    `\\b(?:baixar|download)\\b.{0,15}\\bcomo\\s+(?:um\\s+)?(?:arquivo|script)\\s*${CODE_FILE_NOUN}`,
  'iu'
);
// Generic "a file" fallback — deliberately narrower (indefinite article
// required) than the format-specific patterns above to limit false
// positives on unrelated uses of the word "file". pt-BR mirrors the same
// "downloadable"-equivalent strength requirement (baixável/para baixar),
// not a bare "arquivo" mention.
const FILE_GEN_GENERIC_KEYWORDS = new RegExp(
  `\\b(?:generate|create|make|produce|export|download)\\s+.{0,15}\\ba\\s+(?:downloadable\\s+)?file\\b` +
    `|` +
    `\\b(?:gere|crie|monte|produza|exporte)\\s+.{0,15}\\bum\\s+arquivo\\s+(?:baixável|para\\s+baixar)\\b`,
  'i'
);

// ---------------------------------------------------------------------------
// Core inference
// ---------------------------------------------------------------------------

/**
 * Analyze messages and optional metadata to infer the capabilities required
 * to serve this request well.
 *
 * @param messages - The conversation messages (at minimum the latest user turn).
 * @param metadata - Optional: attached tool definitions and max_tokens hint.
 * @returns A {@link CapabilityInferenceResult} describing the request.
 */
export function inferCapabilities(
  messages: Array<{ role: string; content: string }>,
  metadata?: { tools?: unknown[]; max_tokens?: number },
): CapabilityInferenceResult {
  const userMessages = messages.filter((m) => m.role === 'user');
  const _lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  const allUserText = userMessages.map((m) => m.content).join('\n');
  const totalCharCount = allUserText.length;

  // ---- Task type detection (ordered by specificity) ----

  const taskSignals: Array<{ type: InferredTaskType; score: number }> = [];

  // Coding
  let codingScore = 0;
  if (CODING_KEYWORDS.test(allUserText)) codingScore += 0.4;
  if (CODING_PHRASES.test(allUserText)) codingScore += 0.35;
  if (CODE_BLOCK_RE.test(allUserText)) codingScore += 0.25;
  if (codingScore > 0) taskSignals.push({ type: 'coding', score: codingScore });

  // Reasoning
  let reasoningScore = 0;
  if (REASONING_KEYWORDS.test(allUserText)) reasoningScore += 0.5;
  if (MATH_KEYWORDS.test(allUserText)) reasoningScore += 0.3;
  if (MATH_NOTATION_RE.test(allUserText)) reasoningScore += 0.2;
  if (reasoningScore > 0) taskSignals.push({ type: 'reasoning', score: reasoningScore });

  // Creative
  if (CREATIVE_KEYWORDS.test(allUserText)) {
    taskSignals.push({ type: 'creative', score: 0.7 });
  }

  // Factual QA
  if (FACTUAL_QA_KEYWORDS.test(allUserText)) {
    taskSignals.push({ type: 'factual_qa', score: 0.5 });
  }

  // Translation
  if (TRANSLATION_KEYWORDS.test(allUserText)) {
    taskSignals.push({ type: 'translation', score: 0.8 });
  }

  // Summarization
  if (SUMMARIZATION_KEYWORDS.test(allUserText)) {
    taskSignals.push({ type: 'summarization', score: 0.75 });
  }

  // Tool use
  let toolScore = 0;
  if (metadata?.tools && Array.isArray(metadata.tools) && metadata.tools.length > 0) {
    toolScore += 0.6;
  }
  if (TOOL_USE_KEYWORDS.test(allUserText)) toolScore += 0.3;
  if (toolScore > 0) taskSignals.push({ type: 'tool_use', score: toolScore });

  // Multi-step
  let multiStepScore = 0;
  if (MULTI_STEP_INDICATORS.test(allUserText)) multiStepScore += 0.5;
  if (NUMBERED_LIST_RE.test(allUserText)) multiStepScore += 0.3;
  if (messages.length > 6) multiStepScore += 0.2;
  if (multiStepScore > 0) taskSignals.push({ type: 'multi_step', score: multiStepScore });

  // Pick highest-scoring task type
  taskSignals.sort((a, b) => b.score - a.score);
  const taskType: InferredTaskType = taskSignals.length > 0 ? taskSignals[0].type : 'general';
  const taskConfidence = taskSignals.length > 0 ? Math.min(taskSignals[0].score, 1) : 0.3;

  // ---- Required capabilities ----

  const capabilities: Set<RequiredCapability> = new Set();

  if (toolScore > 0) capabilities.add('tool_use');
  if (SAFETY_KEYWORDS.test(allUserText)) capabilities.add('safety_critical');
  if (codingScore > 0) capabilities.add('code_execution');
  if (MATH_KEYWORDS.test(allUserText) || MATH_NOTATION_RE.test(allUserText)) {
    capabilities.add('math_reasoning');
  }
  if (MULTILINGUAL_RE.test(allUserText) || TRANSLATION_KEYWORDS.test(allUserText)) {
    capabilities.add('multilingual');
  }
  if (FACTUAL_QA_KEYWORDS.test(allUserText)) capabilities.add('groundedness');

  // Multimodal capabilities — image, audio, video generation and vision
  if (IMAGE_GEN_KEYWORDS.test(allUserText) || IMAGE_GEN_DIRECT.test(allUserText) || IMAGE_GEN_SIMPLE.test(allUserText)) {
    capabilities.add('image_generation');
  }
  if (AUDIO_GEN_KEYWORDS.test(allUserText) || AUDIO_GEN_DIRECT.test(allUserText)) {
    capabilities.add('audio_generation');
  }
  if (VIDEO_GEN_KEYWORDS.test(allUserText) || VIDEO_GEN_DIRECT.test(allUserText)) {
    capabilities.add('video_generation');
  }

  // File generation — most-specific format wins; only fall back to the
  // generic tag when none of the concrete formats matched. zip_generation
  // is checked first: a request like "generate a zip with a csv and json
  // inside" would also match CSV_GEN_KEYWORDS/JSON_GEN_KEYWORDS, but the
  // outer intent (a bundled archive, not a single csv/json file) should win.
  if (ZIP_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('zip_generation');
  } else if (DOCX_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('docx_generation');
  } else if (XLSX_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('xlsx_generation');
  } else if (PDF_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('pdf_generation');
  } else if (PPTX_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('pptx_generation');
  } else if (CSV_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('csv_generation');
  } else if (JSON_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('json_generation');
  } else if (MARKDOWN_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('markdown_generation');
  } else if (CODE_FILE_GEN_KEYWORDS.test(allUserText)) {
    capabilities.add('code_file_generation');
  } else if (FILE_GEN_GENERIC_KEYWORDS.test(allUserText)) {
    capabilities.add('file_generation');
  }

  // Vision: detect image_url content parts in messages
  const hasImageContent = messages.some(m => {
    if (typeof m.content !== 'string' && Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string }>).some(
        part => part.type === 'image_url',
      );
    }
    return false;
  });
  if (hasImageContent) {
    capabilities.add('vision');
  }

  // ---- Context needs ----

  const estimatedTokens = Math.ceil(totalCharCount / 4); // rough char-to-token
  const maxTokensHint = metadata?.max_tokens ?? 0;
  const totalEstimate = estimatedTokens + maxTokensHint;

  let contextNeeds: ContextNeed;
  if (totalEstimate < 2000) {
    contextNeeds = 'short';
  } else if (totalEstimate < 8000) {
    contextNeeds = 'medium';
  } else if (totalEstimate < 32000) {
    contextNeeds = 'long';
    capabilities.add('long_context');
  } else {
    contextNeeds = 'very_long';
    capabilities.add('long_context');
  }

  // ---- Complexity ----

  const complexity = estimateComplexity(allUserText, messages.length, capabilities.size);

  // ---- Risk profile ----

  let riskProfile: RiskProfile = 'low';
  if (capabilities.has('safety_critical')) {
    riskProfile = SAFETY_CRITICAL_KEYWORDS.test(allUserText) ? 'critical' : 'high';
  } else if (complexity === 'expert' || complexity === 'complex') {
    riskProfile = 'medium';
  }

  // ---- Cost sensitivity ----

  const costSensitivity = deriveCostSensitivity(allUserText, complexity, contextNeeds);

  // ---- Composite confidence ----

  const confidence = Number(
    Math.max(0.1, Math.min(1, taskConfidence * 0.6 + (capabilities.size > 0 ? 0.2 : 0) + (complexity !== 'simple' ? 0.1 : 0) + 0.1)).toFixed(3),
  );

  log.debug(
    {
      taskType,
      complexity,
      riskProfile,
      contextNeeds,
      costSensitivity,
      capabilities: [...capabilities],
      confidence,
    },
    'Capability inference completed',
  );

  return {
    taskType,
    complexity,
    requiredCapabilities: [...capabilities],
    riskProfile,
    contextNeeds,
    costSensitivity,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/**
 * Estimate complexity from message length, constraint density, and
 * number of detected capability requirements.
 */
function estimateComplexity(
  text: string,
  messageCount: number,
  capabilityCount: number,
): ComplexityLevel {
  let score = 0;

  // Length contribution
  const charLen = text.length;
  if (charLen > 8000) score += 3;
  else if (charLen > 3000) score += 2;
  else if (charLen > 800) score += 1;

  // Constraint density — count constraint-like phrases
  const constraintRe = /\b(must|should|ensure|require|constraint|at\s+least|no\s+more\s+than|exactly|between|within|at\s+most|cannot|do\s+not)\b/gi;
  const constraints = (text.match(constraintRe) || []).length;
  if (constraints > 8) score += 3;
  else if (constraints > 4) score += 2;
  else if (constraints > 1) score += 1;

  // Nested requirements — indentation or sub-lists
  const nestingRe = /(?:^|\n)\s{4,}[-*]|(?:^|\n)\s+\d+\.\d+/;
  if (nestingRe.test(text)) score += 1;

  // Multi-turn depth
  if (messageCount > 10) score += 2;
  else if (messageCount > 4) score += 1;

  // Capability breadth
  if (capabilityCount >= 4) score += 2;
  else if (capabilityCount >= 2) score += 1;

  if (score >= 8) return 'expert';
  if (score >= 5) return 'complex';
  if (score >= 2) return 'moderate';
  return 'simple';
}

// ---------------------------------------------------------------------------
// Cost sensitivity heuristic
// ---------------------------------------------------------------------------

const COST_SENSITIVE_RE = /\b(cheap|budget|low[\s-]?cost|cost[\s-]?effective|minimize\s*cost|affordable|save\s*money|economical|frugal)\b/i;
const QUALITY_PRIORITY_RE = /\b(best\s*(possible|quality)|high[\s-]?quality|premium|top[\s-]?tier|state[\s-]?of[\s-]?the[\s-]?art|no\s*expense)\b/i;

function deriveCostSensitivity(
  text: string,
  complexity: ComplexityLevel,
  contextNeeds: ContextNeed,
): CostSensitivity {
  if (COST_SENSITIVE_RE.test(text)) return 'high';
  if (QUALITY_PRIORITY_RE.test(text)) return 'low';

  // Longer / more complex requests are inherently costlier — treat
  // the user as moderately cost-sensitive unless they signal otherwise.
  if (contextNeeds === 'very_long' || complexity === 'expert') return 'medium';
  if (complexity === 'simple' && contextNeeds === 'short') return 'high';

  return 'medium';
}
