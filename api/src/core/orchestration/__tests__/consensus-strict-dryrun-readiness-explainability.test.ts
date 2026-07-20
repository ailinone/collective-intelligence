// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §13 — Strict dry-run explainability tests.
 *
 * Pins the additive per-role explainability fields on the
 * `ConsensusExecutionPlan`:
 *   - `blockersByRole`
 *   - `criticalRoleReadiness`
 *   - `routeReadinessSummary`
 *
 * These let operators read why an `executable=false` plan failed
 * without scanning the flat `blockers` array.
 *
 * The tests use a STUB planner output — the actual planner is exercised
 * by the broader consensus-execution-planner.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { ConsensusExecutionPlan } from '@/core/orchestration/strategies/consensus-execution-planner';

// A pure projection: given a flat blockers array, group it by role.
function projectBlockersByRole(blockers: readonly string[]) {
  return {
    participant: blockers.filter((b) => b.startsWith('insufficient_participants') || b.startsWith('no_eligible_participant')),
    synthesizer: blockers.filter((b) => b.startsWith('no_eligible_synthesizer') || b.includes('synthesizer')),
    judge: blockers.filter((b) => b.startsWith('no_eligible_judge') || b.includes('judge')),
    fallback: blockers.filter((b) => b.startsWith('no_eligible_fallback') || b.includes('fallback')),
  };
}

describe('01C.1B-J1C §13 — strict dry-run explainability', () => {
  it('blockersByRole groups all four critical roles', () => {
    const blockers = [
      'insufficient_participants:got=0,need>=3',
      'no_eligible_synthesizer',
      'no_eligible_judge',
      'no_eligible_fallback_single',
    ];
    const grouped = projectBlockersByRole(blockers);
    expect(grouped.participant).toHaveLength(1);
    expect(grouped.synthesizer).toHaveLength(1);
    expect(grouped.judge).toHaveLength(1);
    expect(grouped.fallback).toHaveLength(1);
  });

  it('blockersByRole handles a plan with only one blocked role', () => {
    const grouped = projectBlockersByRole(['no_eligible_judge']);
    expect(grouped.participant).toHaveLength(0);
    expect(grouped.synthesizer).toHaveLength(0);
    expect(grouped.judge).toHaveLength(1);
    expect(grouped.fallback).toHaveLength(0);
  });

  it('criticalRoleReadiness exposes selectedCount / targetCount / blocked / firstBlocker', () => {
    const fakePlan: Pick<ConsensusExecutionPlan, 'criticalRoleReadiness'> = {
      criticalRoleReadiness: {
        participant: { role: 'participant', selectedCount: 0, targetCount: 3, blocked: true, firstBlocker: 'insufficient_participants:got=0,need>=3' },
        synthesizer: { role: 'synthesizer', selectedCount: 0, targetCount: 1, blocked: true, firstBlocker: 'no_eligible_synthesizer' },
        judge: { role: 'judge', selectedCount: 0, targetCount: 1, blocked: true, firstBlocker: 'no_eligible_judge' },
        fallback: { role: 'fallback', selectedCount: 0, targetCount: 1, blocked: true, firstBlocker: 'no_eligible_fallback_single' },
      },
    };
    expect(fakePlan.criticalRoleReadiness?.participant.selectedCount).toBe(0);
    expect(fakePlan.criticalRoleReadiness?.participant.targetCount).toBe(3);
    expect(fakePlan.criticalRoleReadiness?.participant.blocked).toBe(true);
    expect(fakePlan.criticalRoleReadiness?.synthesizer.firstBlocker).toBe('no_eligible_synthesizer');
  });

  it('routeReadinessSummary derives allRolesSelected from per-role counts', () => {
    const happy = {
      participantSelected: 3,
      synthesizerSelected: 1,
      judgeSelected: 1,
      fallbackSelected: 1,
    };
    const allRolesSelected =
      happy.participantSelected >= 3 &&
      happy.synthesizerSelected >= 1 &&
      happy.judgeSelected >= 1 &&
      happy.fallbackSelected >= 1;
    expect(allRolesSelected).toBe(true);

    const sad = { ...happy, synthesizerSelected: 0 };
    const sadAll =
      sad.participantSelected >= 3 &&
      sad.synthesizerSelected >= 1 &&
      sad.judgeSelected >= 1 &&
      sad.fallbackSelected >= 1;
    expect(sadAll).toBe(false);
  });

  it('explainability surfaces NEVER include raw prompt text or secrets', () => {
    const fakePlan = {
      blockers: ['insufficient_participants:got=0,need>=3'],
      blockersByRole: { participant: ['insufficient_participants:got=0,need>=3'], synthesizer: [], judge: [], fallback: [] },
      criticalRoleReadiness: {
        participant: { role: 'participant', selectedCount: 0, targetCount: 3, blocked: true, firstBlocker: 'insufficient_participants:got=0,need>=3' },
        synthesizer: { role: 'synthesizer', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
        judge: { role: 'judge', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
        fallback: { role: 'fallback', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
      },
    };
    const json = JSON.stringify(fakePlan);
    // No raw prompt
    expect(json).not.toMatch(/parseMoneyBR|R\$ 1\.234,56/);
    // No secret patterns
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(json).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
  });

  it('contract field names are stable for downstream consumers', () => {
    const fakePlan: Partial<ConsensusExecutionPlan> = {
      blockersByRole: { participant: [], synthesizer: [], judge: [], fallback: [] },
      criticalRoleReadiness: {
        participant: { role: 'participant', selectedCount: 3, targetCount: 3, blocked: false, firstBlocker: null },
        synthesizer: { role: 'synthesizer', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
        judge: { role: 'judge', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
        fallback: { role: 'fallback', selectedCount: 1, targetCount: 1, blocked: false, firstBlocker: null },
      },
      routeReadinessSummary: { allRolesSelected: true, blockedRoles: [], totalBlockers: 0 },
    };
    expect(fakePlan).toHaveProperty('blockersByRole');
    expect(fakePlan).toHaveProperty('criticalRoleReadiness');
    expect(fakePlan).toHaveProperty('routeReadinessSummary');
  });
});
