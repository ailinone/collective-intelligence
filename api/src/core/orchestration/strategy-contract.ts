// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  CanonicalStrategyName,
  ExecutionStrategyName,
  StrategyInputName,
} from '@/types';

export const STRATEGY_INPUT_VALUES: readonly StrategyInputName[] = [
  'single',
  'cost',
  'speed',
  'quality',
  'balanced',
  'parallel',
  'sequential',
  'collaborative',
  'hybrid',
  'competitive',
  'massive-parallel',
  'cost-cascade',
  'adaptive',
  'contextual',
  'hierarchical',
  'reinforcement',
  'debate',
  'consensus',
  'quality_multipass',
  'expert-panel',
  'war-room',
  'blind-debate',
  'devil-advocate-consensus',
  'safety-quorum',
  'diversity-ensemble',
  'stigmergic-refinement',
  'swarm-explore',
  'clarification-first',
  'research-synthesize',
  'critique-repair',
  'double-diamond',
  'multi-hop-qa',
  'persona-exploration',
  'agentic',
  // Phase 2c shadow-wired strategies (also in CanonicalStrategyName but
  // were missing from STRATEGY_INPUT_VALUES → /v1/chat/completions Fastify
  // schema rejected them with `Request validation failed`. Adding them
  // closes the gap so c3-main-comparison arms using these strategies can
  // actually execute.
  'sensitivity-consensus',
  'tri-role-collective',
  'multi-hop',
  'personas',
  'clarify',
  'research',
  'dynamic',
  'quality-multi-pass',
  'quality-multipass',
  'fast',
  'auto',
];

const INPUT_SET = new Set<string>(STRATEGY_INPUT_VALUES);

const aliasToCanonical: Record<string, CanonicalStrategyName> = {
  quality_multipass: 'quality_multipass',
  'quality-multi-pass': 'quality_multipass',
  'quality-multipass': 'quality_multipass',
  single: 'single',
  cost: 'cost',
  speed: 'speed',
  quality: 'quality',
  balanced: 'balanced',
  parallel: 'parallel',
  sequential: 'sequential',
  collaborative: 'collaborative',
  hybrid: 'hybrid',
  competitive: 'competitive',
  'massive-parallel': 'massive-parallel',
  'cost-cascade': 'cost-cascade',
  adaptive: 'adaptive',
  contextual: 'contextual',
  hierarchical: 'hierarchical',
  reinforcement: 'reinforcement',
  debate: 'debate',
  consensus: 'consensus',
  'expert-panel': 'expert-panel',
  'war-room': 'war-room',
  'blind-debate': 'blind-debate',
  'devil-advocate-consensus': 'devil-advocate-consensus',
  'safety-quorum': 'safety-quorum',
  'diversity-ensemble': 'diversity-ensemble',
  'stigmergic-refinement': 'stigmergic-refinement',
  'swarm-explore': 'swarm-explore',
  'clarification-first': 'clarification-first',
  'clarify': 'clarification-first',
  'research-synthesize': 'research-synthesize',
  'research': 'research-synthesize',
  'critique-repair': 'critique-repair',
  'double-diamond': 'double-diamond',
  'multi-hop-qa': 'multi-hop-qa',
  'multi-hop': 'multi-hop-qa',
  'persona-exploration': 'persona-exploration',
  'personas': 'persona-exploration',
  'agentic': 'agentic',
  fast: 'sensitivity-consensus',
  dynamic: 'dynamic',
  auto: 'dynamic',
};

const canonicalToExecution: Record<CanonicalStrategyName, ExecutionStrategyName> = {
  single: 'single',
  cost: 'cost-cascade',
  speed: 'single',
  quality: 'quality-multipass',
  balanced: 'hybrid',
  parallel: 'parallel',
  sequential: 'sequential',
  collaborative: 'collaborative',
  hybrid: 'hybrid',
  competitive: 'competitive',
  'massive-parallel': 'massive-parallel',
  'cost-cascade': 'cost-cascade',
  adaptive: 'adaptive',
  contextual: 'contextual',
  hierarchical: 'hierarchical',
  reinforcement: 'reinforcement',
  debate: 'debate',
  consensus: 'consensus',
  quality_multipass: 'quality-multipass',
  'expert-panel': 'expert-panel',
  'war-room': 'war-room',
  'blind-debate': 'blind-debate',
  'devil-advocate-consensus': 'devil-advocate-consensus',
  'safety-quorum': 'safety-quorum',
  'diversity-ensemble': 'diversity-ensemble',
  'stigmergic-refinement': 'stigmergic-refinement',
  'swarm-explore': 'swarm-explore',
  'clarification-first': 'clarification-first',
  'research-synthesize': 'research-synthesize',
  'critique-repair': 'critique-repair',
  'double-diamond': 'double-diamond',
  'multi-hop-qa': 'multi-hop-qa',
  'persona-exploration': 'persona-exploration',
  'agentic': 'agentic',
  'compositor': 'compositor',
  'sensitivity-consensus': 'sensitivity-consensus',
  'tri-role-collective': 'tri-role-collective',
  dynamic: 'auto',
};

const executionToCanonical: Record<ExecutionStrategyName, CanonicalStrategyName> = {
  single: 'single',
  parallel: 'parallel',
  sequential: 'sequential',
  collaborative: 'collaborative',
  hybrid: 'hybrid',
  competitive: 'competitive',
  'expert-panel': 'expert-panel',
  'massive-parallel': 'massive-parallel',
  'cost-cascade': 'cost-cascade',
  'quality-multipass': 'quality_multipass',
  adaptive: 'adaptive',
  contextual: 'contextual',
  hierarchical: 'hierarchical',
  consensus: 'consensus',
  reinforcement: 'reinforcement',
  debate: 'debate',
  'war-room': 'war-room',
  'blind-debate': 'blind-debate',
  'devil-advocate-consensus': 'devil-advocate-consensus',
  'safety-quorum': 'safety-quorum',
  'diversity-ensemble': 'diversity-ensemble',
  'stigmergic-refinement': 'stigmergic-refinement',
  'swarm-explore': 'swarm-explore',
  'clarification-first': 'clarification-first',
  'research-synthesize': 'research-synthesize',
  'critique-repair': 'critique-repair',
  'double-diamond': 'double-diamond',
  'multi-hop-qa': 'multi-hop-qa',
  'persona-exploration': 'persona-exploration',
  'agentic': 'agentic',
  'compositor': 'compositor',
  'sensitivity-consensus': 'sensitivity-consensus',
  'tri-role-collective': 'tri-role-collective',
  cached: 'dynamic',
  auto: 'dynamic',
};

export function normalizeStrategyInput(
  input: string | null | undefined
): StrategyInputName | undefined {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '_');
  if (!INPUT_SET.has(normalized)) {
    return undefined;
  }
  return normalized as StrategyInputName;
}

export function canonicalizeStrategyInput(
  input: string | null | undefined
): CanonicalStrategyName | undefined {
  const normalized = normalizeStrategyInput(input);
  if (!normalized) return undefined;
  return aliasToCanonical[normalized];
}

export function resolveExecutionStrategy(
  input: string | null | undefined
): ExecutionStrategyName | undefined {
  const canonical = canonicalizeStrategyInput(input);
  if (!canonical) return undefined;
  return canonicalToExecution[canonical];
}

export function mapExecutionToCanonical(
  strategy: ExecutionStrategyName | string | null | undefined
): CanonicalStrategyName {
  if (!strategy) return 'dynamic';
  if (strategy in executionToCanonical) {
    return executionToCanonical[strategy as ExecutionStrategyName];
  }
  return 'dynamic';
}

export function getStrategyValidationMessage(): string {
  return `Invalid strategy. Allowed values: ${STRATEGY_INPUT_VALUES.join(', ')}`;
}

