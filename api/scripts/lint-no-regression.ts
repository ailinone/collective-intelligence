// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * Per-rule counts let us enforce strict zero-new on specific anti-patterns
 * (e.g. `as unknown as`, `any`) — independent from the aggregate total.
 *
 * Without this dimension, a contributor could trade one unsafe cast for one
 * stylistic warning fix elsewhere and the aggregate gate would still pass.
 * Per-rule baseline closes that loophole: any specific rule whose violation
 * count grows above its baseline fails the gate, regardless of net totals.
 */
type RuleCounts = Record<string, number>;

type LintBaseline = {
  totalErrors: number;
  totalWarnings: number;
  strictPaths: string[];
  strictPrefixes: string[];
  rules?: RuleCounts;
};

type Totals = {
  errors: number;
  warnings: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(PROJECT_ROOT, 'scripts', 'eslint-baseline.json');
const DEFAULT_STRICT_PATHS = ['src/services/auth-service.ts', 'src/config/index.ts'];
const DEFAULT_STRICT_PREFIXES = ['src/routes/chat/', 'src/routes/threads/', 'src/routes/tools/'];
const UPDATE_FLAG = '--update-baseline';

/**
 * Rules whose count must NEVER increase beyond baseline. These are the
 * "estado-da-arte" prohibitions: `any`, double casts via unknown, unsafe
 * assignments. New code that introduces these patterns fails CI even if
 * other rules' counts decrease.
 */
const TRACKED_RULES: ReadonlyArray<string> = [
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-return',
  'no-restricted-syntax',
];

function toProjectRelative(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function calculateTotals(results: ESLint.LintResult[]): Totals {
  return results.reduce<Totals>(
    (acc, result) => {
      acc.errors += result.errorCount + result.fatalErrorCount;
      acc.warnings += result.warningCount;
      return acc;
    },
    { errors: 0, warnings: 0 }
  );
}

/**
 * Bucket every individual lint message by its `ruleId`. Messages whose
 * `ruleId` is null (e.g. parser errors) are bucketed under '__no_rule__'
 * so the regression script still notices them rather than silently ignoring.
 */
function calculateRuleCounts(results: ESLint.LintResult[]): RuleCounts {
  const counts: RuleCounts = {};
  for (const result of results) {
    for (const message of result.messages) {
      const key = message.ruleId ?? '__no_rule__';
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

async function lintAllSources(): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint();
  return eslint.lintFiles(['src/**/*.ts']);
}

async function loadBaseline(): Promise<LintBaseline> {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `ESLint baseline not found at ${toProjectRelative(BASELINE_PATH)}. Run: pnpm run lint:baseline:update`
    );
  }

  const raw = await readFile(BASELINE_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Baseline at ${BASELINE_PATH} is malformed (not a JSON object)`);
  }

  const candidate = parsed as Record<string, unknown>;
  const totalErrors = typeof candidate.totalErrors === 'number' ? candidate.totalErrors : 0;
  const totalWarnings = typeof candidate.totalWarnings === 'number' ? candidate.totalWarnings : 0;
  const strictPaths = Array.isArray(candidate.strictPaths)
    ? candidate.strictPaths
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.replace(/\\/g, '/'))
    : DEFAULT_STRICT_PATHS;
  const strictPrefixes = Array.isArray(candidate.strictPrefixes)
    ? candidate.strictPrefixes
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.replace(/\\/g, '/'))
    : DEFAULT_STRICT_PREFIXES;

  const rules: RuleCounts = {};
  if (candidate.rules !== undefined && candidate.rules !== null && typeof candidate.rules === 'object') {
    for (const [key, value] of Object.entries(candidate.rules as Record<string, unknown>)) {
      if (typeof value === 'number') {
        rules[key] = value;
      }
    }
  }

  return {
    totalErrors,
    totalWarnings,
    strictPaths,
    strictPrefixes,
    rules,
  };
}

async function writeBaseline(
  totals: Totals,
  ruleCounts: RuleCounts,
  strictPaths: string[],
  strictPrefixes: string[]
): Promise<void> {
  await mkdir(path.dirname(BASELINE_PATH), { recursive: true });

  // Sort rule entries deterministically so diffs stay readable when the
  // baseline gets regenerated.
  const sortedRules: RuleCounts = {};
  for (const key of Object.keys(ruleCounts).sort()) {
    sortedRules[key] = ruleCounts[key];
  }

  const payload: LintBaseline = {
    totalErrors: totals.errors,
    totalWarnings: totals.warnings,
    strictPaths,
    strictPrefixes,
    rules: sortedRules,
  };

  await writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function listStrictViolations(
  results: ESLint.LintResult[],
  strictPaths: string[],
  strictPrefixes: string[]
): Array<{ file: string; issues: number }> {
  const strictSet = new Set(strictPaths.map((entry) => entry.replace(/\\/g, '/')));
  const prefixes = strictPrefixes.map((entry) => entry.replace(/\\/g, '/'));

  return results
    .filter((result) => {
      const relativePath = toProjectRelative(result.filePath);
      return strictSet.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
    })
    .map((result) => ({
      file: toProjectRelative(result.filePath),
      issues: result.errorCount + result.fatalErrorCount + result.warningCount,
    }))
    .filter((entry) => entry.issues > 0)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function printSummary(current: Totals, baseline: Totals): void {
  console.log('ESLint no-regression summary');
  console.log(`  Current:  ${current.errors} errors, ${current.warnings} warnings`);
  console.log(`  Baseline: ${baseline.errors} errors, ${baseline.warnings} warnings`);
}

/**
 * Detect rules whose violation count grew above baseline. Returns one entry
 * per regressed rule with current/baseline counts. Empty array means clean.
 */
function findRuleRegressions(
  current: RuleCounts,
  baseline: RuleCounts
): Array<{ rule: string; current: number; baseline: number; delta: number }> {
  const regressions: Array<{ rule: string; current: number; baseline: number; delta: number }> = [];
  // Check every rule that appears in either side; a missing baseline entry
  // is treated as 0 (any new occurrence is a regression).
  const allRules = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const rule of allRules) {
    const currentCount = current[rule] ?? 0;
    const baselineCount = baseline[rule] ?? 0;
    if (currentCount > baselineCount) {
      regressions.push({
        rule,
        current: currentCount,
        baseline: baselineCount,
        delta: currentCount - baselineCount,
      });
    }
  }
  return regressions.sort((a, b) => b.delta - a.delta);
}

function findReductions(
  current: RuleCounts,
  baseline: RuleCounts
): Array<{ rule: string; reduction: number }> {
  const reductions: Array<{ rule: string; reduction: number }> = [];
  for (const rule of Object.keys(baseline)) {
    const currentCount = current[rule] ?? 0;
    const baselineCount = baseline[rule] ?? 0;
    if (currentCount < baselineCount) {
      reductions.push({ rule, reduction: baselineCount - currentCount });
    }
  }
  return reductions.sort((a, b) => b.reduction - a.reduction);
}

/**
 * Collect `file:line:col` for every current violation of `ruleId`, so a per-rule
 * regression can point at the exact offending sites (the baseline stores counts
 * only, not locations, so this lists all current hits — a superset that still
 * pinpoints the new ones when the baseline for that rule is 0).
 */
function collectRuleLocations(results: ESLint.LintResult[], ruleId: string): string[] {
  const out: string[] = [];
  for (const result of results) {
    for (const message of result.messages) {
      if ((message.ruleId ?? '__no_rule__') === ruleId) {
        out.push(`${toProjectRelative(result.filePath)}:${message.line}:${message.column}`);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const shouldUpdateBaseline = process.argv.includes(UPDATE_FLAG);
  const results = await lintAllSources();
  const currentTotals = calculateTotals(results);
  const currentRules = calculateRuleCounts(results);

  if (shouldUpdateBaseline) {
    const existingBaseline = existsSync(BASELINE_PATH) ? await loadBaseline() : null;
    const strictPaths = existingBaseline?.strictPaths ?? DEFAULT_STRICT_PATHS;
    const strictPrefixes = existingBaseline?.strictPrefixes ?? DEFAULT_STRICT_PREFIXES;
    await writeBaseline(currentTotals, currentRules, strictPaths, strictPrefixes);
    console.log(`ESLint baseline updated at ${toProjectRelative(BASELINE_PATH)}.`);
    printSummary(currentTotals, currentTotals);
    console.log(`  Tracked rule counts:`);
    for (const rule of TRACKED_RULES) {
      console.log(`    ${rule}: ${currentRules[rule] ?? 0}`);
    }
    return;
  }

  const baseline = await loadBaseline();
  const baselineTotals: Totals = {
    errors: baseline.totalErrors,
    warnings: baseline.totalWarnings,
  };
  const baselineRules = baseline.rules ?? {};

  const strictViolations = listStrictViolations(
    results,
    baseline.strictPaths,
    baseline.strictPrefixes
  );
  const errorRegression = currentTotals.errors > baselineTotals.errors;
  const warningRegression = currentTotals.warnings > baselineTotals.warnings;
  const hasStrictViolations = strictViolations.length > 0;
  const ruleRegressions = findRuleRegressions(currentRules, baselineRules);

  printSummary(currentTotals, baselineTotals);

  if (strictViolations.length > 0) {
    console.error('Strict-path violations (must stay clean):');
    for (const violation of strictViolations) {
      console.error(`  - ${violation.file}: ${violation.issues} issue(s)`);
    }
  }

  if (ruleRegressions.length > 0) {
    console.error('Per-rule regressions (zero-new policy):');
    for (const regression of ruleRegressions) {
      console.error(
        `  - ${regression.rule}: ${regression.current} (baseline ${regression.baseline}, +${regression.delta})`
      );
      // Print the offending file:line:col so the failure is ACTIONABLE, not a
      // bare count. Without this, a contributor sees "+1" and cannot tell where
      // — the count alone is un-diagnosable when local eslint (type resolution)
      // disagrees with CI. Cap the list so a large regression stays readable.
      const locations = collectRuleLocations(results, regression.rule);
      for (const loc of locations.slice(0, 25)) {
        console.error(`      ${loc}`);
      }
      if (locations.length > 25) {
        console.error(`      … and ${locations.length - 25} more`);
      }
    }
  }

  if (errorRegression || warningRegression || hasStrictViolations || ruleRegressions.length > 0) {
    if (errorRegression) {
      console.error('Error regression detected.');
    }
    if (warningRegression) {
      console.error('Warning regression detected.');
    }
    if (hasStrictViolations) {
      console.error('Strict-path regression detected.');
    }
    if (ruleRegressions.length > 0) {
      console.error('Per-rule regression detected.');
    }
    process.exitCode = 1;
    return;
  }

  const reductions = findReductions(currentRules, baselineRules);
  if (
    currentTotals.errors < baselineTotals.errors ||
    currentTotals.warnings < baselineTotals.warnings ||
    reductions.length > 0
  ) {
    console.log('Lint debt was reduced. Run `pnpm run lint:baseline:update` to record the new baseline.');
    if (reductions.length > 0) {
      console.log('  Per-rule reductions:');
      for (const reduction of reductions.slice(0, 10)) {
        console.log(`    - ${reduction.rule}: -${reduction.reduction}`);
      }
    }
  }

  console.log('ESLint no-regression gate passed.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`ESLint no-regression gate crashed: ${message}`);
  process.exitCode = 1;
});
