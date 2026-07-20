// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BytezAdapter — hub thin wrapper identity assertions.
 *
 * Bytez speaks pure OpenAI-compatible on chat/embed paths, so the wire-level
 * behavior is exercised by the hub tests. This pack only verifies the
 * dedicated subclass's contract: provider name, display name, construction
 * safety. Wire behavior diverging from the hub would be a hub regression,
 * not a Bytez one.
 */

import { describe, expect, it } from 'vitest';
import { BytezAdapter } from '../bytez-adapter';

describe('BytezAdapter', () => {
  it('instantiates with a real apiKey', () => {
    expect(
      () =>
        new BytezAdapter({
          name: 'bytez',
          enabled: true,
          providerName: 'bytez',
          apiKey: 'test-bytez-key',
          baseUrl: 'https://api.bytez.com/v1',
        }),
    ).not.toThrow();
  });

  it('defaults displayName to "Bytez"', () => {
    const adapter = new BytezAdapter({
      name: 'bytez',
      enabled: true,
      providerName: 'bytez',
      apiKey: 'k',
      baseUrl: 'https://api.bytez.com/v1',
    });
    expect(adapter.displayName).toBe('Bytez');
  });

  it('honors a caller-supplied displayName override', () => {
    const adapter = new BytezAdapter({
      name: 'bytez',
      enabled: true,
      providerName: 'bytez',
      displayName: 'Bytez (Internal)',
      apiKey: 'k',
      baseUrl: 'https://api.bytez.com/v1',
    });
    expect(adapter.displayName).toBe('Bytez (Internal)');
  });

  it('provider identity is "bytez"', () => {
    const adapter = new BytezAdapter({
      name: 'bytez',
      enabled: true,
      providerName: 'bytez',
      apiKey: 'k',
      baseUrl: 'https://api.bytez.com/v1',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('bytez');
  });
});
