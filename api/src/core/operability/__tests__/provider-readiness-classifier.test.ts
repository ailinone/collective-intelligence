// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Tests for the readiness classifier helpers + alias map +
 * capability kind + canonical resolver.
 *
 * These pin the exact G→G2 reclassification logic that determines
 * whether a provider's 404/400 is an ALIAS issue (cheap fix) or a
 * TRUE unsupported (expensive fix).
 */
import { describe, it, expect } from 'vitest';
import { looksLikeAliasMismatch } from '../provider-readiness-classifier';
import {
  PROVIDER_MODEL_ALIASES,
  resolveProviderApiModelId,
  findCatalogIdForApiModelId,
} from '../provider-model-aliases';
import {
  classifyProviderCapabilityKind,
  isChatPrimaryProvider,
  isSpecializedNonChatProvider,
} from '../provider-capability-kind';
import { resolveCanonicalProbeModel } from '../provider-canonical-model-resolver';

describe('looksLikeAliasMismatch — double-prefix detection (signal 1)', () => {
  it('detects openai/openai-gpt-5.1-mini for providerId=openai', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'openai',
        modelId: 'openai/openai-gpt-5.1-mini',
      }),
    ).toBe(true);
  });

  it('does NOT flag a hub-provider single-prefix as alias', () => {
    // vercel-ai-gateway DOES accept namespaced model IDs like
    // `meta/llama-3.2-11b`. That's not an alias issue.
    expect(
      looksLikeAliasMismatch({
        providerId: 'vercel-ai-gateway',
        modelId: 'meta/llama-3.2-11b',
      }),
    ).toBe(false);
  });
});

describe('looksLikeAliasMismatch — native-provider prefix rejection (signal 2)', () => {
  it('flags openai/gpt-5.1-mini for providerId=openai (native rejects prefix)', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'openai',
        modelId: 'openai/gpt-5.1-mini',
      }),
    ).toBe(true);
  });

  it('flags huggingface single-prefix as alias-suspect', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'huggingface',
        modelId: 'huggingface/meta-llama-3-8b',
      }),
    ).toBe(true);
  });

  it('does NOT flag a non-native-prefix model id (no slash)', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
      }),
    ).toBe(false);
  });
});

describe('looksLikeAliasMismatch — discovery cross-check (signal 4)', () => {
  it('flags catalog form when discovery has bare form', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'openai',
        modelId: 'openai/gpt-5.1-mini',
        discoveredModelIds: ['gpt-5.1-mini', 'gpt-4o-mini'],
      }),
    ).toBe(true);
  });

  it('does NOT flag when discovery has no match', () => {
    expect(
      looksLikeAliasMismatch({
        providerId: 'someprovider',
        modelId: 'someprovider-only-model',
        discoveredModelIds: ['totally-different-model'],
      }),
    ).toBe(false);
  });
});

describe('PROVIDER_MODEL_ALIASES', () => {
  it('has openai entry with the gpt-5.1-mini canonical mapping', () => {
    expect(PROVIDER_MODEL_ALIASES.openai).toBeDefined();
    expect(PROVIDER_MODEL_ALIASES.openai!['openai/openai-gpt-5.1-mini']).toBe('gpt-5.1-mini');
  });

  it('resolveProviderApiModelId returns the alias when present', () => {
    const r = resolveProviderApiModelId('openai', 'openai/openai-gpt-5.1-mini');
    expect(r.apiModelId).toBe('gpt-5.1-mini');
    expect(r.aliasUsed).toBe(true);
  });

  it('resolveProviderApiModelId returns the original when no alias', () => {
    const r = resolveProviderApiModelId('deepseek', 'deepseek-chat');
    expect(r.apiModelId).toBe('deepseek-chat');
    expect(r.aliasUsed).toBe(false);
  });

  it('findCatalogIdForApiModelId reverse-lookup works', () => {
    const r = findCatalogIdForApiModelId('openai', 'gpt-5.1-mini');
    expect(r).toBe('openai/openai-gpt-5.1-mini');
  });
});

describe('classifyProviderCapabilityKind', () => {
  it('audio providers are not chat-primary', () => {
    expect(classifyProviderCapabilityKind('deepgram')).toBe('speech_to_text');
    expect(classifyProviderCapabilityKind('cartesia')).toBe('text_to_speech');
    expect(classifyProviderCapabilityKind('elevenlabs')).toBe('text_to_speech');
    expect(isChatPrimaryProvider('elevenlabs')).toBe(false);
    expect(isSpecializedNonChatProvider('elevenlabs')).toBe(true);
  });

  it('voyage is embeddings', () => {
    expect(classifyProviderCapabilityKind('voyage')).toBe('embeddings');
    expect(isSpecializedNonChatProvider('voyage')).toBe(true);
  });

  it('image providers are non-chat', () => {
    for (const p of ['recraft', 'runwayml', 'topaz', 'bfl', 'imagerouter']) {
      expect(isSpecializedNonChatProvider(p)).toBe(true);
    }
  });

  it('unknown provider defaults to chat (conservative)', () => {
    expect(classifyProviderCapabilityKind('some-new-provider')).toBe('chat');
    expect(isChatPrimaryProvider('some-new-provider')).toBe(true);
  });

  it('local providers are chat-probable', () => {
    expect(classifyProviderCapabilityKind('ollama')).toBe('local');
    expect(isChatPrimaryProvider('ollama')).toBe(true);
    expect(isSpecializedNonChatProvider('ollama')).toBe(false);
  });
});

describe('resolveCanonicalProbeModel', () => {
  it('prefers manual override (highest authority)', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'openai',
      catalogModels: [{ id: 'openai/openai-gpt-4o' }],
      manualOverride: 'gpt-5.1-mini',
    });
    expect(r?.source).toBe('manual_probe_spec');
    expect(r?.apiModelId).toBe('gpt-5.1-mini');
  });

  it('prefers last_success over discovery', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'openai',
      catalogModels: [],
      discoveredModels: [{ id: 'gpt-4o-mini' }],
      lastSuccessfulModels: ['gpt-5.1-mini'],
    });
    expect(r?.source).toBe('last_success');
    expect(r?.modelId).toBe('gpt-5.1-mini');
  });

  it('applies alias when catalog form maps in PROVIDER_MODEL_ALIASES', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'openai',
      catalogModels: [
        { id: 'openai/openai-gpt-5.1-mini', capabilities: ['chat'] },
      ],
    });
    expect(r?.source).toBe('catalog_alias');
    expect(r?.modelId).toBe('openai/openai-gpt-5.1-mini');
    expect(r?.apiModelId).toBe('gpt-5.1-mini');
  });

  it('falls back to catalog_direct when no alias exists', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'deepseek',
      catalogModels: [
        { id: 'deepseek-chat', capabilities: ['chat'] },
      ],
    });
    expect(r?.source).toBe('catalog_direct');
    expect(r?.modelId).toBe('deepseek-chat');
    expect(r?.apiModelId).toBe('deepseek-chat');
  });

  it('returns null when no candidates exist', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'someprovider',
      catalogModels: [],
    });
    expect(r).toBeNull();
  });

  it('skips non-chat catalog candidates', () => {
    const r = resolveCanonicalProbeModel({
      providerId: 'alibaba',
      catalogModels: [
        { id: 'qwen3-tts-instruct-flash', capabilities: ['audio'] },
        { id: 'qwen3-chat', capabilities: ['chat'] },
      ],
    });
    expect(r?.modelId).toBe('qwen3-chat');
  });
});
