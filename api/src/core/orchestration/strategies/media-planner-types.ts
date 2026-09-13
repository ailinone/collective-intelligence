// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-planner-types — shared types + zod schemas for `MediaPlannerStrategy`
 * (LOTE AT, Part 2).
 *
 * Split into its own module (mirrors how Part 1 split
 * `media-deterministic-gate.ts` / `evaluation/media-judge-evaluator.types.ts`
 * out of `media-consensus-strategy.ts`) so the strategy file, the gating
 * heuristic, and the persistence repository can all import the same shapes
 * without a circular dependency.
 *
 * IMPORTANT — Part 1 dependency: this file declares STRUCTURAL, type-only
 * mirrors of `MediaConsensusStrategy`'s real public surface
 * (`feat/media-consensus-strategy-lote-at`,
 * `api/src/core/orchestration/strategies/media-consensus-strategy.ts`).
 * That branch has NOT merged into `main` as of this PR (LOTE AT Part 2 was
 * built against `origin/main` per its task brief), so the real class is
 * never imported here — only its shape is duplicated, verified by reading
 * that branch's source directly. A real `MediaConsensusStrategy` instance
 * already satisfies `MediaConsensusExecutor` structurally (TypeScript
 * structural typing), so once Part 1 merges, wiring a real instance in via
 * `MediaPlannerDeps.mediaConsensusExecutor` requires no changes here.
 */
import { z } from 'zod';
import type { ModelCapability } from '@/types';

// ─── Media constraint set (mirrors Part 1's `MediaConstraintSet`) ─────────

export interface DurationConstraintLike {
  readonly minSec?: number;
  readonly maxSec?: number;
}

export interface ResolutionConstraintLike {
  readonly width?: number;
  readonly height?: number;
  readonly tolerancePct?: number;
}

export interface MediaConstraintSet {
  readonly durationSec?: DurationConstraintLike;
  readonly resolution?: ResolutionConstraintLike;
  readonly requireAudioTrack?: boolean;
}

export function hasAnyConstraint(constraints: MediaConstraintSet | undefined): boolean {
  if (!constraints) return false;
  return Boolean(
    constraints.durationSec || constraints.resolution || constraints.requireAudioTrack
  );
}

// ─── MediaConsensusStrategy structural mirror (Part 1) ────────────────────

/** The two generation capabilities Part 1's `MediaConsensusStrategy` accepts. */
export type MediaGenerationCapability = 'video_generation' | 'image_generation';

export const MEDIA_GENERATION_CAPABILITIES: ReadonlySet<ModelCapability> = new Set<ModelCapability>(
  ['video_generation', 'image_generation']
);

/**
 * Structural mirror of Part 1's `AilinArtifact`-producing result shape.
 * Deliberately loose on `candidates` (`readonly unknown[]`) — the planner
 * never inspects individual candidate records, it just persists whatever
 * Part 1 hands back as part of the audit trail.
 */
export interface MediaConsensusResultLike {
  readonly bestCandidateIndex: number | undefined;
  readonly bestArtifact?: import('@/types').AilinArtifact;
  readonly candidates: readonly unknown[];
  readonly totalJudgeCostUsd: number;
  readonly totalDurationMs: number;
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

export interface MediaConsensusRequestLike {
  readonly capability: MediaGenerationCapability;
  readonly prompt: string;
  readonly stageName: string;
  readonly stageIndex: number;
  readonly videoOptions?: Record<string, unknown>;
  readonly imageOptions?: Record<string, unknown>;
  readonly constraints?: MediaConstraintSet;
  readonly candidateCount?: number;
  readonly userContext: import('@/types').OrchestrationContext;
  readonly requestId: string;
}

/**
 * Structural interface `MediaPlannerStrategy` depends on for generation
 * actions. A real `MediaConsensusStrategy` (Part 1) satisfies this without
 * modification — see the module doc comment above.
 */
export interface MediaConsensusExecutor {
  execute(request: MediaConsensusRequestLike): Promise<MediaConsensusResultLike>;
}

// ─── Planner action schema (zod — structurally enforces unmetConstraints[]) ─

const MediaConstraintSetSchema = z
  .object({
    durationSec: z
      .object({
        minSec: z.number().positive().optional(),
        maxSec: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    resolution: z
      .object({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        tolerancePct: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    requireAudioTrack: z.boolean().optional(),
  })
  .strict();

/** Dispatch a non-generation capability through `executeCapabilityByPlan`. */
const CapabilityCallActionSchema = z.object({
  kind: z.literal('capability_call'),
  capability: z.string().min(1),
  body: z.record(z.unknown()).optional(),
  reasoning: z.string().optional(),
});

/** Dispatch a generation-heavy step through `MediaConsensusStrategy`. */
const GenerateActionSchema = z.object({
  kind: z.literal('generate'),
  capability: z.enum(['video_generation', 'image_generation']),
  prompt: z.string().min(1),
  constraints: MediaConstraintSetSchema.optional(),
  reasoning: z.string().optional(),
});

/**
 * Terminal action. `unmetConstraints` is REQUIRED (an empty array is a
 * valid value meaning "nothing unmet") — per the architecture's explicit
 * decision that this field is structurally enforced, not left to prompt
 * convention. Parsing a final action missing the field throws a ZodError.
 */
const FinalActionSchema = z.object({
  kind: z.literal('final'),
  content: z.string().min(1),
  unmetConstraints: z.array(z.string()),
  reasoning: z.string().optional(),
});

export const PlannerActionSchema = z.discriminatedUnion('kind', [
  CapabilityCallActionSchema,
  GenerateActionSchema,
  FinalActionSchema,
]);

export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type CapabilityCallAction = z.infer<typeof CapabilityCallActionSchema>;
export type GenerateAction = z.infer<typeof GenerateActionSchema>;
export type FinalAction = z.infer<typeof FinalActionSchema>;

// ─── Turn / state / budget (the persisted audit trail — §3.3) ─────────────

export type PlannerTurnOutcome =
  | {
      readonly type: 'capability_result';
      readonly capability: string;
      readonly success: boolean;
      readonly summary: string;
      readonly executionPath?: string;
      readonly fallbackUsed?: boolean;
    }
  | {
      readonly type: 'generation_result';
      readonly capability: MediaGenerationCapability;
      readonly success: boolean;
      readonly summary: string;
      readonly degraded?: boolean;
      readonly hasArtifact: boolean;
    }
  | {
      readonly type: 'native_collapse';
      readonly capability: MediaGenerationCapability;
      readonly modelId: string;
      readonly summary: string;
      readonly hasArtifact: boolean;
    }
  | { readonly type: 'final'; readonly unmetConstraints: readonly string[] }
  | { readonly type: 'error'; readonly message: string };

export interface PlannerTurn {
  readonly turnIndex: number;
  readonly action: PlannerAction | undefined; // undefined when the planner-model call itself failed/parsed invalid
  readonly rawActionParseError?: string;
  readonly outcome: PlannerTurnOutcome;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface PlannerBudget {
  /** Provisional default, needs a real product/cost decision before raising.
   *  Per the LOTE AT architecture (§8): "Planner turn/round cap: default 3."
   *  Configurable via `MEDIA_PLANNER_MAX_TURNS` / `config.mediaPlanner.maxTurns`. */
  readonly maxTurns: number;
  /** Provisional default, needs a real product/cost decision before raising.
   *  Per the LOTE AT architecture (§8): "Cost ceiling: express as a
   *  multiplier of the cost of a single candidate generation call for the
   *  capability in question ... NOT a fixed currency amount." Configurable
   *  via `MEDIA_PLANNER_COST_CEILING_MULTIPLIER` / `config.mediaPlanner.costCeilingMultiplier`. */
  readonly costCeilingMultiplier: number;
}

export type PlannerStopReason = 'final' | 'turn_cap_exhausted' | 'cost_ceiling_exhausted' | 'error';

export interface PlannerState {
  readonly originalRequest: string;
  readonly turns: PlannerTurn[];
  readonly artifacts: import('@/types').AilinArtifact[];
  readonly budget: PlannerBudget;
}
