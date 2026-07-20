// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Architectural invariant: every strategy that integrates the Phase 2c
 * shadow ensemble wire MUST follow the same pattern. A regression
 * (someone removes the .catch, forgets to import buildEnsembleRequest,
 * misuses the void operator) becomes a real production hazard:
 *
 *   - Missing .catch → unhandled promise rejection on coord-serving
 *     timeout, eventually crashing the process under tracing/sourcemap
 *     plugins that promote unhandled rejections to thrown errors.
 *   - Missing void → linting error (no-floating-promises) but more
 *     importantly: the strategy might `await` it inadvertently and
 *     block the heuristic path on shadow latency.
 *   - buildEnsembleRequest with the wrong (strategy, decisionType) tuple
 *     → wire contract drift between TS and Python validation rules.
 *
 * This test reads the strategy source files and asserts the pattern
 * structurally. Static analysis is sufficient because the pattern is
 * mechanical — five places that must look the same.
 *
 * If this test fails after a refactor: don't suppress it. Either keep
 * the canonical pattern or update this invariant deliberately.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface StrategyExpectation {
  /** File relative to api/ root. */
  path: string;
  /** Strategy id passed to buildEnsembleRequest. */
  strategyId: string;
  /** decisionType passed alongside strategyId. */
  decisionType: string;
}

const API_ROOT = resolve(__dirname, '../../../..');

const EXPECTED: ReadonlyArray<StrategyExpectation> = [
  {
    path: 'src/core/orchestration/strategies/debate-strategy.ts',
    strategyId: 'debate',
    decisionType: 'moderator-selection',
  },
  {
    path: 'src/core/orchestration/strategies/tri-role-collective-strategy.ts',
    strategyId: 'tri-role-collective',
    decisionType: 'role-for-turn',
  },
  {
    path: 'src/core/orchestration/strategies/expert-panel-strategy.ts',
    strategyId: 'expert-panel',
    decisionType: 'panel-composition',
  },
  {
    path: 'src/core/orchestration/strategies/consensus-strategy.ts',
    strategyId: 'consensus',
    decisionType: 'synthesis-coordinator',
  },
  // parallel-race-strategy removed 2026-06-11 (audit DEAD-1): implemented and
  // tested but never registered in the orchestration engine — recoverable
  // from git history if a race-style strategy earns a niche in benchmark v4.
];

function readStrategy(p: string): string {
  return readFileSync(resolve(API_ROOT, p), 'utf-8');
}

describe('strategies shadow-wire architectural invariant', () => {
  for (const exp of EXPECTED) {
    describe(exp.strategyId, () => {
      const source = readStrategy(exp.path);

      it('imports buildEnsembleRequest from ensemble-coordinator-client', () => {
        expect(source).toMatch(
          /import\s+\{[^}]*buildEnsembleRequest[^}]*\}\s+from\s+['"]@\/core\/coordination\/ensemble-coordinator-client['"]/,
        );
      });

      it('imports runEnsembleInShadow from ensemble-coordinator-shadow', () => {
        expect(source).toMatch(
          /import\s+\{[^}]*runEnsembleInShadow[^}]*\}\s+from\s+['"]@\/core\/coordination\/ensemble-coordinator-shadow['"]/,
        );
      });

      it(`calls buildEnsembleRequest('${exp.strategyId}', '${exp.decisionType}', ...)`, () => {
        // Allows any whitespace/newlines between args. The order is
        // fixed: strategy, decisionType, context.
        const pattern = new RegExp(
          `buildEnsembleRequest\\s*\\(\\s*['"]${exp.strategyId}['"]\\s*,\\s*['"]${exp.decisionType}['"]`,
        );
        expect(source).toMatch(pattern);
      });

      it('uses void operator on the runEnsembleInShadow call', () => {
        // The pattern is `void runEnsembleInShadow(...)` — without it,
        // ESLint's no-floating-promises gate fails. Catching the lack
        // here gives a more diagnostic error than a generic lint
        // failure (the test name calls out the strategy by id).
        expect(source).toMatch(/void\s+runEnsembleInShadow\s*\(/);
      });

      it('attaches a .catch handler to the runEnsembleInShadow promise', () => {
        // Defense in depth: runEnsembleInShadow already swallows
        // errors internally, but the strategy's .catch is the final
        // safety net so an unhandled rejection from a future refactor
        // can't bubble to the request path.
        expect(source).toMatch(
          /void\s+runEnsembleInShadow\s*\([\s\S]*?\)\s*\.catch\s*\(/,
        );
      });

      it('passes heuristicDecisionForComparison so divergence is computed', () => {
        // Without this option, every divergence record is null and
        // the live "ensemble-vs-heuristic" SLI metric goes silent.
        expect(source).toMatch(/heuristicDecisionForComparison\s*:/);
      });
    });
  }

  describe('cross-strategy invariants', () => {
    it('every strategy uses the SAME buildEnsembleRequest import path', () => {
      const importPaths = EXPECTED.map((exp) => {
        const source = readStrategy(exp.path);
        const match = source.match(
          /from\s+['"](@\/core\/coordination\/ensemble-coordinator-client)['"]/,
        );
        return match?.[1];
      });
      const uniquePaths = new Set(importPaths);
      expect(uniquePaths.size).toBe(1);
      expect(uniquePaths.has('@/core/coordination/ensemble-coordinator-client')).toBe(true);
    });

    it('every strategy uses the SAME runEnsembleInShadow import path', () => {
      const importPaths = EXPECTED.map((exp) => {
        const source = readStrategy(exp.path);
        const match = source.match(
          /from\s+['"](@\/core\/coordination\/ensemble-coordinator-shadow)['"]/,
        );
        return match?.[1];
      });
      const uniquePaths = new Set(importPaths);
      expect(uniquePaths.size).toBe(1);
    });

    it('strategies that PERSIST signals also import ShadowEnsembleSnapshot', () => {
      // Only debate, tri-role, and expert-panel persist signals. The
      // other two log shadow data via teacher_traces only (no DB
      // persistence path) and don't need the type. This invariant
      // prevents the persistence wire from drifting partially: if you
      // import ShadowEnsembleSnapshot, you committed to threading it
      // into the SignalInput.
      const PERSISTING_STRATEGIES = [
        'debate-strategy.ts',
        'tri-role-collective-strategy.ts',
        'expert-panel-strategy.ts',
      ];
      for (const fileName of PERSISTING_STRATEGIES) {
        const path = `src/core/orchestration/strategies/${fileName}`;
        const source = readStrategy(path);
        expect(
          source,
          `${fileName} should import ShadowEnsembleSnapshot`,
        ).toMatch(/ShadowEnsembleSnapshot/);
      }
    });

    it('the canonical (strategy, decisionType) tuples match the wire-contract enum', () => {
      // The Python coord_serving.py validates these via Pydantic
      // Literal types. If a TS strategy invents a NEW tuple, the
      // Python side rejects with 422. Lock the set here so refactors
      // can't drift one side.
      const TS_TUPLES = EXPECTED.map((e) => `${e.strategyId}/${e.decisionType}`).sort();
      // The Python enum from coord_serving.py + ensemble-coordinator-types.ts.
      // sensitivity-consensus is reserved but no strategy uses it yet.
      const ALLOWED_TUPLES = [
        'consensus/synthesis-coordinator',
        'debate/moderator-selection',
        'expert-panel/panel-composition',
        'parallel-race/race-candidates',
        'tri-role-collective/role-for-turn',
      ];
      expect(TS_TUPLES).toEqual(ALLOWED_TUPLES);
    });
  });
});
