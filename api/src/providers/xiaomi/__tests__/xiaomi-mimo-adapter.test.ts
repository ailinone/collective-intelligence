// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * XiaomiMimoAdapter — thin hub wrapper; identity + displayName assertions.
 */

import { describe, expect, it } from 'vitest';
import { XiaomiMimoAdapter } from '../xiaomi-mimo-adapter';

describe('XiaomiMimoAdapter', () => {
  it('instantiates with a real apiKey', () => {
    expect(
      () =>
        new XiaomiMimoAdapter({
          name: 'xiaomi-mimo',
          enabled: true,
          providerName: 'xiaomi-mimo',
          apiKey: 'test-mimo-key',
          baseUrl: 'https://platform.xiaomimimo.com/v1',
        }),
    ).not.toThrow();
  });

  it('defaults displayName to "Xiaomi MiMo"', () => {
    const adapter = new XiaomiMimoAdapter({
      name: 'xiaomi-mimo',
      enabled: true,
      providerName: 'xiaomi-mimo',
      apiKey: 'k',
      baseUrl: 'https://platform.xiaomimimo.com/v1',
    });
    expect(adapter.displayName).toBe('Xiaomi MiMo');
  });

  it('provider identity is "xiaomi-mimo"', () => {
    const adapter = new XiaomiMimoAdapter({
      name: 'xiaomi-mimo',
      enabled: true,
      providerName: 'xiaomi-mimo',
      apiKey: 'k',
      baseUrl: 'https://platform.xiaomimimo.com/v1',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('xiaomi-mimo');
  });
});
