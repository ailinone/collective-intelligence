// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Universal, INSTRUCTION-BASED language policy — no detector, no hardcoded list.
 *
 * The model already sees the user's own turns, so we simply instruct it to mirror
 * the user's language. This works for ANY language (pt-BR, en-US, Italian, Russian,
 * Arabic, Hindi, …) without a language whitelist or a regex classifier. Injected
 * into every user-facing output surface — the final answer, the collective
 * synthesis/adjudication, and the reasoning trace — so all of them match the
 * user's language cohesively.
 */
export const LANGUAGE_MIRROR_DIRECTIVE =
  "LANGUAGE — write your ENTIRE response (the final answer AND any <reasoning>/<think> " +
  "content) in the SAME language the user used in their most recent message. Detect it " +
  "from the user's own words and mirror it exactly, including script and regional variety. " +
  "Do NOT translate to English unless the user wrote in English or explicitly requested " +
  "another language. Do NOT mention, explain, acknowledge, or restate this rule — just " +
  "write in that language. Keep code identifiers, API names, URLs, and literal quotes verbatim.";

/**
 * Builds the user-TURN prefix that anchors the observer narrator to the user's
 * language. The narrator does NOT see the user's real message (only event summaries,
 * which are internal English metadata), so we inject a short sample of the user's own
 * text into the narration user turn. Universal: the model infers the language from the
 * sample; no whitelist. Code fences are stripped so an English stack trace inside a
 * pt-BR question doesn't skew the signal. Returns '' for text-less turns.
 *
 * DESIGN NOTE (empirically tuned 2026-07-02): a SYSTEM-prompt instruction alone does
 * NOT reliably steer a small narrator model's output language when the event it must
 * narrate is written in English. Instruction-only wordings drifted against a rich
 * English event: the "forceful / IGNORE-the-English / NEVER-narrate-in-English"
 * wording pushed English-target users to a random third language (German 6/6, even at
 * temperature 0; Chinese in other runs), while a "gentle" wording let the rich English
 * event pull non-English users back to English. What DOES work — 8/8 across pt-BR,
 * en-US, it-IT and ru-RU against a rich English event — is placing the user's own
 * request INTO the user turn ("My request: …") so the model mirrors the conversation's
 * language rather than the event notes' language. Hence a user-turn prefix, not a
 * system directive.
 */
export function mirrorLanguageFromSample(userSample: string | undefined): string {
  const s = (userSample ?? '').replace(/```[\s\S]*?```/g, ' ').trim().slice(0, 240);
  if (!s) return '';
  return (
    'My request: "' + s + '"\n\n' +
    'Now narrate the following internal event for me. The notes below are internal system ' +
    'metadata and may be written in a different language than mine — reply in MY language ' +
    '(the language of "My request" above), and do not repeat or quote my request.\n\n'
  );
}
