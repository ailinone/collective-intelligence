// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SAC-01 / SAC-02 (audit 2026-08-20, 11-STRATEGY-AGENT-CONTRACTS):
 *   - SAC-01 (P1): explicit-only strategies must NEVER be selected by an
 *     automatic path (triage / archive / Pareto / Thompson bandit / heuristic).
 *   - SAC-02 (P2): the `hierarchical` stub must not be exposed as a valid
 *     registered strategy (explicit callers would silently get single-model
 *     passthrough).
 */

import { describe, it, expect } from 'vitest';
import { OrchestrationEngine, isAutoSelectableStrategy } from '../orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';

const EXPLICIT_ONLY = [
  'massive-parallel',
  'war-room',
  'blind-debate',
  'devil-advocate-consensus',
  'safety-quorum',
  'diversity-ensemble',
  'stigmergic-refinement',
  'swarm-explore',
  'clarification-first',
  'research-synthesize',
  'double-diamond',
  'multi-hop-qa',
  'persona-exploration',
  'agentic',
  'sensitivity-consensus',
  'tri-role-collective',
] as const;

function makeModels(n: number): Model[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    provider: `p${(i % 3) + 1}`,
    capabilities: ['chat', 'text_generation'],
    performance: { quality: 0.9 },
  })) as unknown as Model[];
}

function makeEngine(): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as ProviderRegistry,
    defaultStrategy: 'auto',
    enableAutoSelection: true,
  });
}

type EngineInternals = {
  strategies: Map<string, { getMetadata(): { name: string } }>;
  selectStrategyCore(
    request: ChatRequest,
    context: OrchestrationContext
  ): { strategy: { getMetadata(): { name: string } }; selectionSource: string };
};

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'sac-01-test',
    taskType: 'analysis',
    contextSize: 1000,
    models: makeModels(9),
    ...overrides,
  } as OrchestrationContext;
}

const AUTO_REQUEST: ChatRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'analyze this' }],
} as unknown as ChatRequest;

describe('SAC-01/SAC-02 — explicit-only strategy policy', () => {
  it('isAutoSelectableStrategy flags exactly the explicit-only portfolio', () => {
    for (const name of EXPLICIT_ONLY) {
      expect(isAutoSelectableStrategy(name)).toBe(false);
    }
    // Auto-reachable strategies stay auto-selectable
    for (const name of [
      'single',
      'parallel',
      'sequential',
      'collaborative',
      'hybrid',
      'competitive',
      'expert-panel',
      'cost-cascade',
      'quality-multipass',
      'adaptive',
      'contextual',
      'consensus',
      'reinforcement',
      'debate',
      'critique-repair', // has a legit auto path (TaskProfile hint)
    ]) {
      expect(isAutoSelectableStrategy(name)).toBe(true);
    }
  });

  it('SAC-02: hierarchical stub is NOT registered', () => {
    const engine = makeEngine() as unknown as EngineInternals;
    expect(engine.strategies.has('hierarchical')).toBe(false);
    expect(Array.from(engine.strategies.keys())).not.toContain('hierarchical');
  });

  it('SAC-02: explicit request for hierarchical fails loudly with invalid_strategy', () => {
    const engine = makeEngine() as unknown as EngineInternals;
    const request = { ...AUTO_REQUEST, strategy: 'hierarchical' } as ChatRequest;
    expect(() => engine.selectStrategyCore(request, makeContext())).toThrowError(
      /is not registered/
    );
    try {
      engine.selectStrategyCore(request, makeContext());
    } catch (err) {
      expect((err as { code?: string }).code).toBe('invalid_strategy');
    }
  });

  it('explicit-only strategies remain reachable via explicit request.strategy', () => {
    const engine = makeEngine() as unknown as EngineInternals;
    for (const name of EXPLICIT_ONLY) {
      const request = { ...AUTO_REQUEST, strategy: name } as ChatRequest;
      const selection = engine.selectStrategyCore(request, makeContext());
      expect(selection.strategy.getMetadata().name).toBe(name);
      expect(selection.selectionSource).toBe('explicit');
    }
  });

  it('SAC-01: auto path never selects an explicit-only strategy (bandit/heuristic pool)', () => {
    const engine = makeEngine() as unknown as EngineInternals;
    const taskTypes = ['analysis', 'code-generation', 'general', 'creative', 'reasoning'];
    for (let i = 0; i < 100; i++) {
      const context = makeContext({
        requestId: `sac-01-auto-${i}`,
        taskType: taskTypes[i % taskTypes.length] as OrchestrationContext['taskType'],
      });
      const selection = engine.selectStrategyCore(AUTO_REQUEST, context);
      expect(EXPLICIT_ONLY).not.toContain(selection.strategy.getMetadata().name);
    }
  });

  it('SAC-01: a triage recommendation pointing at an explicit-only strategy is skipped', () => {
    const engine = makeEngine() as unknown as EngineInternals;
    const context = makeContext({
      requestId: 'sac-01-triage',
      // War-room IS suitable for analysis with 9 models — the guard, not
      // suitability, must be what blocks it.
      triage: { recommendedStrategy: 'war-room' } as OrchestrationContext['triage'],
    });
    const selection = engine.selectStrategyCore(AUTO_REQUEST, context);
    expect(selection.strategy.getMetadata().name).not.toBe('war-room');
    expect(selection.selectionSource).not.toBe('triage');
  });
});
