// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Smoke test for Phase 2c shadow wire.
 *
 * Exercises the FULL round-trip for ALL 5 (strategy, decisionType)
 * tuples wired into the orchestration strategies:
 *
 *   buildEnsembleRequest → runEnsembleInShadow → fetch coord_serving →
 *   AggregatedEnsembleDecision → detectDivergence → log
 *
 * Prerequisites:
 *   - coord_serving.py running on 127.0.0.1:8090 in any mode
 *
 * Run:
 *   pnpm tsx scripts/_smoke-ensemble-shadow.ts
 *
 * Expected:
 *   - exit code 0
 *   - 5 "Ensemble shadow decision recorded" log lines
 *   - per-tuple: shadow.role + divergence.sameRole
 */

import type { EnsembleDecisionRequest } from '../src/core/coordination/ensemble-coordinator-types';
import {
  buildEnsembleRequest,
  loadEnsembleClientConfig,
} from '../src/core/coordination/ensemble-coordinator-client';
import { runEnsembleInShadow } from '../src/core/coordination/ensemble-coordinator-shadow';

interface SmokeCase {
  label: string;
  request: EnsembleDecisionRequest;
  heuristicRole: string;
  heuristicScheduler: string;
  heuristicReason: string;
  expectedRole: string;
}

const CASES: ReadonlyArray<SmokeCase> = [
  {
    label: 'tri-role-collective:role-for-turn',
    request: buildEnsembleRequest('tri-role-collective', 'role-for-turn', {
      requestId: 'smoke-tri',
      turn: 1,
      transcriptLength: 0,
      taskType: 'reasoning',
    }),
    heuristicRole: 'planner',
    heuristicScheduler: 'fixed-state-machine',
    heuristicReason: 'turn-1-planner',
    expectedRole: 'auditor', // mock returns auditor for tri-role per coord_serving.py
  },
  {
    label: 'debate:moderator-selection',
    request: buildEnsembleRequest('debate', 'moderator-selection', {
      requestId: 'smoke-debate',
      participantCount: 3,
      taskType: 'reasoning',
    }),
    heuristicRole: 'moderator',
    heuristicScheduler: 'fixed-state-machine',
    heuristicReason: 'heuristic-default',
    expectedRole: 'moderator',
  },
  {
    label: 'expert-panel:panel-composition',
    request: buildEnsembleRequest('expert-panel', 'panel-composition', {
      requestId: 'smoke-panel',
      domains: ['code', 'reasoning'],
      expertCount: 2,
    }),
    heuristicRole: 'coordinator',
    heuristicScheduler: 'context-and-quality',
    heuristicReason: 'panel-default',
    expectedRole: 'coordinator',
  },
  {
    label: 'consensus:synthesis-coordinator',
    request: buildEnsembleRequest('consensus', 'synthesis-coordinator', {
      requestId: 'smoke-consensus',
      voterCount: 3,
      taskType: 'analysis',
    }),
    heuristicRole: 'synthesizer',
    heuristicScheduler: 'context-and-quality',
    heuristicReason: 'quality-fallback',
    expectedRole: 'synthesizer',
  },
  {
    label: 'parallel-race:race-candidates',
    request: buildEnsembleRequest('parallel-race', 'race-candidates', {
      requestId: 'smoke-race',
      candidateCount: 3,
      taskType: 'general',
    }),
    heuristicRole: 'candidate',
    heuristicScheduler: 'pin-then-first-N',
    heuristicReason: 'default-slice',
    expectedRole: 'candidate',
  },
];

async function runOne(c: SmokeCase): Promise<boolean> {
  const config = loadEnsembleClientConfig();
  const result = await runEnsembleInShadow(c.request, {
    config,
    heuristicDecisionForComparison: {
      role: c.heuristicRole,
      scheduler: c.heuristicScheduler,
      reason: c.heuristicReason,
    },
  });
  if (result === null) {
    console.error(`[smoke ${c.label}] FAIL: runEnsembleInShadow returned null`);
    return false;
  }
  if (result.kind !== 'success') {
    console.error(`[smoke ${c.label}] FAIL: kind=${result.kind} ${JSON.stringify(result)}`);
    return false;
  }
  const matched = result.decision.role === c.expectedRole;
  console.log(
    `[smoke ${c.label}] ${matched ? 'PASS' : 'FAIL'} role=${result.decision.role} expected=${c.expectedRole} latencyMs=${result.latencyMs}`,
  );
  return matched;
}

async function main(): Promise<number> {
  process.env.CI_ENSEMBLE_COORDINATOR_ENABLED = 'true';
  process.env.CI_ENSEMBLE_COORDINATOR_SHADOW_MODE = 'true';
  process.env.CI_ENSEMBLE_COORDINATOR_URL =
    process.env.CI_ENSEMBLE_COORDINATOR_URL || 'http://127.0.0.1:8090/v1/ensemble/decide';
  process.env.CI_ENSEMBLE_COORDINATOR_TIMEOUT_MS =
    process.env.CI_ENSEMBLE_COORDINATOR_TIMEOUT_MS || '5000';

  const config = loadEnsembleClientConfig();
  console.log('[smoke] config:', {
    enabled: config.enabled,
    endpoint: config.endpoint,
    shadowMode: config.shadowMode,
  });

  let passed = 0;
  for (const c of CASES) {
    const ok = await runOne(c);
    if (ok) passed += 1;
  }
  console.log(`[smoke] ${passed}/${CASES.length} cases passed`);
  return passed === CASES.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('[smoke] FAIL — unhandled:', err);
    process.exit(99);
  });
