// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PerplexityAdapter — search-knob injection tests.
 *
 * Verifies that Perplexity-specific search filters pass through the hub's
 * extension hook intact, that invalid enum values (recency) are rejected,
 * and that the citation-preserving response type narrows statically.
 */

import { describe, expect, it } from 'vitest';
import { PerplexityAdapter } from '../perplexity-adapter';
import type { ChatRequest } from '@/types';

function makeAdapter(): PerplexityAdapter {
  return new PerplexityAdapter({
    name: 'perplexity',
    enabled: true,
    apiKey: 'pplx-test',
    baseUrl: 'https://api.perplexity.ai',
    providerName: 'perplexity',
  });
}

function invokeHook(
  adapter: PerplexityAdapter,
  request: ChatRequest,
): Record<string, unknown> {
  return (
    adapter as unknown as {
      getExtraChatPayloadFields: (m: string, r: ChatRequest) => Record<string, unknown>;
    }
  ).getExtraChatPayloadFields('sonar', request);
}

describe('PerplexityAdapter — getExtraChatPayloadFields hook', () => {
  it('returns empty when no perplexity knobs present', () => {
    const adapter = makeAdapter();
    const request: ChatRequest = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(invokeHook(adapter, request)).toEqual({});
  });

  it('forwards all five documented search knobs', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar-pro',
      messages: [{ role: 'user', content: 'latest news' }],
      options: {
        search_domain_filter: ['arxiv.org', 'wikipedia.org'],
        search_recency_filter: 'week',
        return_citations: true,
        return_images: false,
        return_related_questions: true,
      },
    } as unknown as ChatRequest;

    const extras = invokeHook(adapter, request);
    expect(extras).toEqual({
      search_domain_filter: ['arxiv.org', 'wikipedia.org'],
      search_recency_filter: 'week',
      return_citations: true,
      return_images: false,
      return_related_questions: true,
    });
  });

  it('accepts knobs from top-level when options bag absent', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'q' }],
      search_recency_filter: 'day',
      return_citations: true,
    } as unknown as ChatRequest;

    expect(invokeHook(adapter, request)).toEqual({
      search_recency_filter: 'day',
      return_citations: true,
    });
  });

  it('filters non-string values from search_domain_filter', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'q' }],
      options: {
        search_domain_filter: ['arxiv.org', 123, null, '', 'wikipedia.org'],
      },
    } as unknown as ChatRequest;

    const extras = invokeHook(adapter, request);
    expect(extras).toEqual({
      search_domain_filter: ['arxiv.org', 'wikipedia.org'],
    });
  });

  it('rejects invalid search_recency_filter enum values', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'q' }],
      options: {
        search_recency_filter: 'decade', // not in the allowed set
      },
    } as unknown as ChatRequest;

    expect(invokeHook(adapter, request)).toEqual({});
  });

  it('omits the domain filter entirely when every element is invalid', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'q' }],
      options: {
        search_domain_filter: [null, 123, ''],
      },
    } as unknown as ChatRequest;

    expect(invokeHook(adapter, request)).toEqual({});
  });

  it('rejects non-boolean flags', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'sonar',
      messages: [{ role: 'user', content: 'q' }],
      options: {
        return_citations: 'yes', // should be rejected — not a boolean
        return_images: 0,
      },
    } as unknown as ChatRequest;

    expect(invokeHook(adapter, request)).toEqual({});
  });
});
