// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RealtimeClientFactory — upstream selection.
 *
 * REGRESSION GUARD. Before this suite, `createClient()` began with
 * `if (userContext) { return new AilinRealtimeClient(...) }`, and the route's
 * `getUserContext()` always returns an object — so every session took the
 * composite STT->chat->TTS branch and the entire provider-native bridge to the
 * OpenAI Realtime API and the Gemini Live API was unreachable code. Naming a
 * provider realtime model changed nothing, and `audio_to_audio` (true
 * speech-to-speech) had no path at all.
 *
 * The first test here fails against that implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registryGet = vi.fn();

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ get: registryGet }),
}));

const { RealtimeClientFactory, parseTransportPreference } = await import('./realtime-routes');
const { OpenAIRealtimeClient } = await import('@/providers/openai/realtime-client');
const { GoogleLiveClient } = await import('@/providers/google/google-live-client');
const { AilinRealtimeClient } = await import('@/providers/ailin/ailin-realtime-client');
import type { ModelRepository } from '@/services/model-repository';
import type { Model } from '@/types';

const USER_CONTEXT = { organizationId: 'org-1', userId: 'user-1', authToken: 'tok' };

function model(name: string, provider: string): Model {
  return { id: `${provider}:${name}`, name, provider } as unknown as Model;
}

/** Adapter stub declaring a realtime transport, as a real adapter would. */
function adapterWithTransport(
  kind: 'openai-realtime-ws' | 'google-live-ws' | null,
  apiKey = 'sk-test-not-a-real-key',
  baseUrl?: string
) {
  return {
    getRealtimeTransport: () => (kind ? { kind, evidenceUrl: 'https://example.invalid/docs' } : { kind: null }),
    getApiKey: () => apiKey,
    config: baseUrl ? { baseUrl } : undefined,
  };
}

function repo(overrides: Partial<Record<keyof ModelRepository, unknown>> = {}) {
  return {
    findModelsByIdOrName: vi.fn().mockResolvedValue([]),
    findModelsWithCapabilities: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ModelRepository;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseTransportPreference', () => {
  it('accepts only the documented values and defaults to auto', () => {
    expect(parseTransportPreference('provider')).toBe('provider');
    expect(parseTransportPreference('composite')).toBe('composite');
    expect(parseTransportPreference('auto')).toBe('auto');
    expect(parseTransportPreference('nonsense')).toBe('auto');
    expect(parseTransportPreference(undefined)).toBe('auto');
    expect(parseTransportPreference(42)).toBe('auto');
  });
});

describe('RealtimeClientFactory — provider-native bridge reachability', () => {
  it('bridges to the OpenAI Realtime WebSocket when the named model resolves to it', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('some-realtime-model', 'openai')]),
    });
    registryGet.mockReturnValue(adapterWithTransport('openai-realtime-ws'));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('some-realtime-model', 'req-1', USER_CONTEXT);

    // THE regression assertion: previously this was an AilinRealtimeClient.
    expect(selection).not.toBeNull();
    expect(selection!.client).toBeInstanceOf(OpenAIRealtimeClient);
    expect(selection!.transport).toBe('provider');
    expect(selection!.transportKind).toBe('openai-realtime-ws');
    expect(selection!.provider).toBe('openai');
    expect(selection!.model).toBe('some-realtime-model');
  });

  it('bridges to the Google Live WebSocket for a google-live-ws adapter', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('some-live-model', 'google')]),
    });
    registryGet.mockReturnValue(adapterWithTransport('google-live-ws'));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('some-live-model', 'req-1', USER_CONTEXT);

    expect(selection!.client).toBeInstanceOf(GoogleLiveClient);
    expect(selection!.transport).toBe('provider');
    expect(selection!.transportKind).toBe('google-live-ws');
  });

  it('passes the adapter base URL through so OpenAI-compatible upstreams are bridged at their own host', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('m', 'some-compatible-provider')]),
    });
    registryGet.mockReturnValue(
      adapterWithTransport('openai-realtime-ws', 'key', 'https://upstream.invalid/v1')
    );
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('m', 'req-1', USER_CONTEXT);

    expect(selection!.client).toBeInstanceOf(OpenAIRealtimeClient);
    expect(selection!.provider).toBe('some-compatible-provider');
  });

  it('never substitutes a different model for an explicitly named one', async () => {
    const findByName = vi.fn().mockResolvedValue([]);
    const findByCapability = vi.fn().mockResolvedValue([model('other', 'openai')]);
    const modelRepo = repo({
      findModelsByIdOrName: findByName,
      findModelsWithCapabilities: findByCapability,
    });
    registryGet.mockReturnValue(adapterWithTransport('openai-realtime-ws'));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('a-model-that-does-not-exist', 'req-1', USER_CONTEXT);

    expect(findByName).toHaveBeenCalledWith('a-model-that-does-not-exist');
    // A capability search would have silently swapped in a different model.
    expect(findByCapability).not.toHaveBeenCalled();
    expect(selection!.transport).toBe('composite');
  });
});

describe('RealtimeClientFactory — composite fallback', () => {
  it('serves the composite pipeline when no model is named (unchanged default)', async () => {
    const modelRepo = repo();
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient(null, 'req-1', USER_CONTEXT);

    expect(selection!.client).toBeInstanceOf(AilinRealtimeClient);
    expect(selection!.transport).toBe('composite');
    expect(selection!.provider).toBe('ailin');
  });

  it('does not hit the catalog for an ailin-* composite alias', async () => {
    const findByName = vi.fn().mockResolvedValue([]);
    const modelRepo = repo({ findModelsByIdOrName: findByName });
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('ailin-auto', 'req-1', USER_CONTEXT);

    expect(findByName).not.toHaveBeenCalled();
    expect(selection!.client).toBeInstanceOf(AilinRealtimeClient);
  });

  it('falls back to the composite when the resolved provider declares no transport', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('chat-only', 'some-provider')]),
    });
    registryGet.mockReturnValue(adapterWithTransport(null));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('chat-only', 'req-1', USER_CONTEXT);

    expect(selection!.transport).toBe('composite');
  });

  it('skips a transport-declaring provider that has no credential', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('m', 'unfunded-provider')]),
    });
    registryGet.mockReturnValue(adapterWithTransport('openai-realtime-ws', ''));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('m', 'req-1', USER_CONTEXT);

    expect(selection!.transport).toBe('composite');
  });

  it('pins the composite when transport=composite, even for a provider realtime model', async () => {
    const findByName = vi.fn().mockResolvedValue([model('some-realtime-model', 'openai')]);
    const modelRepo = repo({ findModelsByIdOrName: findByName });
    registryGet.mockReturnValue(adapterWithTransport('openai-realtime-ws'));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient(
      'some-realtime-model',
      'req-1',
      USER_CONTEXT,
      'composite'
    );

    expect(findByName).not.toHaveBeenCalled();
    expect(selection!.client).toBeInstanceOf(AilinRealtimeClient);
    expect(selection!.transport).toBe('composite');
  });
});

describe('RealtimeClientFactory — transport=provider fails closed', () => {
  it('returns null instead of downgrading to a text round-trip', async () => {
    const modelRepo = repo({
      findModelsByIdOrName: vi.fn().mockResolvedValue([model('chat-only', 'some-provider')]),
    });
    registryGet.mockReturnValue(adapterWithTransport(null));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient('chat-only', 'req-1', USER_CONTEXT, 'provider');

    // Speech-to-speech answered by STT->chat->TTS is not speech-to-speech.
    expect(selection).toBeNull();
  });

  it('searches by capability when no model was named', async () => {
    const findByCapability = vi
      .fn()
      .mockResolvedValueOnce([model('live-audio-model', 'google')])
      .mockResolvedValueOnce([]);
    const modelRepo = repo({ findModelsWithCapabilities: findByCapability });
    registryGet.mockReturnValue(adapterWithTransport('google-live-ws'));
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient(null, 'req-1', USER_CONTEXT, 'provider');

    expect(findByCapability).toHaveBeenCalledWith(['realtime_audio'], { limit: 10 });
    expect(findByCapability).toHaveBeenCalledWith(['realtime'], { limit: 10 });
    expect(selection!.transport).toBe('provider');
    expect(selection!.model).toBe('live-audio-model');
  });

  it('returns null when nothing in the catalog offers a realtime transport', async () => {
    const modelRepo = repo();
    const factory = new RealtimeClientFactory(modelRepo);

    const selection = await factory.createClient(null, 'req-1', USER_CONTEXT, 'provider');

    expect(selection).toBeNull();
  });
});
