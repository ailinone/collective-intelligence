// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ fallback system prompt (R4).
 *
 * Every prompt in the orchestration pipeline has a canonical source: the SOTA catalog
 * for collective strategies, the execution-system-prompt builder for single-stage, and
 * the triage `task_context` for task augmentation. When none of these paths produce a
 * prompt, the request previously fell back to `"You are a helpful assistant."` — a
 * generic, non-Ailin¹ string that silently degraded collective behavior to single and
 * masked configuration or wiring bugs because operators had no signal that a fallback
 * had been activated.
 *
 * This helper replaces that behavior with:
 * 1. A minimal but Ailin¹-aware fallback string so downstream models still know which
 *    system they are running under.
 * 2. An explicit `[fallback]` marker in the prompt text so the degradation is visible
 *    in traces and observability.
 * 3. A structured `logger.warn` with the call site so fallback activations are
 *    countable across the fleet and a spike of activations surfaces immediately.
 */

import { logger } from '@/utils/logger';
import { incrementPromptMetric, PROMPT_METRIC_NAMES } from './prompt-metrics';

const log = logger.child({ component: 'ailin-fallback-prompt' });

/**
 * Canonical fallback content. Short, specific, and labelled as fallback so the
 * degradation is never silent — operators can grep for this marker in production logs.
 */
export const AILIN_FALLBACK_PROMPT =
  'You are an Ailin¹ Collective Intelligence model. ' +
  'Provide thorough, expert-level, evidence-based analysis. ' +
  '[fallback: strategy-specific system prompt unavailable]';

/**
 * Returns the Ailin¹ fallback prompt and logs a structured warning identifying the
 * call site. Use this at every point where a strategy, builder, or adapter would
 * otherwise emit `"You are a helpful assistant."` or equivalent.
 *
 * @param where Stable identifier of the call site (e.g. `'base-strategy.reasoning'`,
 *              `'openai-realtime-client.session-init'`). Must be stable across calls
 *              so operators can count fallback activations per site.
 */
export function buildAilinFallbackPrompt(where: string): string {
  incrementPromptMetric(PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS, { where });
  log.warn({ where }, 'Ailin¹ fallback system prompt activated — strategy prompt unavailable');
  return AILIN_FALLBACK_PROMPT;
}
