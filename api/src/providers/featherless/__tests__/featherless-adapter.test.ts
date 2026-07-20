// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * FeatherlessAdapter — hub thin wrapper identity assertions.
 *
 * Featherless speaks pure OpenAI-compat on chat/streaming, so wire-level
 * behavior is exercised by the hub tests. This pack verifies only the
 * dedicated subclass's contract: provider name, display name, construction
 * safety. A wire behavior regression here would be a hub regression, not a
 * Featherless-specific one.
 *
 * Note: no model identifiers appear in these fixtures — consistent with the
 * NENHUM MODELO HARDCODED rule. The adapter carries no model list; the
 * catalog / discovery service is the sole source of truth.
 */

import { describe, expect, it } from 'vitest';
import { FeatherlessAdapter } from '../featherless-adapter';

describe('FeatherlessAdapter', () => {
  it('instantiates with a real apiKey', () => {
    expect(
      () =>
        new FeatherlessAdapter({
          name: 'featherless-ai',
          enabled: true,
          providerName: 'featherless-ai',
          apiKey: 'test-featherless-key',
          baseUrl: 'https://api.featherless.ai/v1',
        }),
    ).not.toThrow();
  });

  it('defaults displayName to "Featherless AI"', () => {
    const adapter = new FeatherlessAdapter({
      name: 'featherless-ai',
      enabled: true,
      providerName: 'featherless-ai',
      apiKey: 'k',
      baseUrl: 'https://api.featherless.ai/v1',
    });
    expect(adapter.displayName).toBe('Featherless AI');
  });

  it('honors a caller-supplied displayName override', () => {
    const adapter = new FeatherlessAdapter({
      name: 'featherless-ai',
      enabled: true,
      providerName: 'featherless-ai',
      displayName: 'Featherless (Private)',
      apiKey: 'k',
      baseUrl: 'https://api.featherless.ai/v1',
    });
    expect(adapter.displayName).toBe('Featherless (Private)');
  });

  it('provider identity is "featherless-ai"', () => {
    const adapter = new FeatherlessAdapter({
      name: 'featherless-ai',
      enabled: true,
      providerName: 'featherless-ai',
      apiKey: 'k',
      baseUrl: 'https://api.featherless.ai/v1',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe(
      'featherless-ai',
    );
  });
});
