// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Session/conversation affinity (LOTE AW, 2026-09).
 *
 * Problem this closes (see the audit that produced this design): NEITHER
 * `TriagingService.triage()` NOR `DynamicModelSelector.selectModels()` carry
 * any cross-request identity — every single `/v1/chat/completions` request
 * re-triages and re-selects from scratch, even for turn 2+ of the SAME
 * conversation. That means (a) 'auto' routing can silently hop a
 * conversation across different models/providers turn to turn for reasons
 * unrelated to the request content (contextSize crossing a threshold,
 * live provider health/credit flips), and (b) prompt caching (Anthropic
 * `cache_control`, OpenAI's automatic prefix cache) can never hit, because
 * provider-side cache lineage is keyed to a stable model+prefix and nothing
 * here was stable.
 *
 * This module is the fix: a thin, fail-open, Redis-backed "the last model
 * that served this conversation" cache, scoped so two tenants (or two API
 * keys under the same org) can never collide.
 *
 * ── Multi-tenancy (hard requirement) ────────────────────────────────────
 * Mirrors the ONE real scoping pattern already in this codebase —
 * `token-bucket-limiter.ts`'s `rate-limit:token-bucket:${scope}:${identifier}`
 * — rather than the (nonexistent) `sandbox-session-manager.ts`/`scopeKeyOf`
 * named in the original task brief (grepped `api/src` fully; no such file or
 * symbol exists). The Redis key is
 * `session-affinity:{organizationId}:{identifier}:{sessionKey}` — a plain
 * string composed from the caller's OWN organizationId, so two different
 * organizations produce two entirely different keys regardless of what the
 * rest of the key looks like. This makes cross-tenant collision structurally
 * impossible, not just policy-avoided. See
 * `session-affinity-service.multi-tenant-isolation.test.ts` for the proof.
 *
 * ── Read/write contract ─────────────────────────────────────────────────
 * - `lookup()` is called from `OrchestrationEngine.buildContext()` — it only
 *   PROPOSES a pin. The caller must still confirm the pinned model passes
 *   the current hard gates (context-window fit, credit balance, circuit
 *   state) before trusting it; this service does not know about model
 *   health at all.
 * - `recordOutcome()` is called from the write hooks (the streaming
 *   fast-path in chat-routes.ts, and the `strategy.recordExecution()` sibling
 *   calls in orchestration-engine.ts) with whatever model ACTUALLY served
 *   the request — never the original pin. A dead pin therefore self-heals on
 *   the very next write: there is no separate "unpin" / invalidation path.
 * - Any Redis failure (down, timeout) is treated as a cache miss / no-op —
 *   this feature must never turn an outage into a request failure.
 */

import { createHash } from 'node:crypto';
import { getRedisClient } from '@/cache/redis-client';
import { getErrorMessage } from '@/utils/type-guards';
import { logger } from '@/utils/logger';
import type { ChatMessage, ChatRequest, TriageDecision } from '@/types';

const log = logger.child({ component: 'session-affinity' });

/** Idle TTL refreshed on every read-hit and every write. Default matches
 *  LiteLLM's `deployment_affinity_ttl_seconds` default (3600s) and — as of
 *  the mismatch fix below — Anthropic's 1h extended cache tier, but the two
 *  are DIFFERENT mechanisms this default merely happens to line up with,
 *  not one shared clock:
 *
 *  - This TTL only decides how long the PIN (the "which model served this
 *    conversation last" record in Redis) survives an idle gap. It never
 *    talks to Anthropic and has no effect on the vendor's own prompt cache.
 *  - `anthropic-adapter.ts`'s `buildCacheControl()` decides, independently
 *    and per-request, whether to ask Anthropic for its 5-minute or 1-hour
 *    `cache_control` tier (`ttl: '1h'`, gated by
 *    `isExtendedCacheTtlEnabled()` and `hasConversationHistory()` — it does
 *    NOT read this TTL or anything else from this service). Before that
 *    fix, this adapter only ever sent bare `{type: 'ephemeral'}` (Anthropic's
 *    STANDARD 5-minute tier) regardless of this 3600s default, so a session
 *    idle for 5-60 minutes kept its model pin (this TTL genuinely covers
 *    that) but silently lost Anthropic's own prompt cache and repaid the
 *    full prefix on the next turn — no error, just quietly worse
 *    latency/cost than this comment implied. Fixed by actually requesting
 *    the 1h tier once a conversation proves itself (turn 2+); see that
 *    function's doc comment for why it isn't unconditional (1h cache
 *    WRITES cost 2x base input vs 1.25x for 5 minutes — not a free
 *    upgrade). If SESSION_AFFINITY_IDLE_TTL_SECONDS is ever tuned away from
 *    3600, Anthropic's 1h tier does not move with it — they are configured
 *    (and can drift) independently.
 *  Env-tunable, following the existing `ORCHESTRATION_TRIAGE_TIMEOUT_MS`-
 *  style ad-hoc override convention. */
function getIdleTtlSeconds(): number {
  const raw = Number(process.env.SESSION_AFFINITY_IDLE_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

/** Global kill-switch. Defaults to enabled. */
export function isSessionAffinityEnabled(): boolean {
  return process.env.SESSION_AFFINITY_ENABLED !== 'false';
}

export interface SessionAffinityRecord {
  modelId: string;
  provider: string;
  triageIntent?: string;
  triageComplexity?: string;
  recommendedStrategy?: string;
  lastUsedAt: number;
  turnCount: number;
}

/** Serialize a message's content field (string or structured parts) to plain
 *  text — generic over any role, unlike an Anthropic-specific system-block
 *  joiner. Exported for reuse by context-compaction-service.ts, which needs
 *  the identical string-ification to render older turns into summarizer
 *  input. */
export function messageContentToText(content: ChatMessage['content'] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part) {
        if (part.type === 'text') return part.text;
        return `[${part.type}]`;
      }
      return '';
    })
    .join('');
}

/**
 * Stable-prefix hash: sha256 of (system message + first user message).
 *
 * Deliberately NOT the full growing message array and NOT `contextSize` —
 * that is precisely what makes `DynamicModelSelector`'s own selection cache
 * (`findModels:${JSON.stringify(criteria)}...`, criteria includes
 * contextSize) miss on almost every turn. The system prompt and the first
 * user message are the one part of a conversation that stays byte-identical
 * across every subsequent turn (compaction, per the long-context design,
 * only ever touches turns older than the kept-verbatim tail and never
 * re-hashes this prefix).
 */
export function deriveStablePrefixHash(messages: ChatMessage[] | undefined): string {
  const list = messages ?? [];
  const systemMessage = list.find((m) => m.role === 'system');
  const firstUserMessage = list.find((m) => m.role === 'user');
  return createHash('sha256')
    .update(messageContentToText(systemMessage?.content))
    .update(' ')
    .update(messageContentToText(firstUserMessage?.content))
    .digest('hex');
}

/**
 * Two-tier session-key derivation:
 *   1. Client-supplied conversation id (`ailin_session_scope.conversationId`,
 *      populated server-side in chat-routes.ts from the
 *      `x-ailin-conversation-id` request header) — the strongest option per
 *      the OpenRouter/LiteLLM prior art when a caller provides it.
 *   2. Fallback: the stable-prefix hash above.
 *
 * The returned key carries a tag prefix (`conv:`/`prefix:`) so the two
 * derivation modes can never collide with each other even in the
 * (astronomically unlikely) case of a raw hash match.
 */
export function deriveSessionKey(request: Pick<ChatRequest, 'messages' | 'ailin_session_scope'>): string {
  const conversationId = request.ailin_session_scope?.conversationId?.trim();
  if (conversationId) {
    return `conv:${createHash('sha256').update(conversationId).digest('hex')}`;
  }
  return `prefix:${deriveStablePrefixHash(request.messages)}`;
}

/**
 * Tenant+caller identifier for the cache key. Prefers the resolved API-key
 * id (a single organization can hold multiple keys/callers whose
 * conversations must not cross-pollinate) and falls back to userId, then a
 * fixed literal — the literal still lives INSIDE the organizationId-scoped
 * key, so it never crosses organizations.
 */
export function resolveAffinityIdentifier(params: {
  apiKeyId?: string;
  userId?: string;
}): string {
  if (params.apiKeyId && params.apiKeyId.trim().length > 0) {
    return `key:${params.apiKeyId.trim()}`;
  }
  if (params.userId && params.userId.trim().length > 0) {
    return `user:${params.userId.trim()}`;
  }
  return 'anon';
}

/**
 * Compose the Redis key. Exported so the multi-tenant isolation test can
 * assert directly on it without depending on internal service plumbing.
 */
export function buildAffinityRedisKey(
  organizationId: string,
  identifier: string,
  sessionKey: string
): string {
  return `session-affinity:${organizationId}:${identifier}:${sessionKey}`;
}

interface RedisHashClient {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hincrby(key: string, field: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class SessionAffinityService {
  constructor(private readonly getClient: () => RedisHashClient = () => getRedisClient()) {}

  /**
   * Read-before-triage: look up a proposed pin for this
   * organization+identifier+sessionKey. Returns null on a genuine miss OR on
   * any Redis error (fail-open — never surfaces a cache backend problem as a
   * request failure). The caller MUST still validate the returned model
   * against current health/capability gates before trusting it.
   */
  async lookup(params: {
    organizationId: string;
    identifier: string;
    sessionKey: string;
  }): Promise<SessionAffinityRecord | null> {
    if (!isSessionAffinityEnabled()) return null;
    if (!params.organizationId) return null; // never look up without a tenant scope

    const key = buildAffinityRedisKey(params.organizationId, params.identifier, params.sessionKey);
    try {
      const raw = await this.getClient().hgetall(key);
      if (!raw || !raw.modelId || !raw.provider) {
        return null;
      }
      return {
        modelId: raw.modelId,
        provider: raw.provider,
        triageIntent: raw.triageIntent || undefined,
        triageComplexity: raw.triageComplexity || undefined,
        recommendedStrategy: raw.recommendedStrategy || undefined,
        lastUsedAt: Number(raw.lastUsedAt) || 0,
        turnCount: Number(raw.turnCount) || 0,
      };
    } catch (error) {
      log.debug(
        { error: getErrorMessage(error), organizationId: params.organizationId },
        'Session affinity lookup failed — treating as cache miss (fail-open)'
      );
      return null;
    }
  }

  /**
   * Write-after-execution: record whichever model ACTUALLY served this
   * turn — never the original pin — so a pin that died mid-turn is
   * automatically corrected for the next turn instead of needing a separate
   * invalidation path. Fire-and-forget from every call site; failures are
   * swallowed here (in addition to callers already wrapping with
   * `.catch(() => {})`) so this can never affect the response.
   */
  async recordOutcome(params: {
    organizationId: string;
    identifier: string;
    sessionKey: string;
    modelId: string;
    provider: string;
    triage?: Pick<TriageDecision, 'intent' | 'complexity' | 'recommendedStrategy'>;
  }): Promise<void> {
    if (!isSessionAffinityEnabled()) return;
    if (!params.organizationId || !params.modelId) return;

    const key = buildAffinityRedisKey(params.organizationId, params.identifier, params.sessionKey);
    try {
      const client = this.getClient();
      const fields: Record<string, string> = {
        modelId: params.modelId,
        provider: params.provider || 'unknown',
        lastUsedAt: String(Date.now()),
      };
      if (params.triage?.intent) fields.triageIntent = String(params.triage.intent);
      if (params.triage?.complexity) fields.triageComplexity = String(params.triage.complexity);
      if (params.triage?.recommendedStrategy) {
        fields.recommendedStrategy = String(params.triage.recommendedStrategy);
      }
      await client.hset(key, fields);
      await client.hincrby(key, 'turnCount', 1);
      await client.expire(key, getIdleTtlSeconds());
    } catch (error) {
      log.debug(
        { error: getErrorMessage(error), organizationId: params.organizationId },
        'Session affinity write failed — non-fatal (fail-open)'
      );
    }
  }
}

let sharedService: SessionAffinityService | null = null;

/** Process-wide singleton, matching the rest of this codebase's
 *  `get<Thing>Service()` convention. */
export function getSessionAffinityService(): SessionAffinityService {
  if (!sharedService) {
    sharedService = new SessionAffinityService();
  }
  return sharedService;
}

/** Test-only seam: reset the singleton between hermetic test files. */
export function __resetSessionAffinityServiceForTests(): void {
  sharedService = null;
}
