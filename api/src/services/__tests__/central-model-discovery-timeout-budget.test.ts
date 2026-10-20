// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for a 2026-09-28 provider-audit finding: discoverAllModels'
 * per-source timeout budget was keyed on `source.type === 'aggregator'` only,
 * so every `'cloud_hub'` and `'router'` source (aihubmix, orqai, edenai,
 * cometapi, nanogpt, requesty, ai302, poe, routeway, aiml, openrouter, ...) —
 * several of which list hundreds to low thousands of models — got the 10s
 * `native_api` budget meant for a single-vendor ping. A slow response or TLS
 * handshake on any of them silently returned 0/partial models for that
 * discovery cycle. Only `native_api` sources (openai-native,
 * anthropic-native, ...) are reliably small/fast enough to fit the short
 * budget; every other type now gets the long one.
 */
import { describe, expect, it } from 'vitest';
import { resolveDiscoveryTimeoutMs } from '@/services/central-model-discovery-service';

describe('resolveDiscoveryTimeoutMs', () => {
  it('gives native_api sources the short budget', () => {
    expect(resolveDiscoveryTimeoutMs('native_api')).toBe(10000);
  });

  it('gives cloud_hub sources the long budget, not the native_api one', () => {
    expect(resolveDiscoveryTimeoutMs('cloud_hub')).toBe(300000);
  });

  it('gives router sources the long budget, not the native_api one', () => {
    expect(resolveDiscoveryTimeoutMs('router')).toBe(300000);
  });

  it('gives aggregator sources the long budget (unchanged prior behavior)', () => {
    expect(resolveDiscoveryTimeoutMs('aggregator')).toBe(300000);
  });
});
