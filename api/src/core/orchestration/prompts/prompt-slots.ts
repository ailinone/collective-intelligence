// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Typed Prompt Slot system — dynamic task-specific augmentation with
 * catalog-level rigor.
 *
 * The SOTA catalog (`sota-system-prompts.ts`) defines the canonical frame for
 * every strategy role: identity, anti-groupthink, adaptive depth, peer-review.
 * This module provides the structured mechanism for injecting TASK-SPECIFIC
 * intelligence into that frame WITHOUT replacing it.
 *
 * Each slot is:
 *   - Named (grep-able, auditable)
 *   - Typed (Zod-validated, bounded)
 *   - Hashed (SHA-256 for reproducibility verification)
 *   - Token-budgeted (<=500 tokens total)
 *
 * The triage LLM fills slots via semantic analysis of the user request.
 * Strategies pass them into prompt factory functions. The execution-system-prompt
 * builder renders them as the last section of the prompt. Every filled slot is
 * logged with its hash so the exact augmentation is recoverable from traces.
 *
 * Design:
 * - Slots are ALL optional — no slots = current behavior, zero regression.
 * - The schema is `.strip()` so unknown triage-emitted fields are silently
 *   dropped (future triage versions can add new slots without breaking
 *   current validation).
 * - Token budget is conservative (chars/3.5) to avoid context blowup.
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import { logger } from '@/utils/logger';
import { incrementPromptMetric } from './prompt-metrics';

const log = logger.child({ component: 'prompt-slots' });

// ── Zod Schema ──────────────────────────────────────────────────────────────

export const PromptSlotValueSchema = z
  .object({
    /** Specific domain/topic framing. E.g., "SEC Rule 144 compliance for token vesting schedules" */
    domainFraming: z.string().max(200).optional(),
    /** Key dimensions the analysis must cover. */
    criticalDimensions: z.array(z.string().max(100)).max(5).optional(),
    /** Common mistakes or confusions to avoid. */
    pitfallHints: z.array(z.string().max(150)).max(3).optional(),
    /** What kind of evidence to prioritize. */
    evidencePriorities: z.array(z.string().max(150)).max(3).optional(),
    /** What quality dimension matters most for this task. */
    qualityFocus: z.string().max(150).optional(),
    /** Formatting or structural constraints on the output. */
    outputConstraints: z.string().max(150).optional(),
  })
  .strip();

export type PromptSlotValues = z.infer<typeof PromptSlotValueSchema>;

// ── Slot Registry ───────────────────────────────────────────────────────────

export interface PromptSlotDefinition {
  name: keyof PromptSlotValues;
  maxLength: number;
  maxItems?: number;
  purpose: string;
}

/**
 * Registry mapping prompt keys to the slots they accept. Used by the triage
 * prompt to guide the LLM on what to emit per strategy, and by runtime
 * validation to enforce per-slot bounds.
 */
export const SLOT_REGISTRY: Record<string, PromptSlotDefinition[]> = {
  expertSpecialist: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Specific domain/topic framing' },
    { name: 'criticalDimensions', maxLength: 100, maxItems: 5, purpose: 'Key dimensions to analyze' },
    { name: 'pitfallHints', maxLength: 150, maxItems: 3, purpose: 'Common mistakes to avoid' },
    { name: 'evidencePriorities', maxLength: 150, maxItems: 3, purpose: 'Types of evidence to prioritize' },
  ],
  consensusVoter: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Specific domain/topic framing' },
    { name: 'qualityFocus', maxLength: 150, purpose: 'What quality dimension matters most' },
    { name: 'criticalDimensions', maxLength: 100, maxItems: 5, purpose: 'Key dimensions to cover' },
  ],
  debateOpening: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Specific domain/topic framing' },
    { name: 'criticalDimensions', maxLength: 100, maxItems: 5, purpose: 'Key dimensions to debate' },
    { name: 'pitfallHints', maxLength: 150, maxItems: 3, purpose: 'Common pitfalls in this domain' },
  ],
  blindRespondent: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Specific domain/topic framing' },
    { name: 'evidencePriorities', maxLength: 150, maxItems: 3, purpose: 'Evidence types to favor' },
  ],
  warRoomSpecialist: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Sub-task domain framing' },
    { name: 'outputConstraints', maxLength: 150, purpose: 'Output format requirements' },
  ],
  stigmergicDrafter: [
    { name: 'domainFraming', maxLength: 200, purpose: 'Topic framing for the draft' },
    { name: 'qualityFocus', maxLength: 150, purpose: 'What quality matters most' },
  ],
};

// ── Metric Names ────────────────────────────────────────────────────────────

const METRIC_SLOT_INJECTIONS = 'ailin_prompt_slot_injections_total';
const METRIC_SLOT_VALIDATION_FAILURES = 'ailin_prompt_slot_validation_failures_total';
const METRIC_SLOT_TOKEN_BUDGET_EXCEEDED = 'ailin_prompt_slot_token_budget_exceeded_total';

// ── Max token budget for all slots combined ─────────────────────────────────

const MAX_SLOT_TOKENS = 500;

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render filled slots into a structured augmentation block that gets appended
 * to the canonical prompt. Returns an empty string if no slots have content.
 *
 * Output format:
 * ```
 * ## Task-Specific Context
 * Domain: SEC Rule 144 compliance ...
 * Critical dimensions: dim1 | dim2 | dim3
 * Pitfalls to avoid: p1 | p2
 * Evidence priorities: e1 | e2
 * ```
 */
export function renderSlotAugmentation(slots: PromptSlotValues): string {
  const lines: string[] = [];

  if (slots.domainFraming) {
    lines.push(`Domain: ${slots.domainFraming}`);
  }
  if (slots.criticalDimensions?.length) {
    lines.push(`Critical dimensions: ${slots.criticalDimensions.join(' | ')}`);
  }
  if (slots.pitfallHints?.length) {
    lines.push(`Pitfalls to avoid: ${slots.pitfallHints.join(' | ')}`);
  }
  if (slots.evidencePriorities?.length) {
    lines.push(`Evidence priorities: ${slots.evidencePriorities.join(' | ')}`);
  }
  if (slots.qualityFocus) {
    lines.push(`Quality focus: ${slots.qualityFocus}`);
  }
  if (slots.outputConstraints) {
    lines.push(`Output constraints: ${slots.outputConstraints}`);
  }

  if (lines.length === 0) return '';

  return `\n## Task-Specific Context\n${lines.join('\n')}`;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Deterministic SHA-256 hex digest of the slot values. Uses canonical JSON
 * (sorted keys) so identical slot values always produce the same hash,
 * regardless of property insertion order.
 */
export function hashSlotValues(slots: PromptSlotValues): string {
  const canonical = JSON.stringify(slots, Object.keys(slots).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ── Token Budget ────────────────────────────────────────────────────────────

/**
 * Conservative estimate of tokens consumed by the rendered slot augmentation.
 * Uses chars/3.5 as a safe approximation for English text with technical terms.
 */
export function estimateSlotTokens(slots: PromptSlotValues): number {
  const rendered = renderSlotAugmentation(slots);
  return Math.ceil(rendered.length / 3.5);
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate and sanitize slot values from triage output. Returns validated
 * slots if valid and within token budget, or `undefined` if validation fails
 * (fail-closed — the canonical prompt is used as-is).
 */
export function validatePromptSlots(
  raw: unknown,
  where: string,
): PromptSlotValues | undefined {
  const result = PromptSlotValueSchema.safeParse(raw);

  if (!result.success) {
    incrementPromptMetric(METRIC_SLOT_VALIDATION_FAILURES, { where });
    log.warn(
      { where, errors: result.error.issues.map((i) => i.message) },
      'Prompt slot validation failed — dropping slots, using canonical prompt',
    );
    return undefined;
  }

  const slots = result.data;

  // Check for empty object (all fields undefined)
  const hasContent = Object.values(slots).some(
    (v) => v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0),
  );
  if (!hasContent) return undefined;

  // Token budget guard
  const tokens = estimateSlotTokens(slots);
  if (tokens > MAX_SLOT_TOKENS) {
    incrementPromptMetric(METRIC_SLOT_TOKEN_BUDGET_EXCEEDED, { where, tokens });
    log.warn(
      { where, tokens, maxTokens: MAX_SLOT_TOKENS },
      'Prompt slot token budget exceeded — dropping slots',
    );
    return undefined;
  }

  incrementPromptMetric(METRIC_SLOT_INJECTIONS, { where });
  log.debug(
    { where, slotHash: hashSlotValues(slots), tokens },
    'Prompt slots validated and ready for injection',
  );

  return slots;
}

// ── Triage Prompt Documentation ─────────────────────────────────────────────

/**
 * Documentation block for the triage system prompt that teaches the LLM
 * about available slots and when to emit them. Inserted into the triage
 * prompt by `triage-service.ts`.
 */
export const TRIAGE_SLOT_DOCUMENTATION = `## Prompt Slots (preferred over task_context):
When you have task-specific intelligence, emit structured \`prompt_slots\` instead
of (or in addition to) the blob \`task_context\`. Available slots:

- \`domainFraming\` (<=200 chars): The specific domain/topic to frame analysis around.
  Example: "SEC Rule 144 compliance for token vesting schedules"
- \`criticalDimensions\` (<=5 items, each <=100 chars): Key dimensions the analysis must cover.
  Example: ["cliff period legality", "lock-up enforcement", "Form 144 filing requirements"]
- \`pitfallHints\` (<=3 items, each <=150 chars): Common mistakes or confusions to avoid.
  Example: ["Don't confuse Rule 144 with Rule 144A (institutional resale exemption)"]
- \`evidencePriorities\` (<=3 items, each <=150 chars): What kind of evidence to prioritize.
  Example: ["cite specific SEC release numbers"]
- \`qualityFocus\` (<=150 chars): What quality dimension matters most for this task.
- \`outputConstraints\` (<=150 chars): Formatting or structural constraints on the output.

Emit prompt_slots when you have SPECIFIC, ACTIONABLE intelligence about the task.
Omit entirely (do not emit empty objects) when the canonical prompt suffices.`;

/**
 * Documentation block for the augmentation sandbox.
 */
export const TRIAGE_AUGMENTATION_DOCUMENTATION = `## Augmentation Sandbox:
For truly novel tasks where your confidence is LOW (<0.6) and prompt_slots cannot
capture the needed guidance, emit an \`augmentation\` string (<=1200 chars) with
longer free-form guidance. Rules:
- NEVER include "You are..." or role identity text
- NEVER remove or override the adaptive depth directive
- NEVER restate collective-intelligence framing
- Focus on task-specific methodology, evaluation criteria, or domain knowledge`;
