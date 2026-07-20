// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LmStudioAdapter — thin hub wrapper for local-only LM Studio server.
 */

import { describe, expect, it } from 'vitest';
import { LmStudioAdapter } from '../lmstudio-adapter';

describe('LmStudioAdapter', () => {
  it('instantiates with empty apiKey (local server)', () => {
    expect(
      () =>
        new LmStudioAdapter({
          name: 'lm-studio',
          enabled: true,
          providerName: 'lm-studio',
          apiKey: '',
          baseUrl: 'http://localhost:1234/v1',
        }),
    ).not.toThrow();
  });

  it('default displayName is "LM Studio"', () => {
    const adapter = new LmStudioAdapter({
      name: 'lm-studio',
      enabled: true,
      providerName: 'lm-studio',
      apiKey: '',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(adapter.displayName).toBe('LM Studio');
  });

  it('honors apiKey if provided (some users set a placeholder)', () => {
    expect(
      () =>
        new LmStudioAdapter({
          name: 'lm-studio',
          enabled: true,
          providerName: 'lm-studio',
          apiKey: 'lm-studio-placeholder',
          baseUrl: 'http://localhost:1234/v1',
        }),
    ).not.toThrow();
  });
});
