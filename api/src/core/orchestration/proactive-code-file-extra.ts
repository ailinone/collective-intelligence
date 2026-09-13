// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proactive structured extras — code-block-to-file promotion.
 *
 * SCOPE: the first of the two follow-ups explicitly deferred by
 * `proactive-structured-extras.ts`'s module doc comment (table -> chart).
 * This module implements exactly ONE extra: when a plain (non-streaming)
 * chat response's finished text already contains a large, well-formed,
 * clearly-tagged fenced code block, ALSO materialize that block as a real
 * downloadable file via `FileGenerationService` and attach it as an
 * `ArtifactRef` through the SAME `AilinMetadata.tool_artifacts` pipeline the
 * table-to-chart extra uses. No new artifact mechanism, no new rendering
 * infrastructure — `FileGenerationService`'s existing `code` format already
 * exists exactly for "materialize already-generated source as a downloadable
 * file" (see its own doc comment: "the content already IS the file's
 * bytes").
 *
 * TRIGGER DESIGN (mirrors proactive-structured-extras.ts's philosophy — an
 * over-eager trigger that decorates every code-containing answer is worse
 * than no feature):
 *
 *   - Requires a PROPERLY CLOSED fence (opening ``` ... closing ```). A
 *     response truncated mid-block (e.g. cut off at `max_tokens`) simply has
 *     no closing fence and never matches — no separate "is this truncated"
 *     detection is needed for that case. As an extra belt-and-braces layer,
 *     the caller may also pass the response's own `finish_reason`; a value
 *     of `'length'` skips detection entirely regardless of what matched,
 *     since a generation that was cut off elsewhere in the response is not
 *     trustworthy enough to promote any part of it as "the complete file".
 *   - Requires a REAL, RECOGNIZED language tag immediately after the opening
 *     fence (e.g. ` ```python `). An UNTAGGED fence, or one tagged with a
 *     generic non-language placeholder ('text'/'plaintext'/'txt'), is never
 *     promoted — this is deliberately the single strongest signal against
 *     misreading illustrative pseudocode as a real source file (pseudocode
 *     is routinely fenced untagged, e.g. ` ``` ` with no language, precisely
 *     because it is NOT any real language). The allow-list is the same
 *     canonical language roster `FileGenerationService` already resolves
 *     extensions from (`CODE_LANGUAGE_EXTENSIONS`), so a tag this module
 *     accepts is guaranteed to resolve to a real, non-generic extension.
 *     Deliberately does NOT fall back to sniffing a filename hint from
 *     surrounding prose when the tag is missing/generic — that would be a
 *     heuristic layered on top of a heuristic, doubling the false-positive
 *     surface for a purely cosmetic benefit (the extension the language tag
 *     already grants is sufficient; a nicer filename stem is not worth the
 *     risk).
 *   - Requires the block to be SUBSTANTIAL: at least {@link MIN_CODE_LINES}
 *     non-blank lines AND at least {@link MIN_CODE_CHARS} characters (both
 *     must hold — no partial credit). A short illustrative snippet ("here's
 *     the general idea: ```python\nfor x in y:\n    print(x)\n```") is not
 *     "a complete downloadable file".
 *   - When multiple qualifying blocks exist in one response, only the
 *     LARGEST (by character count) is promoted — one proactive extra per
 *     response, deterministically the most substantial candidate.
 *   - Detection runs entirely post-hoc on the model's already-finished text,
 *     same as the table-to-chart extra — the model is never asked whether a
 *     file would help.
 */
import { FileGenerationService, CODE_LANGUAGE_EXTENSIONS } from '@/services/file-generation-service';
import type { ArtifactRef } from '@/types';

/** See module doc comment — the "substantial" half of the trigger condition. */
const MIN_CODE_LINES = 12;
/** See module doc comment — the other half (both must hold). */
const MIN_CODE_CHARS = 200;

/** Defensive cap: skip detection entirely on pathologically large content
 *  (mirrors proactive-structured-extras.ts's MAX_CONTENT_LENGTH). */
const MAX_CONTENT_LENGTH = 200_000;

/** Generic/non-language fence tags that convey no real "this is source code"
 *  signal — excluded from the allow-list even though FileGenerationService
 *  itself resolves them (to CODE_DEFAULT_EXTENSION = 'txt'). A block fenced
 *  as ```text or with no tag at all is exactly the shape illustrative
 *  pseudocode/output samples take. */
const GENERIC_LANGUAGE_TAGS = new Set(['text', 'plaintext', 'txt']);

/** The allow-list itself: every `CODE_LANGUAGE_EXTENSIONS` key minus the
 *  generic placeholders above. Reusing that map (rather than a second,
 *  independently-maintained list) guarantees this module's notion of "a real
 *  language" can never silently drift from what `FileGenerationService`
 *  actually resolves a correct extension for. */
const ALLOWED_LANGUAGE_TAGS = new Set(
  Object.keys(CODE_LANGUAGE_EXTENSIONS).filter((tag) => !GENERIC_LANGUAGE_TAGS.has(tag))
);

/** Matches a fenced block with a language tag on the opening line, capturing
 *  the tag and the body lazily up to the NEXT closing fence. Deliberately
 *  requires the closing fence to exist — an unterminated block (e.g. a
 *  response truncated mid-block) never matches at all, see module doc
 *  comment. Tag charset mirrors common GFM info-string usage (letters,
 *  digits, `+`, `#`, `.`, `-`, `_` — covers tags like "c++", "c#", "objective-c"). */
const FENCE_RE = /```([A-Za-z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;

const fileGenerationService = new FileGenerationService();

export interface CodeBlockCandidate {
  language: string;
  code: string;
  nonBlankLines: number;
  charCount: number;
}

/**
 * Finds every properly-closed, language-tagged fenced code block in
 * `content` and returns those that pass the "substantial" size gate,
 * keyed to their normalized (trimmed, lowercased) language tag. Pure and
 * total — never throws, returns `[]` when nothing qualifies. Exported (like
 * `parseMarkdownTables` in the sibling table-to-chart module) so each layer
 * of the trigger can be unit-tested independently of the async
 * `FileGenerationService` call in {@link buildProactiveCodeFileArtifact}.
 */
export function findQualifyingCodeBlocks(content: string): CodeBlockCandidate[] {
  const candidates: CodeBlockCandidate[] = [];
  // Reset lastIndex defensively — FENCE_RE is a module-level `g` regex and a
  // prior call that threw partway through iteration could otherwise leave
  // stale state (not currently possible here since nothing in the loop
  // throws, but cheap insurance against a future edit that adds one).
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const [, rawTag, rawBody] = match;
    const language = rawTag.trim().toLowerCase();
    if (!ALLOWED_LANGUAGE_TAGS.has(language)) continue;

    // The fence's opening line's trailing newline is already consumed by the
    // regex; strip exactly one trailing newline before the closing fence
    // (the conventional "code ends, then a fresh line, then ```") without
    // touching any OTHER blank lines the code itself genuinely contains.
    const code = rawBody.replace(/\n$/, '');
    const nonBlankLines = code.split('\n').filter((line) => line.trim() !== '').length;
    const charCount = code.trim().length;
    if (nonBlankLines < MIN_CODE_LINES || charCount < MIN_CODE_CHARS) continue;

    candidates.push({ language, code, nonBlankLines, charCount });
  }
  return candidates;
}

/**
 * Top-level entry point: scans a finished text response for a large,
 * well-formed, language-tagged fenced code block and, if found, materializes
 * it as a downloadable file via `FileGenerationService` and returns a ready
 * `ArtifactRef` for the caller to append to `AilinMetadata.tool_artifacts`.
 * Returns `undefined` when nothing qualifies (the common case) or when
 * `finishReason` indicates the response itself was cut off.
 *
 * Never throws by construction — the only async work is
 * `FileGenerationService.generate('code', ...)`, whose 'code' path only
 * ever validates the exact shape this function itself constructs
 * (`{ language: string, code: string }`), so it cannot fail the way an
 * arbitrary/model-controlled content shape could for the other formats.
 */
export async function buildProactiveCodeFileArtifact(
  content: string,
  finishReason?: string | null
): Promise<ArtifactRef | undefined> {
  if (!content || content.length === 0 || content.length > MAX_CONTENT_LENGTH) return undefined;
  if (finishReason === 'length') return undefined;

  const candidates = findQualifyingCodeBlocks(content);
  if (candidates.length === 0) return undefined;

  // Deterministic: the most substantial candidate wins. `reduce` with a
  // strict `>` keeps the FIRST-occurring block on an exact tie.
  const chosen = candidates.reduce((best, candidate) =>
    candidate.charCount > best.charCount ? candidate : best
  );

  const result = await fileGenerationService.generate(
    'code',
    { language: chosen.language, code: chosen.code },
    'code_snippet'
  );
  const dataUrl = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;

  return {
    type: 'file',
    url: dataUrl,
    mimeType: result.mimeType,
    meta: {
      source: 'proactive_code_file',
      reason: 'response_contains_large_wellformed_code_block',
      language: chosen.language,
      filename: result.filename,
      lines: chosen.nonBlankLines,
      totalChars: chosen.charCount,
    },
  };
}
