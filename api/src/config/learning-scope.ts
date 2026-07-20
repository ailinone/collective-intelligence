// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

export interface LearningScopeConfig {
  mode: 'online_optimization_memory_offline_reflection';
  localModelTrainingEnabled: boolean;
  offlineReflectionEnabled: boolean;
  offlineReflectionCron: string;
  optimizeRoutingEnabled: boolean;
  semanticMemoryEnabled: boolean;
  notes: string[];
}

export function getLearningScopeConfig(): LearningScopeConfig {
  const localModelTrainingEnabled = process.env.CI_LOCAL_MODEL_TRAINING_ENABLED === 'true';
  const offlineReflectionEnabled = process.env.CI_REFLECTION_JOB_ENABLED !== 'false';

  return {
    mode: 'online_optimization_memory_offline_reflection',
    localModelTrainingEnabled,
    offlineReflectionEnabled,
    offlineReflectionCron: process.env.CI_REFLECTION_CRON || '15 */6 * * *',
    optimizeRoutingEnabled: true,
    semanticMemoryEnabled: true,
    notes: [
      'ci/api performs online routing optimization and memory-driven improvements.',
      'ci/api does not train or fine-tune proprietary foundation models locally.',
      'provider fine-tuning APIs remain available as external provider-managed capabilities.',
    ],
  };
}

