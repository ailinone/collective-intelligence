// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Simple-query fast path (Workstream G, 2026-08-17).
 *
 * Cheap DETERMINISTIC triage for trivially-short single-turn messages ("oi",
 * "hello", "obrigado"): when a request carries no attachments, no conversation
 * history, no tools, no RAG config and no web search, several pieces of heavy
 * per-request machinery are provably unused and are skipped:
 *
 *   - semantic-memory context build (embedding round-trip + pgvector search)
 *     — for an anonymous, history-less greeting there are no prior episodes
 *     worth retrieving, and the lookup is a serial network+DB cost on the
 *     first-token path.
 *
 * NOT skipped (not provably unused): auth/quota, pool build, strategy
 * resolution, prompt assembly, provider execution. The response itself is
 * NEVER special-cased — the provider still generates it.
 *
 * Deliberately conservative: any tool, media part, multi-message history,
 * rag_config, or a message longer than TRIVIAL_MESSAGE_MAX_CHARS opts the
 * request back onto the full path. Deterministic string-shape checks only —
 * no content inspection, no model calls.
 */

import type { ChatRequest } from '@/types';

const DEFAULT_TRIVIAL_MAX_CHARS = 64;

function trivialMaxChars(): number {
  const raw = Number(process.env.TRIVIAL_MESSAGE_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRIVIAL_MAX_CHARS;
}

/**
 * True when the request is a trivially-short single-turn message that cannot
 * benefit from memory/RAG/tool machinery. See module doc for the exact gate.
 */
export function isTrivialSingleTurn(request: ChatRequest): boolean {
  // Any tooling/extensions present → full path.
  if (Array.isArray(request.tools) && request.tools.length > 0) return false;
  if (request.tool_choice && request.tool_choice !== 'none') return false;
  if (request.webSearch) return false;
  const ragConfig = (request as { rag_config?: unknown }).rag_config;
  if (ragConfig && typeof ragConfig === 'object') return false;

  const messages = Array.isArray(request.messages) ? request.messages : [];
  // Single turn: at most one system preamble + exactly one user message, and
  // no assistant/tool/function turns (those are history by definition).
  if (messages.length === 0 || messages.length > 2) return false;
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length !== 1) return false;
  if (messages.some((m) => m.role === 'assistant' || m.role === 'tool' || m.role === 'function')) {
    return false;
  }

  const userMessage = userMessages[0];
  // Structured content (image parts, etc.) → full path. Only a plain short
  // string qualifies.
  if (typeof userMessage.content !== 'string') return false;
  if (userMessage.tool_calls && userMessage.tool_calls.length > 0) return false;
  if (userMessage.tool_results && userMessage.tool_results.length > 0) return false;

  return userMessage.content.trim().length <= trivialMaxChars();
}
