// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embedder Factory (ADR-022, Sprint 3)
 *
 * Single point that resolves the active embedder for HCRA. Default is
 * `OpenAIEmbedder`; can be overridden via `HCRA_EMBEDDER` env var.
 *
 * Why a factory (not a singleton import):
 * - The worker, the search service, and any future ad-hoc consumer must all
 *   agree on the same embedder identity (otherwise vectors written by one
 *   are flagged stale by another and the worker thrashes).
 * - Env-driven swap allows testing alternative embedders (BGE local, Voyage
 *   API, Cohere) without touching call sites.
 * - Tests inject a stub via `setEmbedderForTest` to avoid network calls.
 */

import type { CapabilityEmbedder } from './embedder';
import { OpenAIEmbedder } from './openai-embedder';

let activeEmbedder: CapabilityEmbedder | null = null;

/**
 * Return the active embedder. Lazy-initialised on first call.
 *
 * Embedder selection (highest precedence first):
 * 1. `setEmbedderForTest` override (tests only).
 * 2. `process.env.HCRA_EMBEDDER` value (`openai` is the only built-in today).
 * 3. Default = `openai`.
 */
export function getCapabilityEmbedder(): CapabilityEmbedder {
  if (activeEmbedder) return activeEmbedder;

  const choice = (process.env.HCRA_EMBEDDER ?? 'openai').toLowerCase();
  // HCRA_EMBEDDER_URL lets us point the embedder at a TEI sidecar or another
  // OpenAI-compatible host without hijacking the global OPENAI_BASE_URL (which
  // would redirect ALL OpenAI SDK calls, including chat completions).
  // When set, we accept any placeholder key — TEI typically runs unauthenticated.
  const hcraUrl = process.env.HCRA_EMBEDDER_URL;
  const hcraModel = process.env.HCRA_EMBEDDER_MODEL;
  switch (choice) {
    case 'openai':
      activeEmbedder = new OpenAIEmbedder({
        apiKey: hcraUrl ? (process.env.OPENAI_API_KEY || 'tei-local') : undefined,
        baseUrl: hcraUrl,
        model: hcraModel,
      });
      return activeEmbedder;
    default:
      throw new Error(
        `Unknown HCRA_EMBEDDER='${choice}'. Supported: 'openai'. Add an implementation under capability/embedder/.`,
      );
  }
}

/**
 * Reset the cached embedder. Used after env changes (test setup) or to
 * force re-construction (e.g. credential rotation).
 */
export function resetCapabilityEmbedder(): void {
  activeEmbedder = null;
}

/**
 * Test hook: inject a custom embedder. Bypasses env resolution. Always reset
 * via `resetCapabilityEmbedder()` in test teardown.
 */
export function setEmbedderForTest(embedder: CapabilityEmbedder): void {
  activeEmbedder = embedder;
}
