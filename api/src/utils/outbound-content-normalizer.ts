// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Outbound content normalizer — strips reasoning traces that providers inline
 * into `message.content`.
 *
 * Reasoning-capable providers leak their trace INTO the answer by design, not by
 * accident: Groq's `reasoning_format: 'raw'` means "reasoning inlined in
 * message.content with <think> tags", and MiniMax M-series emit a <think>
 * preamble by default. DeepSeek-R1 and QwQ chat templates go further and
 * PRE-FILL the opening tag into the prompt, so the completion carries the
 * reasoning text plus an UNPAIRED closing tag and no opener at all.
 *
 * `BaseStrategy.extractReasoning()` is the only stripper in the gateway, and it
 * is reachable solely from `executeModelWithReasoning()` behind
 * `ailin_constraints.enable_reasoning === true`. Ordinary requests never set
 * that, and most strategies call `executeModel()` directly, so in production the
 * trace reaches the user verbatim.
 *
 * This module is the outbound normalizer the response path has never had — the
 * same structural gap that let `toolCalls` (instead of `tool_calls`) and an
 * unserializable `content: null` both ship to production.
 *
 * Deliberately NOT installed on `OrchestrationEngine.execute()`. The
 * extended-thinking and ultra-thinking routes MANDATE <thinking> tags in their
 * system prompt and parse them back off `result.finalResponse`; a blanket hook
 * there would silently gut both.
 */

import type { ChatResponse } from '@/types';

export const REASONING_TAGS = ['think', 'thinking', 'reasoning'] as const;

/** Bounds rule 1 so a pathological input cannot spin. */
const MAX_LEADING_BLOCKS = 4;

const LEADING_OPENER = /^\s*<(think|thinking|reasoning)\s*>/i;
const ANY_CLOSER = /<\/(think|thinking|reasoning)\s*>/i;

/**
 * Whether `index` sits inside a fenced code block, judged by fence parity.
 * A leaked tag never arrives fenced; a legitimate answer *about* reasoning tags
 * routinely does.
 */
function insideFence(text: string, index: number): boolean {
  let fences = 0;
  let at = text.indexOf('```');
  while (at !== -1 && at < index) {
    fences += 1;
    at = text.indexOf('```', at + 3);
  }
  return fences % 2 === 1;
}

/**
 * Removes a leaked reasoning trace from the START of `raw`.
 *
 * Anchored at position 0 on purpose. A global replace — the shape used by
 * `extractReasoning` — would eat a tag inside a fenced code block in a genuine
 * answer. Every leak measured in production is at position 0.
 */
export function stripLeakedReasoning(raw: string): { text: string; changed: boolean } {
  try {
    // 99% path: no tag can be present without a '<'.
    if (raw.indexOf('<') === -1) return { text: raw, changed: false };

    let text = raw;
    let changed = false;

    // Rule 1 — leading paired block(s).
    for (let i = 0; i < MAX_LEADING_BLOCKS; i += 1) {
      const opener = LEADING_OPENER.exec(text);
      if (!opener) break;
      const tag = opener[1].toLowerCase();
      const closer = new RegExp(`</${tag}\\s*>`, 'i').exec(text);
      // An opener with no closer is the truncated-mid-think case: the block is
      // the entire generation, so removing it would leave nothing. Stop here.
      if (!closer) break;
      text = text.slice(closer.index + closer[0].length);
      changed = true;
    }

    // Rule 2 — unpaired CLOSING tag (pre-filled-opener providers). Only if
    // rule 1 found nothing, and only when no opener of any family precedes it.
    if (!changed) {
      const closer = ANY_CLOSER.exec(text);
      if (
        closer &&
        !/<(think|thinking|reasoning)\s*>/i.test(text.slice(0, closer.index)) &&
        !insideFence(text, closer.index) &&
        text[closer.index - 1] !== '`'
      ) {
        text = text.slice(closer.index + closer[0].length);
        changed = true;
      }
    }

    if (!changed) return { text: raw, changed: false };

    text = text.trimStart();

    // A visible leak is recoverable; a silent blank 200 is not. If stripping
    // consumed everything, keep the original.
    if (text.length === 0) return { text: raw, changed: false };

    return { text, changed: true };
  } catch {
    // A normalizer that throws turns a good answer into a 500 — precisely the
    // failure mode of the `content: null` incident.
    return { text: raw, changed: false };
  }
}

/** True for progress/observer/clarification frames, which carry no answer. */
function isMetadataOnlyFrame(response: ChatResponse): boolean {
  const meta = (response as { ailin_metadata?: unknown }).ailin_metadata;
  return typeof meta === 'object' && meta !== null && 'type' in meta;
}

/**
 * Applies `stripLeakedReasoning` to every string `content` in a response.
 *
 * Non-mutating: returns the ORIGINAL object reference when nothing changed, so
 * callers that persist the raw payload for audit keep the leaked text while the
 * delivered payload is clean. Idempotent, because it is installed at more than
 * one layer.
 */
export function normalizeOutboundResponse<T extends ChatResponse>(response: T): T {
  try {
    if (!response || !Array.isArray(response.choices)) return response;
    if (isMetadataOnlyFrame(response)) return response;

    let anyChanged = false;
    const choices = response.choices.map((choice) => {
      const message = (choice as { message?: { content?: unknown; tool_calls?: unknown[] } })
        .message;
      // Only string content is touched. `null` (an assistant message carrying
      // only tool_calls), `undefined`, and multimodal arrays pass through by
      // reference, untouched.
      if (!message || typeof message.content !== 'string') return choice;
      // A tool-call message's content is null or a short preamble — not worth
      // touching, and the tool path was expensive to repair.
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return choice;

      const { text, changed } = stripLeakedReasoning(message.content);
      if (!changed) return choice;
      anyChanged = true;
      return { ...choice, message: { ...message, content: text } };
    });

    if (!anyChanged) return response;
    return { ...response, choices } as T;
  } catch {
    return response;
  }
}
