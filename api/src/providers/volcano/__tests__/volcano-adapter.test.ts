// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VolcanoAdapter — endpoint-id validation + no-bulk-models guard tests.
 *
 * Volcano ARK requires `ep-<14-digit-timestamp>-<random>` endpoint ids
 * instead of model family names. The adapter both validates that pattern and
 * short-circuits `getModels()` to an empty list — the ARK inference API has
 * no bulk `/models` route, so the hub fetcher's probe would otherwise log a
 * 404 on every discovery cycle.
 */

import { describe, expect, it } from 'vitest';
import { VolcanoAdapter } from '../volcano-adapter';

describe('VolcanoAdapter — endpoint-id pattern', () => {
  it('accepts the documented ep-<timestamp>-<random> format', () => {
    expect(VolcanoAdapter.isVolcanoEndpointId('ep-20240611071234-abc12')).toBe(true);
    expect(VolcanoAdapter.isVolcanoEndpointId('ep-20250101000000-xyz99')).toBe(true);
  });

  it('is case-insensitive on the random suffix', () => {
    expect(VolcanoAdapter.isVolcanoEndpointId('EP-20240611071234-ABC12')).toBe(true);
  });

  it('rejects family names', () => {
    expect(VolcanoAdapter.isVolcanoEndpointId('doubao-pro-128k')).toBe(false);
    expect(VolcanoAdapter.isVolcanoEndpointId('doubao-lite-4k')).toBe(false);
    expect(VolcanoAdapter.isVolcanoEndpointId('llama3-70b')).toBe(false);
  });

  it('rejects partial matches', () => {
    expect(VolcanoAdapter.isVolcanoEndpointId('ep-')).toBe(false);
    expect(VolcanoAdapter.isVolcanoEndpointId('ep-abc-12')).toBe(false); // no timestamp
    expect(VolcanoAdapter.isVolcanoEndpointId('ep-20240611-abc12')).toBe(false); // short ts
    expect(VolcanoAdapter.isVolcanoEndpointId('prefix-ep-20240611071234-abc12')).toBe(false);
    expect(VolcanoAdapter.isVolcanoEndpointId('')).toBe(false);
  });
});

describe('VolcanoAdapter — getModels returns empty (no bulk /models)', () => {
  it('never hits the wire for discovery', async () => {
    // Install a fetch sentinel that WOULD flag any unexpected HTTP call.
    const fetchSentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = ((..._args: unknown[]) => {
      fetchSentinel.count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = new VolcanoAdapter({
        name: 'volcano',
        enabled: true,
        apiKey: 'volcano-test',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        providerName: 'volcano',
      });
      const models = await adapter.getModels();
      expect(models).toEqual([]);
      expect(fetchSentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
