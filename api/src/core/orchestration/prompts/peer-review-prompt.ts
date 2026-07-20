// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Peer-review (social facilitation) prepend — controllable harness.
 *
 * Background: the orchestration engine has historically prepended a short
 * "your response will be reviewed by expert peers" system message to every
 * request routed through a collective strategy (social-facilitation prompting).
 * The Lote 1 audit flagged this as partially redundant with the catalog prompts
 * (most collective catalog prompts already state that responses are peer-reviewed),
 * but removing it outright is higher risk because the social-facilitation signal
 * may still be load-bearing for some strategies or for models that skim the
 * catalog framing.
 *
 * This module prepares the ground for a future A/B benchmark WITHOUT changing
 * default runtime behavior:
 *
 *   - The canonical prepend string lives here as a single constant.
 *   - The decision of whether to prepend is centralized in `shouldInjectPeerReviewPrompt`
 *     (mode-based + legacy env var + already-present guard), replacing inline logic
 *     scattered in `orchestration-engine.ts`.
 *   - The injection itself is a single helper (`injectPeerReviewPrompt`) so there
 *     is exactly one mutation site and one test surface.
 *   - Mode is resolved via env var `AILIN_PEER_REVIEW_MODE` with legacy fallback
 *     to the pre-existing `DISABLE_FACILITATION_PROMPT` flag. The default is `on`
 *     — identical to Lote 1 behavior.
 *
 * To run the future A/B experiment, the benchmark harness sets
 * `AILIN_PEER_REVIEW_MODE=off` for the B arm and `on` for the A arm, measures
 * quality/cost deltas per strategy, and decides whether the prepend can be
 * retired. No code change required to run the experiment.
 */

import type { ChatRequest } from '@/types';
import { incrementPromptMetric, PROMPT_METRIC_NAMES } from './prompt-metrics';

/**
 * Canonical peer-review prepend string. Short, social-facilitation-aligned,
 * and explicitly labelled so test/search tooling can find all uses.
 */
export const PEER_REVIEW_SYSTEM_PROMPT =
  'Your response will be reviewed and evaluated by expert peers. ' +
  'Provide your most thorough, accurate, and well-reasoned work.';

/**
 * Modes for the peer-review prepend.
 *
 * - `'on'`: always inject when the caller asks for it (current Lote 1 behavior).
 * - `'off'`: never inject; used by the B arm of the future A/B benchmark.
 * - `'auto'`: reserved for a future heuristic that skips injection when the
 *   resolved strategy's catalog prompt already mentions peer review. Currently
 *   treated as `'on'` so default behavior is unchanged; flipping it to real
 *   auto-detection is deferred to a later lote.
 */
export type PeerReviewMode = 'on' | 'off' | 'auto';

const LEGACY_DISABLE_ENV = 'DISABLE_FACILITATION_PROMPT';
const MODE_ENV = 'AILIN_PEER_REVIEW_MODE';

/**
 * Resolve the effective peer-review mode from environment.
 *
 * Precedence:
 *   1. `AILIN_PEER_REVIEW_MODE=on|off|auto` (preferred, new).
 *   2. Legacy `DISABLE_FACILITATION_PROMPT=true` → mapped to `off`.
 *   3. Default: `on` (preserves Lote 1 runtime behavior).
 */
export function resolvePeerReviewMode(env: NodeJS.ProcessEnv = process.env): PeerReviewMode {
  const raw = env[MODE_ENV]?.toLowerCase();
  if (raw === 'on' || raw === 'off' || raw === 'auto') return raw;
  if (env[LEGACY_DISABLE_ENV] === 'true') return 'off';
  return 'on';
}

/**
 * Arguments accepted by the decision function. Kept as a plain object so new
 * signals can be added later without breaking callers.
 */
export interface ShouldInjectPeerReviewArgs {
  /** Whether the resolved top-level strategy is collective (minModels > 1). */
  isCollectiveStrategy: boolean;
  /** The current ChatRequest — inspected to avoid double-injection. */
  request: ChatRequest;
  /** Optional env override for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide whether the peer-review prepend should be injected.
 *
 * Returns `true` only when ALL of the following hold:
 *   - the strategy is collective;
 *   - the effective mode is `on` or `auto`;
 *   - the request does not already contain a system message mentioning "peer".
 *
 * The "peer" substring guard mirrors the legacy inline check at the old
 * orchestration-engine site. It is intentionally loose because catalog prompts
 * use different wording ("peer-reviewed", "expert peers", "reviewed by peers");
 * a stricter check would miss catalog prompts that already cover the signal.
 */
export function shouldInjectPeerReviewPrompt(args: ShouldInjectPeerReviewArgs): boolean {
  if (!args.isCollectiveStrategy) {
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'single-strategy' });
    return false;
  }

  const mode = resolvePeerReviewMode(args.env);
  if (mode === 'off') {
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'mode-off' });
    return false;
  }

  const alreadyMentionsPeer = args.request.messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('peer'),
  );
  if (alreadyMentionsPeer) {
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'already-present' });
    return false;
  }
  return true;
}

/**
 * Inject the peer-review system message at the head of `request.messages`.
 * Returns a NEW ChatRequest — the caller is responsible for using the returned
 * reference (the engine does this already). Callers should gate this with
 * `shouldInjectPeerReviewPrompt` to avoid double-injection.
 */
export function injectPeerReviewPrompt(request: ChatRequest): ChatRequest {
  incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS);
  return {
    ...request,
    messages: [
      { role: 'system', content: PEER_REVIEW_SYSTEM_PROMPT },
      ...request.messages,
    ],
  };
}
