// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AZ (2026-09) — regression coverage for the exact gap the audit found
 * with ZERO test coverage: `normalizeChatRequest` / `resolveAilinVirtualModelAlias`
 * silently dropping the caller's reasoning-effort intent during alias
 * resolution. `normalizeChatRequest` builds its result via
 * `{ ...chatRequest, model, strategy, messages, tools }` — a valid
 * `reasoning_effort` therefore already survives via the object spread
 * whenever `resolveAilinVirtualModelAlias` rewrites `model`, but that
 * survival was never asserted. This file locks it in, plus the two
 * behaviors `normalizeChatRequest` actively performs on the field: dropping
 * an invalid value, and biasing `quality_target` for `'high'` effort via the
 * SAME `>= 0.9` hook orchestration-engine.ts already treats as "the client
 * wants high quality" (see reasoning-effort.ts's
 * HIGH_EFFORT_QUALITY_TARGET_FLOOR doc comment).
 */
import { describe, expect, it } from 'vitest';
import { normalizeChatRequest } from '../chat-routes';
import type { ChatRequest } from '@/types';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatRequest;
}

describe('normalizeChatRequest — reasoning_effort propagation (LOTE AZ)', () => {
  it('survives untouched when no alias is involved', () => {
    const r = normalizeChatRequest(request({ model: 'openai/gpt-4o-mini', reasoning_effort: 'medium' }));
    expect(r.reasoning_effort).toBe('medium');
  });

  it('survives alias resolution unchanged — the exact gap the audit found (ailin-fast rewrites model)', () => {
    const r = normalizeChatRequest(request({ model: 'ailin-fast', reasoning_effort: 'high' }));
    // Confirm the alias actually resolved (model rewritten to 'auto', strategy set)
    // so this test is exercising the real alias-rewrite path, not a no-op.
    expect(r.model).toBe('auto');
    expect(r.strategy).toBe('single');
    expect(r.reasoning_effort).toBe('high');
  });

  it('survives alias resolution unchanged for a <strategy>:<tier> composite alias', () => {
    const r = normalizeChatRequest(request({ model: 'consensus:large', reasoning_effort: 'low' }));
    expect(r.ailin_tier).toBe('large');
    expect(r.reasoning_effort).toBe('low');
  });

  it('is absent (not fabricated) when the caller never sent it', () => {
    const r = normalizeChatRequest(request({ model: 'ailin-fast' }));
    expect(r.reasoning_effort).toBeUndefined();
  });

  it('drops a garbage value instead of forwarding it to resolveReasoningEffort', () => {
    const r = normalizeChatRequest(
      request({ reasoning_effort: 'ultra-mega' as unknown as ChatRequest['reasoning_effort'] })
    );
    expect(r.reasoning_effort).toBeUndefined();
  });

  it("'high' effort biases quality_target to the 0.9 floor when unset", () => {
    const r = normalizeChatRequest(request({ reasoning_effort: 'high' }));
    expect(r.quality_target).toBe(0.9);
  });

  it("'low' and 'medium' effort do NOT touch quality_target", () => {
    expect(normalizeChatRequest(request({ reasoning_effort: 'low' })).quality_target).toBeUndefined();
    expect(normalizeChatRequest(request({ reasoning_effort: 'medium' })).quality_target).toBeUndefined();
  });

  it('never downgrades an explicit client quality_target above the floor', () => {
    const r = normalizeChatRequest(request({ reasoning_effort: 'high', quality_target: 0.98 }));
    expect(r.quality_target).toBe(0.98);
  });

  it('never overrides an explicit client quality_target below the floor either — client intent wins', () => {
    const r = normalizeChatRequest(request({ reasoning_effort: 'high', quality_target: 0.2 }));
    expect(r.quality_target).toBe(0.2);
  });

  it('never overrides an alias-provided quality_target (ailin-best already sets 0.95)', () => {
    const r = normalizeChatRequest(request({ model: 'ailin-best', reasoning_effort: 'high' }));
    expect(r.quality_target).toBe(0.95);
  });
});
