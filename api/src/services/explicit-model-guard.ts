// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Explicit-model existence guard.
 *
 * Measured defect: `POST /v1/chat/completions` with
 * `"model": "definitely-not-a-real-model-xyz"` returned 200. The id never
 * existed in any provider, but nothing on the request path checks that. The
 * pin is carried as a HINT (`preferredModelIds`), and every consumer of that
 * hint treats "not in the pool" as a reason to fall through to automatic
 * selection:
 *
 *   - `single-model-strategy.ts` — "User-specified model not found in
 *     available models" → warn, then delegate to DynamicModelSelector
 *   - `preferred-model-helper.ts` — `pinReason: 'pin-not-in-pool'` → legacy
 *     quality-sort selection
 *   - `orchestration-engine.ts` streaming plan — `planStreaming` returns a
 *     dynamic pick, so the "no suitable model" throw never fires
 *
 * That fall-through is DELIBERATE and stays: a pinned model filtered out by a
 * health, balance or capability gate should still be answered rather than
 * 404'd. What was missing is the distinction between "your model exists but is
 * currently unusable" (degrade, keep serving) and "your model does not exist"
 * (a client bug, and silently answering it with a different model is worse than
 * an error — the caller has no way to learn the id was wrong, and gets billed
 * for a model it never asked for).
 *
 * This guard draws exactly that line, at the edge, before any orchestration
 * work is started. It is deliberately narrow:
 *
 *   - it only runs for a pin the CLIENT wrote (`auto`, `ailin-*` aliases and an
 *     absent model are all "no pin");
 *   - it only asks "does this id or name exist in the catalog at all", the same
 *     `id === x || name === x` predicate every downstream resolver uses, over
 *     the WHOLE catalog (not the 100-row recency window);
 *   - it FAILS OPEN. A catalog lookup that throws yields `indeterminate`, never
 *     a rejection: an unreachable database must not turn every pinned request
 *     into a 404.
 */
import { getModelRepository } from '@/services/model-repository';
import type { ChatRequest } from '@/types';
import { getUserSpecifiedModelFlag } from '@/types/chat-request-extended';
import type { ChatRequestWithMetadata } from '@/types/chat-request-extended';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'explicit-model-guard' });

export interface ExplicitModelCheck {
  /** The id/name the client pinned, or `null` when it pinned nothing. */
  requestedModel: string | null;
  /** True when the pinned id resolves to at least one catalog row. */
  exists: boolean;
  /**
   * True when the check could not be carried out (catalog unreachable). The
   * caller MUST let the request through in this case.
   */
  indeterminate: boolean;
  /** How many catalog rows carry this id/name (same id ships under N providers). */
  matchCount: number;
}

const PASS_THROUGH: ExplicitModelCheck = {
  requestedModel: null,
  exists: true,
  indeterminate: false,
  matchCount: 0,
};

/**
 * Returns the client-pinned model id, or `null` when the request did not pin
 * one. `auto`, an `ailin-*` alias (already rewritten by the route normalizer)
 * and an absent/blank model all count as "not pinned".
 */
export function getPinnedModelId(request: ChatRequest | ChatRequestWithMetadata): string | null {
  if (typeof request.model !== 'string') return null;
  const model = request.model.trim();
  if (model.length === 0) return null;
  if (model.toLowerCase() === 'auto') return null;
  if (!getUserSpecifiedModelFlag(request)) return null;
  return model;
}

/**
 * Resolves whether the client-pinned model exists anywhere in the catalog.
 * Never throws: an unreachable catalog is reported as `indeterminate`.
 */
export async function checkExplicitModelExists(
  request: ChatRequest | ChatRequestWithMetadata
): Promise<ExplicitModelCheck> {
  const requestedModel = getPinnedModelId(request);
  if (!requestedModel) return PASS_THROUGH;

  try {
    // findModelsByIdOrName, not searchModels: the latter silently caps at the
    // 100 most recently discovered rows, which would turn this guard into a
    // generator of false 404s for every older model in the catalog.
    const rows = await getModelRepository().findModelsByIdOrName(requestedModel);
    return {
      requestedModel,
      exists: rows.length > 0,
      indeterminate: false,
      matchCount: rows.length,
    };
  } catch (error) {
    log.warn(
      { error, requestedModel },
      'Explicit-model existence check failed; admitting the request (fail-open)'
    );
    return { requestedModel, exists: true, indeterminate: true, matchCount: 0 };
  }
}

export interface UnknownModelErrorBody {
  error: {
    message: string;
    type: 'invalid_request_error';
    code: 'model_not_found';
    param: 'model';
  };
}

/**
 * OpenAI-compatible 404 body for an id that exists in no provider. Mirrors the
 * shape `GET /v1/models/{id}` and `POST /v1/embeddings` already return, so a
 * client sees one "unknown model" contract across the whole surface.
 */
export function unknownModelErrorBody(requestedModel: string): UnknownModelErrorBody {
  return {
    error: {
      message: `The model '${requestedModel}' does not exist or is not available. Use GET /v1/models to list available models, or omit "model" (or send "auto") to let orchestration choose one.`,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
    },
  };
}
