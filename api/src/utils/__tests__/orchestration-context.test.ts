// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for `utils/orchestration-context.ts`.
 *
 * The helper is the canonical seam between Fastify route handlers and the
 * orchestration layer's `OrchestrationContext`. Two fields it must expose
 * cleanly are `semanticQuery` (Caminho-C Q4 — RRF rerank input) and
 * `preferredModelIds` (Caminho-C Q2/Q3 — strategy pin input).
 *
 * If a future route ever bypasses `OrchestrationEngine.execute` and feeds
 * its `userContext` directly into the strategy layer or
 * `DynamicModelSelector`, these helpers are what keep the two fields
 * populated. The regression goal here is to lock:
 *
 *   - The exported API surface (`createOrchestrationContext`,
 *     `enrichContextWithIntent`, `extractSemanticQueryFromMessages`,
 *     `normalizePreferredModel`).
 *   - The semantic-query extractor's parity with the engine's
 *     `extractTaskSummary` (string-grep against the engine source so the
 *     two never silently diverge).
 *   - The pin-normalization contract: `'auto'`, `''`, `ailin-*` aliases,
 *     and non-string inputs all collapse to `undefined`. Real model IDs
 *     pass through unmodified, wrapped in a single-element array.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createOrchestrationContext,
  enrichContextWithIntent,
  extractSemanticQueryFromMessages,
  normalizePreferredModel,
  SEMANTIC_QUERY_MAX_CHARS,
} from '../orchestration-context';
import type { ChatMessage, OrchestrationContext } from '@/types';
import type { FastifyRequest } from 'fastify';

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for FastifyRequest. The helper only reads `id` and
 * a few duck-typed properties from `request.user` / extended fields,
 * so a partial mock is enough.
 */
function mockRequest(overrides: Partial<{
  id: string;
  organizationId: string;
  userId: string;
  user: { userId: string; organizationId: string; roles: string[]; email: string; name: string };
}> = {}): FastifyRequest {
  return {
    id: overrides.id ?? 'test-req-id',
    organizationId: overrides.organizationId,
    userId: overrides.userId,
    user: overrides.user,
  } as unknown as FastifyRequest;
}

// ── extractSemanticQueryFromMessages ──────────────────────────────────

describe('extractSemanticQueryFromMessages', () => {
  it('returns the last user message as a string', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Earlier turn.' },
      { role: 'assistant', content: 'Reply.' },
      { role: 'user', content: 'Latest user query.' },
    ];
    expect(extractSemanticQueryFromMessages(messages)).toBe('Latest user query.');
  });

  it('skips assistant and system messages when picking the latest', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First.' },
      { role: 'assistant', content: 'Mid response.' },
      { role: 'system', content: 'Tool result.' },
    ];
    // No user message after index 0, so we get index 0.
    expect(extractSemanticQueryFromMessages(messages)).toBe('First.');
  });

  it('handles multimodal content arrays by concatenating text parts', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image:' },
          { type: 'image', image_url: { url: 'data:image/png;base64,...' } } as never,
          { type: 'text', text: 'in detail.' },
        ],
      },
    ];
    expect(extractSemanticQueryFromMessages(messages)).toBe('Describe this image: in detail.');
  });

  it('caps output at SEMANTIC_QUERY_MAX_CHARS by default', () => {
    const longText = 'x'.repeat(SEMANTIC_QUERY_MAX_CHARS + 50);
    const messages: ChatMessage[] = [{ role: 'user', content: longText }];
    const result = extractSemanticQueryFromMessages(messages);
    expect(result).toBeDefined();
    expect(result!.length).toBe(SEMANTIC_QUERY_MAX_CHARS);
  });

  it('honors a custom maxChars cap', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'abcdefghij' }];
    expect(extractSemanticQueryFromMessages(messages, 4)).toBe('abcd');
  });

  it('returns undefined for an empty messages array', () => {
    expect(extractSemanticQueryFromMessages([])).toBeUndefined();
  });

  it('returns undefined when no user-role messages exist', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Only system.' },
      { role: 'assistant', content: 'Only assistant.' },
    ];
    expect(extractSemanticQueryFromMessages(messages)).toBeUndefined();
  });

  it('returns undefined when the only user message is whitespace', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '   \n\t  ' }];
    expect(extractSemanticQueryFromMessages(messages)).toBeUndefined();
  });

  it('returns undefined when messages is undefined', () => {
    expect(extractSemanticQueryFromMessages(undefined)).toBeUndefined();
  });

  it('mirrors the engine extractTaskSummary contract (parity grep)', () => {
    // Lock the parity: if the engine changes the cap or the role-filter
    // direction, this test fails so the helper gets updated in lockstep.
    const enginePath = join(
      __dirname,
      '..',
      '..',
      'core',
      'orchestration',
      'orchestration-engine.ts',
    );
    const src = readFileSync(enginePath, 'utf-8');
    // The engine walks backwards (`for (let i = ...; i >= 0; i--)`) for
    // the last user message and slices to 200 chars.
    expect(src).toMatch(/for\s*\(\s*let\s+i\s*=\s*request\.messages\.length\s*-\s*1\s*;\s*i\s*>=\s*0\s*;\s*i--\s*\)/);
    expect(src).toMatch(/\.slice\(\s*0\s*,\s*200\s*\)/);
    // And our cap matches.
    expect(SEMANTIC_QUERY_MAX_CHARS).toBe(200);
  });
});

// ── normalizePreferredModel ─────────────────────────────────────────────

describe('normalizePreferredModel', () => {
  it('wraps a real model id in a single-element array', () => {
    expect(normalizePreferredModel('claude-sonnet-4-5')).toEqual(['claude-sonnet-4-5']);
  });

  it('preserves case in the model id', () => {
    expect(normalizePreferredModel('Claude-Sonnet-4-5')).toEqual(['Claude-Sonnet-4-5']);
  });

  it('returns undefined for "auto"', () => {
    expect(normalizePreferredModel('auto')).toBeUndefined();
    expect(normalizePreferredModel('Auto')).toBeUndefined();
    expect(normalizePreferredModel('AUTO')).toBeUndefined();
  });

  it('returns undefined for ailin-* virtual aliases', () => {
    expect(normalizePreferredModel('ailin-fast')).toBeUndefined();
    expect(normalizePreferredModel('ailin-ultra')).toBeUndefined();
    expect(normalizePreferredModel('Ailin-Fast')).toBeUndefined();
  });

  it('returns undefined for empty / whitespace strings', () => {
    expect(normalizePreferredModel('')).toBeUndefined();
    expect(normalizePreferredModel('   ')).toBeUndefined();
    expect(normalizePreferredModel('\t\n')).toBeUndefined();
  });

  it('returns undefined for non-string inputs', () => {
    expect(normalizePreferredModel(undefined)).toBeUndefined();
    expect(normalizePreferredModel(null)).toBeUndefined();
    expect(normalizePreferredModel(123)).toBeUndefined();
    expect(normalizePreferredModel({})).toBeUndefined();
    expect(normalizePreferredModel([])).toBeUndefined();
  });

  it('trims surrounding whitespace from valid ids', () => {
    expect(normalizePreferredModel('  gpt-5  ')).toEqual(['gpt-5']);
  });
});

// ── createOrchestrationContext ─────────────────────────────────────────

describe('createOrchestrationContext', () => {
  it('returns the minimal scaffold without options', () => {
    const ctx = createOrchestrationContext(mockRequest({ id: 'r1' }));
    expect(ctx).toMatchObject({
      organizationId: '',
      userId: '',
      requestId: 'r1',
      models: [],
      taskType: 'general',
      contextSize: 0,
    });
    expect(ctx.semanticQuery).toBeUndefined();
    expect(ctx.preferredModelIds).toBeUndefined();
  });

  it('reads org/user from extendedRequest fields when set directly', () => {
    const ctx = createOrchestrationContext(
      mockRequest({ organizationId: 'org-1', userId: 'user-1' }),
    );
    expect(ctx.organizationId).toBe('org-1');
    expect(ctx.userId).toBe('user-1');
  });

  it('falls back to request.user when top-level fields are missing', () => {
    const ctx = createOrchestrationContext(
      mockRequest({
        user: {
          userId: 'u-from-token',
          organizationId: 'o-from-token',
          roles: ['admin'],
          email: 'a@b',
          name: 'Test',
        },
      }),
    );
    expect(ctx.organizationId).toBe('o-from-token');
    expect(ctx.userId).toBe('u-from-token');
  });

  it('forwards semanticQuery when provided', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      semanticQuery: 'translate this prompt',
    });
    expect(ctx.semanticQuery).toBe('translate this prompt');
  });

  it('forwards preferredModelIds when provided', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      preferredModelIds: ['gpt-5', 'claude-opus'],
    });
    expect(ctx.preferredModelIds).toEqual(['gpt-5', 'claude-opus']);
  });

  it('strips empty / whitespace ids from preferredModelIds', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      preferredModelIds: ['gpt-5', '', '   ', 'claude-opus'],
    });
    expect(ctx.preferredModelIds).toEqual(['gpt-5', 'claude-opus']);
  });

  it('omits semanticQuery when given empty / whitespace input', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      semanticQuery: '   \t\n  ',
    });
    expect(ctx.semanticQuery).toBeUndefined();
  });

  it('omits preferredModelIds when the array is empty after filtering', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      preferredModelIds: ['', '   '],
    });
    expect(ctx.preferredModelIds).toBeUndefined();
  });

  it('honors taskType and contextSize options', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      taskType: 'reasoning',
      contextSize: 4096,
    });
    expect(ctx.taskType).toBe('reasoning');
    expect(ctx.contextSize).toBe(4096);
  });
});

// ── enrichContextWithIntent ─────────────────────────────────────────────

describe('enrichContextWithIntent', () => {
  const baseContext: OrchestrationContext = {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'r-1',
    models: [],
    taskType: 'general',
    contextSize: 0,
  };

  it('returns the same context reference when intent is empty', () => {
    expect(enrichContextWithIntent(baseContext, {})).toBe(baseContext);
  });

  it('returns a new context object with semanticQuery layered on', () => {
    const enriched = enrichContextWithIntent(baseContext, {
      semanticQuery: 'classify this',
    });
    expect(enriched).not.toBe(baseContext);
    expect(enriched.semanticQuery).toBe('classify this');
    // Originals preserved.
    expect(enriched.organizationId).toBe('org-1');
    expect(enriched.userId).toBe('user-1');
  });

  it('returns a new context object with preferredModelIds layered on', () => {
    const enriched = enrichContextWithIntent(baseContext, {
      preferredModelIds: ['gpt-5'],
    });
    expect(enriched.preferredModelIds).toEqual(['gpt-5']);
  });

  it('layers both fields atomically', () => {
    const enriched = enrichContextWithIntent(baseContext, {
      semanticQuery: 'classify',
      preferredModelIds: ['claude-opus'],
    });
    expect(enriched.semanticQuery).toBe('classify');
    expect(enriched.preferredModelIds).toEqual(['claude-opus']);
  });

  it('does not mutate the input context', () => {
    enrichContextWithIntent(baseContext, {
      semanticQuery: 'x',
      preferredModelIds: ['y'],
    });
    expect(baseContext.semanticQuery).toBeUndefined();
    expect(baseContext.preferredModelIds).toBeUndefined();
  });

  it('skips empty / whitespace semanticQuery without changing context', () => {
    expect(enrichContextWithIntent(baseContext, { semanticQuery: '   ' })).toBe(baseContext);
  });

  it('skips fully-empty preferredModelIds without changing context', () => {
    expect(enrichContextWithIntent(baseContext, { preferredModelIds: [] })).toBe(baseContext);
    expect(enrichContextWithIntent(baseContext, { preferredModelIds: ['', '  '] })).toBe(baseContext);
  });
});

// ── End-to-end wiring assertion ─────────────────────────────────────────

describe('helper wiring contract (route → context)', () => {
  it('a route can build a fully-enriched context from a chat-shaped body', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system' as const, content: 'You are a translator.' },
        { role: 'user' as const, content: 'Translate "hello" to Portuguese.' },
      ],
    };

    const ctx = createOrchestrationContext(mockRequest({ id: 'route-1' }), {
      taskType: 'general',
      contextSize: JSON.stringify(body.messages).length,
      semanticQuery: extractSemanticQueryFromMessages(body.messages),
      preferredModelIds: normalizePreferredModel(body.model),
    });

    expect(ctx.requestId).toBe('route-1');
    expect(ctx.semanticQuery).toBe('Translate "hello" to Portuguese.');
    expect(ctx.preferredModelIds).toEqual(['claude-sonnet-4-5']);
  });

  it('a route with model="auto" produces no preferredModelIds', () => {
    const body = {
      model: 'auto',
      messages: [{ role: 'user' as const, content: 'Anything.' }],
    };
    const ctx = createOrchestrationContext(mockRequest(), {
      semanticQuery: extractSemanticQueryFromMessages(body.messages),
      preferredModelIds: normalizePreferredModel(body.model),
    });
    expect(ctx.preferredModelIds).toBeUndefined();
    expect(ctx.semanticQuery).toBe('Anything.');
  });

  it('an ailin-* alias never leaks into preferredModelIds', () => {
    const ctx = createOrchestrationContext(mockRequest(), {
      preferredModelIds: normalizePreferredModel('ailin-ultra'),
    });
    expect(ctx.preferredModelIds).toBeUndefined();
  });
});
