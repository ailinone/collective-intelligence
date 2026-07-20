// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Trace builder helpers. Re-exports the trace type so consumers don't
 * have to dig into model-role-types for it.
 */
import type {
  FilterStage,
  ModelRoleSelectionTrace,
  StrategyModelRole,
} from './model-role-types';

export type { FilterStage, ModelRoleSelectionTrace } from './model-role-types';

export interface TraceBuilderOpts {
  readonly role: StrategyModelRole;
  readonly strategyName: string;
  readonly inputCandidateCount: number;
  readonly registrySourceStatus: ModelRoleSelectionTrace['registrySourceStatus'];
  readonly providerHealthStatus: ModelRoleSelectionTrace['providerHealthStatus'];
  readonly pricingStatus: ModelRoleSelectionTrace['pricingStatus'];
  readonly semanticSearchStatus: ModelRoleSelectionTrace['semanticSearchStatus'];
}

export class TraceBuilder {
  private readonly stageCounts: Partial<Record<FilterStage, number>> = {};
  private readonly criteria: string[] = [];
  private readonly notes: string[] = [];
  private finalSelectedCount = 0;
  private selectionSource: ModelRoleSelectionTrace['selectionSource'] = 'dynamic';

  constructor(private readonly opts: TraceBuilderOpts) {}

  recordStage(stage: FilterStage, remaining: number): void {
    this.stageCounts[stage] = remaining;
  }

  addCriterion(criterion: string): void {
    this.criteria.push(criterion);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  setSelectionSource(source: ModelRoleSelectionTrace['selectionSource']): void {
    this.selectionSource = source;
  }

  setFinalSelected(count: number): void {
    this.finalSelectedCount = count;
  }

  build(): ModelRoleSelectionTrace {
    const stages: Record<FilterStage, number> = {
      capability: this.stageCounts.capability ?? this.opts.inputCandidateCount,
      health: this.stageCounts.health ?? this.opts.inputCandidateCount,
      credits: this.stageCounts.credits ?? this.opts.inputCandidateCount,
      rate_limit: this.stageCounts.rate_limit ?? this.opts.inputCandidateCount,
      cost: this.stageCounts.cost ?? this.opts.inputCandidateCount,
      context_window: this.stageCounts.context_window ?? this.opts.inputCandidateCount,
      locality: this.stageCounts.locality ?? this.opts.inputCandidateCount,
      exclusions: this.stageCounts.exclusions ?? this.opts.inputCandidateCount,
      role_specific: this.stageCounts.role_specific ?? this.opts.inputCandidateCount,
    };
    return {
      role: this.opts.role,
      strategyName: this.opts.strategyName,
      inputCandidateCount: this.opts.inputCandidateCount,
      stageCounts: stages,
      finalSelectedCount: this.finalSelectedCount,
      selectionSource: this.selectionSource,
      semanticSearchStatus: this.opts.semanticSearchStatus,
      registrySourceStatus: this.opts.registrySourceStatus,
      providerHealthStatus: this.opts.providerHealthStatus,
      pricingStatus: this.opts.pricingStatus,
      hardcodedModelUsed: false,
      criteria: [...this.criteria],
      notes: [...this.notes],
    };
  }
}
