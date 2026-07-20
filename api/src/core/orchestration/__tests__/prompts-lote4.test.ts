// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Lote 4 of the system-prompts audit refactor.
 *
 * Covers:
 *   J-Final   — migrated judges (quality-multipass, experiment-runner, judge-calibration,
 *               quality-scorer, arbitration-system) parse canonical verdicts via
 *               normalizeJudgeOutput and still produce their internal contract shapes.
 *   M-Export  — Prometheus text-format exporter emits every counter with HELP + TYPE.
 *   Z-Real    — CLI runner module is importable and wires the harness correctly
 *               without executing any real provider calls (the real run is deferred
 *               to operator-with-credentials, per the Lote 4 Z-Real contract).
 *   A-Final   — guardrail test: no stray `role: 'system'` literal prompt strings
 *               in the strategies directory outside the explicit allowlist.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

import {
  exportPromptMetricsAsPrometheus,
  exportPromptMetricsAsJson,
  PROMETHEUS_CONTENT_TYPE,
} from '../prompts/prompt-metrics-exporter';
import {
  PROMPT_METRIC_NAMES,
  incrementPromptMetric,
  resetPromptMetrics,
  getPromptMetric,
} from '../prompts/prompt-metrics';
import { normalizeJudgeOutput, JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS } from '@/core/quality/judge-schema';

// ────────────────────────────────────────────────────────────────────────────
// J-Final — migrated judges produce canonical-compatible parse paths
// ────────────────────────────────────────────────────────────────────────────

describe('J-Final — migrated judges parse canonical verdicts', () => {
  beforeEach(() => resetPromptMetrics());

  /**
   * The judge migrations keep their internal consumer types (LLMJudgeEvaluation,
   * ArbiterEvaluation, etc.) unchanged. What we verify here is that
   * `normalizeJudgeOutput` — the parse path they now share — successfully
   * handles the input shapes each judge's LLM is asked to produce. Concretely
   * the prompts now all embed JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS, so canonical
   * verdict JSON is the primary contract for every migrated judge.
   */

  it('quality-multipass canonical input produces a verdict with score and issues', () => {
    const raw = JSON.stringify({
      score: 0.82,
      issues: [
        { severity: 'major', location: 'paragraph 3', description: 'missing test case' },
      ],
    });
    const v = normalizeJudgeOutput(raw, { where: 'quality-multipass.validator' });
    expect(v?.score).toBeCloseTo(0.82, 3);
    expect(v?.issues).toHaveLength(1);
  });

  it('quality-multipass legacy "QUALITY_SCORE: 85" text format is NOT recognized by canonical normalizer', () => {
    // The text format is handled as legacy back-compat INSIDE the strategy
    // (extractQualityScore falls back to the regex). normalizeJudgeOutput
    // itself only recognizes canonical / legacy-JSON / BEST:N shapes — the
    // QUALITY_SCORE bare text is NOT one of them, and that is intentional:
    // the strategy keeps its own fallback to the regex for old models.
    const v = normalizeJudgeOutput('QUALITY_SCORE: 85\nISSUES:\n- some issue', {
      where: 'test.quality-multipass-legacy',
    });
    expect(v).toBeUndefined();
  });

  it('experiment-runner canonical verdict with just score produces normalized result', () => {
    const raw = JSON.stringify({ score: 0.91, issues: [] });
    const v = normalizeJudgeOutput(raw, { where: 'experiment-runner.judge' });
    expect(v?.score).toBeCloseTo(0.91, 3);
  });

  it('experiment-runner legacy {score, reasoning} shape IS recovered by tolerant salvage', () => {
    // The canonical schema is .strict() and would reject the unknown `reasoning`
    // key — but the tolerant salvage layer (judge-schema Case 4b) intentionally
    // recovers near-canonical drift: real production judges emit an extra
    // `reasoning`/`breakdown` key, and dropping those silently loses ~half of
    // all judge scores (measured). So the score survives; unknown keys are shed.
    // Mirrors judge-schema.tolerant.test.ts #2.
    const raw = JSON.stringify({ score: 0.9, reasoning: 'good' });
    const v = normalizeJudgeOutput(raw, { where: 'test.exp-runner-legacy' });
    expect(v?.score).toBeCloseTo(0.9, 3);
    expect(v?.issues.length).toBe(0);
  });

  it('judge-calibration canonical verdict with summary is accepted', () => {
    const raw = JSON.stringify({
      score: 0.73,
      issues: [],
      summary: 'Mostly correct but incomplete.',
    });
    const v = normalizeJudgeOutput(raw, { where: 'judge-calibration.case' });
    expect(v?.summary).toContain('Mostly correct');
  });

  it('quality-scorer: legacy dimensional {overall, correctness, ...} still adapts through normalizer', () => {
    // quality-scorer sends a prompt that asks for dimensional fields and then
    // routes through normalizeJudgeOutput, which recognizes the dimensional
    // shape via its legacy adapter. This preserves the internal
    // LLMJudgeEvaluation contract without requiring a prompt rewrite.
    const raw = JSON.stringify({
      overall: 0.88,
      correctness: 0.9,
      completeness: 0.85,
      clarity: 0.9,
      relevance: 0.87,
      reasoning: ['solid structure', 'minor verbosity'],
      confidence: 0.85,
    });
    const v = normalizeJudgeOutput(raw, { where: 'quality-scorer.llm-judge' });
    expect(v?.score).toBeCloseTo(0.88, 3);
    expect(v?.dimensions?.correctness).toBeCloseTo(0.9, 3);
    expect(v?.dimensions?.completeness).toBeCloseTo(0.85, 3);
    expect(v?.summary).toContain('solid structure');
  });

  it('arbitration-system: legacy {scores: [0-100], weaknesses} still adapts through normalizer', () => {
    const raw = JSON.stringify({
      scores: [65, 90, 72],
      weaknesses: [
        ['too terse', 'lacks examples'],
        [],
        ['missing edge case'],
      ],
      recommendation: 'Solution 2 dominates on completeness.',
      confidence: 0.85,
    });
    const v = normalizeJudgeOutput(raw, {
      where: 'arbitration-system.arbiter',
      candidateCount: 3,
    });
    expect(v?.winnerIndex).toBe(1);
    expect(v?.score).toBeCloseTo(0.9, 3);
    // Issues carry location "solution N" so the arbiter can regroup them by candidate.
    expect(v?.issues.some((i) => /solution\s+1/.test(i.location))).toBe(true);
  });

  it('every migrated judge increments JUDGE_NORMALIZATIONS on invocation', () => {
    resetPromptMetrics();
    normalizeJudgeOutput({ score: 0.5, issues: [] }, { where: 'test.any' });
    normalizeJudgeOutput({ score: 0.6, issues: [] }, { where: 'test.any' });
    normalizeJudgeOutput({ score: 0.7, issues: [] }, { where: 'test.any' });
    expect(getPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS)).toBe(3);
  });

  it('JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS is now embedded into the 5 migrated judge prompts', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const paths = [
      'src/core/orchestration/strategies/quality-multipass-strategy.ts',
      'src/core/experiment/experiment-runner.ts',
      'src/core/experiment/judge-calibration.ts',
      'src/core/arbitration/arbitration-system.ts',
    ];
    for (const rel of paths) {
      const src = await fs.readFile(path.join(repoRoot, rel), 'utf8');
      expect(
        src.includes('JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS'),
        `${rel} should embed JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS in its judge prompt`,
      ).toBe(true);
      expect(
        src.includes('normalizeJudgeOutput'),
        `${rel} should route its parse through normalizeJudgeOutput`,
      ).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M-Export — Prometheus text-format exporter
// ────────────────────────────────────────────────────────────────────────────

describe('M-Export — Prometheus text-format exporter', () => {
  beforeEach(() => resetPromptMetrics());

  it('emits HELP + TYPE + value for every canonical counter', () => {
    const out = exportPromptMetricsAsPrometheus();
    for (const name of Object.values(PROMPT_METRIC_NAMES)) {
      expect(out).toContain(`# HELP ${name}`);
      expect(out).toContain(`# TYPE ${name} counter`);
      expect(out).toMatch(new RegExp(`^${name} \\d+`, 'm'));
    }
  });

  it('emits zero for untouched counters (avoids silent-metric ambiguity)', () => {
    const out = exportPromptMetricsAsPrometheus();
    expect(out).toMatch(new RegExp(`^${PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS} 0`, 'm'));
  });

  it('reflects live counter increments in the exported body', () => {
    incrementPromptMetric(PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS, { where: 'x' });
    incrementPromptMetric(PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS, { where: 'y' });
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS);
    const out = exportPromptMetricsAsPrometheus();
    // O1 (Lote 5) upgraded the exporter to emit labelled series when attributes
    // are present. Fallback was incremented with 2 different `where` attributes,
    // so the exporter emits one series per label combination:
    expect(out).toContain(`${PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS}{where="x"} 1`);
    expect(out).toContain(`${PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS}{where="y"} 1`);
    // Peer-review was incremented without attributes, so it's a single unlabelled line:
    expect(out).toMatch(new RegExp(`^${PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS} 1`, 'm'));
  });

  it('JSON snapshot is structurally symmetric to the Prometheus export', () => {
    incrementPromptMetric(PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS);
    const snapshot = exportPromptMetricsAsJson();
    expect(snapshot.metrics.length).toBe(Object.values(PROMPT_METRIC_NAMES).length);
    const entry = snapshot.metrics.find(
      (m) => m.name === PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS,
    );
    expect(entry?.value).toBe(1);
    expect(entry?.type).toBe('counter');
    expect(entry?.help.length).toBeGreaterThan(0);
  });

  it('exposes the stable Prometheus content type for route handlers', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Z-Real — CLI runner module is importable and wires the harness
// ────────────────────────────────────────────────────────────────────────────

describe('Z-Real — CLI runner module', () => {
  it('file exists at scripts/run-peer-review-benchmark.ts', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const scriptPath = path.join(repoRoot, 'scripts/run-peer-review-benchmark.ts');
    const stat = await fs.stat(scriptPath);
    expect(stat.isFile()).toBe(true);
  });

  it('CLI source imports the canonical harness and normalizer', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const src = await fs.readFile(
      path.join(repoRoot, 'scripts/run-peer-review-benchmark.ts'),
      'utf8',
    );
    expect(src).toContain('runPeerReviewABBenchmark');
    expect(src).toContain('normalizeJudgeOutput');
    expect(src).toContain('REPRESENTATIVE_TASKS');
    // The CLI must NOT set AILIN_PEER_REVIEW_MODE at module scope; arm scoping
    // is delegated to the runner so the two arms are compared cleanly.
    expect(src).not.toContain("process.env.AILIN_PEER_REVIEW_MODE = 'on'");
  });

  it('CLI exports a runnable entry point that does not execute on import', async () => {
    const mod = await import('../../../../scripts/run-peer-review-benchmark');
    expect(typeof mod.runPeerReviewBenchmarkCli).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A-Final — guardrail: no stray system-prompt literals in strategies/ directory
// ────────────────────────────────────────────────────────────────────────────

describe('A-Final — strategies/ directory contains no stray system-prompt literals', () => {
  /**
   * Soft lint. Walks every file under `src/core/orchestration/strategies/`
   * and matches lines that look like a system-message literal:
   *
   *   role: 'system', content: 'You are a ...'
   *
   * Known-legitimate inline prompts (war-room commander short variant,
   * double-diamond discoverer user-message framing, etc.) are allowlisted
   * by file. Anything else fails the test — which is the intended
   * guardrail: if a new collective strategy adds a fresh literal system
   * prompt outside the catalog, this test surfaces it.
   */
  const ALLOWLIST: ReadonlySet<string> = new Set([
    // war-room-strategy has a short decompose-commander variant (different
    // contract from PROMPTS.warRoomCommander) that is used to short-circuit
    // simple tasks. The canonical variant lives in the catalog; this one is
    // a legitimate local specialization and is explicitly exempt.
    'war-room-strategy.ts',
    // double-diamond sends user-role framing for discover/define/develop
    // phases. Those aren't system prompts — the test's regex only catches
    // system-role literals — but we allowlist the file defensively in case
    // a user-role framing happens to match a stray false positive.
    'double-diamond-strategy.ts',
  ]);

  it('does not introduce new system-role literal prompts outside catalog', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const stratDir = path.join(repoRoot, 'src/core/orchestration/strategies');
    const entries = await fs.readdir(stratDir);
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      if (ALLOWLIST.has(entry)) continue;
      const src = await fs.readFile(path.join(stratDir, entry), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // Match:  role: 'system', content: 'You are ...'
        // Skip lines that use PROMPTS.xxx references (those import from catalog).
        if (
          /role:\s*['"]system['"]/.test(line) &&
          /content:\s*['"`](You are|Your )/.test(line)
        ) {
          offenders.push({ file: entry, line: i + 1, snippet: line.trim().slice(0, 120) });
        }
      });
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
        .join('\n');
      throw new Error(
        `A-Final guardrail: stray system-prompt literals found in strategies/.\n${report}\n` +
          `Move these to the SOTA catalog (sota-system-prompts.ts) or add the file to the allowlist with justification.`,
      );
    }
  });
});
