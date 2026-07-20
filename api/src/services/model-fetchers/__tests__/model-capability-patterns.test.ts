// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability inference patterns — coverage tests
 *
 * Background (2026-04-28 gap closure → root-cause refactor)
 * ──────────────────────────────────────────────────────────
 * Initial closure (Phase 7) used REGEX patterns to retro-classify 26 model
 * rows with `capabilities = []`. That was a palliative — name-regex sits at
 * the bottom of the 8-source capability fusion hierarchy (weight ≈0.20).
 *
 * Root-cause refactor (2026-04-28): operator-declared capabilities live
 * directly in catalog `pinnedFallback.models[].capabilities`, flowing
 * through the catalog-bridge as primary signal. Regex patterns here are now
 * STRUCTURAL fallbacks ONLY — vendor-family naming conventions (rerank-*,
 * omni-moderation-*, *-transcribe-*, databricks-{dbrx|...}-*, etc.) that
 * aggregator hubs may surface for SKUs we haven't catalogued.
 *
 * Vendor-specific patterns that compensated for missing catalog declarations
 * (palmyra, sonar, ernie, inflection, aqa, relace-apply) were intentionally
 * REMOVED. Those models now flow through the catalog-bridge with operator-
 * declared capabilities — see `provider-runtime-pinned-capabilities.test.ts`
 * for the catalog invariant.
 */

import { describe, it, expect } from 'vitest';
import { inferCapabilitiesFromModelId } from '@/services/model-fetchers/model-capability-patterns';

describe('model-capability-patterns — structural fallback coverage 2026-04-28', () => {
  // ── Structural patterns (vendor-family naming conventions) ──────────────
  // These tests pin behaviour for HUB-AGGREGATOR-surfaced SKUs that fall
  // outside catalog declaration. Catalog-declared families (palmyra, sonar,
  // ernie, inflection, aqa, relace-apply) are NOT covered here — see
  // `provider-runtime-pinned-capabilities.test.ts` for the catalog invariant
  // that asserts every pinned model carries operator-declared capabilities.

  describe('Databricks hub-prefixed variants', () => {
    it('databricks-bge-large-en → embedding/embeddings', () => {
      const r = inferCapabilitiesFromModelId('databricks-bge-large-en');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('embedding');
      expect(r!.capabilities).toContain('embeddings');
    });
    it('databricks-gte-large-en → embedding/embeddings', () => {
      const r = inferCapabilitiesFromModelId('databricks-gte-large-en');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('embedding');
    });
    it('databricks-dbrx-instruct → chat', () => {
      const r = inferCapabilitiesFromModelId('databricks-dbrx-instruct');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
    it('databricks-mixtral-8x7b-instruct → chat', () => {
      const r = inferCapabilitiesFromModelId('databricks-mixtral-8x7b-instruct');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
    it('databricks-mpt-30b-instruct → chat', () => {
      const r = inferCapabilitiesFromModelId('databricks-mpt-30b-instruct');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
    it('databricks-mpt-7b-instruct → chat', () => {
      const r = inferCapabilitiesFromModelId('databricks-mpt-7b-instruct');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
  });

  describe('Avian hub-prefixed (slash-separated, prefix-strip handles)', () => {
    it('moonshotai/kimi-k2.6 → chat', () => {
      const r = inferCapabilitiesFromModelId('moonshotai/kimi-k2.6');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
    it('z-ai/glm-5.1 → chat', () => {
      const r = inferCapabilitiesFromModelId('z-ai/glm-5.1');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('chat');
    });
  });

  describe('Atlascloud media specialty', () => {
    it('kling-v2.0 → video_generation', () => {
      const r = inferCapabilitiesFromModelId('kling-v2.0');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('video_generation');
    });
    it('seedream-3.0 → image_generation', () => {
      const r = inferCapabilitiesFromModelId('seedream-3.0');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('image_generation');
    });
  });

  // ── Dynamic models (native fetcher path with empty capability list) ──────
  // 8 of the 26 untagged DB rows came from native fetchers (cohere/openai/
  // vertex-ai) that returned `capabilities: []`. The fallback inference now
  // catches these.

  describe('Cohere reranking and transcription', () => {
    it('cohere-transcribe-03-2026 → transcription', () => {
      const r = inferCapabilitiesFromModelId('cohere-transcribe-03-2026');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('transcription');
      expect(r!.capabilities).toContain('speech_to_text');
    });
    const rerankIds = [
      'rerank-english-v3.0',
      'rerank-multilingual-v3.0',
      'rerank-v3.5',
      'rerank-v4.0-fast',
      'rerank-v4.0-pro',
    ];
    for (const id of rerankIds) {
      it(`${id} → reranking / retrieval`, () => {
        const r = inferCapabilitiesFromModelId(id);
        expect(r, id).not.toBeNull();
        expect(r!.capabilities).toContain('reranking');
        expect(r!.capabilities).toContain('retrieval');
        expect(r!.modelType).toBe('reranker');
      });
    }
  });

  describe('OpenAI moderation classifiers', () => {
    it('omni-moderation-latest → moderation', () => {
      const r = inferCapabilitiesFromModelId('omni-moderation-latest');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('moderation');
      expect(r!.capabilities).toContain('safety');
      expect(r!.modelType).toBe('moderation');
    });
    it('omni-moderation-2024-09-26 → moderation', () => {
      const r = inferCapabilitiesFromModelId('omni-moderation-2024-09-26');
      expect(r).not.toBeNull();
      expect(r!.capabilities).toContain('moderation');
    });
    it('omni-moderation-* MUST NOT match the chat rule (regex order safety)', () => {
      // `omni-` once accidentally matched the chat rule when the moderation
      // block sat after chat. This guard locks the order in: moderation
      // MUST be evaluated before chat.
      const r = inferCapabilitiesFromModelId('omni-moderation-latest');
      expect(r!.capabilities).not.toContain('chat');
      expect(r!.capabilities).not.toContain('streaming');
    });
  });

  // Vertex AI `aqa` (Attributed QA): no longer pattern-matched here. The
  // Vertex native fetcher reads `supportedGenerationMethods` from API
  // metadata as the primary signal; the OAI-hub aggregator path no longer
  // pretends to know what `aqa` is by name.

  describe('Regex order invariants (regression guard)', () => {
    it('rerank-* matches reranker before chat', () => {
      const r = inferCapabilitiesFromModelId('rerank-english-v3.0');
      expect(r!.modelType).toBe('reranker');
      expect(r!.capabilities).not.toContain('chat');
    });
    it('omni-moderation-* matches moderation before any chat rule', () => {
      const r = inferCapabilitiesFromModelId('omni-moderation-latest');
      expect(r!.modelType).toBe('moderation');
    });
    it('cohere-transcribe-* matches stt before chat', () => {
      const r = inferCapabilitiesFromModelId('cohere-transcribe-03-2026');
      expect(r!.modelType).toBe('stt');
      expect(r!.capabilities).not.toContain('chat');
    });
  });
});
