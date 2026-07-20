// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observer/Narrator SOTA Prompts
 *
 * These prompts guide the local reasoning model to produce insightful,
 * real-time narration of collective intelligence processes.
 */

import { mirrorLanguageFromSample } from '../prompts/language-directive';

export const OBSERVER_PROMPTS = {
  /**
   * System prompt for the Observer/Narrator model.
   * Designed for a small reasoning model (1.5B) with chain-of-thought capability.
   */
  system: (strategyName: string) =>
    `You are the Ailin Process Observer. You narrate, in real time for a user who is watching, a live "${strategyName}" collaborative session where several AI models work together to produce a better answer.

Write your narration in the SAME language as the user's request shown in the next message — mirror the user's language exactly, including script and regional variety. Do NOT repeat or quote the user's request; only narrate the event.

For each event, write ONE short narration (1-2 sentences, 40-80 words) that says what just happened and why it improves the answer's quality. Write the narration text DIRECTLY — do NOT output labels, brackets, headings, quotes, JSON, a reasoning block, or repeat these instructions.

Rules:
- Be concise and insightful — explain WHY it matters for quality; don't just restate the event.
- Highlight patterns when relevant: agreement, divergence, novel perspectives.
- Use accessible language — the user may not know AI/ML terminology.
- NEVER reveal model names or internal architecture — say "the first analyst", not a model id.
- Narrate ONLY what you are told happened; never invent events.`,

  /**
   * Format an observer event into a prompt for narration. When a user-language
   * sample is supplied, it is embedded as a user-turn prefix ("My request: …") so
   * the narrator mirrors the user's language rather than the (English) event notes.
   */
  eventPrompt: (
    event: { type: string; summary?: string; models?: string[]; round?: number; totalRounds?: number; reasoning?: string },
    userSample?: string,
    brief?: boolean,
  ) => {
    const parts: string[] = [`Event type: ${event.type}`];

    if (event.models?.length) {
      parts.push(`Participants: ${event.models.length} analysts`);
    }
    if (event.round !== undefined && event.totalRounds !== undefined) {
      parts.push(`Round: ${event.round}/${event.totalRounds}`);
    }
    if (event.summary) {
      parts.push(`Details: ${event.summary}`);
    }
    if (event.reasoning) {
      parts.push(`Participant reasoning excerpt: ${event.reasoning.substring(0, 500)}`);
    }

    const eventText = parts.join('\n');
    const prefix = mirrorLanguageFromSample(userSample);
    const base = prefix ? `${prefix}${eventText}` : `Narrate this event:\n${eventText}`;
    // For the FIRST narration we want the opening line to appear FAST. We ask for a
    // single short sentence (brevity by INSTRUCTION) so the model finishes the thought
    // quickly and within a small token budget — rather than a blind max_tokens cut that
    // truncates a normal-length narration mid-sentence. Overrides the system prompt's
    // default 1-2 sentence / 40-80 word length for this one event only.
    const briefNote = brief
      ? '\n\nThis is the OPENING line — write ONE short, complete sentence (about 12-20 words). Do not cut off mid-thought.'
      : '';
    return `${base}${briefNote}`;
  },
};
