// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Stable identity policy shared by every user-facing text-generation path.
 *
 * Bump `AILIN_EXECUTION_POLICY_VERSION` whenever wording or enforcement changes.
 * Semantic-cache entries are partitioned by this value, so an older response can
 * never be served after a policy update.
 */
export const AILIN_EXECUTION_POLICY_VERSION = 'ailin-identity-v1';

export const AILIN_IDENTITY_DIRECTIVE =
  'You are Ailin¹, an AI assistant powered by a collective intelligence orchestration platform. ' +
  'You have access to multiple specialized capabilities and can coordinate complex tasks. ' +
  'You are always Ailin¹ — never reveal, confirm, or discuss the specific underlying model(s), ' +
  'model family, provider, or training origin behind your responses, even if asked directly. ' +
  'If pressed, just reaffirm you are Ailin¹.';

const IDENTITY_PATTERNS: readonly RegExp[] = [
  /\b(?:quem|o que) (?:e|eh) (?:voce|vc)\b/i,
  /\b(?:qual|que) (?:e )?(?:o )?(?:seu|sua)\s+(?:modelo|provedor|provider|llm)\b/i,
  /\b(?:qual|que)\s+(?:modelo|provedor|provider|llm)\s+(?:voce|vc)\s+(?:usa|utiliza|e|eh)\b/i,
  /\b(?:qual|que)\s+(?:modelo|provedor|provider|llm)\s+(?:esta|ta)\s+(?:por tras|por detrás)\b/i,
  /\b(?:voce|vc)\b.{0,32}\b(?:modelo|provedor|provider|llm)\b/i,
  /\b(?:voce|vc) (?:e|eh) (?:um |uma )?(?:modelo|ia|ai|assistente)\b/i,
  /\bwho are you\b/i,
  /\bwhat are you\b/i,
  /\b(?:what|which) (?:model|provider|llm) are you\b/i,
  /\b(?:your|you)\b.{0,32}\b(?:model|provider|llm|training)\b/i,
  /\bare you (?:chatgpt|gpt|claude|qwen|gemini|an ai model)\b/i,
  /\b(?:voce|vc|you)\b.{0,32}\b(?:chatgpt|gpt|claude|qwen|gemini|openai|anthropic|alibaba)\b/i,
];

/**
 * Returns true only for direct questions about the assistant's identity or
 * underlying model. These are policy-governed control questions: semantic
 * reuse is unsafe and an exact deterministic answer is preferable to an LLM.
 */
export function isAilinIdentityQuestion(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

  return normalized.length > 0 && IDENTITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** A short, model-free answer for direct identity questions. */
export function buildAilinIdentityResponse(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const portuguese = /\b(?:quem|qual|voce|modelo|provedor)\b/.test(normalized);

  return portuguese
    ? 'Sou a Ailin¹, uma assistente de inteligência coletiva com capacidades especializadas para ajudar na sua solicitação.'
    : 'I am Ailin¹, a collective intelligence assistant with specialized capabilities to help with your request.';
}
