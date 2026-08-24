// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Function-calling routing guard (2026-08-20 incident, request
 * 91YJ-kZPPLHjodsSSKLkz): when `chatRequest.tools` is present, EVERY selection
 * path (streaming fast path, non-streaming orchestration, primary AND
 * fallbacks) must only execute models that can actually carry tool calls.
 *
 * The catalog/DB selection layers already hard-filter candidates by declared
 * capabilities — but the model that is FINALLY RESOLVED from the provider
 * registry can diverge from the catalog row (different provider variant,
 * stale vendor listing). The incident showed registry-resolved models whose
 * printed capabilities were `["chat","text_generation","streaming"]` — no
 * function_calling — being executed for a tools request after passing the
 * DB-side filter.
 *
 * Semantics (conservative, operator-confirmed):
 *   - A model COUNTS as function-calling-capable only when the capability is
 *     EXPLICITLY declared. Never inferred from name/keywords.
 *   - Re-validation REJECTS a resolved model only when its capabilities are
 *     explicitly declared AND function_calling is absent. Missing/empty
 *     metadata means "unknown" and is allowed through — rejecting unknowns
 *     would empty the chain for providers that don't populate capabilities.
 */

import type { Model } from '@/types';

export type CapabilityBearer = Pick<Model, 'capabilities'>;

/** True when the request carries tools and therefore requires function calling. */
export function requestRequiresFunctionCalling(tools: unknown): boolean {
  return Array.isArray(tools) && tools.length > 0;
}

/** True only when `function_calling` is explicitly declared on the model. */
export function hasDeclaredFunctionCalling(model: CapabilityBearer): boolean {
  return (
    Array.isArray(model.capabilities) && model.capabilities.includes('function_calling')
  );
}

/**
 * Re-validation predicate for REGISTRY-resolved models: reject only on an
 * explicit, non-empty capability list that lacks function_calling.
 */
export function explicitlyLacksFunctionCalling(model: CapabilityBearer): boolean {
  return (
    Array.isArray(model.capabilities) &&
    model.capabilities.length > 0 &&
    !model.capabilities.includes('function_calling')
  );
}
