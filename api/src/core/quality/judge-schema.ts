// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unified judge / evaluator output schema (R2).
 *
 * Prior to R2, judges and evaluators in the system produced heterogeneous
 * output: some JSON `{ correctness, completeness, clarity, relevance, overall }`
 * on a 0-1 scale, others JSON `{ scores: [0-100], ... }`, and the competitive
 * strategy arbiter used freeform text like `BEST: 2\nREASON: better accuracy`.
 * Three scales, three formats, zero cross-judge comparability.
 *
 * This module defines ONE canonical contract that every judge can adopt
 * without losing semantic nuance. The contract has two axes:
 *
 * 1. **Score axis**: a single `score` in [0, 1]. Judges that currently emit
 *    0-100 or heterogeneous dimensions normalize to this scalar. Multi-
 *    dimensional breakdowns go into `dimensions` as an optional detail map.
 *
 * 2. **Issue axis**: a list of `Issue` objects with `severity`, `location`,
 *    and `description`. Severity is a closed enum. Location is free text.
 *    This unifies "issues" / "weaknesses" / "problems" across judges without
 *    forcing them to invent a field name.
 *
 * When a judge has to name a winner (competitive arbitration), `winnerIndex`
 * holds the integer index. When it produces a recommendation or summary, that
 * goes in `summary`. `confidence` is the judge's own epistemic confidence.
 *
 * The schema is `.strict()` on top-level fields — drift at this layer is a
 * contract bug and should fail loudly — but `dimensions` is an open record
 * because dimension names are inherently judge-specific (correctness,
 * latency, security, ...).
 *
 * R2 does not force every existing judge to adopt this contract on day one;
 * it provides the shared vocabulary and a normalizer so the most visible
 * offender (the competitive arbiter's BEST/REASON text format) can migrate
 * first and downstream consumers can begin depending on a uniform shape.
 */

import { z } from 'zod';
import {
  incrementPromptMetric,
  PROMPT_METRIC_NAMES,
} from '@/core/orchestration/prompts/prompt-metrics';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'judge-schema' });

/** Closed severity enum — every judge speaks the same three levels. */
export const IssueSeveritySchema = z.enum(['critical', 'major', 'minor']);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const IssueSchema = z
  .object({
    severity: IssueSeveritySchema,
    /** Free-form location pointer: `"paragraph 2"`, `"line 17"`, `"solution 1"`, ... */
    location: z.string().min(1),
    description: z.string().min(1),
    /** Optional concrete fix — omit if the judge is a pure evaluator. */
    suggestedFix: z.string().optional(),
  })
  .strict();

export type JudgeIssue = z.infer<typeof IssueSchema>;

/**
 * Canonical judge verdict. Every judge / evaluator in the system should
 * either emit this shape directly (preferred) or route their output through
 * `normalizeJudgeOutput()` which adapts legacy formats.
 */
export const JudgeVerdictSchema = z
  .object({
    /** Overall quality in [0, 1]. Required. */
    score: z.number().min(0).max(1),
    /** Structured issues. Empty array is valid (clean response). */
    issues: z.array(IssueSchema).default([]),
    /** Optional short natural-language rationale (<=400 chars). */
    summary: z.string().max(400).optional(),
    /** When the judge picks a winner among N candidates, the 0-based index. */
    winnerIndex: z.number().int().min(0).optional(),
    /** Judge's own epistemic confidence in its verdict, [0, 1]. */
    confidence: z.number().min(0).max(1).optional(),
    /** Optional per-dimension breakdown, each in [0, 1]. */
    dimensions: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .strict();

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * Canonical system-prompt snippet that judges can embed verbatim to instruct
 * the underlying LLM to emit exactly `JudgeVerdict` JSON. Kept as a plain
 * template string so callers can prepend their domain-specific rubric.
 */
export const JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS =
  'Return ONLY valid JSON matching this schema:\n' +
  '{\n' +
  '  "score": <number in [0,1]>,\n' +
  '  "issues": [{"severity": "critical|major|minor", "location": "<pointer>", "description": "<what is wrong>", "suggestedFix": "<optional fix>"}],\n' +
  '  "summary": "<optional short rationale, <=400 chars>",\n' +
  '  "winnerIndex": <optional 0-based index when selecting among candidates>,\n' +
  '  "confidence": <optional number in [0,1]>\n' +
  '}';

/**
 * Attempt to normalize an arbitrary judge output payload into `JudgeVerdict`.
 *
 * Accepts, in order of preference:
 *   1. An object that already matches `JudgeVerdictSchema` (strict parse).
 *   2. A JSON string containing such an object.
 *   3. Legacy 0-100 `{ scores: [...] }` from arbitration-system.
 *   4. Legacy `{ overall, correctness, completeness, clarity, relevance }`
 *      from quality-scorer.
 *   5. Legacy `BEST: N\nREASON: ...` free text from competitive-strategy.
 *
 * On unrecoverable input returns `undefined` and logs via metrics.
 */
export function normalizeJudgeOutput(
  raw: unknown,
  context: { where: string; candidateCount?: number },
): JudgeVerdict | undefined {
  incrementPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS, { where: context.where });

  // Case 1+2: object already canonical, or JSON string of canonical object.
  const parsedObject = coerceObject(raw);
  if (parsedObject) {
    const strict = JudgeVerdictSchema.safeParse(parsedObject);
    if (strict.success) return strict.data;

    // Case 3: 0-100 scores array (arbitration-system legacy).
    const scoresArray = (parsedObject as { scores?: unknown }).scores;
    if (Array.isArray(scoresArray) && scoresArray.every((n) => typeof n === 'number')) {
      return normalizeArbitrationScores(parsedObject, scoresArray as number[], context);
    }

    // Case 4: dimensions-per-key (quality-scorer legacy).
    if (typeof (parsedObject as { overall?: unknown }).overall === 'number') {
      return normalizeDimensionalVerdict(parsedObject as Record<string, unknown>);
    }

    // Case 4b: tolerant salvage of near-canonical JSON that strict parsing
    // rejected. Real LLM judges drift — extra keys (`reasoning`/`breakdown`/
    // `maxScore`/alt dimensions), `confidence` as a string, `overallScore`
    // instead of `score`, a 0-100 score, non-enum severities. Dropping these
    // silently loses ~half of all production judge scores (measured), so
    // recover a usable verdict instead of failing on the first deviation.
    const tolerant = tolerantVerdict(parsedObject);
    if (tolerant) return tolerant;
  }

  // Case 5: `BEST: N\nREASON: ...` freeform text (competitive-strategy legacy).
  if (typeof raw === 'string') {
    const fromText = normalizeBestReasonText(raw, context.candidateCount ?? Number.MAX_SAFE_INTEGER);
    if (fromText) return fromText;
  }

  // Case 6: regex salvage. The JSON was UNPARSEABLE — truncated mid-object by a
  // judge timeout / max_tokens cut, or malformed by a drifting model — so
  // `coerceObject` returned undefined and Cases 1-4 never ran. But the numeric
  // score is right there in the text (`"overall": 0.93`), typically emitted
  // before the verbose `reasoning` that got cut. Recover it rather than discard
  // a correct verdict. Measured: a slow dynamic-judge cascade had ~50% of its
  // (accurate) scores dropped here, collapsing them to a neutral judgeFailed 0.5.
  if (typeof raw === 'string') {
    const salvaged = regexSalvageVerdict(raw);
    if (salvaged) {
      log.debug(
        { where: context.where, score: salvaged.score },
        'normalizeJudgeOutput: recovered score via regex salvage (unparseable JSON)',
      );
      return salvaged;
    }
  }

  incrementPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATION_FAILURES, {
    where: context.where,
  });
  log.warn({ where: context.where }, 'normalizeJudgeOutput: unrecognized judge payload shape');
  return undefined;
}

/**
 * Last-resort recovery when JSON parsing has already failed. Pulls the numeric
 * overall score (and any per-dimension scores) straight out of the text with
 * regexes, tolerating a 0-100 scale. Only used AFTER strict/tolerant/legacy
 * parsing fails, so it recovers otherwise-lost verdicts without changing the
 * happy path. Returns undefined when no score-like field is present.
 */
function regexSalvageVerdict(text: string): JudgeVerdict | undefined {
  const num = (re: RegExp): number | undefined => {
    const m = text.match(re);
    if (!m) return undefined;
    let n = Number(m[1]);
    if (!Number.isFinite(n)) return undefined;
    if (n > 1 && n <= 100) n = n / 100; // tolerate a 0-100 scale
    return clamp01(n);
  };

  const score = num(/"(?:overall_score|overallscore|overall|score)"\s*:\s*(-?\d+(?:\.\d+)?)/i);
  if (score === undefined) return undefined;

  const dimensions: Record<string, number> = {};
  for (const key of ['correctness', 'completeness', 'clarity', 'relevance']) {
    const v = num(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
    if (v !== undefined) dimensions[key] = v;
  }

  const verdict: JudgeVerdict = { score, issues: [] };
  if (Object.keys(dimensions).length > 0) verdict.dimensions = dimensions;
  const confidence = num(/"confidence"\s*:\s*(-?\d+(?:\.\d+)?)/i);
  if (confidence !== undefined) verdict.confidence = confidence;

  const checked = JudgeVerdictSchema.safeParse(verdict);
  return checked.success ? checked.data : undefined;
}

/** Coerce string/object input to a plain object, or return undefined. */
function coerceObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Convert legacy `{ scores: [0-100], ... }` arbitration output to canonical verdict. */
function normalizeArbitrationScores(
  payload: Record<string, unknown>,
  scoresRaw: number[],
  context: { where: string },
): JudgeVerdict {
  const scores = scoresRaw.map((s) => clamp01(s / 100));
  const bestIdx = scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0);

  const issues: JudgeIssue[] = [];
  const weaknesses = (payload as { weaknesses?: unknown }).weaknesses;
  if (Array.isArray(weaknesses)) {
    weaknesses.forEach((entry, i) => {
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (typeof item === 'string' && item.length > 0) {
            issues.push({
              severity: 'major',
              location: `solution ${i + 1}`,
              description: item,
            });
          }
        }
      }
    });
  }

  const verdict: JudgeVerdict = {
    score: scores[bestIdx] ?? 0,
    issues,
    winnerIndex: bestIdx,
    confidence: clamp01(
      typeof (payload as { confidence?: unknown }).confidence === 'number'
        ? (payload as { confidence: number }).confidence
        : 0.75,
    ),
    summary:
      typeof (payload as { recommendation?: unknown }).recommendation === 'string'
        ? String((payload as { recommendation: string }).recommendation).slice(0, 400)
        : undefined,
    dimensions: Object.fromEntries(scores.map((s, i) => [`solution_${i}`, s])),
  };
  log.debug({ where: context.where, bestIdx, scores }, 'normalized arbitration-scores payload');
  return verdict;
}

/** Convert legacy `{ overall, correctness, completeness, clarity, relevance, reasoning[] }` to canonical. */
function normalizeDimensionalVerdict(payload: Record<string, unknown>): JudgeVerdict {
  const overall = clamp01(Number((payload as { overall: number }).overall));
  const dimensions: Record<string, number> = {};
  for (const key of ['correctness', 'completeness', 'clarity', 'relevance']) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'number') dimensions[key] = clamp01(v);
  }
  const reasoning = (payload as { reasoning?: unknown }).reasoning;
  const summary = Array.isArray(reasoning)
    ? reasoning.filter((r) => typeof r === 'string').join('; ').slice(0, 400)
    : undefined;
  return {
    score: overall,
    issues: [],
    summary,
    confidence:
      typeof (payload as { confidence?: unknown }).confidence === 'number'
        ? clamp01((payload as { confidence: number }).confidence)
        : undefined,
    dimensions,
  };
}

/**
 * Lenient salvage for near-canonical judge JSON that `.strict()` rejects.
 * Real LLM judges drift: extra top-level keys, `confidence` as a string,
 * `overallScore`/`overall` instead of `score`, a 0-100 score, or non-enum
 * issue severities. The point of a normalizer is to recover a usable score
 * from these rather than drop ~half of all judge outputs (which silently
 * degrades production scoring + learning). Returns undefined only when no
 * numeric score can be recovered. Output is re-validated against the schema.
 */
function tolerantVerdict(payload: Record<string, unknown>): JudgeVerdict | undefined {
  const toScore = (v: unknown): number | undefined => {
    let n: number;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
    else return undefined;
    if (Number.isNaN(n)) return undefined;
    if (n > 1 && n <= 100) n = n / 100; // tolerate a 0-100 scale
    return clamp01(n);
  };

  const score =
    toScore(payload.score) ??
    toScore(payload.overallScore) ??
    toScore(payload.overall) ??
    toScore(payload.overall_score);
  if (score === undefined) return undefined; // nothing usable — let caller fail

  const SEVERITY_ALIASES: Record<string, IssueSeverity> = {
    critical: 'critical', blocker: 'critical', severe: 'critical',
    major: 'major', high: 'major', medium: 'major', moderate: 'major',
    minor: 'minor', low: 'minor', warning: 'minor', info: 'minor', trivial: 'minor',
  };
  const issues: JudgeIssue[] = [];
  const rawIssues = payload.issues;
  if (Array.isArray(rawIssues)) {
    for (const entry of rawIssues) {
      if (typeof entry !== 'object' || entry === null) continue;
      const o = entry as Record<string, unknown>;
      const description =
        typeof o.description === 'string' && o.description.length > 0 ? o.description :
        typeof o.issue === 'string' && o.issue.length > 0 ? o.issue : undefined;
      if (!description) continue;
      const sevKey = typeof o.severity === 'string' ? o.severity.toLowerCase() : 'minor';
      const issue: JudgeIssue = {
        severity: SEVERITY_ALIASES[sevKey] ?? 'minor',
        location: typeof o.location === 'string' && o.location.length > 0 ? o.location : 'unspecified',
        description,
      };
      if (typeof o.suggestedFix === 'string') issue.suggestedFix = o.suggestedFix;
      issues.push(issue);
    }
  }

  const confidence = toScore(payload.confidence);
  const summarySource = payload.summary ?? payload.justification ?? payload.reasoning;
  const summary =
    typeof summarySource === 'string' ? summarySource.slice(0, 400) :
    Array.isArray(summarySource)
      ? summarySource.filter((s): s is string => typeof s === 'string').join('; ').slice(0, 400)
      : undefined;
  const winnerIndex =
    typeof payload.winnerIndex === 'number' && Number.isInteger(payload.winnerIndex) && payload.winnerIndex >= 0
      ? payload.winnerIndex
      : undefined;

  const verdict: JudgeVerdict = { score, issues };
  if (summary) verdict.summary = summary;
  if (confidence !== undefined) verdict.confidence = confidence;
  if (winnerIndex !== undefined) verdict.winnerIndex = winnerIndex;

  // Guarantee the salvaged verdict is itself canonical before returning.
  const checked = JudgeVerdictSchema.safeParse(verdict);
  return checked.success ? checked.data : undefined;
}

/** Parse legacy `BEST: N\nREASON: ...` text from the competitive arbiter. */
function normalizeBestReasonText(raw: string, maxIndex: number): JudgeVerdict | undefined {
  const bestMatch = raw.match(/BEST:\s*(\d+)/i);
  if (!bestMatch) return undefined;
  const idx = parseInt(bestMatch[1], 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= maxIndex) return undefined;

  const reasonMatch = raw.match(/REASON:\s*([\s\S]*)/i);
  const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 400) : undefined;

  return {
    score: 1.0, // The arbiter only tells us "best", not absolute quality.
    issues: [],
    winnerIndex: idx,
    summary: reason,
    confidence: 0.7,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
