// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profile-trace.ts — MVP 6A
 *
 * Pure types for safe trace serialisation.
 *
 * INVARIANT: the trace MUST NOT carry `text`, `prompt`, raw `messages`,
 * `userMessage`, `context`, or `rawContext`. Builder enforces.
 */

import type {
  Complexity,
  PrivacyMode,
  RiskLevel,
  StrategyHint,
  TaskProfile,
  TaskProfilerInput,
  TaskType,
} from './task-profile-types';

export interface TaskProfileTrace {
  readonly requestId: string;
  readonly taskType: TaskType;
  readonly complexity: Complexity;
  readonly riskLevel: RiskLevel;
  readonly privacyMode: PrivacyMode;
  readonly requiredCapabilities: readonly string[];
  readonly strategyHints: readonly StrategyHint[];
  readonly reasons: readonly string[];
}

/**
 * Pure helper: builds the safe trace from a profile + categorical
 * inputs. Strips `text` and other free-form fields that could carry
 * PII.
 */
export function buildTaskProfileTrace(
  input: TaskProfilerInput,
  profile: TaskProfile,
  reasons: readonly string[],
): TaskProfileTrace {
  return {
    requestId: input.requestId,
    taskType: profile.taskType,
    complexity: profile.complexity,
    riskLevel: profile.riskLevel,
    privacyMode: profile.privacyMode,
    requiredCapabilities: profile.requiredCapabilities,
    strategyHints: profile.strategyHints,
    reasons: Object.freeze([...reasons]),
  };
}
