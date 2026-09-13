// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-1 Diagnostic Classifier (Tiered Capability Fingerprint, "TCF").
 *
 * Pure, dependency-free classification of ONE diagnostic chat response into
 * structural evidence for eight capabilities: chat, reasoning, analysis,
 * code_generation, json_mode, streaming, translation, refactoring.
 *
 * Design (feasibility investigation, this session): a single rich prompt
 * that asks the model to do all eight things in one response is far cheaper
 * than one probe call per capability (8 calls → 1), and — because each task
 * leaves a distinct, cheaply-checkable STRUCTURAL trace in the response
 * (a numbered step list, a markdown table, a fenced code block, parseable
 * JSON, a second before/after code block, a labeled translation section) —
 * most of the eight verdicts never need an LLM judge at all. Only the
 * genuinely unverifiable-by-regex claim (translation quality) is expected to
 * need one; see `Tier1StructuralVerdict`.
 *
 * Mirrors `strategy-output-evaluator.ts`'s `StructuralChecks` philosophy
 * (cheap deterministic checks first, real facts not vibes) without importing
 * that module: this classifier answers a different question (which
 * CAPABILITIES did the response demonstrate) than that one (is this
 * particular output good enough), and the two have no real code to share
 * beyond "check with a regex before paying for a judge".
 *
 * This module does ZERO I/O — no provider calls, no DB, no judge. The I/O
 * side (making the call, running the judge fallback for ambiguous verdicts,
 * persisting confirmed capabilities) lives in `tier1-diagnostic-probe.ts`.
 */

import type { ModelCapability } from '@/types';

/**
 * The eight capabilities this single diagnostic call can reveal.
 *
 * `as const satisfies readonly ModelCapability[]` (not a plain
 * `: readonly ModelCapability[]` annotation) deliberately: an explicit
 * annotation WIDENS the array to the full `ModelCapability` union, which
 * would make `Tier1Capability` below equal to every capability in the
 * ontology instead of just these eight — `satisfies` validates each element
 * against `ModelCapability` while `as const` keeps the narrow literal tuple
 * type `Tier1Capability` actually needs.
 */
export const TIER1_PROBED_CAPABILITIES = [
  'chat',
  'reasoning',
  'analysis',
  'code_generation',
  'json_mode',
  'streaming',
  'translation',
  'refactoring',
] as const satisfies readonly ModelCapability[];

export type Tier1Capability = (typeof TIER1_PROBED_CAPABILITIES)[number];

/**
 * `confirmed`  — structural check passed; safe to assert without a judge.
 * `ambiguous`  — the diagnostic ATTEMPTED the task (a labeled section
 *                exists) but correctness can't be verified by regex alone;
 *                a judge-model fallback can resolve it (see
 *                `tier1-diagnostic-probe.ts`'s `Tier1JudgeClient`).
 * `rejected`   — the diagnostic did not attempt the task at all (section
 *                missing/empty) — a decisive structural negative. Nothing is
 *                asserted for `rejected` (this module never emits negative
 *                capability claims; see `tier1-diagnostic-probe.ts`'s doc).
 */
export type Tier1StructuralVerdict = 'confirmed' | 'ambiguous' | 'rejected';

export interface Tier1StructuralFacts {
  readonly trimmedLength: number;
  readonly hasNumberedSteps: boolean;
  readonly hasMarkdownTable: boolean;
  readonly codeBlockCount: number;
  readonly jsonSummaryParsed: boolean;
  readonly jsonSummaryHasExpectedKeys: boolean;
  readonly hasTranslationSection: boolean;
  readonly translationContentNonTrivial: boolean;
  readonly confidenceTag: 'high' | 'medium' | 'low' | null;
}

export interface Tier1ClassificationResult {
  readonly verdicts: Readonly<Record<Tier1Capability, Tier1StructuralVerdict>>;
  readonly facts: Tier1StructuralFacts;
}

/**
 * The actual diagnostic prompt. One user message, no system prompt required
 * (the probe caller may still send one — the instructions here are
 * self-contained and don't depend on it). Every section is explicitly
 * labeled so the classifier can regex-locate it regardless of what else the
 * model writes around it.
 *
 * Deliberately generic (no code language or subject pinned to anything
 * proprietary) — the SAME prompt is sent to every model in the sweep so
 * responses are comparable and cacheable per (provider, model).
 */
export function buildTier1DiagnosticPrompt(): string {
  return [
    'Please respond to ALL of the following six tasks in order, using the exact section labels shown (### Step N: <label>) so your answer can be parsed automatically. Keep each section concise.',
    '',
    '### Step 1: Reasoning',
    'A train leaves station A at 60 km/h. Two hours later, a second train leaves the same station on the same track at 90 km/h. Show your reasoning as a NUMBERED list of steps, then state how many hours after the first train the second train catches up.',
    '',
    '### Step 2: Analysis',
    'Summarize the trade-offs between three data storage options (relational database, key-value store, object storage) as a MARKDOWN TABLE with columns: Option | Best for | Weakness.',
    '',
    '### Step 3: Code',
    'Write a short function (any language) that returns the nth Fibonacci number. Put it in a fenced code block with a language tag.',
    '',
    '### Step 4: JSON summary',
    'Output a fenced ```json code block containing a JSON object with exactly these keys: "topic" (string), "difficulty" (one of "low"/"medium"/"high"), "steps_used" (integer).',
    '',
    '### Step 5: Translation',
    'Translate the phrase "The weather is nice today, shall we go for a walk?" into French. Put ONLY the translated sentence after the label "Translation:".',
    '',
    '### Step 6: Refactor',
    'Take this snippet:\n```python\ndef f(x):\n    if x == True:\n        return True\n    else:\n        return False\n```\nRewrite it more idiomatically. Show the ORIGINAL in a code block labeled "Before:" and your rewrite in a code block labeled "After:".',
    '',
    'Finally, on its own line, state your own confidence in the correctness of ALL of the above as: CONFIDENCE: high | medium | low',
  ].join('\n');
}

// ─── Structural regexes ─────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\s*(?:\d+[.)]|step\s+\d+[:.]?)\s+\S/gim;
/** A markdown table needs a header row and a `---`/`:--`-style separator row. */
const MARKDOWN_TABLE_RE = /\|[^\n]*\|[ \t]*\r?\n\|[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|/;
const CODE_FENCE_RE = /```[a-zA-Z0-9_+-]*\r?\n[\s\S]*?```/g;
const JSON_FENCE_RE = /```json\r?\n([\s\S]*?)```/i;
const TRANSLATION_LABEL_RE = /translation\s*:\s*([^\n]+)/i;
const CONFIDENCE_RE = /confidence\s*:\s*(high|medium|low)/i;

const EXPECTED_JSON_KEYS = ['topic', 'difficulty', 'steps_used'] as const;

function countMatches(re: RegExp, text: string): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the raw structural facts from a diagnostic response. Exported
 * separately from `classifyTier1StructuralSignals` so callers/tests can
 * inspect the raw evidence without re-deriving the per-capability verdict
 * mapping.
 */
export function extractTier1StructuralFacts(responseText: string): Tier1StructuralFacts {
  const text = responseText ?? '';
  const trimmed = text.trim();

  const hasNumberedSteps = countMatches(NUMBERED_STEP_RE, trimmed) >= 2;
  const hasMarkdownTable = MARKDOWN_TABLE_RE.test(trimmed);
  const codeBlockCount = countMatches(CODE_FENCE_RE, trimmed);

  const jsonMatch = trimmed.match(JSON_FENCE_RE);
  const jsonSummaryObj = jsonMatch ? tryParseJsonObject(jsonMatch[1]) : null;
  const jsonSummaryParsed = jsonSummaryObj !== null;
  const jsonSummaryHasExpectedKeys =
    jsonSummaryObj !== null && EXPECTED_JSON_KEYS.every((k) => k in jsonSummaryObj);

  const translationMatch = trimmed.match(TRANSLATION_LABEL_RE);
  const hasTranslationSection = translationMatch !== null;
  const translationContent = translationMatch ? translationMatch[1].trim() : '';
  // Non-trivial: present, not a mere restatement of the English source, and
  // long enough to be a real sentence rather than a stray label echo.
  const translationContentNonTrivial =
    translationContent.length >= 8 &&
    !/^the weather is nice today/i.test(translationContent);

  const confidenceMatch = trimmed.match(CONFIDENCE_RE);
  const confidenceTag = confidenceMatch
    ? (confidenceMatch[1].toLowerCase() as 'high' | 'medium' | 'low')
    : null;

  return {
    trimmedLength: trimmed.length,
    hasNumberedSteps,
    hasMarkdownTable,
    codeBlockCount,
    jsonSummaryParsed,
    jsonSummaryHasExpectedKeys,
    hasTranslationSection,
    translationContentNonTrivial,
    confidenceTag,
  };
}

/**
 * Map structural facts to a verdict per capability. Conservative: a
 * capability is only `confirmed` when the structural trace is unambiguous
 * evidence of the underlying skill, not merely of following instructions
 * (e.g. `chat` requires a substantive multi-section reply, not just any
 * non-empty string — a one-line refusal should not confirm `chat`).
 */
export function classifyTier1StructuralSignals(responseText: string): Tier1ClassificationResult {
  const facts = extractTier1StructuralFacts(responseText);

  const verdicts: Record<Tier1Capability, Tier1StructuralVerdict> = {
    // A coherent, on-topic, multi-section reply IS the definitional evidence
    // for chat capability — same bar `structural-evaluator.ts` uses
    // (nonEmpty + meetsMinLength), scaled up since this prompt asks for six
    // full sections rather than one short answer.
    chat: facts.trimmedLength >= 200 ? 'confirmed' : 'rejected',
    reasoning: facts.hasNumberedSteps ? 'confirmed' : 'rejected',
    analysis: facts.hasMarkdownTable ? 'confirmed' : 'rejected',
    code_generation: facts.codeBlockCount >= 1 ? 'confirmed' : 'rejected',
    json_mode:
      facts.jsonSummaryParsed && facts.jsonSummaryHasExpectedKeys ? 'confirmed' : 'rejected',
    // Streaming is NOT determined from response text — the probe caller
    // observes chunk delivery at the transport level (see
    // `tier1-diagnostic-probe.ts`) and overwrites this verdict directly.
    // Default here is `rejected` (no positive claim without transport
    // evidence) so a caller that forgets to overwrite it never asserts a
    // false positive.
    streaming: 'rejected',
    // Translation quality cannot be verified by regex — a labeled,
    // non-trivial section is a real ATTEMPT (ambiguous, worth a judge call);
    // a missing/empty section is a decisive non-attempt.
    translation:
      facts.hasTranslationSection && facts.translationContentNonTrivial
        ? 'ambiguous'
        : 'rejected',
    // Two-or-more code blocks (before + after) is the structural signature
    // of an actual refactor attempt, as opposed to `code_generation`'s
    // single-block bar.
    refactoring: facts.codeBlockCount >= 2 ? 'confirmed' : 'rejected',
  };

  return { verdicts, facts };
}
