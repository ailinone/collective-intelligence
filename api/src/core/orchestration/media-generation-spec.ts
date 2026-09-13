// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Structured media-generation spec EXTRACTION (Package A, 2026-09-09).
 *
 * The problem this closes: when a user asks for "a 30-second 4K video with
 * audio and a soundtrack", nothing in the pipeline reliably turns that
 * sentence into checkable fields UNLESS an LLM (the triage model) happens to
 * extract them correctly. Concretely, as of this change:
 *
 *   - `TriageStageSchema` (triage-schema.ts) already carries optional
 *     `duration`/`resolution`/`aspect_ratio`/`audio_requested` fields (LOTE AS,
 *     2026-09-06), and `VideoOrchestrationService` already has a real,
 *     catalog-attribute-aware pre-filter (`video-capability-matcher.ts
 *     #canSatisfyVideoAttributes`, consuming `ProviderCatalogEntry
 *     .videoCapabilityAttributes`) — but BOTH of those depend entirely on the
 *     TRIAGE LLM correctly extracting the fields from prose per the system
 *     prompt's few-shot examples. There is no deterministic fallback for when
 *     it doesn't.
 *   - `detectVideoGenerationIntent` (chat-request-processor.ts), the EARLY
 *     chat-completion path that bypasses triage entirely, reads ONLY explicit
 *     top-level request fields (`duration`, `aspect_ratio`, `size`) — it never
 *     looks at the prompt text at all, and has no audio-requested detection
 *     whatsoever. A user typing "generate a 30 second 4K video with a
 *     soundtrack" directly in chat (the exact audit example) gets
 *     `duration: undefined, aspectRatio: undefined, size: undefined` and no
 *     audio signal, full stop.
 *
 * This module is the deterministic, rules-based extraction layer that closes
 * both gaps — see `video-orchestration-service.ts` (soundtrack composition)
 * and `chat-request-processor.ts`/`orchestration-engine.ts` (call sites that
 * merge this extraction in as a fallback under LLM/explicit-field values).
 *
 * Design choice: rules-based extraction, not a structured-output LLM call.
 * This codebase's own idiom for "read structured signal out of a free-text
 * generation prompt" is exactly the regex/keyword approach already used one
 * file over by `capability-inference.ts` (image/audio/video/file-generation
 * DETECTION) and by the triage LLM's own few-shot prompt for this SAME
 * duration/resolution/aspect-ratio/audio extraction task. Duration/resolution/
 * audio-required phrasing is highly regular ("30 second", "1080p", "with a
 * soundtrack", "no audio needed") — regular enough that a deterministic parser
 * reaches useful coverage as a FALLBACK, without adding a paid sub-call +
 * latency to every video/image generation request just to catch the cases the
 * primary mechanism (triage LLM, or an explicit request field) already misses.
 *
 * NOTE on scope: catalog-attribute COMPARISON (does a candidate model's
 * declared limits satisfy the request) is intentionally NOT duplicated here —
 * that already exists, is more mature than a first draft of it would be, and
 * lives in `@/providers/catalog/video-capability-matcher.ts`
 * (`canSatisfyVideoAttributes`, `resolutionTier`, `normalizeRatio`), wired
 * into `VideoOrchestrationService.selectVideoCandidateModels`. This module's
 * extracted `resolution` tokens ('480p'|'720p'|'1080p'|'2K'|'4K'|'8K') are
 * valid input strings for that matcher's `resolutionTier()` lookup table
 * as-is (it lowercases before its own table lookup) — no bridging/mapping
 * function is needed there. The 'K' tokens are deliberately UPPERCASE,
 * matching the casing `TRIAGE_SYSTEM_PROMPT` teaches the triage LLM to
 * extract (triage-service.ts: `"in 4K" -> resolution: "4K"`) and the exact
 * casing `byteplus-adapter.ts#buildVideoBody`'s `RESOLUTIONS` set requires
 * (`new Set(['480p', '720p', '1080p', '4K'])`, a case-SENSITIVE check) — this
 * extraction fallback's whole point is to fill the same `resolution` field
 * triage populates, so it must produce values that field's real downstream
 * consumers accept, not just values `resolutionTier()` tolerates.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse resolution ladder — matches the labeled tiers
 *  `video-capability-matcher.ts#resolutionTier` already recognizes (that
 *  lookup is case-insensitive). The 'K' tokens are uppercase to match the
 *  casing triage extraction and `byteplus-adapter.ts`'s case-sensitive
 *  `RESOLUTIONS` set both use — see the module doc above. */
export type VideoResolutionToken = '480p' | '720p' | '1080p' | '2K' | '4K' | '8K';

/** Structured spec extracted from (or explicitly supplied alongside) a
 *  video-generation request. Every field is optional: absence means "not
 *  mentioned/not requested", never "requested as the default". Field names
 *  intentionally mirror `VideoGenerationOptions` (video-orchestration-service.ts)
 *  EXCEPT `requiresAudio`, which maps onto that interface's `generateAudio`
 *  at the call site — `requiresAudio` reads better as a spec predicate and
 *  this module has no direct dependency on that interface. */
export interface VideoGenerationSpec {
  readonly durationSeconds?: number;
  readonly resolution?: VideoResolutionToken;
  readonly aspectRatio?: string;
  /** `true` = explicit audio/soundtrack request. `false` = explicit "no
   *  audio"/"silent" request. `undefined` = not mentioned either way. */
  readonly requiresAudio?: boolean;
}

/** Structured spec extracted for image-generation requests. Deliberately
 *  narrower than video's — the concrete, checkable image attribute this
 *  codebase's API surface exposes is the fixed OpenAI-style `size` enum
 *  (see `ImageGenerationOptions.size` in images-orchestration-service.ts). */
export interface ImageGenerationSpec {
  readonly size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
}

// ---------------------------------------------------------------------------
// Word boundary helpers
// ---------------------------------------------------------------------------

// Unicode-aware word boundary — mirrors capability-inference.ts's documented
// fix for the ASCII-only `\b` gap (plain `\b` never asserts a boundary right
// before an accented first character under the `u` flag, since `\w` stays
// ASCII-only even then). Reused here rather than imported because the
// constants are module-private in capability-inference.ts.
const WB_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WB_AFTER = '(?![\\p{L}\\p{N}_])';

// ---------------------------------------------------------------------------
// Resolution extraction
// ---------------------------------------------------------------------------

// Checked in descending-resolution order so that a prompt mentioning more
// than one token (rare, e.g. "upscale from 720p to 4K") resolves to the
// higher one — the more common intent when two are both present.
const RESOLUTION_PATTERNS: ReadonlyArray<{ token: VideoResolutionToken; re: RegExp }> = [
  { token: '8K', re: new RegExp(`${WB_BEFORE}8k${WB_AFTER}`, 'iu') },
  {
    token: '4K',
    re: new RegExp(`${WB_BEFORE}(?:4k|uhd|2160p|ultra[\\s-]?hd)${WB_AFTER}`, 'iu'),
  },
  { token: '2K', re: new RegExp(`${WB_BEFORE}(?:2k|1440p|qhd)${WB_AFTER}`, 'iu') },
  {
    token: '1080p',
    re: new RegExp(`${WB_BEFORE}(?:1080p|full[\\s-]?hd|fhd)${WB_AFTER}`, 'iu'),
  },
  { token: '720p', re: new RegExp(`${WB_BEFORE}(?:720p|hd)${WB_AFTER}`, 'iu') },
  { token: '480p', re: new RegExp(`${WB_BEFORE}(?:480p|sd)${WB_AFTER}`, 'iu') },
];

export function extractResolution(text: string): VideoResolutionToken | undefined {
  for (const { token, re } of RESOLUTION_PATTERNS) {
    if (re.test(text)) return token;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Aspect ratio extraction
// ---------------------------------------------------------------------------

// Restricted to an ALLOWLIST of known video/image aspect ratios rather than a
// generic `\d+:\d+` pattern — the generic form false-positives heavily on
// clock times ("10:30"), sports scores, and odds ("3:2 favorite") that
// legitimately appear inside a generation prompt's descriptive text. Every
// ratio actually offered by video-generation providers in this catalog fits
// this small allowlist.
const KNOWN_ASPECT_RATIOS = ['21:9', '16:9', '9:16', '4:3', '3:4', '5:4', '4:5', '1:1'] as const;
const ASPECT_RATIO_EXPLICIT_RE = new RegExp(`\\b(${KNOWN_ASPECT_RATIOS.join('|')})\\b`);

const ASPECT_RATIO_WORDS: ReadonlyArray<{ ratio: string; re: RegExp }> = [
  {
    ratio: '9:16',
    re: new RegExp(
      `${WB_BEFORE}(?:vertical|portrait|story|reels?|tiktok[\\s-]?style)${WB_AFTER}`,
      'iu'
    ),
  },
  {
    ratio: '16:9',
    re: new RegExp(`${WB_BEFORE}(?:landscape|widescreen|horizontal)${WB_AFTER}`, 'iu'),
  },
  { ratio: '1:1', re: new RegExp(`${WB_BEFORE}square${WB_AFTER}`, 'iu') },
];

export function extractAspectRatio(text: string): string | undefined {
  const explicit = ASPECT_RATIO_EXPLICIT_RE.exec(text);
  if (explicit) return explicit[1];
  for (const { ratio, re } of ASPECT_RATIO_WORDS) {
    if (re.test(text)) return ratio;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Duration extraction
// ---------------------------------------------------------------------------

const DURATION_SECONDS_RE = new RegExp(
  `\\b(\\d{1,4}(?:\\.\\d+)?)\\s*-?\\s*(?:seconds?|secs?)${WB_AFTER}`,
  'iu'
);
const DURATION_MINUTES_RE = new RegExp(
  `\\b(\\d{1,3}(?:\\.\\d+)?)\\s*-?\\s*(?:minutes?|mins?)${WB_AFTER}`,
  'iu'
);
// Shorthand form ("10s", "30s") — no space required. Deliberately requires a
// `\b` immediately before the digits, which already excludes attached
// alphanumeric tokens ("PS5s", "RTX4090s": the character before the digit
// run is a letter, so there is no word-boundary transition there for the
// regex to anchor on).
const DURATION_SHORTHAND_RE = /\b(\d{1,3})s\b/i;
// Round-decade numbers are excluded from the bare shorthand form: "80s
// aesthetic" and "in the 90s" are far more common inside a creative video
// prompt than a request for an 80- or 90-second clip, and a genuine 80/90
// second requirement is still caught by the explicit "80 seconds"/
// "90-second" forms above — only the terse, unqualified "80s" shorthand is
// excluded here.
const ROUND_DECADE_NUMBERS: ReadonlySet<number> = new Set([20, 30, 40, 50, 60, 70, 80, 90]);
const MIN_PLAUSIBLE_DURATION_SECONDS = 1;
const MAX_PLAUSIBLE_DURATION_SECONDS = 600;

export function extractDurationSeconds(text: string): number | undefined {
  const minutesMatch = DURATION_MINUTES_RE.exec(text);
  if (minutesMatch) {
    const minutes = Number.parseFloat(minutesMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return Math.round(minutes * 60);
    }
  }

  const secondsMatch = DURATION_SECONDS_RE.exec(text);
  if (secondsMatch) {
    const seconds = Number.parseFloat(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds);
    }
  }

  const shorthandMatch = DURATION_SHORTHAND_RE.exec(text);
  if (shorthandMatch) {
    const seconds = Number.parseInt(shorthandMatch[1], 10);
    if (
      Number.isFinite(seconds) &&
      seconds >= MIN_PLAUSIBLE_DURATION_SECONDS &&
      seconds <= MAX_PLAUSIBLE_DURATION_SECONDS &&
      !ROUND_DECADE_NUMBERS.has(seconds)
    ) {
      return seconds;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Audio-required extraction
// ---------------------------------------------------------------------------

const AUDIO_NEGATIVE_RE = new RegExp(
  `${WB_BEFORE}(?:no|without|skip|omit)${WB_AFTER}\\s+.{0,20}${WB_BEFORE}(?:audio|sound|music|soundtrack|narration|voice)${WB_AFTER}` +
    `|${WB_BEFORE}(?:silent|mute|muted|soundless)${WB_AFTER}`,
  'iu'
);

const AUDIO_POSITIVE_RE = new RegExp(
  `${WB_BEFORE}with${WB_AFTER}\\s+(?:an?\\s+)?.{0,15}${WB_BEFORE}(?:audio|sound(?:track)?|music|voice(?:over)?|narration)${WB_AFTER}` +
    `|${WB_BEFORE}(?:add|include|includes|needs?)${WB_AFTER}\\s+.{0,15}${WB_BEFORE}(?:audio|sound|music|voice|narration|soundtrack)${WB_AFTER}` +
    `|${WB_BEFORE}(?:audio|sound|music|soundtrack)${WB_AFTER}\\s+(?:track\\s+)?(?:required|included|please)`,
  'iu'
);

/**
 * `true` = explicit request for audio/a soundtrack. `false` = explicit
 * request for silence/no audio. `undefined` = not mentioned. The negative
 * pattern is checked FIRST: "no audio needed" would otherwise also satisfy
 * the generic "audio ... needed" positive alternative.
 */
export function extractRequiresAudio(text: string): boolean | undefined {
  if (AUDIO_NEGATIVE_RE.test(text)) return false;
  if (AUDIO_POSITIVE_RE.test(text)) return true;
  return undefined;
}

// ---------------------------------------------------------------------------
// Composite extraction
// ---------------------------------------------------------------------------

export function extractVideoGenerationSpec(text: string | undefined | null): VideoGenerationSpec {
  const source = text ?? '';
  if (!source.trim()) return {};

  const durationSeconds = extractDurationSeconds(source);
  const resolution = extractResolution(source);
  const aspectRatio = extractAspectRatio(source);
  const requiresAudio = extractRequiresAudio(source);

  return {
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(requiresAudio !== undefined ? { requiresAudio } : {}),
  };
}

export function hasVideoGenerationSpecFields(spec: VideoGenerationSpec): boolean {
  return (
    spec.durationSeconds !== undefined ||
    spec.resolution !== undefined ||
    spec.aspectRatio !== undefined ||
    spec.requiresAudio !== undefined
  );
}

/**
 * Merge an explicitly-supplied spec (from a structured API field, or the
 * triage LLM's own `TriageStage.duration`/`.resolution`/`.aspectRatio`/
 * `.audioRequested` extraction) with one extracted from prompt text here.
 * Explicit, per-field values always win — extraction is a FALLBACK for
 * whichever fields the caller/LLM did not already supply.
 */
export function mergeVideoGenerationSpec(
  explicit: VideoGenerationSpec | undefined,
  extracted: VideoGenerationSpec
): VideoGenerationSpec {
  return {
    ...extracted,
    ...(explicit?.durationSeconds !== undefined
      ? { durationSeconds: explicit.durationSeconds }
      : {}),
    ...(explicit?.resolution !== undefined ? { resolution: explicit.resolution } : {}),
    ...(explicit?.aspectRatio !== undefined ? { aspectRatio: explicit.aspectRatio } : {}),
    ...(explicit?.requiresAudio !== undefined ? { requiresAudio: explicit.requiresAudio } : {}),
  };
}

// ---------------------------------------------------------------------------
// Image spec extraction (narrower — see ImageGenerationSpec doc)
// ---------------------------------------------------------------------------

const SMALL_IMAGE_SIZE_RE = new RegExp(
  `${WB_BEFORE}(?:thumbnail|icon|favicon|tiny\\s+(?:image|picture)|small\\s+(?:image|picture|square))${WB_AFTER}`,
  'iu'
);

export function extractImageGenerationSpec(text: string | undefined | null): ImageGenerationSpec {
  const source = text ?? '';
  if (!source.trim()) return {};

  const aspectRatio = extractAspectRatio(source);
  if (aspectRatio === '9:16' || aspectRatio === '3:4' || aspectRatio === '4:5') {
    return { size: '1024x1792' };
  }
  if (aspectRatio === '16:9' || aspectRatio === '21:9') {
    return { size: '1792x1024' };
  }
  if (SMALL_IMAGE_SIZE_RE.test(source)) {
    return { size: '256x256' };
  }
  if (aspectRatio === '1:1' || aspectRatio === '5:4' || aspectRatio === '4:3') {
    return { size: '1024x1024' };
  }
  return {};
}
