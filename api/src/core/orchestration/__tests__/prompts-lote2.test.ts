// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Lote 2 of the system-prompts audit refactor.
 *
 * Covers:
 *   R5 — fixed word minimums removed from the catalog and replaced with an
 *         adaptive-depth directive.
 *   R6 — capability section in the execution builder emits a tag list, not
 *         verbose descriptions.
 *   R7 — quality footer removed from the execution builder.
 *   R8 — parallelCompetitor / massiveParallelExpert / diversityRespondent
 *         consolidated via `buildIndependentRespondentPrompt(mode)`.
 *   R9 — moderation prompt centralized into a single constant consumed by
 *         all provider adapters.
 *   Peer-review harness — social-facilitation prepend is centralized
 *         behind a helper, default behavior preserved, and controllable via env.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

import {
  PROMPTS,
  buildIndependentRespondentPrompt,
  type IndependentRespondentMode,
} from '../prompts/sota-system-prompts';
import { buildExecutionSystemPrompt } from '../execution-system-prompt';
import {
  PEER_REVIEW_SYSTEM_PROMPT,
  resolvePeerReviewMode,
  shouldInjectPeerReviewPrompt,
  injectPeerReviewPrompt,
} from '../prompts/peer-review-prompt';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '@/providers/base/moderation-prompt';
import type { ChatRequest, OrchestrationContext, Model } from '@/types';

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello Ailin' }],
    ...overrides,
  } as ChatRequest;
}

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-req',
    models: [] as Model[],
    taskType: 'analysis',
    contextSize: 0,
    ...overrides,
  } as OrchestrationContext;
}

describe('R5 — catalog prompts no longer hardcode word minimums', () => {
  // The prompts audited in Lote 1 that used to carry fixed word minimums.
  // Listing them here acts as a regression guard: if any of these strings
  // reintroduces a "XXX+ words" or "minimum N words" directive, the test fails.
  const AUDITED_PROMPTS: readonly string[] = [
    PROMPTS.debateOpening('model-A'),
    PROMPTS.consensusVoter(),
    PROMPTS.blindRespondent(),
    PROMPTS.expertSpecialist('security', 'auditor'),
    PROMPTS.warRoomSpecialist('audit the auth flow'),
    PROMPTS.stigmergicDrafter(),
  ];

  it('contain no "NNN+ words" or "at least NNN words" directives', () => {
    for (const prompt of AUDITED_PROMPTS) {
      expect(prompt).not.toMatch(/\b\d{2,}\+?\s+words\b/i);
      expect(prompt).not.toMatch(/at least\s+\d{2,}\s+words/i);
      expect(prompt).not.toMatch(/minimum\s+\d/i);
    }
  });

  it('still exhibit the adaptive-depth directive for rigor', () => {
    // At least one of the audited prompts must carry the shared directive.
    // (Not all — devilsAdvocate never had a word floor, and some prompts have
    // role-specific wording — but the ones we touched in R5 all do.)
    const withDirective = AUDITED_PROMPTS.filter((p) =>
      /match depth to task complexity/i.test(p),
    );
    expect(withDirective.length).toBeGreaterThanOrEqual(5);
  });
});

describe('R6 — execution-system-prompt capability section is a tag list, not prose', () => {
  it('emits a single-line "Available capabilities: ..." tag list when caps are present', () => {
    const out = buildExecutionSystemPrompt(
      makeRequest(),
      makeContext({ requiredCapabilities: ['web_search', 'vision'] }),
    );
    expect(out).toContain('Available capabilities: web_search, vision');
  });

  it('does not emit verbose description sentences like the prior capMap', () => {
    const out = buildExecutionSystemPrompt(
      makeRequest(),
      makeContext({ requiredCapabilities: ['web_search', 'vision', 'code_generation'] }),
    );
    // Representative strings from the prior capMap — none should appear.
    expect(out).not.toContain('Search the web for current information');
    expect(out).not.toContain('Analyze and understand images provided in the conversation');
    expect(out).not.toContain('Write, analyze, and debug code');
  });

  it('omits the capability section entirely when no known caps are provided', () => {
    const out = buildExecutionSystemPrompt(
      makeRequest(),
      makeContext({ requiredCapabilities: [] }),
    );
    expect(out).not.toContain('Available capabilities');
  });

  it('filters out capability tags unknown to the catalog', () => {
    const out = buildExecutionSystemPrompt(
      makeRequest(),
      makeContext({
        requiredCapabilities: ['web_search', 'unknown_fake_cap' as unknown as never],
      }),
    );
    expect(out).toContain('Available capabilities: web_search');
    expect(out).not.toContain('unknown_fake_cap');
  });
});

describe('R7 — execution-system-prompt no longer emits the quality footer', () => {
  it('does not include the legacy "Provide thorough, accurate..." footer', () => {
    const out = buildExecutionSystemPrompt(makeRequest(), makeContext());
    expect(out).not.toContain('Provide thorough, accurate, and well-structured responses');
  });

  it('does not include the "explain what is needed clearly" capability-fallback line', () => {
    const out = buildExecutionSystemPrompt(makeRequest(), makeContext());
    expect(out).not.toContain('explain what is needed clearly');
  });
});

describe('R8 — independent-respondent prompts are consolidated via shared factory', () => {
  const MODES: IndependentRespondentMode[] = ['competitive', 'ensemble', 'diversity'];

  it('buildIndependentRespondentPrompt produces distinct prompts per mode hint', () => {
    const prompts = MODES.map((m) => buildIndependentRespondentPrompt(m));
    expect(new Set(prompts).size).toBe(MODES.length);
  });

  it('all three public aliases are driven by the shared factory (shared base)', () => {
    const shared = 'You are one of multiple expert models in the Ailin¹ Collective Intelligence system';
    expect(PROMPTS.parallelCompetitor).toContain(shared);
    expect(PROMPTS.massiveParallelExpert).toContain(shared);
    expect(PROMPTS.diversityRespondent).toContain(shared);
  });

  it('each mode preserves its operational nuance (one hint sentence)', () => {
    expect(PROMPTS.parallelCompetitor).toContain('race for QUALITY');
    expect(PROMPTS.massiveParallelExpert).toContain('large ensemble');
    expect(PROMPTS.diversityRespondent).toContain('architecture and training data differ');
  });

  it('R8 consolidation preserves the adaptive-depth directive (no regression vs R5)', () => {
    for (const mode of MODES) {
      const prompt = buildIndependentRespondentPrompt(mode);
      expect(prompt).toMatch(/match depth to task complexity/i);
    }
  });
});

describe('R9 — moderation prompt is centralized', () => {
  it('all six provider adapters import the shared constant instead of a literal string', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const adapterPaths = [
      'src/providers/xai/xai-adapter.ts',
      'src/providers/vertex-ai/vertex-ai-adapter.ts',
      'src/providers/deepseek/deepseek-adapter.ts',
      'src/providers/google/google-adapter.ts',
      'src/providers/openrouter/openrouter-adapter.ts',
      'src/providers/cohere/cohere-adapter.ts',
    ];
    for (const rel of adapterPaths) {
      const abs = path.join(repoRoot, rel);
      const src = await fs.readFile(abs, 'utf8');
      expect(src, `${rel} should import MODERATION_ANALYZER_SYSTEM_PROMPT`).toContain(
        'MODERATION_ANALYZER_SYSTEM_PROMPT',
      );
      expect(
        src.includes("'You are a content moderation analyzer. Respond only with valid JSON.'"),
        `${rel} must not contain the legacy literal moderation prompt`,
      ).toBe(false);
    }
  });

  it('exposes the canonical content expected by the moderation flow', () => {
    expect(MODERATION_ANALYZER_SYSTEM_PROMPT).toBe(
      'You are a content moderation analyzer. Respond only with valid JSON.',
    );
  });
});

describe('Peer-review harness — social-facilitation prepend is centralized and controllable', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AILIN_PEER_REVIEW_MODE;
    delete process.env.DISABLE_FACILITATION_PROMPT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves to "on" by default (Lote 1 runtime default preserved)', () => {
    expect(resolvePeerReviewMode({})).toBe('on');
  });

  it('honors AILIN_PEER_REVIEW_MODE=off as the new opt-out', () => {
    expect(resolvePeerReviewMode({ AILIN_PEER_REVIEW_MODE: 'off' })).toBe('off');
  });

  it('honors legacy DISABLE_FACILITATION_PROMPT=true as a fallback', () => {
    expect(resolvePeerReviewMode({ DISABLE_FACILITATION_PROMPT: 'true' })).toBe('off');
  });

  it('new env var wins over legacy env var when both are set', () => {
    expect(
      resolvePeerReviewMode({
        AILIN_PEER_REVIEW_MODE: 'on',
        DISABLE_FACILITATION_PROMPT: 'true',
      }),
    ).toBe('on');
  });

  it('shouldInjectPeerReviewPrompt is false for non-collective strategies', () => {
    expect(
      shouldInjectPeerReviewPrompt({
        isCollectiveStrategy: false,
        request: makeRequest(),
      }),
    ).toBe(false);
  });

  it('shouldInjectPeerReviewPrompt is true for collective strategies by default', () => {
    expect(
      shouldInjectPeerReviewPrompt({
        isCollectiveStrategy: true,
        request: makeRequest(),
        env: {},
      }),
    ).toBe(true);
  });

  it('shouldInjectPeerReviewPrompt is false when env sets mode to off', () => {
    expect(
      shouldInjectPeerReviewPrompt({
        isCollectiveStrategy: true,
        request: makeRequest(),
        env: { AILIN_PEER_REVIEW_MODE: 'off' },
      }),
    ).toBe(false);
  });

  it('shouldInjectPeerReviewPrompt is false when a prior system msg already mentions "peer"', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'Already peer-reviewed framing.' },
        { role: 'user', content: 'go' },
      ] as ChatRequest['messages'],
    });
    expect(
      shouldInjectPeerReviewPrompt({
        isCollectiveStrategy: true,
        request: req,
        env: {},
      }),
    ).toBe(false);
  });

  it('injectPeerReviewPrompt prepends the canonical string at index 0', () => {
    const req = makeRequest();
    const next = injectPeerReviewPrompt(req);
    expect(next.messages[0]).toEqual({
      role: 'system',
      content: PEER_REVIEW_SYSTEM_PROMPT,
    });
    // Original request is not mutated.
    expect(req.messages[0].role).toBe('user');
  });

  it('canonical prepend string mentions "peer" so the idempotency guard works', () => {
    expect(PEER_REVIEW_SYSTEM_PROMPT.toLowerCase()).toContain('peer');
  });
});
