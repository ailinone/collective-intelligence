// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §11 — Deterministic local model quality evaluator.
 *
 * Scores model outputs against task rubrics WITHOUT using an LLM as judge.
 * Every rubric is a pure function over the output string + expected schema.
 *
 * Why no LLM judge in J2:
 *   - LLM-as-judge introduces a circular dependency (we'd benchmark a model
 *     using a model we haven't benchmarked yet)
 *   - Costs ANOTHER provider call per evaluation
 *   - Non-deterministic (same output, different scores between runs)
 *   - Out of J2 scope (deferred to J2-L if needed)
 *
 * Rubric kinds implemented:
 *   - codeUnitTest: parse function from output, execute against cases
 *   - structuredBullets: count bullets, validate keyword coverage
 *   - jsonSchema: parse JSON, check required keys + values
 *   - singleLetterChoice: extract letter, validate against correct
 *   - twoLineBugFix: parse "Bug: ..." + "Fix: ..." lines, match keywords
 *
 * NO external HTTP. NO secret values.
 */

export interface EvaluationResult {
  readonly score: number; // 0..1
  readonly dimensionScores: Readonly<Record<string, number>>;
  readonly passed: boolean;
  readonly notes: readonly string[];
  readonly debug?: Readonly<Record<string, unknown>>;
}

export interface BenchmarkTask {
  readonly taskId: string;
  readonly prompt: string;
  readonly expectedFormat: string;
  readonly maxTokens: number;
  readonly dimensionWeights: Readonly<Record<string, number>>;
  readonly rubric: unknown;
}

// ─── Rubric implementations ──────────────────────────────────────────────

/**
 * Evaluates a code unit test rubric. Extracts the function from the
 * output (handles markdown code fences) and runs each test case.
 * Returns the fraction of passed cases as the coding score.
 */
function evaluateCodeUnitTest(
  output: string,
  rubric: {
    languageHint: string;
    functionName: string;
    cases: ReadonlyArray<{ input: unknown; expected: unknown }>;
    partialCredit: boolean;
  },
): { codingScore: number; instructionFollowingScore: number; structuredOutputScore: number; notes: string[] } {
  const notes: string[] = [];
  // Strip markdown fences if present
  let code = output.trim();
  const fenceMatch = code.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
    notes.push('extracted_from_code_fence');
  }

  // Check function presence
  const funcPattern = new RegExp(`(?:function\\s+${rubric.functionName}|const\\s+${rubric.functionName}\\s*=)`);
  if (!funcPattern.test(code)) {
    notes.push(`function_not_found: ${rubric.functionName}`);
    return { codingScore: 0, instructionFollowingScore: 0.2, structuredOutputScore: 0.2, notes };
  }
  notes.push('function_found');

  // Attempt to execute the function. Sandboxed in a vm-like Function constructor.
  let fn: ((arg: unknown) => unknown) | null = null;
  try {
    const wrapped = `${code}\nreturn ${rubric.functionName};`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(wrapped)() as (arg: unknown) => unknown;
  } catch (e) {
    notes.push(`compile_error: ${(e as Error).message.substring(0, 100)}`);
    return { codingScore: 0, instructionFollowingScore: 0.5, structuredOutputScore: 0.7, notes };
  }

  // Run cases
  let passed = 0;
  for (const c of rubric.cases) {
    try {
      const result = fn!(c.input);
      if (result === c.expected) passed += 1;
    } catch {
      // Case threw — counts as fail
    }
  }
  const codingScore = passed / rubric.cases.length;
  notes.push(`unit_tests: ${passed}/${rubric.cases.length}`);

  return {
    codingScore: rubric.partialCredit ? codingScore : (codingScore === 1 ? 1 : 0),
    instructionFollowingScore: 1.0, // output was code, format respected
    structuredOutputScore: fenceMatch ? 0.8 : 1.0, // penalize fence (instruction said "ONLY function code")
    notes,
  };
}

function evaluateStructuredBullets(
  output: string,
  rubric: {
    expectedBulletCount: number;
    bulletPrefix: string;
    maxWordsPerBullet: number;
    mustMentionTerms: readonly (readonly string[])[];
    partialCredit: boolean;
  },
): { synthesisScore: number; instructionFollowingScore: number; structuredOutputScore: number; notes: string[] } {
  const notes: string[] = [];
  const lines = output.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => l.startsWith(rubric.bulletPrefix));

  const countMatch = bullets.length === rubric.expectedBulletCount;
  notes.push(`bullets_found: ${bullets.length}/${rubric.expectedBulletCount}`);

  // Word count check
  const tooLong = bullets.filter((b) => b.split(/\s+/).length > rubric.maxWordsPerBullet);
  if (tooLong.length > 0) notes.push(`too_long: ${tooLong.length}`);

  // Term coverage
  const lowerBullets = bullets.map((b) => b.toLowerCase());
  let termsMatched = 0;
  for (const termGroup of rubric.mustMentionTerms) {
    const someHit = termGroup.some((t) => lowerBullets.some((b) => b.includes(t.toLowerCase())));
    if (someHit) termsMatched += 1;
  }
  notes.push(`terms_matched: ${termsMatched}/${rubric.mustMentionTerms.length}`);

  const synthesisScore = termsMatched / rubric.mustMentionTerms.length;
  const formatScore = (countMatch ? 1 : 0.5) - tooLong.length * 0.1;
  return {
    synthesisScore,
    instructionFollowingScore: Math.max(0, Math.min(1, formatScore)),
    structuredOutputScore: countMatch ? (tooLong.length === 0 ? 1 : 0.7) : 0.4,
    notes,
  };
}

function evaluateJsonSchema(
  output: string,
  rubric: {
    requiredKeys: readonly string[];
    expectedValues: Readonly<Record<string, { kind: string; value?: unknown; values?: readonly unknown[] }>>;
    partialCredit: boolean;
  },
): { structuredOutputScore: number; instructionFollowingScore: number; factualityScore: number; notes: string[] } {
  const notes: string[] = [];

  // Strip markdown fences if present
  let jsonStr = output.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
    notes.push('extracted_from_code_fence');
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    // JSON.parse returns `any`; assert the shape we validate below (sanctioned
    // assertion — not `as any` / `as unknown as`).
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (e) {
    notes.push(`json_parse_failed: ${(e as Error).message.substring(0, 80)}`);
    return { structuredOutputScore: 0, instructionFollowingScore: 0.2, factualityScore: 0, notes };
  }
  notes.push('json_parsed');

  // Required keys
  const keysPresent = rubric.requiredKeys.filter((k) => k in parsed!);
  const keyScore = keysPresent.length / rubric.requiredKeys.length;
  notes.push(`keys_present: ${keysPresent.length}/${rubric.requiredKeys.length}`);

  // Value checks. TS18047: `parsed` is narrowed by the JSON.parse try/catch
  // above — at this point it's a non-null object. Explicit `!` for clarity.
  let valueScore = 0;
  let valueChecks = 0;
  const parsedObj = parsed!;
  for (const [key, check] of Object.entries(rubric.expectedValues)) {
    valueChecks += 1;
    const val = parsedObj[key];
    if (val === undefined) continue;
    if (check.kind === 'exactNumber' && val === check.value) valueScore += 1;
    else if (check.kind === 'stringContains' && typeof val === 'string') {
      const hits = (check.values ?? []).filter((v) => val.toLowerCase().includes(String(v).toLowerCase()));
      if (hits.length === (check.values?.length ?? 0)) valueScore += 1;
      else if (hits.length > 0) valueScore += 0.5;
    } else if (check.kind === 'arrayContainsAll' && Array.isArray(val)) {
      const needed = check.values ?? [];
      const valLower = val.map((x) => String(x).toLowerCase());
      const hits = needed.filter((n) => valLower.some((vl) => vl.includes(String(n).toLowerCase())));
      if (hits.length === needed.length) valueScore += 1;
      else valueScore += hits.length / needed.length;
    }
  }
  const factualityScore = valueChecks > 0 ? valueScore / valueChecks : 0;
  notes.push(`values_correct: ${valueScore.toFixed(2)}/${valueChecks}`);

  const structuredOutputScore = keyScore;
  return {
    structuredOutputScore,
    instructionFollowingScore: fenceMatch ? 0.7 : 1.0, // instruction said "no markdown"
    factualityScore,
    notes,
  };
}

function evaluateSingleLetterChoice(
  output: string,
  rubric: {
    correctLetter: string;
    mustMentionInReasoning: readonly string[];
    partialCredit: boolean;
  },
): { reasoningScore: number; instructionFollowingScore: number; factualityScore: number; notes: string[] } {
  const notes: string[] = [];
  // Extract first standalone letter A/B/C from output
  const letterMatch = output.match(/\b([A-C])\b/);
  const letter = letterMatch ? letterMatch[1] : null;
  notes.push(`letter_extracted: ${letter}`);

  const correct = letter === rubric.correctLetter;
  notes.push(`letter_correct: ${correct}`);

  const lowerOutput = output.toLowerCase();
  const mentioned = rubric.mustMentionInReasoning.filter((t) => lowerOutput.includes(t.toLowerCase()));
  notes.push(`reasoning_terms: ${mentioned.length}/${rubric.mustMentionInReasoning.length}`);

  return {
    reasoningScore: correct ? (mentioned.length / rubric.mustMentionInReasoning.length) : 0,
    instructionFollowingScore: letter ? 1.0 : 0.2,
    factualityScore: correct ? 1.0 : 0.0,
    notes,
  };
}

function evaluateTwoLineBugFix(
  output: string,
  rubric: {
    bugKeywords: readonly string[];
    fixKeywords: readonly string[];
    partialCredit: boolean;
  },
): { codingScore: number; reasoningScore: number; structuredOutputScore: number; notes: string[] } {
  const notes: string[] = [];
  const lower = output.toLowerCase();
  const hasBugPrefix = /bug\s*:/i.test(output);
  const hasFixPrefix = /fix\s*:/i.test(output);
  notes.push(`format_bug_prefix: ${hasBugPrefix}, fix_prefix: ${hasFixPrefix}`);

  const bugMatches = rubric.bugKeywords.filter((k) => lower.includes(k.toLowerCase()));
  const fixMatches = rubric.fixKeywords.filter((k) => lower.includes(k.toLowerCase()));
  notes.push(`bug_keywords: ${bugMatches.length}/${rubric.bugKeywords.length}, fix_keywords: ${fixMatches.length}/${rubric.fixKeywords.length}`);

  const bugScore = Math.min(1, bugMatches.length / 2); // need 2+ keywords for full
  const fixScore = Math.min(1, fixMatches.length / 2);

  return {
    codingScore: (bugScore + fixScore) / 2,
    reasoningScore: bugScore,
    structuredOutputScore: (hasBugPrefix ? 0.5 : 0) + (hasFixPrefix ? 0.5 : 0),
    notes,
  };
}

// ─── Top-level dispatcher ────────────────────────────────────────────────

export function evaluateTaskOutput(task: BenchmarkTask, output: string): EvaluationResult {
  if (!output || typeof output !== 'string') {
    return {
      score: 0,
      dimensionScores: {},
      passed: false,
      notes: ['empty_or_invalid_output'],
    };
  }

  const rubric = task.rubric as { kind: string } & Record<string, unknown>;
  let dimensionScores: Record<string, number> = {};
  let notes: string[] = [];

  switch (rubric.kind) {
    case 'codeUnitTest': {
      const r = evaluateCodeUnitTest(output, rubric as never);
      dimensionScores = {
        coding: r.codingScore,
        instruction_following: r.instructionFollowingScore,
        structured_output: r.structuredOutputScore,
      };
      notes = r.notes;
      break;
    }
    case 'structuredBullets': {
      const r = evaluateStructuredBullets(output, rubric as never);
      dimensionScores = {
        synthesis: r.synthesisScore,
        instruction_following: r.instructionFollowingScore,
        structured_output: r.structuredOutputScore,
      };
      notes = r.notes;
      break;
    }
    case 'jsonSchema': {
      const r = evaluateJsonSchema(output, rubric as never);
      dimensionScores = {
        structured_output: r.structuredOutputScore,
        instruction_following: r.instructionFollowingScore,
        factuality: r.factualityScore,
      };
      notes = r.notes;
      break;
    }
    case 'singleLetterChoice': {
      const r = evaluateSingleLetterChoice(output, rubric as never);
      dimensionScores = {
        reasoning: r.reasoningScore,
        instruction_following: r.instructionFollowingScore,
        factuality: r.factualityScore,
      };
      notes = r.notes;
      break;
    }
    case 'twoLineBugFix': {
      const r = evaluateTwoLineBugFix(output, rubric as never);
      dimensionScores = {
        coding: r.codingScore,
        reasoning: r.reasoningScore,
        structured_output: r.structuredOutputScore,
      };
      notes = r.notes;
      break;
    }
    default:
      return {
        score: 0,
        dimensionScores: {},
        passed: false,
        notes: [`unknown_rubric_kind: ${rubric.kind}`],
      };
  }

  // Weighted aggregate per task
  const weights = task.dimensionWeights;
  let aggregate = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    const score = dimensionScores[dim] ?? 0;
    aggregate += score * weight;
    weightSum += weight;
  }
  const finalScore = weightSum > 0 ? aggregate / weightSum : 0;

  return {
    score: finalScore,
    dimensionScores,
    passed: finalScore >= 0.5,
    notes,
  };
}
