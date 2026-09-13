// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hub fetcher — model-list body-shape contract (LOTE AK, 2026-09-04).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Three catalog rows (writer, atlascloud, avian) carried a hand-curated
 * `pinnedFallback` inventory for months on the recorded premise that their
 * `/models` body was "a non-OAI shape the default hub discovery parser
 * cannot consume". That premise was false: `extractRawModels` sweeps
 * `data | models | results | items | entries` and also accepts a bare
 * top-level array, so all three bodies were always readable.
 *
 * A hardcoded inventory is the most expensive thing in this repo to carry —
 * it silently rots (perplexity's pin still named retired sonar-*-online SKUs;
 * atlascloud's named ids the live host does not serve). So the parser's
 * shape coverage must be an ASSERTED CONTRACT, not folklore recorded in a
 * catalog comment. If someone narrows `extractRawModels`, these rows lose
 * discovery silently — this test fails first.
 *
 * Each case below is the real body shape observed on that vendor's live
 * endpoint during the 2026-09-04 probe sweep, reduced to its structure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubModelFetcher } from '@/services/model-fetchers/openai-compatible-hub-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetcherFor(providerName: string, baseUrl: string): OpenAICompatibleHubModelFetcher {
  return new OpenAICompatibleHubModelFetcher({
    providerName,
    apiKey: 'probe-key',
    baseUrl,
    modelListPaths: ['/models'],
  });
}

describe('hub fetcher — /models body shapes that catalog rows depend on', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Writer's `{models: [...]}` envelope (was believed unparseable)", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        models: [
          { id: 'palmyra-x5', name: 'Palmyra X5' },
          { id: 'palmyra-med', name: 'Palmyra Med' },
        ],
      })
    );

    const models = await fetcherFor('writer', 'https://api.writer.com/v1').getModels();

    expect(models.map((m) => m.id)).toEqual(['palmyra-x5', 'palmyra-med']);
  });

  it("reads AtlasCloud's `{code, msg, data: [...]}` wrapper", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        msg: 'succeed',
        data: [
          {
            id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
            object: 'model',
            owned_by: 'custom',
          },
        ],
      })
    );

    const models = await fetcherFor('atlascloud', 'https://api.atlascloud.ai/v1').getModels();

    // Vendor-prefixed ids must survive intact — stripping the vendor segment
    // would make the id unroutable on this host.
    expect(models.map((m) => m.id)).toEqual(['Qwen/Qwen3-235B-A22B-Instruct-2507']);
  });

  it("reads Avian's pure OpenAI `{object: 'list', data: [...]}` body with its metadata", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'deepseek/deepseek-v4-flash',
            object: 'model',
            owned_by: 'DeepSeek',
            display_name: 'DeepSeek V4 Flash',
            context_length: 1_000_000,
          },
        ],
      })
    );

    const models = await fetcherFor('avian', 'https://api.avian.io/v1').getModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('deepseek/deepseek-v4-flash');
    // The pinned list this replaced carried neither of these — that loss of
    // fidelity is the concrete cost a hardcoded inventory was imposing.
    expect(models[0].displayName).toBe('DeepSeek V4 Flash');
    expect(models[0].contextWindow).toBe(1_000_000);
  });

  it('reads a bare top-level array (no envelope at all)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([{ id: 'sonar-pro' }, { id: 'sonar-reasoning-pro' }])
    );

    const models = await fetcherFor('perplexity', 'https://api.perplexity.ai').getModels();

    expect(models.map((m) => m.id)).toEqual(['sonar-pro', 'sonar-reasoning-pro']);
  });

  it('returns nothing rather than inventing rows when the envelope key is unknown', async () => {
    // Guard against the opposite failure mode: a body we genuinely cannot
    // read must yield ZERO models, never a fabricated or partially-guessed
    // inventory. Discovery reporting "0 models" is the honest signal that
    // sends an operator to the parser.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ unexpectedEnvelope: [{ id: 'ghost-model' }] })
    );

    const models = await fetcherFor('unknown-shape', 'https://example.invalid/v1').getModels();

    expect(models).toEqual([]);
  });
});
