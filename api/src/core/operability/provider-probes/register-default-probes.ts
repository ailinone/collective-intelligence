// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — default probe registration.
 *
 * Registers known-safe non-billable probes for providers where the
 * endpoint contract is documented. Each provider is opt-in: a probe
 * is registered only when the corresponding env credential is set.
 *
 * Add new provider probes here as adapter authors verify their
 * non-billable endpoint contracts.
 */
import { ProviderProbeRegistry } from '../provider-probe-registry';
import { createOllamaProbe } from './ollama-probe';
import { createOpenRouterProbe } from './openrouter-probe';
import { createGenericListModelsProbe } from './generic-list-models-probe';

export interface RegisterDefaultProbesOptions {
  /** Skip auto-registration; only register when explicitly requested. */
  readonly skipAutoEnv?: boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Register every provider probe whose required env var is set.
 *
 * Local providers (Ollama) register unconditionally — they don't
 * need credentials. Cloud providers register only when their API
 * key env var is present.
 */
export function registerDefaultProbes(
  registry: ProviderProbeRegistry,
  opts: RegisterDefaultProbesOptions = {},
): readonly string[] {
  const registered: string[] = [];

  // Local — register unconditionally; probe handles "not running"
  // gracefully (returns auth_failed when connection refused).
  registry.register(createOllamaProbe({ fetchImpl: opts.fetchImpl }));
  registered.push('ollama');

  if (opts.skipAutoEnv) return registered;

  if ((process.env.OPENROUTER_API_KEY ?? '').trim().length > 0) {
    registry.register(createOpenRouterProbe({ fetchImpl: opts.fetchImpl }));
    registered.push('openrouter');
  }

  // OpenAI-compatible generic list-models probe.
  // Registered when `<UPPERCASE>_API_KEY` is set. Base URLs default to
  // well-known aggregator endpoints; operators can override via
  // `<UPPERCASE>_BASE_URL`. Each aggregator's `/v1/models` is verified
  // to be non-billable.
  const candidates: ReadonlyArray<{ providerId: string; baseUrl?: string; apiKey?: string; defaultBaseUrl: string }> = [
    {
      providerId: 'aihubmix',
      baseUrl: process.env.AIHUBMIX_BASE_URL,
      apiKey: process.env.AIHUBMIX_API_KEY,
      defaultBaseUrl: 'https://aihubmix.com',
    },
    {
      providerId: 'cometapi',
      baseUrl: process.env.COMETAPI_BASE_URL,
      apiKey: process.env.COMETAPI_API_KEY,
      defaultBaseUrl: 'https://api.cometapi.com',
    },
    {
      providerId: 'edenai',
      baseUrl: process.env.EDENAI_BASE_URL,
      apiKey: process.env.EDENAI_API_KEY,
      defaultBaseUrl: 'https://api.edenai.run',
    },
  ];
  for (const c of candidates) {
    if (c.apiKey) {
      const baseUrl = c.baseUrl ?? c.defaultBaseUrl;
      registry.register(
        createGenericListModelsProbe({
          providerId: c.providerId,
          baseUrl,
          apiKey: c.apiKey,
          fetchImpl: opts.fetchImpl,
        }),
      );
      registered.push(c.providerId);
    }
  }

  return registered;
}
