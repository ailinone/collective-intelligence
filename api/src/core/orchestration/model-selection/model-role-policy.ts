// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Per-role policies for model selection.
 *
 * A policy declares what a role *needs* without naming any specific
 * model. Resolvers use these to filter candidates and rank them. The
 * fact that some real models in 2026 happen to satisfy these criteria
 * is incidental — the policy is about capability shape, not identity.
 *
 * Each role has:
 *   - `requiredCapabilities` — hard filter (no model lacking these can
 *      be chosen)
 *   - `preferredCapabilities` — soft signal (boosts rank)
 *   - `contextWindowMin` — minimum useful context window
 *   - `defaultCount` — how many to pick when caller doesn't specify
 *   - `requireProviderDiversity` — true → pick from distinct providers
 *   - `preferIndependence` — true → de-rank candidates overlapping
 *      with already-chosen roles (passed via excludeModelIds)
 *   - `preferJsonOutput` — true → de-rank candidates missing structured
 *      output capability
 *   - `preferInstructionFollowing` — true → boost candidates with
 *      instruction-following capability
 *   - `preferLowCost` — true → cheaper wins on ties (judge / fallback)
 */
import type { StrategyModelRole } from './model-role-types';

export interface RolePolicy {
  readonly role: StrategyModelRole;
  readonly description: string;
  readonly requiredCapabilities: readonly string[];
  readonly preferredCapabilities: readonly string[];
  readonly contextWindowMin: number;
  readonly defaultCount: number;
  readonly requireProviderDiversity: boolean;
  readonly preferIndependence: boolean;
  readonly preferJsonOutput: boolean;
  readonly preferInstructionFollowing: boolean;
  readonly preferLowCost: boolean;
  /** Multiplier for `model.performance.quality` in ranking. */
  readonly qualityWeight: number;
  /** Multiplier for `1 - normalisedCost`. */
  readonly costWeight: number;
  /** Multiplier for `model.performance.reliability`. */
  readonly reliabilityWeight: number;
  /** Boost applied per matched preferredCapability. */
  readonly preferredCapBoost: number;
}

const baseChat: readonly string[] = ['chat'];
const codeFocus: readonly string[] = ['code_generation', 'coding', 'code_review'];
const reasoningFocus: readonly string[] = ['reasoning', 'thinking_mode'];
const structuredFocus: readonly string[] = ['json_mode', 'function_calling', 'tool_use'];

export const POLICIES: Record<StrategyModelRole, RolePolicy> = {
  participant: {
    role: 'participant',
    description:
      'Independent voter. Must be chat-capable, healthy, with credits, and within budget. Diversity of provider/family is preferred.',
    requiredCapabilities: baseChat,
    preferredCapabilities: [...reasoningFocus, 'instruction_following'],
    contextWindowMin: 8000,
    defaultCount: 3,
    requireProviderDiversity: true,
    preferIndependence: false,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.0,
    costWeight: 0.2,
    reliabilityWeight: 0.6,
    preferredCapBoost: 0.05,
  },
  leader: {
    role: 'leader',
    description:
      'Coordinator. Strong instruction following + long context to receive participant outputs.',
    requiredCapabilities: baseChat,
    preferredCapabilities: ['instruction_following', 'reasoning'],
    contextWindowMin: 32000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.2,
    costWeight: 0.1,
    reliabilityWeight: 0.7,
    preferredCapBoost: 0.07,
  },
  synthesizer: {
    role: 'synthesizer',
    description:
      'Synthesises participant outputs into a unified response. Needs long context and strong instruction following.',
    requiredCapabilities: baseChat,
    preferredCapabilities: ['instruction_following', 'reasoning', 'long_context'],
    contextWindowMin: 32000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.2,
    costWeight: 0.1,
    reliabilityWeight: 0.7,
    preferredCapBoost: 0.07,
  },
  observer: {
    role: 'observer',
    description:
      'Watches the collective without voting. Light footprint, low cost preferred.',
    requiredCapabilities: baseChat,
    preferredCapabilities: ['reasoning'],
    contextWindowMin: 16000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: true,
    qualityWeight: 0.7,
    costWeight: 0.7,
    reliabilityWeight: 0.5,
    preferredCapBoost: 0.04,
  },
  critic: {
    role: 'critic',
    description:
      'Adversarial evaluator. Looks for inconsistencies. Diversity from participants helps.',
    requiredCapabilities: baseChat,
    preferredCapabilities: [...reasoningFocus, 'code_review'],
    contextWindowMin: 16000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.0,
    costWeight: 0.2,
    reliabilityWeight: 0.6,
    preferredCapBoost: 0.06,
  },
  reviewer: {
    role: 'reviewer',
    description:
      'Reviews candidate outputs against requirements. Similar to critic but less adversarial.',
    requiredCapabilities: baseChat,
    preferredCapabilities: ['reasoning', 'code_review'],
    contextWindowMin: 16000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.0,
    costWeight: 0.2,
    reliabilityWeight: 0.6,
    preferredCapBoost: 0.06,
  },
  judge: {
    role: 'judge',
    description:
      'Rubric-based evaluator that scores outputs. Requires JSON output capability. Low cost preferred. Independent from participants/synthesizer.',
    requiredCapabilities: baseChat,
    preferredCapabilities: [...structuredFocus, 'reasoning', 'instruction_following'],
    contextWindowMin: 16000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: true,
    preferJsonOutput: true,
    preferInstructionFollowing: true,
    preferLowCost: true,
    qualityWeight: 0.9,
    costWeight: 0.6,
    reliabilityWeight: 0.7,
    preferredCapBoost: 0.08,
  },
  fallback_single: {
    role: 'fallback_single',
    description:
      'Best single-model baseline. Highest quality within budget. May overlap with participants.',
    requiredCapabilities: baseChat,
    preferredCapabilities: ['instruction_following', 'reasoning'],
    contextWindowMin: 8000,
    defaultCount: 1,
    requireProviderDiversity: false,
    preferIndependence: false,
    preferJsonOutput: false,
    preferInstructionFollowing: true,
    preferLowCost: false,
    qualityWeight: 1.3,
    costWeight: 0.2,
    reliabilityWeight: 0.7,
    preferredCapBoost: 0.05,
  },
};

/**
 * Augment policy capabilities with task-profile hints. E.g., if the
 * task is code-generation, add `code_generation` as preferred for the
 * participant role; if expected format is `json`, add `json_mode` as
 * preferred for the judge role.
 */
export function augmentPolicyForTask(
  policy: RolePolicy,
  task: { taskType?: string; expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text' },
): RolePolicy {
  const extra: string[] = [];
  const tt = (task.taskType ?? '').toLowerCase();
  if (tt.indexOf('code') !== -1) extra.push(...codeFocus);
  if (task.expectedFormat === 'code') extra.push(...codeFocus);
  if (task.expectedFormat === 'json') extra.push(...structuredFocus);
  if (task.expectedFormat === 'reasoning' || tt.indexOf('analysis') !== -1) {
    extra.push(...reasoningFocus);
  }
  if (extra.length === 0) return policy;
  const merged = Array.from(new Set([...policy.preferredCapabilities, ...extra]));
  return { ...policy, preferredCapabilities: merged };
}
