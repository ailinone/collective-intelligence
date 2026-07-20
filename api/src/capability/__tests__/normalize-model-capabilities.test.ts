// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for resolveModelCapabilities — the single source of truth for
 * "is this model chat-capable?". Locks in the precedence rule
 * (canonical first, legacy fallback, none otherwise) and the alias set.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModelCapabilities,
  isChatCapable,
  summariseSources,
} from '../normalize-model-capabilities';

describe('resolveModelCapabilities — precedence', () => {
  it('canonical capability_uris wins when non-empty', () => {
    const r = resolveModelCapabilities({ capabilityUris: ['chat'], capabilities: ['embedding'] });
    expect(r.source).toBe('capability_uris');
    expect(r.hasChat).toBe(true);
    expect(r.hasEmbedding).toBe(false);
  });

  it('legacy capabilities used when capabilityUris is empty array', () => {
    const r = resolveModelCapabilities({ capabilityUris: [], capabilities: ['chat'] });
    expect(r.source).toBe('legacy_capabilities');
    expect(r.hasChat).toBe(true);
  });

  it('legacy capabilities used when capabilityUris is null', () => {
    const r = resolveModelCapabilities({ capabilityUris: null, capabilities: ['chat'] });
    expect(r.source).toBe('legacy_capabilities');
    expect(r.hasChat).toBe(true);
  });

  it('legacy capabilities used when capabilityUris is undefined', () => {
    const r = resolveModelCapabilities({ capabilities: ['chat'] });
    expect(r.source).toBe('legacy_capabilities');
    expect(r.hasChat).toBe(true);
  });

  it('text-generation aliased to chat', () => {
    const r = resolveModelCapabilities({ capabilityUris: [], capabilities: ['text-generation'] });
    expect(r.hasChat).toBe(true);
    expect(r.source).toBe('legacy_capabilities');
  });

  it('text_generation (underscore) aliased to chat', () => {
    const r = resolveModelCapabilities({ capabilities: ['text_generation'] });
    expect(r.hasChat).toBe(true);
  });

  it('completions aliased to chat', () => {
    const r = resolveModelCapabilities({ capabilities: ['completions'] });
    expect(r.hasChat).toBe(true);
  });

  it('both empty → source=none, hasChat=false', () => {
    const r = resolveModelCapabilities({ capabilityUris: [], capabilities: [] });
    expect(r.source).toBe('none');
    expect(r.hasChat).toBe(false);
  });

  it('both null → source=none', () => {
    const r = resolveModelCapabilities({ capabilityUris: null, capabilities: null });
    expect(r.source).toBe('none');
    expect(r.hasChat).toBe(false);
  });

  it('null model → source=none', () => {
    expect(resolveModelCapabilities(null).source).toBe('none');
    expect(resolveModelCapabilities(undefined).source).toBe('none');
  });

  it('CANONICAL EXPLICITLY OVERRIDES LEGACY — image_generation in URIs blocks chat from legacy', () => {
    // This is the deliberate precedence: if HCRA / curator put
    // `['image_generation']` in capability_uris, that wins, even if
    // the legacy column says ['chat']. Avoids silent override of
    // explicit curation.
    const r = resolveModelCapabilities({
      capabilityUris: ['image_generation'],
      capabilities: ['chat'],
    });
    expect(r.source).toBe('capability_uris');
    expect(r.hasChat).toBe(false);
    expect(r.hasImageGeneration).toBe(true);
  });
});

describe('resolveModelCapabilities — robust to messy legacy data', () => {
  it('JSON-string array deserialised', () => {
    const r = resolveModelCapabilities({ capabilities: '["chat","streaming"]' });
    expect(r.hasChat).toBe(true);
    expect(r.hasStreaming).toBe(true);
    expect(r.source).toBe('legacy_capabilities');
  });

  it('bare string value treated as single capability', () => {
    const r = resolveModelCapabilities({ capabilities: 'chat' });
    expect(r.hasChat).toBe(true);
  });

  it('object form {chat: true, embedding: false} expanded', () => {
    const r = resolveModelCapabilities({ capabilities: { chat: true, embedding: false } });
    expect(r.hasChat).toBe(true);
    expect(r.hasEmbedding).toBe(false);
  });

  it('upper-case capabilities normalised to lower-case', () => {
    const r = resolveModelCapabilities({ capabilityUris: ['CHAT', 'STREAMING'] });
    expect(r.hasChat).toBe(true);
    expect(r.hasStreaming).toBe(true);
  });

  it('malformed JSON string does not throw', () => {
    const r = resolveModelCapabilities({ capabilities: '["chat",not-json' });
    expect(() => r).not.toThrow();
    expect(r.source).toBe('none');
  });

  it('whitespace trimmed and empty entries removed', () => {
    const r = resolveModelCapabilities({ capabilityUris: [' chat ', '', '  ', 'embedding'] });
    expect(r.hasChat).toBe(true);
    expect(r.hasEmbedding).toBe(true);
    expect(r.raw).toEqual(['chat', 'embedding']);
  });
});

describe('resolveModelCapabilities — flag derivation', () => {
  it('vision flag from various aliases', () => {
    expect(resolveModelCapabilities({ capabilityUris: ['vision'] }).hasVision).toBe(true);
    expect(resolveModelCapabilities({ capabilityUris: ['image-input'] }).hasVision).toBe(true);
    expect(resolveModelCapabilities({ capabilityUris: ['multimodal-vision'] }).hasVision).toBe(true);
  });

  it('tools flag from function_calling alias', () => {
    expect(resolveModelCapabilities({ capabilityUris: ['function_calling'] }).hasTools).toBe(true);
    expect(resolveModelCapabilities({ capabilityUris: ['tools'] }).hasTools).toBe(true);
  });

  it('json flag from json_mode alias', () => {
    expect(resolveModelCapabilities({ capabilityUris: ['json_mode'] }).hasJson).toBe(true);
    expect(resolveModelCapabilities({ capabilityUris: ['structured_output'] }).hasJson).toBe(true);
  });

  it('image-generation does NOT trigger hasChat', () => {
    const r = resolveModelCapabilities({ capabilityUris: ['image_generation'] });
    expect(r.hasImageGeneration).toBe(true);
    expect(r.hasChat).toBe(false);
  });
});

describe('isChatCapable convenience predicate', () => {
  it('mirrors resolveModelCapabilities(...).hasChat', () => {
    expect(isChatCapable({ capabilityUris: ['chat'] })).toBe(true);
    expect(isChatCapable({ capabilityUris: ['embedding'] })).toBe(false);
    expect(isChatCapable({ capabilities: ['chat'] })).toBe(true);
    expect(isChatCapable(null)).toBe(false);
  });
});

describe('summariseSources', () => {
  it('aggregates capability source distribution', () => {
    const out = summariseSources([
      { capabilityUris: ['chat'] },
      { capabilityUris: ['embedding'] },
      { capabilityUris: [], capabilities: ['chat'] },
      { capabilities: [] },
    ]);
    expect(out.capability_uris).toBe(2);
    expect(out.legacy_capabilities).toBe(1);
    expect(out.none).toBe(1);
    expect(out.inferred).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Invariant — audit vs runner agreement.
//
// The whole point of this module is that the C3 audit and the runtime
// orchestrator MUST agree on "is this chat-capable?". This test pins
// that agreement structurally: both sides go through the same function.
// ──────────────────────────────────────────────────────────────────────
describe('audit ↔ runner agreement invariant', () => {
  const cases = [
    { capabilityUris: ['chat'] },
    { capabilityUris: [], capabilities: ['chat'] },
    { capabilityUris: ['image_generation'], capabilities: ['chat'] },
    { capabilities: ['text-generation'] },
    { capabilities: [] },
    { capabilities: '["chat","streaming"]' },
    {},
  ];

  it.each(cases)('agrees for %o', (model) => {
    // "Audit side" (c3-audit, /v1/models, c3-resolvers): same call.
    const auditChat = resolveModelCapabilities(model).hasChat;
    // "Runner side" (pool-builder modality_filter, base-strategy
    // fallback, parallel-race-strategy): same call.
    const runnerChat = resolveModelCapabilities(model).hasChat;
    expect(auditChat).toBe(runnerChat);
  });
});
