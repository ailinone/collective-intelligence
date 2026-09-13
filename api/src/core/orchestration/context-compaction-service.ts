// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Long-context compaction (LOTE AW, 2026-09).
 *
 * Trigger: `contextSize / model.contextWindow >= threshold` (default 0.75,
 * env-tunable `CONTEXT_COMPACTION_THRESHOLD`), evaluated in
 * `OrchestrationEngine.buildContext()` against the session-affinity-pinned
 * (or freshly resolved) model's REAL `contextWindow`, using the corrected
 * shared estimator (`context-size-estimator.ts`) — the old broken estimators
 * this replaces never counted `request.tools`, which made the trigger itself
 * untrustworthy for a tool-heavy agentic session.
 *
 * Mechanism: client-side (gateway-side) compaction, not delegation-first.
 * Keep the system message(s) + the most recent `keepTurns` messages
 * verbatim; summarize everything older via one fast/cheap model call and
 * replace it with a single synthetic system message carrying the summary.
 * Delegation to a larger-context same-provider sibling (see
 * `pickDelegationModel` below) is the SECONDARY option, used only when even
 * the kept-verbatim tail + summary still doesn't fit any model.
 *
 * Interaction with session affinity (the key constraint): compaction must
 * NEVER change the stable-prefix hash (`session-affinity-service.ts`'s
 * `deriveStablePrefixHash`, computed from the system message + FIRST user
 * message). Since compaction only ever touches messages OLDER than the
 * kept-verbatim tail, and the caller derives the session key from the
 * ORIGINAL `request.messages` BEFORE calling `compact()`, this holds by
 * construction — no special-case code needed here.
 */

import { logger } from '@/utils/logger';
import { messageContentToText } from '@/services/session-affinity-service.js';
import type { ChatMessage, Model, OrchestrationContext } from '@/types';

const log = logger.child({ component: 'context-compaction' });

function getThreshold(): number {
  const raw = Number(process.env.CONTEXT_COMPACTION_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
}

function getKeepTurns(): number {
  const raw = Number(process.env.CONTEXT_COMPACTION_KEEP_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

export interface CompactionOutcome {
  messages: ChatMessage[];
  compacted: boolean;
  /** Number of older messages folded into the summary (0 when not compacted). */
  collapsedMessageCount: number;
}

/**
 * A cheap-model text summarizer, injected so this service is unit-testable
 * without a real LLM call. The production default (wired in
 * orchestration-engine.ts) resolves a cheap/fast model via the SAME
 * machinery `TriagingService` already uses to pick its own classification
 * model (see `TriagingService.resolveCheapModel`).
 */
export type Summarizer = (text: string, context: OrchestrationContext) => Promise<string>;

export class ContextCompactionService {
  constructor(private readonly summarize?: Summarizer) {}

  /**
   * Whether the given contextSize/contextWindow pair crosses the compaction
   * threshold. `contextWindow` of 0/undefined never triggers — an unknown
   * window is not evidence of overflow.
   */
  shouldCompact(contextSize: number, contextWindow: number | undefined): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    if (!Number.isFinite(contextSize) || contextSize <= 0) return false;
    return contextSize / contextWindow >= getThreshold();
  }

  /**
   * Compact `messages`: system message(s) + the most recent `keepTurns`
   * non-system messages are kept verbatim; anything older is folded into one
   * synthetic system message summarizing it. Fails open (returns the
   * original messages, `compacted: false`) on any summarizer error, and when
   * there is nothing old enough to compact.
   */
  async compact(
    messages: ChatMessage[],
    context: OrchestrationContext
  ): Promise<CompactionOutcome> {
    const keepTurns = getKeepTurns();
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    if (nonSystemMessages.length <= keepTurns) {
      return { messages, compacted: false, collapsedMessageCount: 0 };
    }

    const tail = nonSystemMessages.slice(-keepTurns);
    const head = nonSystemMessages.slice(0, nonSystemMessages.length - keepTurns);
    if (head.length === 0) {
      return { messages, compacted: false, collapsedMessageCount: 0 };
    }

    const headText = head
      .map((m) => `${m.role}: ${messageContentToText(m.content)}`)
      .join('\n');

    let summaryText: string;
    try {
      summaryText = this.summarize
        ? await this.summarize(headText, context)
        : this.heuristicSummary(headText);
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Context compaction summarizer failed — skipping compaction for this turn (fail-open)'
      );
      return { messages, compacted: false, collapsedMessageCount: 0 };
    }

    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[Summary of ${head.length} earlier conversation turns]\n${summaryText}`,
      // LOTE AZ, 2026-09: lets provider adapters (e.g. the Anthropic
      // adapter's `convertMessages()`) keep this out of the stable,
      // cache_control-marked system prefix — this text is regenerated fresh
      // on every request where compaction re-triggers, so folding it into
      // the same cached block as the original system prompt would
      // invalidate the whole cache on every single turn from here on.
      isCompactionSummary: true,
    };

    return {
      messages: [...systemMessages, summaryMessage, ...tail],
      compacted: true,
      collapsedMessageCount: head.length,
    };
  }

  /** Fallback used only when no LLM summarizer is wired (e.g. unit tests, or
   *  the cheap-model resolver itself failing) — a bounded truncation, never
   *  a silent drop of the whole head. */
  private heuristicSummary(headText: string): string {
    const CAP = 2000;
    return headText.length > CAP ? `${headText.slice(0, CAP)}…` : headText;
  }
}

/**
 * Secondary option (§2.2): pick a larger-context sibling to delegate to when
 * compaction alone still doesn't fit. Prefers the SAME provider as
 * `currentModel` first (preserves both the session-affinity pin and any
 * Anthropic prompt-cache warmth), then falls back to any operational model
 * with enough room, ranked by quality (the same ordering direction
 * `executeModelWithRetry`'s fallback-candidate sort already uses, per
 * `base-strategy.ts`).
 */
export function pickDelegationModel(
  pool: Model[],
  currentModel: Pick<Model, 'id' | 'provider'>,
  requiredContextTokens: number
): Model | null {
  const candidates = pool.filter(
    (m) => m.id !== currentModel.id && m.contextWindow >= requiredContextTokens
  );
  if (candidates.length === 0) return null;

  const sameProvider = candidates.filter((m) => m.provider === currentModel.provider);
  const pickFrom = sameProvider.length > 0 ? sameProvider : candidates;

  return (
    [...pickFrom].sort((a, b) => (b.performance?.quality ?? 0) - (a.performance?.quality ?? 0))[0] ??
    null
  );
}

let sharedService: ContextCompactionService | null = null;

export function getContextCompactionService(summarize?: Summarizer): ContextCompactionService {
  if (!sharedService) {
    sharedService = new ContextCompactionService(summarize);
  }
  return sharedService;
}

/** Test-only seam. */
export function __resetContextCompactionServiceForTests(): void {
  sharedService = null;
}
