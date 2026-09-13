// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CerebrasAdapter — max_completion_tokens normalization + prompt-cache-key
 * tests.
 *
 * Cerebras docs recommend `max_completion_tokens` for newer reasoning models;
 * older models still accept `max_tokens`. The hub's payload builder only
 * knows `max_tokens` — so this adapter must thread `max_completion_tokens`
 * through the extension hook and back-fill `max_tokens` when only the new
 * field was provided.
 *
 * ADR-025 follow-up (2026-09-09): every request also carries
 * `prompt_cache_key` (Cerebras's documented, optional cache-routing hint —
 * see the adapter's own comment for the citation), so every assertion below
 * accounts for that field being present unconditionally.
 */

import { describe, expect, it } from 'vitest';
import { CerebrasAdapter } from '../cerebras-adapter';
import type { ChatRequest } from '@/types';

/** Matches either branch of `deriveSessionKey()` — this suite only cares that SOME stable key is sent. */
const ANY_CACHE_KEY = expect.stringMatching(/^(conv|prefix):/);

function makeAdapter(): CerebrasAdapter {
  return new CerebrasAdapter({
    name: 'cerebras',
    enabled: true,
    apiKey: 'cb-test',
    baseUrl: 'https://api.cerebras.ai/v1',
    providerName: 'cerebras',
  });
}

function invokeHook(adapter: CerebrasAdapter, request: ChatRequest): Record<string, unknown> {
  return (
    adapter as unknown as {
      getExtraChatPayloadFields: (m: string, r: ChatRequest) => Record<string, unknown>;
    }
  ).getExtraChatPayloadFields('fixture-chat-model', request);
}

describe('CerebrasAdapter — getExtraChatPayloadFields hook', () => {
  it('sends only prompt_cache_key when neither max_tokens nor max_completion_tokens set', () => {
    const adapter = makeAdapter();
    const req: ChatRequest = {
      model: 'fixture-chat-model',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(invokeHook(adapter, req)).toEqual({ prompt_cache_key: ANY_CACHE_KEY });
  });

  it('sends only prompt_cache_key when only max_tokens set (hub handles canonically)', () => {
    const adapter = makeAdapter();
    const req = {
      model: 'fixture-chat-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 512,
    } as unknown as ChatRequest;
    expect(invokeHook(adapter, req)).toEqual({ prompt_cache_key: ANY_CACHE_KEY });
  });

  it('lifts max_completion_tokens into BOTH fields when only new name set', () => {
    const adapter = makeAdapter();
    const req = {
      model: 'fixture-reasoning-model',
      messages: [{ role: 'user', content: 'reason' }],
      max_completion_tokens: 2048,
    } as unknown as ChatRequest;
    expect(invokeHook(adapter, req)).toEqual({
      prompt_cache_key: ANY_CACHE_KEY,
      max_completion_tokens: 2048,
      max_tokens: 2048,
    });
  });

  it('keeps the caller-set max_tokens and only adds max_completion_tokens extra', () => {
    const adapter = makeAdapter();
    const req = {
      model: 'fixture-reasoning-model',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1024,
      max_completion_tokens: 4096, // caller intentionally different — Cerebras docs say this wins
    } as unknown as ChatRequest;
    const extras = invokeHook(adapter, req);
    expect(extras.max_completion_tokens).toBe(4096);
    // We do not add max_tokens here because the caller already set it.
    expect(extras.max_tokens).toBeUndefined();
  });

  it('ignores non-numeric max_completion_tokens', () => {
    const adapter = makeAdapter();
    const req = {
      model: 'fixture-reasoning-model',
      messages: [{ role: 'user', content: 'x' }],
      max_completion_tokens: 'unlimited', // invalid
    } as unknown as ChatRequest;
    expect(invokeHook(adapter, req)).toEqual({ prompt_cache_key: ANY_CACHE_KEY });
  });

  it('derives a stable prompt_cache_key from deriveSessionKey (ADR-025 follow-up)', () => {
    const adapter = makeAdapter();
    const req: ChatRequest = {
      model: 'fixture-chat-model',
      messages: [{ role: 'user', content: 'same prefix' }],
    };
    const first = invokeHook(adapter, req).prompt_cache_key;
    const second = invokeHook(adapter, req).prompt_cache_key;
    expect(typeof first).toBe('string');
    expect(first).toBe(second); // same request shape → same key, turn-to-turn stable
  });
});
