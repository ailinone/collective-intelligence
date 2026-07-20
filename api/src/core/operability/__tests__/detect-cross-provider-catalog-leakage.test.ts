// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §9 — Tests for catalog cross-provider leakage detector.
 *
 * Pins the exact G3 evidence cases:
 *   - perplexity row with id="openai/gpt-5.5" → LEAKAGE (suggests provider=openai)
 *   - sambanova row with id="MiniMax-M2.7" → NOT detected by this rule
 *     (no slash prefix). The signal here was the response body, not the id.
 *   - sambanova row with id="minimax/m2.7" → LEAKAGE (when id IS slash-prefixed)
 *   - replicate row with id="mistralai/mistral-7b" → OK (replicate is a
 *     known hub provider that legitimately hosts namespaced ids)
 *   - perplexity row with id="llama-3.1-sonar-large" → OK (no namespace)
 */
import { describe, it, expect } from 'vitest';
import {
  detectModelLeakage,
  detectCrossProviderCatalogLeakage,
  type CatalogModelLike,
} from '../detect-cross-provider-catalog-leakage';

describe('detectModelLeakage — single-model audit', () => {
  it('flags perplexity row with id="openai/gpt-5.5" as LEAKAGE', () => {
    const f = detectModelLeakage({ id: 'openai/gpt-5.5', provider: 'perplexity' });
    expect(f.severity).toBe('leakage');
    expect(f.detectedNamespace).toBe('openai');
    expect(f.suggestedFix).toContain('openai');
  });

  it('flags sambanova row with id="minimax/m2.7" as LEAKAGE', () => {
    const f = detectModelLeakage({ id: 'minimax/m2.7', provider: 'sambanova' });
    expect(f.severity).toBe('leakage');
    expect(f.detectedNamespace).toBe('minimax');
  });

  it('does NOT flag replicate row with id="mistralai/mistral-7b" (hub host)', () => {
    const f = detectModelLeakage({ id: 'mistralai/mistral-7b', provider: 'replicate' });
    expect(f.severity).toBe('ok');
    expect(f.reason).toContain('hub');
  });

  it('does NOT flag openrouter row with id="anthropic/claude-3.5" (hub host)', () => {
    const f = detectModelLeakage({ id: 'anthropic/claude-3.5', provider: 'openrouter' });
    expect(f.severity).toBe('ok');
  });

  it('does NOT flag perplexity row with id="llama-3.1-sonar-large" (no namespace)', () => {
    const f = detectModelLeakage({ id: 'llama-3.1-sonar-large', provider: 'perplexity' });
    expect(f.severity).toBe('ok');
    expect(f.reason).toBe('no_namespace_prefix');
  });

  it('flags openai row with id="openai/openai-gpt-5.1-mini" as SUSPICIOUS (double-prefix)', () => {
    const f = detectModelLeakage({ id: 'openai/openai-gpt-5.1-mini', provider: 'openai' });
    expect(f.severity).toBe('suspicious');
    expect(f.suggestedFix).toContain('PROVIDER_MODEL_ALIASES');
  });

  it('does NOT flag when upstreamProvider field matches the namespace (legitimate)', () => {
    const f = detectModelLeakage({
      id: 'meta/llama-3.2-11b',
      provider: 'someprovider',
      upstreamProvider: 'meta',
    });
    expect(f.severity).toBe('ok');
    expect(f.reason).toContain('upstream');
  });

  it('flags unknown namespace as SUSPICIOUS (not leakage)', () => {
    const f = detectModelLeakage({ id: 'mycorp/secret-model', provider: 'someprovider' });
    expect(f.severity).toBe('suspicious');
    expect(f.detectedNamespace).toBe('mycorp');
  });

  it('handles empty model id gracefully', () => {
    const f = detectModelLeakage({ id: '', provider: 'someprovider' });
    expect(f.severity).toBe('ok');
    expect(f.reason).toBe('empty_model_id');
  });
});

describe('detectCrossProviderCatalogLeakage — full-catalog audit', () => {
  it('aggregates findings by severity', () => {
    const catalog: CatalogModelLike[] = [
      { id: 'openai/gpt-5.5', provider: 'perplexity' },           // leakage
      { id: 'minimax/m2.7', provider: 'sambanova' },              // leakage
      { id: 'llama-3.1-sonar', provider: 'perplexity' },          // ok
      { id: 'anthropic/claude-3.5', provider: 'openrouter' },     // ok (hub)
      { id: 'mistralai/mistral-7b', provider: 'replicate' },      // ok (hub)
      { id: 'openai/openai-gpt-5.1-mini', provider: 'openai' },   // suspicious (double-prefix)
      { id: 'custom/model-x', provider: 'cohere' },               // suspicious (unknown namespace)
    ];
    const report = detectCrossProviderCatalogLeakage(catalog);
    expect(report.total).toBe(7);
    expect(report.leakage).toBe(2);
    expect(report.suspicious).toBe(2);
    expect(report.ok).toBe(3);
    expect(report.findings).toHaveLength(7);
  });

  it('groups counts by provider', () => {
    const report = detectCrossProviderCatalogLeakage([
      { id: 'openai/gpt-5.5', provider: 'perplexity' },
      { id: 'openai/gpt-6', provider: 'perplexity' },
      { id: 'llama-3.1-sonar', provider: 'perplexity' },
    ]);
    expect(report.byProvider.perplexity).toEqual({ leakage: 2, suspicious: 0, ok: 1 });
  });

  it('produces an empty report for empty input', () => {
    const report = detectCrossProviderCatalogLeakage([]);
    expect(report.total).toBe(0);
    expect(report.leakage).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('case-insensitive on provider and namespace comparison', () => {
    const f = detectModelLeakage({ id: 'OpenAI/gpt-5.5', provider: 'Perplexity' });
    expect(f.severity).toBe('leakage');
    expect(f.detectedNamespace).toBe('openai');
  });
});
