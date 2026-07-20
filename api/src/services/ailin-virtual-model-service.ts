// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  AilinBillingProfile,
  AilinRuntimeConstraints,
  ExecutionStrategyName,
  TaskType,
} from '@/types';
import { ensureModelCapabilityArray } from '@/types';
import { resolveExecutionStrategy } from '@/core/orchestration/strategy-contract';
import { logger } from '@/utils/logger';
import {
  resolveStrategyTier,
  STATIC_RATE_CARD,
  type TierId,
  type TierRate,
  type TierRateCard,
} from '@/services/pricing-tiers';

export interface AilinVirtualModelProfile {
  id: string;
  displayName: string;
  description: string;
  strategy?: ExecutionStrategyName;
  qualityTarget?: number;
  maxCost?: number;
  taskType?: TaskType;
  constraints?: AilinRuntimeConstraints;
  billing?: AilinBillingProfile;
  endpoints: string[];
}

export interface ResolvedAilinVirtualModel {
  alias: string;
  model: 'auto';
  strategy?: ExecutionStrategyName;
  qualityTarget?: number;
  maxCost?: number;
  taskType?: TaskType;
  constraints?: AilinRuntimeConstraints;
  billing?: AilinBillingProfile;
  /**
   * Set when the alias was a `<strategy>:<tier>` composite. The chat path meters
   * the USER's tokens at `tierRate` (the published price), independent of the
   * internal fan-out cost. Absent for the legacy `ailin-*` preset aliases.
   */
  tier?: TierId;
  tierRate?: TierRate;
}

const DEFAULT_PROFILES: AilinVirtualModelProfile[] = [
  {
    id: 'ailin-auto',
    displayName: 'Ailin Auto',
    description: 'Automatic dynamic orchestration across discovered providers and models.',
    strategy: 'auto',
    endpoints: ['chat_completions', 'responses'],
  },
  {
    id: 'ailin-best',
    displayName: 'Ailin Best',
    description: 'Prioritizes quality-oriented orchestration for difficult tasks.',
    strategy: 'quality-multipass',
    qualityTarget: 0.95,
    endpoints: ['chat_completions', 'responses'],
  },
  {
    id: 'ailin-fast',
    displayName: 'Ailin Fast',
    description: 'Prioritizes lower-latency execution while preserving fallback behavior.',
    strategy: 'single',
    endpoints: ['chat_completions', 'responses'],
  },
  {
    id: 'ailin-economy',
    displayName: 'Ailin Economy',
    description: 'Prioritizes cost-aware orchestration and cascading fallback.',
    strategy: 'cost-cascade',
    maxCost: 0.002,
    endpoints: ['chat_completions', 'responses'],
  },
  {
    id: 'ailin-consensus',
    displayName: 'Ailin Consensus',
    description: 'Runs consensus strategy for stronger agreement across candidate models.',
    strategy: 'consensus',
    qualityTarget: 0.9,
    endpoints: ['chat_completions', 'responses'],
  },
  {
    id: 'ailin-voice',
    displayName: 'Ailin Voice',
    description: 'Best voice model — all TTS/STT/STS providers (cloud + self-hosted). Optimal selection by latency and health.',
    strategy: 'single',
    endpoints: ['audio_speech', 'audio_transcriptions', 'realtime'],
  },
  {
    id: 'ailin-stt',
    displayName: 'Ailin STT',
    description: 'Best speech-to-text model by latency and accuracy.',
    strategy: 'single',
    endpoints: ['audio_transcriptions'],
  },
  {
    id: 'ailin-realtime',
    displayName: 'Ailin Realtime',
    description: 'Optimized voice pipeline for lowest latency speech-to-speech.',
    strategy: 'single',
    endpoints: ['realtime'],
  },
];

const log = logger.child({ component: 'ailin-virtual-models' });

const EXECUTION_STRATEGIES = new Set<ExecutionStrategyName>([
  'single',
  'parallel',
  'sequential',
  'collaborative',
  'hybrid',
  'competitive',
  'expert-panel',
  'massive-parallel',
  'cost-cascade',
  'quality-multipass',
  'adaptive',
  'contextual',
  'hierarchical',
  'consensus',
  'reinforcement',
  'debate',
  'cached',
  'auto',
]);

const TASK_TYPES = new Set<TaskType>([
  'code-generation',
  'code-review',
  'debugging',
  'refactoring',
  'documentation',
  'testing',
  'analysis',
  'qa',
  'general',
  'caching',
  'reasoning',
  'decision-making',
  'architecture',
]);

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseTaskType(value: unknown): TaskType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return TASK_TYPES.has(normalized as TaskType) ? (normalized as TaskType) : undefined;
}

function parseRuntimeConstraints(value: unknown): AilinRuntimeConstraints | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const obj = value as Record<string, unknown>;

  const requiredCapabilities = ensureModelCapabilityArray(obj.requiredCapabilities);
  const requiredTools = toStringArray(obj.requiredTools);
  const requiredEndpoint =
    typeof obj.requiredEndpoint === 'string' && obj.requiredEndpoint.trim().length > 0
      ? obj.requiredEndpoint.trim()
      : undefined;
  const preferredProviders = toStringArray(obj.preferredProviders).map((entry) => entry.toLowerCase());
  const excludedProviders = toStringArray(obj.excludedProviders).map((entry) => entry.toLowerCase());

  const constraints: AilinRuntimeConstraints = {
    requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
    requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
    requiredEndpoint,
    preferredProviders: preferredProviders.length > 0 ? preferredProviders : undefined,
    excludedProviders: excludedProviders.length > 0 ? excludedProviders : undefined,
    maxInputCostPer1k: toPositiveNumber(obj.maxInputCostPer1k),
    maxOutputCostPer1k: toPositiveNumber(obj.maxOutputCostPer1k),
    maxAverageCostPer1k: toPositiveNumber(obj.maxAverageCostPer1k),
    minContextWindow: toPositiveNumber(obj.minContextWindow),
  };

  const hasConstraints = Object.values(constraints).some((entry) => entry !== undefined);
  return hasConstraints ? constraints : undefined;
}

function parseBillingProfile(value: unknown): AilinBillingProfile | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : undefined;
  const billing: AilinBillingProfile = {
    enabled,
    inputMarkupMultiplier: toPositiveNumber(obj.inputMarkupMultiplier),
    outputMarkupMultiplier: toPositiveNumber(obj.outputMarkupMultiplier),
    flatFeeUsd: toPositiveNumber(obj.flatFeeUsd),
    minimumChargeUsd: toPositiveNumber(obj.minimumChargeUsd),
    maximumChargeUsd: toPositiveNumber(obj.maximumChargeUsd),
    minInputCostPer1kUsd: toPositiveNumber(obj.minInputCostPer1kUsd),
    minOutputCostPer1kUsd: toPositiveNumber(obj.minOutputCostPer1kUsd),
  };
  const hasBilling = Object.values(billing).some((entry) => entry !== undefined);
  return hasBilling ? billing : undefined;
}

function parseVirtualProfilesFromEnv(): AilinVirtualModelProfile[] {
  const raw = process.env.AILIN_VIRTUAL_MODEL_PROFILES;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const profiles: AilinVirtualModelProfile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? normalizeAlias(obj.id) : '';
      if (!id) continue;

      const strategyInput = typeof obj.strategy === 'string' ? obj.strategy.trim().toLowerCase() : undefined;
      const strategy = strategyInput
        ? resolveExecutionStrategy(strategyInput) ??
          (EXECUTION_STRATEGIES.has(strategyInput as ExecutionStrategyName)
            ? (strategyInput as ExecutionStrategyName)
            : undefined)
        : undefined;
      if (strategyInput && !strategy) {
        log.warn({ id, strategy: strategyInput }, 'Ignoring invalid strategy in AILIN_VIRTUAL_MODEL_PROFILES');
      }

      profiles.push({
        id,
        displayName: typeof obj.displayName === 'string' ? obj.displayName : `Ailin ${id}`,
        description:
          typeof obj.description === 'string'
            ? obj.description
            : 'Custom virtual orchestration alias from AILIN_VIRTUAL_MODEL_PROFILES',
        strategy,
        qualityTarget: typeof obj.qualityTarget === 'number' ? obj.qualityTarget : undefined,
        maxCost: typeof obj.maxCost === 'number' ? obj.maxCost : undefined,
        taskType: parseTaskType(obj.taskType),
        constraints: parseRuntimeConstraints(obj.constraints),
        billing: parseBillingProfile(obj.billing),
        endpoints: toStringArray(obj.endpoints).length > 0 ? toStringArray(obj.endpoints) : ['chat_completions', 'responses'],
      });
    }
    return profiles;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ error: message }, 'Failed to parse AILIN_VIRTUAL_MODEL_PROFILES; using defaults only');
    return [];
  }
}

function parseAdditionalAutoAliases(): AilinVirtualModelProfile[] {
  const raw = process.env.AILIN_AUTO_MODEL_ALIASES;
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => normalizeAlias(entry))
    .filter(Boolean)
    .filter((id) => id !== 'auto')
    .map((id) => ({
      id,
      displayName: `Ailin ${id}`,
      description: 'Additional alias for automatic orchestration.',
      strategy: 'auto' as ExecutionStrategyName,
      endpoints: ['chat_completions', 'responses'],
    }));
}

export function getAilinVirtualModelProfiles(): AilinVirtualModelProfile[] {
  const merged = new Map<string, AilinVirtualModelProfile>();
  for (const profile of DEFAULT_PROFILES) {
    merged.set(normalizeAlias(profile.id), profile);
  }
  for (const profile of parseAdditionalAutoAliases()) {
    merged.set(normalizeAlias(profile.id), profile);
  }
  for (const profile of parseVirtualProfilesFromEnv()) {
    merged.set(normalizeAlias(profile.id), profile);
  }
  return Array.from(merged.values());
}

/** The 4 preset strategy names → a concrete execution strategy. Mechanism names pass through. */
const PRESET_STRATEGY_TO_EXECUTION: Record<string, ExecutionStrategyName> = {
  auto: 'auto',
  best: 'quality-multipass',
  fast: 'single',
  economy: 'cost-cascade',
};

function strategyTierToExecution(strategy: string): ExecutionStrategyName {
  return PRESET_STRATEGY_TO_EXECUTION[strategy] ?? resolveExecutionStrategy(strategy) ?? 'auto';
}

export function resolveAilinVirtualModelAlias(
  modelInput?: string,
  rates: TierRateCard = STATIC_RATE_CARD,
): ResolvedAilinVirtualModel | null {
  if (typeof modelInput !== 'string') return null;
  const normalized = normalizeAlias(modelInput);
  if (!normalized || normalized === 'auto') return null;

  // 1) Legacy preset aliases (ailin-best, ailin-consensus, …) keep their EXACT behaviour.
  const match = getAilinVirtualModelProfiles().find((profile) => normalizeAlias(profile.id) === normalized);
  if (match) {
    return {
      alias: match.id,
      model: 'auto',
      strategy: match.strategy,
      qualityTarget: match.qualityTarget,
      maxCost: match.maxCost,
      taskType: match.taskType,
      constraints: match.constraints,
      billing: match.billing,
    };
  }

  // 2) New `<strategy>:<tier>` composite (e.g. `consensus:large`). Only execution-ready
  //    cells route; shadow-wired strategies resolve to null until they ship distinctly.
  const st = resolveStrategyTier(modelInput, rates);
  if (st && st.executionReady) {
    return {
      alias: `${st.strategy}:${st.tier}`,
      model: 'auto',
      strategy: strategyTierToExecution(st.strategy),
      qualityTarget: st.qualityTarget,
      tier: st.tier,
      tierRate: { inputPer1MUsd: st.inputPer1MUsd, outputPer1MUsd: st.outputPer1MUsd },
    };
  }

  return null;
}
