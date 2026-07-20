// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Helper to create OrchestrationContext from FastifyRequest
 * Ensures all required fields are present.
 *
 * ─── Caminho-C closure (2026-04-29) ──────────────────────────────────────
 * `OrchestrationContext` carries two fields that the strategy layer + the
 * `DynamicModelSelector` depend on:
 *
 *   - `preferredModelIds`: the user's explicit model pin. Strategies use
 *     it as a strong hint when picking analyzer / executor / synthesizer
 *     slots. (Caminho-C Q2/Q3 — 27/27 strategies honor it.)
 *
 *   - `semanticQuery`: free-text last-user-message snippet, capped at 200
 *     chars. The selector forwards it to `CapabilitySearchService` for
 *     RRF-fused (lexical + vector) candidate reranking. With it empty,
 *     the rerank is a no-op and we fall back to 6-component scoring
 *     (Caminho-C Q4).
 *
 * The canonical chat-style flow (chat / extended-thinking / responses /
 * capability-execution-service / pdf-service) all funnel through
 * `OrchestrationEngine.execute(chatRequest, orgId, userId)`, which rebuilds
 * the context internally from `chatRequest.messages` + `chatRequest.model`
 * + the `user_specified_model` flag. So those routes don't *need* the
 * helper to populate these fields — the engine fills them in.
 *
 * BUT: routes that bypass the engine and consume the route-level
 * `userContext` directly (admin tools, eval harnesses, future entry
 * points) need a clean way to seed these two fields without re-implementing
 * extraction logic. The helper now exposes `semanticQuery` /
 * `preferredModelIds` options, plus two pure utilities mirroring the
 * engine's extraction logic so the contract stays in sync.
 */

import type { FastifyRequest } from 'fastify';
import type {
  OrchestrationContext,
  TaskType,
  Model,
  ChatMessage,
} from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Maximum characters extracted from the last user message into
 * `semanticQuery`. Mirrors the cap in
 * `OrchestrationEngine.extractTaskSummary`.
 *
 * The 200-char ceiling is a deliberate trade-off: long enough to capture
 * the user's intent in most queries, short enough to keep the embedding
 * round-trip cheap and the RRF fusion responsive.
 */
export const SEMANTIC_QUERY_MAX_CHARS = 200;

/**
 * Pull a semantic query from a chat-style messages array. Walks the list
 * backwards looking for the LAST user-role message — assistants and
 * system prompts are ignored on purpose: the user's most recent intent
 * is what should drive capability search.
 *
 * Returns `undefined` for arrays with no user messages or only empty/
 * whitespace content. Callers should treat `undefined` as "skip the RRF
 * rerank, score with the legacy 6-component formula".
 *
 * Mirror of `OrchestrationEngine.extractTaskSummary` — keep them in sync.
 * If the engine's extraction logic changes, mirror that change here and
 * update `preferred-model-honor-wiring.test.ts`.
 */
export function extractSemanticQueryFromMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  maxChars: number = SEMANTIC_QUERY_MAX_CHARS,
): string | undefined {
  if (!messages || messages.length === 0) return undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;

    const content = message.content;
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Multimodal content: concatenate text parts. Image / audio
      // parts are skipped — they don't contribute to a text-based
      // semantic query.
      text = content
        .filter(
          (p): p is { type: 'text'; text: string } =>
            p !== null &&
            typeof p === 'object' &&
            'type' in p &&
            (p as { type?: unknown }).type === 'text' &&
            'text' in p &&
            typeof (p as { text?: unknown }).text === 'string',
        )
        .map((p) => p.text)
        .join(' ');
    }

    const trimmed = text.trim().slice(0, maxChars);
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

/**
 * Normalize a model field from a request body into a `preferredModelIds`
 * array. Treats the empty string, `'auto'`, virtual `ailin-*` aliases,
 * and non-string values as "no preference" (returns `undefined`).
 *
 * The leading-`ailin-` check matches `getUserSpecifiedModelFlag` in
 * `chat-request-extended.ts`: virtual aliases are profile selectors,
 * not model pins, so they should never end up in `preferredModelIds`.
 */
export function normalizePreferredModel(
  model: unknown,
): string[] | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto') return undefined;
  if (normalized.startsWith('ailin-')) return undefined;
  return [trimmed];
}

/**
 * Create OrchestrationContext from request.
 * Uses minimal defaults for required fields that aren't available at
 * route level. The caller may seed `semanticQuery` and
 * `preferredModelIds` if it has access to the parsed body — when omitted
 * AND the downstream code path is `engine.execute`, the engine will fill
 * them in from `chatRequest.messages` / `chatRequest.model`.
 */
export function createOrchestrationContext(
  request: FastifyRequest,
  options?: {
    models?: Model[];
    taskType?: TaskType;
    contextSize?: number;
    /**
     * Free-text query for capability search reranking. See module-level
     * docstring. Use `extractSemanticQueryFromMessages(body.messages)`
     * when the route has chat-shaped input.
     */
    semanticQuery?: string;
    /**
     * Explicit user model pin. See module-level docstring. Use
     * `normalizePreferredModel(body.model)` to filter out 'auto' and
     * `ailin-*` aliases before passing.
     */
    preferredModelIds?: string[];
  }
): OrchestrationContext {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user;
  const userObj = user && typeof user === 'object' && !Buffer.isBuffer(user) && 'organizationId' in user
    ? user as { userId: string; organizationId: string; roles: string[]; email: string; name: string }
    : undefined;
  const organizationId = extendedRequest.organizationId || userObj?.organizationId || '';
  const userId = extendedRequest.userId || userObj?.userId || '';

  const trimmedSemanticQuery = options?.semanticQuery?.trim();
  const filteredPreferredIds = options?.preferredModelIds?.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );

  return {
    organizationId,
    userId,
    requestId: request.id,
    models: options?.models || [],
    taskType: options?.taskType || 'general',
    contextSize: options?.contextSize || 0,
    ...(trimmedSemanticQuery && trimmedSemanticQuery.length > 0
      ? { semanticQuery: trimmedSemanticQuery }
      : {}),
    ...(filteredPreferredIds && filteredPreferredIds.length > 0
      ? { preferredModelIds: filteredPreferredIds }
      : {}),
  };
}

/**
 * Layer body-derived intent (semanticQuery + preferredModelIds) onto an
 * existing context. Used when the auth middleware pre-creates a minimal
 * scaffold via `createOrchestrationContext(request)` and the route handler
 * subsequently parses the body and wants to seed intent fields without
 * rebuilding the whole context.
 *
 * Pure function — does not mutate `context`. Pass `undefined` for either
 * field to leave it untouched on the existing context.
 */
export function enrichContextWithIntent(
  context: OrchestrationContext,
  intent: {
    semanticQuery?: string;
    preferredModelIds?: string[];
  },
): OrchestrationContext {
  const trimmedSemanticQuery = intent.semanticQuery?.trim();
  const filteredPreferredIds = intent.preferredModelIds?.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );

  const hasNewSemantic =
    trimmedSemanticQuery !== undefined && trimmedSemanticQuery.length > 0;
  const hasNewPreferred =
    filteredPreferredIds !== undefined && filteredPreferredIds.length > 0;

  if (!hasNewSemantic && !hasNewPreferred) return context;

  return {
    ...context,
    ...(hasNewSemantic ? { semanticQuery: trimmedSemanticQuery } : {}),
    ...(hasNewPreferred ? { preferredModelIds: filteredPreferredIds } : {}),
  };
}
