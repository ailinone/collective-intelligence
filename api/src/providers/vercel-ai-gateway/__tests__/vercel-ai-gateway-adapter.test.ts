// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VercelAIGatewayAdapter — model-id parsing + attribution tests.
 *
 * The Vercel AI Gateway namespaces every model as `provider/model`. The
 * capability merger attributes requests to the real upstream family by
 * reading either the namespace or the `/v1/models` `owned_by` field —
 * these tests pin both paths down.
 */

import { describe, expect, it } from 'vitest';
import { VercelAIGatewayAdapter } from '../vercel-ai-gateway-adapter';

describe('VercelAIGatewayAdapter — parseModelId', () => {
  it('parses anthropic/claude-sonnet-4', () => {
    expect(VercelAIGatewayAdapter.parseModelId('anthropic/claude-sonnet-4')).toEqual({
      family: 'anthropic',
      model: 'claude-sonnet-4',
      raw: 'anthropic/claude-sonnet-4',
    });
  });

  it('parses openai/gpt-4o', () => {
    expect(VercelAIGatewayAdapter.parseModelId('openai/gpt-4o')).toEqual({
      family: 'openai',
      model: 'gpt-4o',
      raw: 'openai/gpt-4o',
    });
  });

  it('lowercases the family portion', () => {
    const parsed = VercelAIGatewayAdapter.parseModelId('Anthropic/Claude-Sonnet-4');
    expect(parsed?.family).toBe('anthropic');
    // Model half is preserved as-is — some upstreams are case-sensitive on model.
    expect(parsed?.model).toBe('Claude-Sonnet-4');
  });

  it('returns undefined for bare (non-namespaced) ids', () => {
    expect(VercelAIGatewayAdapter.parseModelId('gpt-4o')).toBeUndefined();
  });

  it('returns undefined for empty or malformed ids', () => {
    expect(VercelAIGatewayAdapter.parseModelId('')).toBeUndefined();
    expect(VercelAIGatewayAdapter.parseModelId('/leading-slash')).toBeUndefined();
    expect(VercelAIGatewayAdapter.parseModelId('trailing-slash/')).toBeUndefined();
    expect(VercelAIGatewayAdapter.parseModelId(null as unknown as string)).toBeUndefined();
    expect(VercelAIGatewayAdapter.parseModelId(undefined as unknown as string)).toBeUndefined();
  });
});

describe('VercelAIGatewayAdapter — attributeFromDiscovery', () => {
  it('prefers owned_by over the namespace', () => {
    const attributed = VercelAIGatewayAdapter.attributeFromDiscovery({
      id: 'anthropic/claude-sonnet-4',
      owned_by: 'anthropic',
    });
    expect(attributed).toEqual({
      family: 'anthropic',
      model: 'claude-sonnet-4',
      raw: 'anthropic/claude-sonnet-4',
    });
  });

  it('uses owned_by to override a mismatched namespace (edge case)', () => {
    // Pathological case: Vercel re-routes `fooproxy/gpt-4o` but owned_by
    // correctly says openai. Attribution must trust owned_by.
    const attributed = VercelAIGatewayAdapter.attributeFromDiscovery({
      id: 'fooproxy/gpt-4o',
      owned_by: 'openai',
    });
    expect(attributed?.family).toBe('openai');
  });

  it('falls back to namespace parsing when owned_by is missing/empty', () => {
    expect(
      VercelAIGatewayAdapter.attributeFromDiscovery({
        id: 'xai/grok-4',
      }),
    ).toEqual({
      family: 'xai',
      model: 'grok-4',
      raw: 'xai/grok-4',
    });
    expect(
      VercelAIGatewayAdapter.attributeFromDiscovery({
        id: 'xai/grok-4',
        owned_by: '',
      }),
    ).toEqual({
      family: 'xai',
      model: 'grok-4',
      raw: 'xai/grok-4',
    });
  });

  it('handles bare id + owned_by combo (no namespace but attribution present)', () => {
    const attributed = VercelAIGatewayAdapter.attributeFromDiscovery({
      id: 'gpt-4o',
      owned_by: 'openai',
    });
    expect(attributed).toEqual({
      family: 'openai',
      model: 'gpt-4o',
      raw: 'gpt-4o',
    });
  });

  it('returns undefined when everything is missing', () => {
    expect(
      VercelAIGatewayAdapter.attributeFromDiscovery({ id: 'bare' }),
    ).toBeUndefined();
  });
});

describe('VercelAIGatewayAdapter — construction', () => {
  it('constructs with the default displayName', () => {
    const adapter = new VercelAIGatewayAdapter({
      name: 'vercel-ai-gateway',
      enabled: true,
      apiKey: 'vercel-test',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      providerName: 'vercel-ai-gateway',
    });
    expect(adapter).toBeInstanceOf(VercelAIGatewayAdapter);
  });
});
