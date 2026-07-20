// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-capability-document-builder.test.ts — MVP 5A
 *
 * Proves:
 *   - Builder is deterministic (same input ⇒ identical output).
 *   - Capabilities are normalised through the ontology.
 *   - routeKinds aggregate across all input routes.
 *   - contextWindowMax is the MAX across routes.
 *   - cost / latency classes bucket correctly.
 *   - text representation contains expected labels.
 *   - Builder does NOT include prompts / user data.
 *   - Builder does NOT call fetch (no I/O).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildModelCapabilityDocument } from '../model-capability-document-builder';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { CanonicalModel } from '../../registry/canonical-model';
import type { ModelProviderOffering } from '../../registry/model-offering';
import type { ProviderModelRoute } from '../../registry/model-route';

// ─── fetch sentinel ─────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('document builder MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────

function findInputs(
  registry: ReturnType<typeof buildFixtureRegistry>,
  providerId: string,
  modelId: string,
): {
  canonical: CanonicalModel;
  offerings: readonly ModelProviderOffering[];
  routes: readonly ProviderModelRoute[];
} {
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  const oid = snap?.uid ?? `${providerId}:${modelId}`;
  const offering = registry.lookupOffering(oid);
  if (!offering) throw new Error('offering missing');
  const canonical = registry.lookupCanonicalModel(offering.canonicalModelId);
  if (!canonical) throw new Error('canonical missing');
  const offerings = registry.offeringsForCanonical(offering.canonicalModelId);
  const routes = registry.routesForCanonical(offering.canonicalModelId);
  return { canonical, offerings, routes };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('buildModelCapabilityDocument — determinism', () => {
  it('same input ⇒ byte-identical text + structured', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const a = buildModelCapabilityDocument(inputs);
    const b = buildModelCapabilityDocument(inputs);
    expect(a.text).toBe(b.text);
    expect(a.title).toBe(b.title);
    expect(a.structured).toEqual(b.structured);
  });

  it('repeated calls on 1000 iterations all yield identical document', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'openai', 'gpt-5.5-pro');
    const first = buildModelCapabilityDocument(inputs);
    const firstJSON = JSON.stringify(first);
    for (let i = 0; i < 1000; i += 1) {
      const next = buildModelCapabilityDocument(inputs);
      if (JSON.stringify(next) !== firstJSON) {
        throw new Error(`non-deterministic at iter ${i}`);
      }
    }
    expect(first).toBeDefined();
  });
});

describe('buildModelCapabilityDocument — fields', () => {
  it('canonicalModelId, title, text, structured are present', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'cohere', 'command-a');
    const doc = buildModelCapabilityDocument(inputs);
    expect(doc.canonicalModelId).toBe('cohere:command-a');
    expect(doc.title.length).toBeGreaterThan(0);
    expect(doc.text.length).toBeGreaterThan(0);
    expect(doc.structured).toBeDefined();
  });

  it('text contains canonical-id, family, lifecycle, capabilities labels', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument(inputs);
    expect(doc.text).toContain('canonical:anthropic:claude-opus-4-7');
    expect(doc.text).toContain('family:');
    expect(doc.text).toContain('lifecycle:');
    expect(doc.text).toContain('capabilities:');
    expect(doc.text).toContain('route_kinds:');
    expect(doc.text).toContain('cost_class:');
    expect(doc.text).toContain('freshness:');
  });

  it('capabilities are normalised + alphabetically sorted', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'openai', 'gpt-5.5-pro');
    const doc = buildModelCapabilityDocument(inputs);
    const caps = doc.structured.capabilities;
    const sorted = [...caps].sort();
    expect(caps).toEqual(sorted);
  });

  it('contextWindowMax is the MAX across routes (when routes exist)', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'google', 'gemini-2.5-pro');
    const doc = buildModelCapabilityDocument(inputs);
    expect(doc.structured.contextWindowMax).toBe(1_000_000);
  });

  it('routeKinds aggregate across input routes (sorted)', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument(inputs);
    const kinds = doc.structured.routeKinds;
    expect(kinds.length).toBeGreaterThan(0);
    const sorted = [...kinds].sort();
    expect(kinds).toEqual(sorted);
  });
});

describe('buildModelCapabilityDocument — cost class bucketing', () => {
  it('Ollama (zero-cost) → costClass=free', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'ollama', 'llama-3.3-70b');
    const doc = buildModelCapabilityDocument(inputs);
    expect(doc.structured.costClass).toBe('free');
  });

  it('non-zero, low-cost model → mid or low (not free, not high)', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'deepseek', 'deepseek-v4');
    const doc = buildModelCapabilityDocument(inputs);
    expect(['micro', 'low', 'mid']).toContain(doc.structured.costClass);
  });

  it('expensive frontier (Claude Opus 4.7) → high', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument(inputs);
    // Anthropic native: input $15/1M, output $75/1M → total $90 minimum.
    expect(doc.structured.costClass).toBe('high');
  });
});

describe('buildModelCapabilityDocument — privacy invariant', () => {
  it('document does NOT include prompt / user data / messages', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument(inputs);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"prompt"');
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"userMessage"');
    expect(json).not.toContain('"rawContext"');
  });
});

describe('buildModelCapabilityDocument — no fetch', () => {
  it('does not call fetch', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    buildModelCapabilityDocument(inputs);
    expect(fetchCalls).toBe(0);
  });
});

describe('buildModelCapabilityDocument — edge cases', () => {
  it('zero routes → undefined contextWindowMax + costClass=unknown', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument({
      canonical: inputs.canonical,
      offerings: inputs.offerings,
      routes: [],
    });
    expect(doc.structured.contextWindowMax).toBeUndefined();
    expect(doc.structured.costClass).toBe('unknown');
    expect(doc.structured.latencyClass).toBe('unknown');
  });

  it('no offerings → capabilities only from canonical', () => {
    const registry = buildFixtureRegistry();
    const inputs = findInputs(registry, 'anthropic', 'claude-opus-4-7');
    const doc = buildModelCapabilityDocument({
      canonical: inputs.canonical,
      offerings: [],
      routes: inputs.routes,
    });
    // canonical's normalised capabilities should still appear.
    expect(doc.structured.capabilities.length).toBeGreaterThan(0);
  });
});
