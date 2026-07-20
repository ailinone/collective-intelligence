// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever-local-policy.test.ts — MVP 5A
 *
 * Proves the three privacy modes:
 *   - `standard`: local routes compete normally (no boost, no block)
 *   - `local_preferred`: scorer applies a local-preference boost
 *     (cloud routes are still allowed)
 *   - `local_required`: ONLY local/self_hosted routes pass
 */

import { describe, expect, it } from 'vitest';
import { retrieveCandidates } from '../candidate-retriever';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';

const LOCAL_KINDS = new Set(['local', 'self_hosted']);

describe('retriever — privacy: local_required', () => {
  it('returns ONLY local/self_hosted routes', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        privacyMode: 'local_required',
      },
      { registry },
    );
    for (const c of result.candidates) {
      const routeId = c.routeId.toLowerCase();
      // Route ids start with `<offeringId>::<providerId>`. Local routes
      // come from ollama/vllm in the fixture.
      expect(routeId.includes('ollama') || routeId.includes('vllm')).toBe(true);
    }
    // External routes are rejected by the privacy filter.
    const externalRejections = result.rejectedByStage.filter(
      (r) => r.reason === 'privacy_local_required_but_route_is_external',
    );
    expect(externalRejections.length).toBeGreaterThan(0);
  });

  it('returns NO candidates if no local route satisfies caps', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat', 'audio_generation'], // Ollama fixtures lack audio
        privacyMode: 'local_required',
      },
      { registry },
    );
    expect(result.candidates.length).toBe(0);
  });
});

describe('retriever — privacy: local_preferred', () => {
  it('returns BOTH local and external routes (no hard exclusion)', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        privacyMode: 'local_preferred',
      },
      { registry },
    );
    expect(result.candidates.length).toBeGreaterThan(0);

    const hasLocal = result.candidates.some((c) => {
      const id = c.routeId.toLowerCase();
      return LOCAL_KINDS.has('local') && (id.includes('ollama') || id.includes('vllm'));
    });
    const hasExternal = result.candidates.some((c) => {
      const id = c.routeId.toLowerCase();
      return !id.includes('ollama') && !id.includes('vllm');
    });
    expect(hasLocal).toBe(true);
    expect(hasExternal).toBe(true);
  });

  it('local candidates receive a localPreference boost (>0)', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        privacyMode: 'local_preferred',
      },
      { registry },
    );
    const localCandidates = result.candidates.filter((c) => {
      const id = c.routeId.toLowerCase();
      return id.includes('ollama') || id.includes('vllm');
    });
    expect(localCandidates.length).toBeGreaterThan(0);
    for (const c of localCandidates) {
      expect(c.breakdown.localPreference).toBe(1);
    }
  });

  it('external candidates have localPreference=0', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        privacyMode: 'local_preferred',
      },
      { registry },
    );
    const externalCandidates = result.candidates.filter((c) => {
      const id = c.routeId.toLowerCase();
      return !id.includes('ollama') && !id.includes('vllm');
    });
    expect(externalCandidates.length).toBeGreaterThan(0);
    for (const c of externalCandidates) {
      expect(c.breakdown.localPreference).toBe(0);
    }
  });
});

describe('retriever — privacy: standard (default)', () => {
  it('NO local boost is applied', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        // privacyMode omitted — defaults to standard
      },
      { registry },
    );
    for (const c of result.candidates) {
      expect(c.breakdown.localPreference).toBe(0);
    }
  });

  it('returns both local and external candidates', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    const hasLocal = result.candidates.some((c) => {
      const id = c.routeId.toLowerCase();
      return id.includes('ollama') || id.includes('vllm');
    });
    const hasExternal = result.candidates.some((c) => {
      const id = c.routeId.toLowerCase();
      return !id.includes('ollama') && !id.includes('vllm');
    });
    expect(hasLocal).toBe(true);
    expect(hasExternal).toBe(true);
  });
});
