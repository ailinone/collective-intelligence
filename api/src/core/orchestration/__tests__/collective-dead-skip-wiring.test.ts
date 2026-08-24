// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract — collective strategies must not select dead primaries.
 *
 * Why a string-grep test (mirrors chat-routes-pin-wiring.test.ts and
 * streaming-function-calling-chain-wiring.test.ts)
 * ───────────────────────────────────────────────────────────────────
 * The 2026-08-21 incident was a WIRING hole, not a missing feature: the
 * fast path already had dead-skip, but the shared eligible pool feeding
 * every collective strategy (quality-multipass, debate, consensus, ...)
 * never applied it. The regression mode is silent — a refactor can inline
 * the pool build or bypass getEligibleModels without failing any import
 * or type check. Locking the textual wiring is the structural guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ORCH, rel), 'utf8');

const baseStrategy = read('base-strategy.ts');
const chatRoutes = read(join('..', '..', 'routes', 'chat', 'chat-routes.ts'));
const collectives = [
  'strategies/quality-multipass-strategy.ts',
  'strategies/debate-strategy.ts',
  'strategies/consensus-strategy.ts',
  'strategies/competitive-strategy.ts',
];

describe('collective dead-skip wiring contract', () => {
  it('base-strategy gates the SHARED eligible pool through skipDeadCandidates', () => {
    // The public getEligibleModels must wrap the raw pool build with the
    // dead-skip gate, applied OUTSIDE the TTL cache (fresh per call).
    expect(baseStrategy).toMatch(
      /const pool = this\.getEligibleModelsRaw\(context\);\s*\n\s*\/\/ DEAD-CANDIDATE SKIP/
    );
    expect(baseStrategy).toMatch(/const live = skipDeadCandidates\(pool\);/);
    expect(baseStrategy).toMatch(/private getEligibleModelsRaw\(context/);
  });

  it('the streaming fast path reuses the same shared helper', () => {
    expect(chatRoutes).toMatch(
      /if \(isDeadCandidateProvider\(adapterProvider, model\.id\)\) return true;/
    );
    expect(chatRoutes).toMatch(
      /from '@\/core\/orchestration\/dead-candidate-skip'/
    );
  });

  it.each(collectives)('%s selects its pool via the gated getEligibleModels', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/this\.getEligibleModels\(context\)/);
  });
});
