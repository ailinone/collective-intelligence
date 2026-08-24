// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Behavioral guardrails coverage (2026-08-20 incident follow-up).
 *
 * The execution system prompt previously had identity/capability/task sections
 * but ZERO conduct directives — an anonymous-chat visitor received a slur in a
 * model response with the prompt active. These tests pin the conduct floor:
 * it must be present, early (positional weight), echoed at the end, and must
 * not displace the language directive from its terminal position.
 */
import { describe, expect, it } from 'vitest';
import { buildExecutionSystemPrompt } from '@/core/orchestration/execution-system-prompt';
import {
  BEHAVIORAL_GUARDRAILS_DIRECTIVE,
  BEHAVIORAL_GUARDRAILS_ECHO,
} from '@/core/orchestration/prompts/behavioral-guardrails';
import type { ChatRequest, OrchestrationContext } from '@/types';

function buildContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-1',
    models: [],
    ...overrides,
  } as OrchestrationContext;
}

function buildRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'ailin-economy',
    messages: [{ role: 'user', content: 'oi' }],
    ...overrides,
  } as ChatRequest;
}

describe('execution system prompt — behavioral guardrails', () => {
  it('includes the full conduct directive when no system message exists', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext());
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_DIRECTIVE);
  });

  it('places the conduct directive EARLY — before the language directive and after identity', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext()) ?? '';
    const conductIdx = prompt.indexOf('CONDUCT —');
    const identityIdx = prompt.indexOf('You are Ailin¹');
    const languageIdx = prompt.indexOf('LANGUAGE —');
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(conductIdx).toBeGreaterThan(identityIdx);
    expect(conductIdx).toBeLessThan(languageIdx);
  });

  it('echoes the conduct floor at the end (small-context positional reinforcement)', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext());
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_ECHO);
    // The echo must be near the end — after the midpoint of the prompt.
    const echoIdx = prompt?.indexOf(BEHAVIORAL_GUARDRAILS_ECHO) ?? -1;
    expect(echoIdx).toBeGreaterThan((prompt?.length ?? 0) / 2);
  });

  it('keeps the language directive as the LAST section (guardrails do not displace it)', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext()) ?? '';
    const languageIdx = prompt.indexOf('LANGUAGE —');
    const echoIdx = prompt.indexOf(BEHAVIORAL_GUARDRAILS_ECHO);
    expect(languageIdx).toBeGreaterThan(echoIdx);
  });

  it('does not inject any prompt when the caller supplied a system message (existing contract preserved)', () => {
    const request = buildRequest({
      messages: [
        { role: 'system', content: 'custom system' },
        { role: 'user', content: 'oi' },
      ],
    });
    expect(buildExecutionSystemPrompt(request, buildContext())).toBeNull();
  });

  it('directive enumerates the concrete prohibitions that failed in the incident', () => {
    // The 2026-08-20 incident was a slur under provocation. The directive must
    // name insults/slurs/degrading language explicitly AND give the model an
    // explicit provocation path — prohibition-only wording is what a
    // weakly-aligned model pattern-matches past.
    for (const term of ['insult', 'slur', 'degrading', 'provoked']) {
      expect(BEHAVIORAL_GUARDRAILS_DIRECTIVE.toLowerCase()).toContain(term);
    }
  });
});
