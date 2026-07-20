// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GeminiOpenAIAdapter — thin OAI-compat wrapper. This pack pins provider
 * identity + baseUrl default; the wire protocol itself is exercised by hub
 * tests. Crucially, we verify the provider name does NOT collide with the
 * native `google` adapter so telemetry scopes stay separate.
 */

import { describe, expect, it } from 'vitest';
import { GeminiOpenAIAdapter } from '../gemini-openai-adapter';

function getInternals(adapter: GeminiOpenAIAdapter): {
  baseUrl: string;
  authHeaderName: string;
  authScheme: string;
} {
  const internal = adapter as unknown as {
    config: { baseUrl: string };
    metadata: { authHeaderName: string; authScheme: string };
  };
  return {
    baseUrl: internal.config.baseUrl,
    authHeaderName: internal.metadata.authHeaderName,
    authScheme: internal.metadata.authScheme,
  };
}

describe('GeminiOpenAIAdapter', () => {
  it('instantiates with a Gemini API key', () => {
    expect(
      () =>
        new GeminiOpenAIAdapter({
          name: 'gemini-openai',
          enabled: true,
          providerName: 'gemini-openai',
          apiKey: 'AIza_gemini_key',
        }),
    ).not.toThrow();
  });

  it('defaults to the official Google AI Studio OAI-compat URL', () => {
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      apiKey: 'k',
    });
    expect(getInternals(adapter).baseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  });

  it('honors an explicit baseUrl override (e.g. VPN-scoped Google endpoint)', () => {
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      apiKey: 'k',
      baseUrl: 'https://gemini-proxy.internal.corp/v1beta/openai',
    });
    expect(getInternals(adapter).baseUrl).toBe(
      'https://gemini-proxy.internal.corp/v1beta/openai',
    );
  });

  it('uses Bearer auth on the Authorization header', () => {
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      apiKey: 'k',
    });
    const internals = getInternals(adapter);
    expect(internals.authHeaderName).toBe('Authorization');
    expect(internals.authScheme).toBe('Bearer');
  });

  it('provider identity is "gemini-openai" (distinct from native "google")', () => {
    // This test's purpose is architectural: if someone "helpfully" renames
    // this to `google`, telemetry for the OAI shim would pollute the native
    // Google scope, and the self-healing discovery map would collide. This
    // assertion is the guardrail.
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      apiKey: 'k',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('gemini-openai');
    expect((adapter as unknown as { providerName: string }).providerName).not.toBe('google');
  });

  it('default displayName is "Google AI Studio (Gemini OAI)"', () => {
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      apiKey: 'k',
    });
    expect(adapter.displayName).toBe('Google AI Studio (Gemini OAI)');
  });

  it('caller-supplied displayName wins', () => {
    const adapter = new GeminiOpenAIAdapter({
      name: 'gemini-openai',
      enabled: true,
      providerName: 'gemini-openai',
      displayName: 'Gemini OAI (US-West)',
      apiKey: 'k',
    });
    expect(adapter.displayName).toBe('Gemini OAI (US-West)');
  });
});
