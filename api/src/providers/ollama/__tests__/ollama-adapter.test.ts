// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OllamaAdapter — thin hub wrapper. Ollama's OAI-compat endpoint is exercised
 * by hub tests; this pack only pins the identity contract and the
 * apiKeyOptional default.
 */

import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../ollama-adapter';

describe('OllamaAdapter', () => {
  it('instantiates with empty apiKey (local Ollama has no auth)', () => {
    expect(
      () =>
        new OllamaAdapter({
          name: 'ollama',
          enabled: true,
          providerName: 'ollama',
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
        }),
    ).not.toThrow();
  });

  it('default displayName is "Ollama"', () => {
    const adapter = new OllamaAdapter({
      name: 'ollama',
      enabled: true,
      providerName: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(adapter.displayName).toBe('Ollama');
  });

  it('honors a caller-supplied displayName (e.g. "Ollama (GPU node)")', () => {
    const adapter = new OllamaAdapter({
      name: 'ollama',
      enabled: true,
      providerName: 'ollama',
      displayName: 'Ollama (GPU node)',
      apiKey: '',
      baseUrl: 'http://gpu.example.com:11434/v1',
    });
    expect(adapter.displayName).toBe('Ollama (GPU node)');
  });

  it('provider identity is "ollama"', () => {
    const adapter = new OllamaAdapter({
      name: 'ollama',
      enabled: true,
      providerName: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('ollama');
  });

  it('still accepts an apiKey when a reverse proxy fronts Ollama', () => {
    // Some operators put Ollama behind an auth proxy (cloudflared tunnel,
    // Traefik ForwardAuth). The adapter should emit the Bearer header for
    // the proxy; Ollama itself ignores it.
    expect(
      () =>
        new OllamaAdapter({
          name: 'ollama',
          enabled: true,
          providerName: 'ollama',
          apiKey: 'proxy-token-123',
          baseUrl: 'https://ollama.example.com/v1',
        }),
    ).not.toThrow();
  });

  it('forces apiKeyOptional=true in metadata (even if caller omits metadata)', () => {
    const adapter = new OllamaAdapter({
      name: 'ollama',
      enabled: true,
      providerName: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
    });
    const metadata = (adapter as unknown as { metadata: { apiKeyOptional: boolean } }).metadata;
    expect(metadata.apiKeyOptional).toBe(true);
  });
});
