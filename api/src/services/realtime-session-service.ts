// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Realtime Session Service
 *
 * Issues truly ephemeral, single-use session tokens for the
 * GET /v1/realtime WebSocket upgrade, so the caller's long-lived
 * credential (JWT or API key) never appears in a WebSocket URL,
 * proxy log, gateway access log, or browser history.
 *
 * Security properties:
 * - Token is a high-entropy random string (`rst_` prefix), not a JWT:
 *   it carries no claims and is meaningless outside this service.
 * - Only a SHA-256 hash of the token is stored at rest (Redis) —
 *   a Redis dump cannot be replayed.
 * - Single-use: consumed (deleted) on first successful validation.
 *   A URL captured in an access log is useless after the client connects.
 * - Expiry enforced server-side twice: Redis TTL and an explicit
 *   `expiresAt` check (belt and braces).
 * - A token mismatch does NOT delete the session — otherwise an attacker
 *   who guessed a sessionId could invalidate legitimate sessions.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'realtime-session-service' });

export const REALTIME_SESSION_TOKEN_PREFIX = 'rst_';
export const REALTIME_SESSION_TTL_SECONDS = 300; // 5 minutes
const SESSION_KEY_PREFIX = 'realtime:session:';

/**
 * Identity snapshot captured at session creation (from the already
 * authenticated POST /v1/realtime/session request) and re-attached to the
 * WebSocket request on consume. Staleness window is bounded by the TTL.
 */
export interface RealtimeSessionIdentity {
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  roles: string[];
  tier: string;
}

interface RealtimeSessionRecord extends RealtimeSessionIdentity {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Minimal key-value store contract — Redis in production, a Map-backed
 * fake in unit tests.
 */
export interface RealtimeSessionStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

class RedisSessionStore implements RealtimeSessionStore {
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await getRedisClient().set(key, value, 'EX', ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return getRedisClient().get(key);
  }

  async del(key: string): Promise<void> {
    await getRedisClient().del(key);
  }
}

const defaultStore: RealtimeSessionStore = new RedisSessionStore();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenHashMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashToken(presented), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');
  if (presentedHash.length !== expectedHash.length) {
    return false;
  }
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Create an ephemeral realtime session for an authenticated identity.
 * Returns the raw token exactly once — only its hash is persisted.
 */
export async function createRealtimeSession(
  identity: RealtimeSessionIdentity,
  store: RealtimeSessionStore = defaultStore
): Promise<{ sessionId: string; sessionToken: string; expiresAt: number }> {
  const sessionId = `rs_${nanoid(24)}`;
  const sessionToken = `${REALTIME_SESSION_TOKEN_PREFIX}${nanoid(48)}`;
  const now = Date.now();
  const expiresAt = now + REALTIME_SESSION_TTL_SECONDS * 1000;

  const record: RealtimeSessionRecord = {
    ...identity,
    tokenHash: hashToken(sessionToken),
    createdAt: now,
    expiresAt,
  };

  await store.set(
    `${SESSION_KEY_PREFIX}${sessionId}`,
    JSON.stringify(record),
    REALTIME_SESSION_TTL_SECONDS
  );

  log.info(
    { sessionId, userId: identity.userId, organizationId: identity.organizationId, expiresAt },
    'Realtime session created'
  );

  return { sessionId, sessionToken, expiresAt };
}

/**
 * Validate and consume (single-use) an ephemeral session token.
 * Returns the identity snapshot on success, null on any failure.
 */
export async function consumeRealtimeSession(
  sessionId: string,
  sessionToken: string,
  store: RealtimeSessionStore = defaultStore
): Promise<RealtimeSessionIdentity | null> {
  if (!sessionId.startsWith('rs_') || !sessionToken.startsWith(REALTIME_SESSION_TOKEN_PREFIX)) {
    return null;
  }

  const key = `${SESSION_KEY_PREFIX}${sessionId}`;
  const raw = await store.get(key);
  if (!raw) {
    log.warn({ sessionId }, 'Realtime session not found or expired');
    return null;
  }

  let record: RealtimeSessionRecord;
  try {
    record = JSON.parse(raw) as RealtimeSessionRecord;
  } catch {
    log.error({ sessionId }, 'Realtime session record corrupted');
    await store.del(key);
    return null;
  }

  if (!tokenHashMatches(sessionToken, record.tokenHash)) {
    // Deliberately do NOT delete: a wrong token must not let an attacker
    // who only knows the sessionId invalidate a legitimate session.
    log.warn({ sessionId }, 'Realtime session token mismatch');
    return null;
  }

  if (Date.now() >= record.expiresAt) {
    log.warn({ sessionId, expiresAt: record.expiresAt }, 'Realtime session expired');
    await store.del(key);
    return null;
  }

  // Single-use: consume on first successful validation.
  await store.del(key);

  return {
    userId: record.userId,
    organizationId: record.organizationId,
    email: record.email,
    name: record.name,
    roles: record.roles,
    tier: record.tier,
  };
}
