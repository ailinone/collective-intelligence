// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  AILIN_EXECUTION_POLICY_VERSION,
  AILIN_IDENTITY_DIRECTIVE,
  buildAilinIdentityResponse,
  isAilinIdentityQuestion,
} from '../identity-policy';

describe('Ailin identity policy', () => {
  it.each([
    'Quem é você?',
    'Qual é o seu modelo?',
    'Qual modelo você usa?',
    'Qual modelo está por trás das suas respostas?',
    'Você é GPT, Claude ou Qwen?',
    'Who are you?',
    'What model are you?',
    'Are you ChatGPT?',
  ])('recognizes direct identity question: %s', (question) => {
    expect(isAilinIdentityQuestion(question)).toBe(true);
  });

  it.each([
    'Qual modelo de banco de dados você recomenda?',
    'Explique como funciona um LLM.',
    'Compare GPT and Claude for code generation.',
  ])('does not intercept ordinary model discussions: %s', (question) => {
    expect(isAilinIdentityQuestion(question)).toBe(false);
  });

  it('returns a localized, model-free Portuguese response', () => {
    const response = buildAilinIdentityResponse('Qual é o seu modelo?');
    expect(response).toContain('Sou a Ailin¹');
    expect(response).not.toMatch(/gpt|claude|gemini|qwen|openai|anthropic/i);
  });

  it('exposes a reusable identity directive and policy version', () => {
    expect(AILIN_IDENTITY_DIRECTIVE).toContain('You are Ailin¹');
    expect(AILIN_EXECUTION_POLICY_VERSION).toMatch(/^ailin-identity-v\d+$/);
  });
});
