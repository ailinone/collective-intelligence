// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared context-size estimator (LOTE AW, 2026-09).
 *
 * Consolidates FIVE previously-independent, drifted copies of this exact
 * calculation that all fed the hard context-window gate
 * (`dynamic-model-selector.ts` SQL filter + `calculateCapabilityFit`) with
 * wrong numbers:
 *
 *   - `single-model-strategy.ts` / `parallel-strategy.ts` /
 *     `collaborative-strategy.ts` / `sequential-strategy.ts`: four
 *     byte-identical private `estimateContextSize(request)` methods that
 *     (a) never counted `request.tools` at all, and (b) used
 *     `msg.content?.toString()`, which mis-serializes structured/array
 *     content (tool-result blocks, multi-part vision content) into the
 *     literal string `"[object Object]"` instead of its real size.
 *   - `triage-service.ts`: an independently-broken FIFTH copy that didn't
 *     even divide by 4 — it returned a raw character count and called it a
 *     token estimate.
 *   - `orchestration-engine.ts`'s own copy already used `JSON.stringify`
 *     correctly for non-string content, but likewise never counted
 *     `request.tools`.
 *
 * For a long tool-calling-heavy agentic session, undercounting `tools` (a
 * function/tool-schema block that can itself run into the thousands of
 * tokens) let the hard gate pass a model whose REAL context window the
 * actual prompt did not fit — a provider context-length error or silent
 * truncation downstream. This is also the load-bearing prerequisite for
 * long-context compaction (`context-compaction-service.ts`): the 0.75
 * compaction trigger is only trustworthy once the number it's measured
 * against is accurate.
 *
 * Context-window preflight audit (2026-09): a SIXTH gap in this same family
 * — `msg.tool_calls` / `msg.function_call` (an assistant turn's tool-call
 * argument payloads, which routinely carry full file contents/diffs/command
 * output in an agentic tool-calling conversation) were never counted either,
 * only `msg.content`. Fixed by `toolCallsSizeChars()` below, same
 * JSON.stringify treatment as `request.tools`.
 *
 * Every call site should import `estimateContextSize` from here instead of
 * maintaining its own copy.
 */

import type { ChatMessage, ChatRequest } from '@/types';

/**
 * Serialize one message's `content` field for size estimation.
 * String content is used as-is; anything else (structured/array content —
 * tool-result blocks, multi-part vision content) is JSON.stringify'd so its
 * real size is counted, instead of `.toString()`'s `"[object Object]"`.
 */
function contentSizeChars(content: ChatMessage['content']): number {
  if (typeof content === 'string') {
    return content.length;
  }
  try {
    return JSON.stringify(content ?? '').length;
  } catch {
    return 0;
  }
}

/**
 * Serialize a message's `tool_calls` / `function_call` fields for size
 * estimation (context-window preflight audit, 2026-09).
 *
 * Undercount found alongside the pinned-model context-window gate: an
 * assistant turn's tool-call argument payloads — which routinely carry full
 * file contents, diffs, or command output in an agentic tool-calling
 * conversation (exactly the traffic shape IDE integrations like Cursor/
 * Cline/Zed/Claude Code/Goose/Opencode produce) — were entirely invisible to
 * this estimator. Only `msg.content` was ever measured, so a long
 * tool-calling turn's REAL size was undercounted, sometimes drastically.
 * Mirrors how `request.tools` (the schema definitions) are already counted
 * below: JSON.stringify the whole field when present.
 */
function toolCallsSizeChars(msg: ChatMessage): number {
  let chars = 0;
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    try {
      chars += JSON.stringify(msg.tool_calls).length;
    } catch {
      /* ignore — best-effort size estimate */
    }
  }
  if (msg.function_call) {
    try {
      chars += JSON.stringify(msg.function_call).length;
    } catch {
      /* ignore — best-effort size estimate */
    }
  }
  return chars;
}

/**
 * Estimate context size in tokens (rough ~4 chars/token heuristic — the same
 * ratio every prior copy used) for a request. Counts message content AND
 * `request.tools` (the function/tool-schema definitions block), since a
 * tool-heavy agentic request can carry thousands of schema tokens that were
 * previously invisible to every hard-gate check.
 *
 * Accepts either a full `ChatRequest` (preferred — lets `tools` be counted)
 * or a bare `ChatMessage[]` for call sites that only ever had the messages
 * array on hand (tools are simply not counted in that form, matching those
 * call sites' pre-existing scope).
 *
 * Rounds UP (`Math.ceil`), matching the majority (4 of 5) of the prior
 * per-strategy copies — the conservative direction for a hard-gate input:
 * overestimating risks an unnecessary compaction/delegation, underestimating
 * risks a provider context-length error.
 */
export function estimateContextSize(messagesOrRequest: ChatMessage[] | ChatRequest): number {
  const isBareMessages = Array.isArray(messagesOrRequest);
  const messages: ChatMessage[] = isBareMessages
    ? messagesOrRequest
    : (messagesOrRequest.messages ?? []);
  const tools = isBareMessages ? undefined : messagesOrRequest.tools;

  const messagesChars = messages.reduce(
    (sum, msg) => sum + contentSizeChars(msg.content) + toolCallsSizeChars(msg),
    0
  );
  const toolsChars = tools && tools.length > 0 ? JSON.stringify(tools).length : 0;

  return Math.ceil((messagesChars + toolsChars) / 4);
}
