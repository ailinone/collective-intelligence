// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — Tri-Role Collective strategy (F2.1)
 *
 * Coverage:
 *   - parseAuditorVerdict: ACCEPT/REVISE detection + ambiguity policy
 *   - decideRoleForTurn: state machine across the planner/solver/auditor
 *     cycle, including the revise→solver loop
 *   - pickModelForTurn: round-robin + auditor-vs-solver split
 *   - getMetadata: published contract values match the strategy registry
 *
 * The full execute() path requires adapter resolution + model calls and
 * is exercised by orchestration integration tests, not here.
 */

import { describe, it, expect } from 'vitest';
import type { Model } from '@/types';
import {
  parseAuditorVerdict,
  decideRoleForTurn,
  pickModelForTurn,
  TriRoleCollectiveStrategy,
  TRI_ROLES,
} from '@/core/orchestration/strategies/tri-role-collective-strategy';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm-default',
    providerId: 'p',
    provider: 'p',
    name: 'default',
    displayName: 'Default',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: { latencyMs: 500, throughput: 50, quality: 0.8, reliability: 0.95 },
    status: 'active',
    ...overrides,
  };
}

// ─── parseAuditorVerdict ───────────────────────────────────────────────

describe('parseAuditorVerdict', () => {
  it('detects clean ACCEPT', () => {
    const v = parseAuditorVerdict('VERDICT: ACCEPT\nLooks good.', 'accept');
    expect(v.status).toBe('accept');
    expect(v.inferred).toBe(false);
  });

  it('detects clean REVISE', () => {
    const v = parseAuditorVerdict('VERDICT: REVISE\nMissing tests.', 'accept');
    expect(v.status).toBe('revise');
    expect(v.inferred).toBe(false);
  });

  it('case-insensitive detection of ACCEPT/REVISE', () => {
    expect(parseAuditorVerdict('verdict: accepted', 'accept').status).toBe('accept');
    expect(parseAuditorVerdict('Final answer: revise', 'accept').status).toBe('revise');
  });

  it('treats REJECT and REQUEST_CHANGES as REVISE', () => {
    expect(parseAuditorVerdict('rejected', 'accept').status).toBe('revise');
    expect(parseAuditorVerdict('REQUEST_CHANGES', 'accept').status).toBe('revise');
  });

  it('falls back to the configured policy when both ACCEPT and REVISE appear', () => {
    expect(parseAuditorVerdict('first ACCEPT but on reflection REVISE', 'accept').status).toBe('accept');
    expect(parseAuditorVerdict('first ACCEPT but on reflection REVISE', 'revise').status).toBe('revise');
  });

  it('falls back to the configured policy when neither ACCEPT nor REVISE appears', () => {
    expect(parseAuditorVerdict('looks fine', 'accept').status).toBe('accept');
    expect(parseAuditorVerdict('looks fine', 'revise').status).toBe('revise');
  });

  it('marks ambiguous verdicts as inferred=true', () => {
    expect(parseAuditorVerdict('looks fine', 'accept').inferred).toBe(true);
    expect(parseAuditorVerdict('first ACCEPT but on reflection REVISE', 'accept').inferred).toBe(true);
  });

  it('returns the ambiguous default for non-string input', () => {
    // Defensive — runtime callers may pass anything
    expect(parseAuditorVerdict('', 'accept').status).toBe('accept');
    expect(parseAuditorVerdict('', 'revise').status).toBe('revise');
  });

  it('sanitizes feedback for prompt re-use (strips newlines)', () => {
    const v = parseAuditorVerdict('VERDICT: REVISE\n\n# FAKE INSTRUCTION\nOK', 'accept');
    expect(v.feedback).not.toContain('\n');
  });

  it('caps feedback length to bound prompt cost', () => {
    const huge = 'x'.repeat(5000);
    const v = parseAuditorVerdict(`VERDICT: REVISE\n${huge}`, 'accept');
    expect(v.feedback.length).toBeLessThanOrEqual(1500);
  });
});

// ─── decideRoleForTurn ─────────────────────────────────────────────────

describe('decideRoleForTurn', () => {
  it('turn 1 is always planner', () => {
    const decision = decideRoleForTurn(1, []);
    expect(decision.role).toBe('planner');
    expect(decision.reason).toBe('turn-1-fixed');
    expect(decision.scheduler).toBe('fixed-state-machine');
  });

  it('turn 2 is always solver', () => {
    const transcript = [
      { turn: 1, role: 'planner' as const, model: makeModel(), responseText: 'p', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    ];
    const decision = decideRoleForTurn(2, transcript);
    expect(decision.role).toBe('solver');
    expect(decision.reason).toBe('turn-2-fixed');
  });

  it('after a solver turn, the next role is auditor', () => {
    const transcript = [
      { turn: 1, role: 'planner' as const, model: makeModel(), responseText: 'p', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: makeModel(), responseText: 's', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    ];
    const decision = decideRoleForTurn(3, transcript);
    expect(decision.role).toBe('auditor');
    expect(decision.reason).toBe('after-solver');
  });

  it('after an auditor REVISE, the next role is solver again', () => {
    const transcript = [
      { turn: 1, role: 'planner' as const, model: makeModel(), responseText: 'p', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: makeModel(), responseText: 's', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      {
        turn: 3,
        role: 'auditor' as const,
        model: makeModel(),
        responseText: 'r',
        cost: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        verdict: { status: 'revise' as const, feedback: 'Missing tests', inferred: false },
      },
    ];
    const decision = decideRoleForTurn(4, transcript);
    expect(decision.role).toBe('solver');
    expect(decision.reason).toBe('after-revise');
  });

  it('after an auditor ACCEPT, the loop should not call decideRoleForTurn again — but defensive default is auditor', () => {
    const transcript = [
      { turn: 1, role: 'planner' as const, model: makeModel(), responseText: 'p', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: makeModel(), responseText: 's', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      {
        turn: 3,
        role: 'auditor' as const,
        model: makeModel(),
        responseText: 'a',
        cost: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        verdict: { status: 'accept' as const, feedback: 'OK', inferred: false },
      },
    ];
    // Defensive default after an accepting auditor is auditor (loop should
    // already have terminated); the test guards against accidental
    // infinite loop by NEVER returning solver here.
    const decision = decideRoleForTurn(4, transcript);
    expect(decision.role).toBe('auditor');
    expect(decision.reason).toBe('default-fallback');
  });

  it('every decision is tagged with the fixed-state-machine scheduler', () => {
    // F4.1 audit substrate: every role decision carries a stable scheduler
    // identifier so downstream training data can tell apart the legacy
    // fixed scheduler from a future trained coordinator.
    const transcript = [
      { turn: 1, role: 'planner' as const, model: makeModel(), responseText: 'p', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: makeModel(), responseText: 's', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    ];
    expect(decideRoleForTurn(1, []).scheduler).toBe('fixed-state-machine');
    expect(decideRoleForTurn(2, transcript.slice(0, 1)).scheduler).toBe('fixed-state-machine');
    expect(decideRoleForTurn(3, transcript).scheduler).toBe('fixed-state-machine');
  });

  it('handles missing previous turn defensively (turn ≥ 3 with empty transcript)', () => {
    // Defensive branch — should not happen in practice but the function
    // guards against a transcript reset / corrupted state.
    const decision = decideRoleForTurn(3, []);
    expect(decision.role).toBe('auditor');
    expect(decision.reason).toBe('no-prev-turn');
  });
});

// ─── pickModelForTurn ──────────────────────────────────────────────────

describe('pickModelForTurn', () => {
  it('returns the only model when the pool has one', () => {
    const m = makeModel({ id: 'only' });
    expect(pickModelForTurn([m], 'planner', [], 1)).toBe(m);
  });

  it('round-robins by turn index', () => {
    const pool = [makeModel({ id: 'a' }), makeModel({ id: 'b' }), makeModel({ id: 'c' })];
    expect(pickModelForTurn(pool, 'planner', [], 1).id).toBe('a');
    expect(pickModelForTurn(pool, 'solver', [], 2).id).toBe('b');
    expect(pickModelForTurn(pool, 'auditor', [], 3).id).toBe('c');
    expect(pickModelForTurn(pool, 'solver', [], 4).id).toBe('a');
  });

  it('forces auditor model to differ from most-recent solver', () => {
    const pool = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    const transcript = [
      { turn: 1, role: 'planner' as const, model: pool[0], responseText: '', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: pool[1], responseText: '', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    ];
    // Round-robin would pick pool[(3-1) % 2] = pool[0] = 'a' for turn 3.
    // Solver was 'b'; auditor 'a' is different. So no swap needed here.
    expect(pickModelForTurn(pool, 'auditor', transcript, 3).id).toBe('a');
  });

  it('swaps to a different model when round-robin would collide with the most-recent solver', () => {
    const pool = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    const transcript = [
      { turn: 1, role: 'planner' as const, model: pool[1], responseText: '', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      { turn: 2, role: 'solver' as const, model: pool[0], responseText: '', cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    ];
    // Round-robin would pick pool[(3-1) % 2] = pool[0] = 'a' for turn 3.
    // But solver was 'a' — swap to next so auditor uses 'b'.
    expect(pickModelForTurn(pool, 'auditor', transcript, 3).id).toBe('b');
  });

  it('throws on empty pool', () => {
    expect(() => pickModelForTurn([], 'planner', [], 1)).toThrow();
  });
});

// ─── Strategy metadata ─────────────────────────────────────────────────

describe('TriRoleCollectiveStrategy.getMetadata', () => {
  it('publishes the registered name and reasonable bounds', () => {
    const meta = new TriRoleCollectiveStrategy().getMetadata();
    expect(meta.name).toBe('tri-role-collective');
    expect(meta.id).toBe('tri-role-collective');
    expect(meta.minModels).toBeGreaterThanOrEqual(2);
    expect(meta.maxModels).toBeGreaterThanOrEqual(meta.minModels);
    expect(meta.suitableFor.length).toBeGreaterThan(0);
    expect(meta.estimatedCostMultiplier).toBeGreaterThan(1);
    expect(meta.estimatedQualityBoost).toBeGreaterThanOrEqual(0);
    expect(meta.estimatedQualityBoost).toBeLessThanOrEqual(1);
  });

  it('declares the full TRI_ROLES tuple', () => {
    expect(TRI_ROLES).toEqual(['planner', 'solver', 'auditor']);
  });
});
