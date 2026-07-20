// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderProbeStrategy resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProbeStrategy,
  probeSupportsCreditCheck,
  probeSupportsModelEnumeration,
} from '../probe-strategy';

describe('resolveProbeStrategy', () => {
  it('returns provider-specific override when defined', () => {
    const s = resolveProbeStrategy({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure' });
    // aihubmix has billing API
    expect(s.creditProbe).toBe('billing_api');
    expect(s.modelProbe).toBe('list_models');
  });

  it('falls back to integration class default', () => {
    const s = resolveProbeStrategy({ providerId: 'unknown-provider', integrationClass: 'oai-compat-pure' });
    expect(s.credentialProbe).toBe('env_only');
    expect(s.endpointProbe).toBe('models_api');
    expect(s.modelProbe).toBe('list_models');
    expect(s.creditProbe).toBe('not_supported'); // pure oai-compat: no billing default
  });

  it('uses safe defaults for unknown integration class', () => {
    const s = resolveProbeStrategy({ providerId: 'mystery', integrationClass: undefined });
    expect(s.credentialProbe).toBe('env_only');
    expect(s.endpointProbe).toBe('not_supported'); // never assume HEAD/OPTIONS works
    expect(s.modelProbe).toBe('known_catalog_alias');
  });

  it('native-anthropic does NOT enumerate models', () => {
    const s = resolveProbeStrategy({ providerId: 'anthropic', integrationClass: 'native-anthropic' });
    expect(s.modelProbe).toBe('known_catalog_alias');
    expect(s.endpointProbe).toBe('not_supported');
  });

  it('native-openai DOES enumerate models', () => {
    const s = resolveProbeStrategy({ providerId: 'openai', integrationClass: 'native-openai' });
    expect(s.modelProbe).toBe('list_models');
    expect(s.endpointProbe).toBe('models_api');
  });

  it('self-hosted has no credential check (open daemon)', () => {
    const s = resolveProbeStrategy({ providerId: 'ollama', integrationClass: 'self-hosted-oai-compat' });
    expect(s.credentialProbe).toBe('not_supported');
    expect(s.modelProbe).toBe('list_models');
  });
});

describe('probe predicates', () => {
  it('probeSupportsCreditCheck recognizes billing_api / quota_header', () => {
    expect(probeSupportsCreditCheck('billing_api')).toBe(true);
    expect(probeSupportsCreditCheck('not_supported')).toBe(false);
  });

  it('probeSupportsModelEnumeration accepts list_models and minimal_completion', () => {
    expect(probeSupportsModelEnumeration('list_models')).toBe(true);
    expect(probeSupportsModelEnumeration('minimal_completion')).toBe(true);
    expect(probeSupportsModelEnumeration('known_catalog_alias')).toBe(false);
    expect(probeSupportsModelEnumeration('not_supported')).toBe(false);
  });
});
