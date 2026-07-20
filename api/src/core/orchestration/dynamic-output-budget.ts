// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dynamic output-token budgeting — derive a request's `max_tokens` from the
 * SELECTED model's own declared capability, never a static/pinned constant.
 *
 * WHY: the project's hard rule is "no static/pinned — everything dynamic". A
 * fixed output ceiling (e.g. 8192, 1024, 2000) both violates that rule and
 * caps the whole benchmark BELOW frontier output — a frontier model that can
 * emit 32k–256k tokens gets silently clipped, and a clipped answer is scored as
 * a worse answer, biasing the single-vs-collective comparison. The correct
 * value is the model's OWN `maxOutputTokens` (Model.maxOutputTokens, seeded
 * 16k–256k per model), which is exact (never over-asks beyond what the provider
 * supports) and per-model (a frontier model gets its full length; a small model
 * gets its own). Input/context parity is handled separately (up to 10M tokens,
 * per-model contextWindow gate — see selection-criteria-validator).
 */

/**
 * Output ceiling to REQUEST for a concrete model, derived from its own declared
 * capability. Returns `undefined` when the model declares no output limit AND no
 * context window (unknown capability → let the provider apply its own default
 * rather than invent a number). Callers stamp `max_tokens` only when a positive
 * value is returned.
 *
 * Note: when `maxOutputTokens` is 0 (catalog / execution-only entries that never
 * had it populated) we fall back to a fraction of the context window — still the
 * model's OWN capability, not a magic frontier constant — so a long answer is
 * not clipped to a provider's stingy default. The real fix for those is to
 * populate `maxOutputTokens` in the catalog.
 */
export function deriveModelMaxOutputTokens(model: {
  maxOutputTokens?: number | null;
  contextWindow?: number | null;
}): number | undefined {
  const declared = Number(model?.maxOutputTokens);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const ctx = Number(model?.contextWindow);
  if (Number.isFinite(ctx) && ctx > 0) {
    // Reserve most of the window for the input; allow a generous output slice.
    // A fraction of the model's OWN window — dynamic, not a fixed frontier value.
    return Math.max(1024, Math.floor(ctx / 2));
  }
  return undefined;
}

/**
 * Resolve the effective `max_tokens` for a request against a concrete model:
 * honor an explicit positive client value (the caller chose the length), else
 * derive from the model's capability. Returns `undefined` only when neither is
 * available.
 */
export function resolveDynamicMaxTokens(
  clientMaxTokens: number | null | undefined,
  model: { maxOutputTokens?: number | null; contextWindow?: number | null },
): number | undefined {
  const client = Number(clientMaxTokens);
  if (Number.isFinite(client) && client > 0) return client;
  return deriveModelMaxOutputTokens(model);
}
