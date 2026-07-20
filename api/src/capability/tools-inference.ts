// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability → tools heuristic.
 *
 * The "tools" field on metadata is the set of named tool surfaces the model
 * can invoke during execution: 'web_search', 'code_interpreter', etc. These
 * map onto adapter routing decisions (e.g. should we attach the OpenAI
 * web-search tool block, or the Anthropic computer-use block).
 *
 * Until 2026-04-29 only `BaseProviderModelFetcher.extractTools` knew the
 * rule, and only the fetchers that called it inside their own metadata-
 * building blocks populated the field. Models persisted via the central
 * discovery service's six other code paths (bulkUpsertModels,
 * createNewModel and updateExistingModel each have ~2 metadata-construction
 * sites for upsert/update branches) wrote rows with no `tools` key at all.
 *
 * Mirroring the `endpoint-inference` design here gives us the same single
 * source of truth + single normalization seam: every persisted row carries
 * a `tools` key, even when the answer is `[]` ("investigated; no tools
 * surfaced from capabilities"). That `[]`-vs-`undefined` distinction lets
 * downstream filters tell "we know this model has no tools" apart from "we
 * never looked".
 *
 * The heuristic deliberately matches the existing fetcher rule one-to-one
 * during this migration. Expanding the mapping (e.g. function_calling →
 * 'function_calling', vision → 'image_input') is a separate behavior change
 * and belongs in its own commit so the centralization doesn't bundle a
 * silent semantic shift.
 */

const TOOL_CAPABILITY_TO_TOOL_NAME: ReadonlyArray<readonly [string, string]> = [
  ['web_search', 'web_search'],
  ['code_interpreter', 'code_interpreter'],
  ['file_search', 'file_search'],
  ['mcp', 'mcp'],
];

type LooseMetadata = {
  tools?: unknown;
  [key: string]: unknown;
} | null | undefined;

/**
 * Returns the tool slugs for a model given its capabilities and (optional)
 * metadata. If `metadata.tools` is already an array, it wins — the fetcher
 * knows better than the heuristic, including the case where it deliberately
 * stored `[]` to mean "investigated; no tools".
 *
 * The output is order-stable: tools appear in the order their source
 * capabilities are listed in TOOL_CAPABILITY_TO_TOOL_NAME, regardless of
 * the order in `capabilities`. Stable order makes diff-based change
 * detection in downstream consumers simpler.
 */
export function inferTools(
  capabilities: readonly string[],
  metadata?: LooseMetadata,
): string[] {
  if (Array.isArray(metadata?.tools)) {
    return metadata.tools.filter((t): t is string => typeof t === 'string');
  }

  const caps = new Set<string>(capabilities);
  const tools: string[] = [];
  for (const [capability, tool] of TOOL_CAPABILITY_TO_TOOL_NAME) {
    if (caps.has(capability)) tools.push(tool);
  }
  return tools;
}

/**
 * Returns a metadata object with `tools` set, inferring it if missing or
 * not an array. Used by the discovery-service persistence paths so every
 * persisted row carries the field — see the seven call sites in
 * `central-model-discovery-service.ts`.
 *
 * Distinct from `inferTools` in that it preserves `metadata.tools = []`
 * when present (the fetcher chose to record an empty list). Only an
 * absent or malformed `tools` field is replaced.
 *
 * The input is not mutated.
 */
export function withInferredTools<T extends Record<string, unknown>>(
  metadata: T,
  capabilities: readonly string[],
): T & { tools: string[] } {
  if (Array.isArray(metadata.tools)) {
    return metadata as T & { tools: string[] };
  }
  return { ...metadata, tools: inferTools(capabilities, metadata) };
}
