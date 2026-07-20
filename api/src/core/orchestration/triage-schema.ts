// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Zod schemas for the triage LLM output (R12).
 *
 * The triage JSON is produced by an LLM and must be validated strictly before
 * reaching the orchestration pipeline. Prior to R12, parsing was best-effort:
 * individual fields were coerced with ad-hoc `typeof` guards inside
 * `triage-service.ts`, which silently accepted malformed or partially correct
 * payloads and masked prompt-contract drift.
 *
 * These schemas:
 * - formalize the contract between the triage prompt and the orchestration engine
 * - enforce bounds (token limits, quality targets, model count) at parse time
 * - validate the new `task_context` field introduced by R1
 * - reject (not silently coerce) obvious type mismatches so callers can fall back
 *   to heuristic triage via an explicit error path
 *
 * The schemas intentionally keep `strategy` as a loose string: normalization to
 * `ExecutionStrategyName` is performed downstream by `TriagingService.normalizeStrategy`
 * which handles legacy aliases. Keeping the string loose at parse time means a
 * legacy alias does not trigger a validation failure — it is normalized instead.
 */

import { z } from 'zod';
import {
  incrementPromptMetric,
  PROMPT_METRIC_NAMES,
} from './prompts/prompt-metrics';
import { PromptSlotValueSchema } from './prompts/prompt-slots';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'triage-schema' });

const MAX_TOKENS_CEILING = 131_072;
const MAX_MODELS = 9;
const MAX_DELIBERATION_ROUNDS = 5;

/** Maximum length of a `task_context` string. Short by design: task context is meant
 *  to augment, not replace, the canonical strategy prompt. */
export const TASK_CONTEXT_MAX_LENGTH = 400;

/** Maximum length of the augmentation sandbox (activated only when triage confidence is low). */
export const AUGMENTATION_MAX_LENGTH = 1200;

/**
 * Deny patterns for the augmentation sandbox. Any match causes the entire
 * augmentation to be rejected (fail-closed). These patterns prevent the triage
 * LLM from smuggling role-identity overrides or directive removals through the
 * free-form augmentation path.
 */
export const AUGMENTATION_DENY_PATTERNS: readonly RegExp[] = [
  /you are\b/i,                      // role identity override
  /your role\b/i,                    // role identity override
  /ignore (previous|prior|above)/i,  // instruction injection
  /adaptive depth/i,                 // tampering with depth directive
  /never pad/i,                      // tampering with depth directive
  /you must always/i,                // absolute directives that override catalog
  /system:\s/i,                      // embedded system message injection
];

/**
 * Augmentation sandbox schema. Accepts a free-form string up to 1200 chars,
 * validated against deny patterns. Used when triage confidence is low and
 * structured slots cannot capture the needed guidance.
 */
export const AugmentationSandboxSchema = z
  .string()
  .max(AUGMENTATION_MAX_LENGTH)
  .refine(
    (val) => !AUGMENTATION_DENY_PATTERNS.some((p) => p.test(val)),
    { message: 'Augmentation contains prohibited patterns (role identity override, directive tampering, etc.)' },
  )
  .optional();

/**
 * T-Strict (Lote 3): core fields are `.strict()` so unknown keys are rejected
 * with a structured drift signal. Extension-prone sub-objects (stages,
 * model_roles) use `.strip()` which silently drops unknown keys so the
 * triage LLM can evolve without breaking resilience — drops are counted via
 * the `ailin_triage_drift_detected_total` metric so drift is still observable.
 *
 * Rationale: we want loud failure when the TOP-LEVEL contract drifts (that
 * would signal a prompt engineering regression), but graceful degradation
 * when sub-object shapes pick up experimental fields (that is the normal
 * lifecycle of prompt iteration).
 */

/** Role assignment. No per-role system prompt — R1 removed per-role prompt
 *  fabrication from the triage contract. Role differentiation is handled by the
 *  SOTA catalog prompts the strategy selects. Uses `.strip()` so experimental
 *  extension keys are dropped rather than failing the whole parse. */
export const TriageModelRoleSchema = z
  .object({
    role: z.string().min(1).default('primary'),
    count: z.number().int().min(1).max(MAX_MODELS).default(1),
    preferred_capabilities: z.array(z.string()).default([]),
    quality_target: z.number().min(0).max(1).default(0.75),
  })
  .strip();

export const TriageStageSchema = z
  .object({
    name: z.string().min(1).default('main'),
    strategy: z.string().min(1).default('single'),
    model_roles: z.array(TriageModelRoleSchema).default([]),
    required_capabilities: z.array(z.string()).default([]),
    max_tokens: z.number().int().min(1).max(MAX_TOKENS_CEILING).default(2048),
    /** Short task-specific context (<=400 chars). See R1 in the prompts audit. */
    task_context: z.string().max(TASK_CONTEXT_MAX_LENGTH).optional(),
    /** Typed prompt slots for task-specific augmentation (preferred over blob task_context). */
    prompt_slots: PromptSlotValueSchema.optional(),
    /** Free-form augmentation for novel tasks (<=1200 chars, deny-pattern validated). */
    augmentation: AugmentationSandboxSchema,
    /** Literal, self-contained prompt for media-generation stages
     *  (image_generation/video_generation/audio_generation/text_to_speech in
     *  required_capabilities). Absent for text-only stages.
     *  Review fix: TRUNCATE overlong values instead of rejecting — this is
     *  content, not contract; a 2001-char prompt failing the WHOLE parse
     *  would silently drop the entire multimodal plan to heuristic triage. */
    generation_prompt: z.string().transform((s) => s.slice(0, 2000)).optional(),
  })
  .strip();

export const TriageExecutionPlanSchema = z
  .object({
    max_tokens: z.number().int().min(1).max(MAX_TOKENS_CEILING).default(2048),
    quality_target: z.number().min(0).max(1).default(0.75),
    prefer_speed: z.boolean().default(false),
    required_capabilities: z.array(z.string()).default([]),
    estimated_input_tokens: z.number().int().min(0).default(0),
    strategy: z.string().min(1).default('single'),
    model_count: z.number().int().min(1).max(MAX_MODELS).default(1),
    requires_continuation: z.boolean().default(false),
    max_deliberation_rounds: z.number().int().min(0).max(MAX_DELIBERATION_ROUNDS).optional(),
    enable_reasoning: z.boolean().optional(),
    /** Tool names (verbatim from the tool catalog) the triage LLM recommends
     *  enabling for this task. Only applied when the client did not already
     *  supply its own `request.tools`. */
    recommended_tools: z.array(z.string()).optional(),
    stages: z.array(TriageStageSchema).default([]),
  })
  .strip();

/** Top-level triage response. `.strict()` on purpose: unknown top-level keys
 *  are a contract violation worth failing loudly on. */
export const TriageResponseSchema = z
  .object({
    intent: z.string().optional(),
    complexity: z.enum(['low', 'medium', 'high']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
    requires_tools: z.boolean().optional(),
    /** Fast-path signal: `direct_response` for trivial social messages (greetings,
     *  thanks) with no real task — the engine skips multi-stage plan construction
     *  UNLESS the client explicitly set `tools` or `quality_target>=0.9`, which
     *  always win regardless of this field. Defaults to `planned_execution`. */
    route: z.enum(['direct_response', 'planned_execution']).optional().default('planned_execution'),
    recommended_strategy: z.string().optional(),
    recommended_models: z.array(z.string()).optional(),
    estimated_tokens: z.number().int().min(0).optional(),
    execution_plan: TriageExecutionPlanSchema.optional(),
  })
  .strict();

/**
 * Canonical allowlist of top-level keys. Used by `detectTriageDrift` to
 * identify unknown keys BEFORE the strict schema rejects them, so we can log
 * and count drift without blocking legitimate field additions once they are
 * added to this list.
 */
const CANONICAL_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'intent',
  'complexity',
  'priority',
  'confidence',
  'reason',
  'requires_tools',
  'route',
  'recommended_strategy',
  'recommended_models',
  'estimated_tokens',
  'execution_plan',
]);

/**
 * Inspect a parsed-but-not-yet-validated payload for unknown top-level keys.
 * Emits a `triage_drift_detected` metric for each unknown key and logs the
 * set so operators can detect prompt-contract drift without parsing the
 * strict-schema error output.
 *
 * Returns the list of unknown keys (empty array when clean) so callers can
 * decide policy — the parser in `triage-service.ts` uses this signal to
 * detect drift before the strict parser rejects the payload, giving a
 * cleaner error path.
 */
export function detectTriageDrift(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const keys = Object.keys(raw as Record<string, unknown>);
  const unknown = keys.filter((k) => !CANONICAL_TOP_LEVEL_KEYS.has(k));
  if (unknown.length > 0) {
    for (const key of unknown) {
      incrementPromptMetric(PROMPT_METRIC_NAMES.TRIAGE_DRIFT_DETECTED, { key });
    }
    log.warn({ unknownKeys: unknown }, 'Triage response contains unknown top-level keys');
  }
  return unknown;
}

export type TriageResponseRaw = z.infer<typeof TriageResponseSchema>;
export type TriageExecutionPlanRaw = z.infer<typeof TriageExecutionPlanSchema>;
export type TriageStageRaw = z.infer<typeof TriageStageSchema>;
export type TriageModelRoleRaw = z.infer<typeof TriageModelRoleSchema>;
