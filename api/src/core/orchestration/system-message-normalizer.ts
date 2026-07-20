// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Collapse multiple `system` messages into a single leading system message.
 *
 * WHY: collective strategies stack several system messages onto one request —
 * the strategy's role prompt, the peer-review directive, and the client's own
 * system message. But provider adapters disagree on how to read more than one:
 *
 *   - Anthropic: `messages.find(m => m.role === 'system')` → FIRST only
 *     (silently drops peer-review AND the client's system message)
 *   - Google:    iterates, later assignment wins → LAST only
 *     (silently drops the strategy's role prompt)
 *   - OpenAI:    passes all through (additive)
 *   - Bedrock:   concatenates
 *
 * So the SAME request meant different things depending on which provider a
 * model happened to resolve to — a real confound for a single-vs-collective
 * benchmark and a correctness bug in production. Normalizing to exactly one
 * system message (concatenated IN ORDER) makes every adapter converge on the
 * same, complete instruction set. It is safe-or-better everywhere: providers
 * that already concatenated are unaffected; providers that dropped messages now
 * receive the full context they were meant to get.
 *
 * The merged system message is placed at the position of the FIRST system
 * message; non-system messages keep their order and content untouched.
 */
import type { ChatMessage, MessageContent } from '@/types';

/** Extract the plain text of a system message (string or content-part array). */
function systemText(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && part.type === 'text' ? part.text : ''))
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * Return `messages` with all system messages merged into a single leading one.
 * Returns the original array reference when there are 0 or 1 system messages
 * (no allocation, no behavior change).
 */
export function normalizeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages)) return messages;

  let systemCount = 0;
  for (const m of messages) if (m.role === 'system') systemCount++;
  if (systemCount <= 1) return messages;

  const mergedText = messages
    .filter((m) => m.role === 'system')
    .map((m) => systemText(m.content).trim())
    .filter((t) => t.length > 0)
    .join('\n\n');

  const out: ChatMessage[] = [];
  let placedMerged = false;
  for (const m of messages) {
    if (m.role === 'system') {
      if (!placedMerged) {
        out.push({ role: 'system', content: mergedText });
        placedMerged = true;
      }
      // subsequent system messages are folded into the merged one — drop them
      continue;
    }
    out.push(m);
  }
  return out;
}
