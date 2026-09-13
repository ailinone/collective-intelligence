// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Replicate pinnedFallback — tool-calling capability correction (2026-09-09)
 * and dead-pin follow-up (same day).
 *
 * ## What was wrong
 *
 * `ReplicateAdapter#chatCompletion` / `#chatCompletionStream`
 * (api/src/providers/replicate/replicate-adapter.ts) build every Replicate
 * prediction's `input` from ONLY `{prompt, max_tokens, temperature, top_p}`
 * via `messagesToPrompt()`. There is no code path that forwards
 * `ChatRequest.tools` / `tool_choice` into a Replicate prediction, for any
 * model. Despite that, the catalog's `pinnedFallback.models` for the
 * `replicate` provider claimed `function_calling`/`tool_use` for three
 * entries: `anthropic/claude-3.5-sonnet`, `meta/meta-llama-3-70b-instruct`,
 * and `openai/gpt-4o-mini` — and `json_mode` for `openai/gpt-4o-mini`. Any
 * router that used those declared capabilities to pick a model for a
 * tool-calling request would silently degrade to a plain-text completion:
 * the model never sees the tool/function definitions and no error surfaces.
 *
 * ## Why the fix is a catalog correction, not an adapter feature
 *
 * Replicate has no universal request schema — each hosted model's Cog
 * wrapper defines its own `openapi_schema.input`, fundamentally unlike
 * OpenAI-compatible APIs. Live schema fetches on 2026-09-09
 * (`GET https://replicate.com/{owner}/{name}/api/schema`) confirmed:
 *
 *   - `anthropic/claude-3.5-sonnet` — the model page now 404s; Replicate
 *     has removed it (claude-3.7-sonnet also 404s). The still-live
 *     `anthropic/claude-4-sonnet` wrapper (same publisher/Cog-wrapper
 *     lineage) exposes only `{image, prompt, max_tokens, system_prompt,
 *     extended_thinking, max_image_resolution, thinking_budget_tokens}` —
 *     no `tools`/`tool_choice` field anywhere in the Anthropic-on-Replicate
 *     wrapper family, current or historical.
 *   - `meta/meta-llama-3-70b-instruct` — input schema is exactly `{prompt,
 *     max_tokens, min_tokens, temperature, top_p, top_k, prompt_template,
 *     presence_penalty, frequency_penalty}`. No tools field.
 *   - `openai/gpt-4o-mini` — input schema is exactly `{prompt, messages,
 *     image_input, system_prompt, temperature, top_p,
 *     max_completion_tokens, presence_penalty, frequency_penalty}`. No
 *     `tools`/`tool_choice` field, and no `response_format` field either
 *     (so the `json_mode` claim was equally unearned).
 *
 * `vision`/`multimodal` are kept for the Anthropic entry (`image` field) and
 * `openai/gpt-4o-mini` (`image_input` field) — those are real, schema-backed
 * fields, unlike the removed tool-calling/json-mode claims.
 *
 * ## Dead-pin follow-up (same day)
 *
 * Since `anthropic/claude-3.5-sonnet` itself 404s on Replicate (confirmed
 * above), the catalog id was swapped to `anthropic/claude-4-sonnet` — the
 * still-live model whose schema was the actual source of the capability
 * evidence quoted above, so the capability list did not need to change.
 * `mistralai/mistral-7b-instruct-v0.2` also 404s and was removed outright:
 * the natural replacement, `mistralai/mistral-7b-instruct-v0.1`, returns
 * HTTP 200 on its model page but has zero pushed versions (confirmed on its
 * `/versions` page and by its own `/api/schema` 404), so it is not a
 * runnable substitute either.
 *
 * This test locks the correction in so a future edit can't silently
 * re-introduce the false claim, or re-pin a 404'd model id, without
 * deliberately touching this file. See also `replicate-adapter.test.ts` →
 * "tool-calling capability gap", which pins the adapter-side behavior
 * (tools silently dropped, not forwarded), and
 * `pinned-fallback-capability-coverage.test.ts`, which enforces the general
 * structural invariants for `pinnedFallback` entries.
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import {
  normalizePinnedModelEntry,
  type PinnedModelEntry,
} from '@/providers/catalog/provider-catalog.types';

function getReplicatePinnedModels(): Array<{ id: string; capabilities: readonly string[] }> {
  const replicate = PROVIDER_CATALOG.find((p) => p.providerId === 'replicate');
  if (!replicate) {
    throw new Error('replicate provider row not found in PROVIDER_CATALOG');
  }
  const models = replicate.pinnedFallback?.models as readonly PinnedModelEntry[] | undefined;
  if (!models) {
    throw new Error('replicate provider row has no pinnedFallback.models');
  }
  return models.map((raw) => normalizePinnedModelEntry(raw));
}

describe('Replicate pinnedFallback — tool-calling capability correction (2026-09-09)', () => {
  const models = getReplicatePinnedModels();

  function capsFor(id: string): readonly string[] {
    const entry = models.find((m) => m.id === id);
    if (!entry) {
      throw new Error(`pinned model '${id}' not found in replicate pinnedFallback.models`);
    }
    return entry.capabilities;
  }

  it.each([
    'anthropic/claude-4-sonnet',
    'meta/meta-llama-3-70b-instruct',
    'openai/gpt-4o-mini',
  ])(
    '%s does not claim function_calling or tool_use (no `tools` field in the live Replicate schema, and the adapter never forwards tools regardless)',
    (id) => {
      const caps = capsFor(id);
      expect(caps).not.toContain('function_calling');
      expect(caps).not.toContain('tool_use');
    }
  );

  it('openai/gpt-4o-mini does not claim json_mode (no `response_format` field in the live Replicate schema)', () => {
    expect(capsFor('openai/gpt-4o-mini')).not.toContain('json_mode');
  });

  it('vision/multimodal stay declared where the live schema has a real image field', () => {
    // anthropic/claude-4-sonnet: `image` field, confirmed directly on the
    // live 2026-09-09 fetch. openai/gpt-4o-mini: `image_input` field, also
    // confirmed live.
    expect(capsFor('anthropic/claude-4-sonnet')).toEqual(
      expect.arrayContaining(['vision', 'multimodal'])
    );
    expect(capsFor('openai/gpt-4o-mini')).toEqual(expect.arrayContaining(['vision', 'multimodal']));
  });

  it('still-honest capabilities were not collapsed away by the correction', () => {
    // Regression guard against overcorrection: chat/streaming remain true
    // for all three (messagesToPrompt()-based prompt building genuinely
    // works for all of them), and reasoning stays on the Anthropic entry.
    expect(capsFor('anthropic/claude-4-sonnet')).toEqual(
      expect.arrayContaining(['chat', 'streaming', 'reasoning'])
    );
    expect(capsFor('meta/meta-llama-3-70b-instruct')).toEqual(
      expect.arrayContaining(['chat', 'streaming'])
    );
    expect(capsFor('openai/gpt-4o-mini')).toEqual(expect.arrayContaining(['chat', 'streaming']));
  });
});

describe('Replicate pinnedFallback — dead-pin follow-up (2026-09-09)', () => {
  const models = getReplicatePinnedModels();
  const ids = models.map((m) => m.id);

  it.each(['anthropic/claude-3.5-sonnet', 'anthropic/claude-3.7-sonnet'])(
    'does not pin %s — its Replicate model page 404s (Replicate removed it)',
    (deadId) => {
      expect(ids).not.toContain(deadId);
    }
  );

  it('pins anthropic/claude-4-sonnet instead of the dead claude-3.5-sonnet id', () => {
    expect(ids).toContain('anthropic/claude-4-sonnet');
  });

  it('does not pin mistralai/mistral-7b-instruct-v0.2 — its Replicate model page 404s', () => {
    expect(ids).not.toContain('mistralai/mistral-7b-instruct-v0.2');
  });

  it('does not pin mistralai/mistral-7b-instruct-v0.1 as a replacement — it has zero pushed versions on Replicate (base page 200s, but /api/schema 404s and /versions says "No versions have been pushed")', () => {
    expect(ids).not.toContain('mistralai/mistral-7b-instruct-v0.1');
  });
});
