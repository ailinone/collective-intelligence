// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sandbox session manager.
 *
 * A sandbox session owns one writable scope directory. Sessions have to
 * outlive a single tool call — otherwise `computer_write_file` followed by
 * `computer_shell cat` would look at two different empty directories and the
 * tools would be useless — but they must not live forever, because a scope
 * directory is untrusted model-written content sitting on the API host's disk.
 *
 * The compromise: sessions are keyed by caller identity, created on demand,
 * and evicted after an idle TTL.
 *
 * SCOPE LIMITATION (ADR-024, "deliberately out of scope" #3): the key is
 * derived from `organizationId` + `userId`. When BOTH are absent — an
 * unauthenticated or internal caller — the key collapses to a single shared
 * bucket, so such callers share one scope directory. That is acceptable only
 * because the flag gating these tools is off by default and the intended
 * deployment is authenticated. Per-tenant container quotas are likewise not
 * implemented.
 */

import { logger } from '@/utils/logger';
import {
  createSandboxSession,
  disposeSandboxSession,
  type SandboxSession,
} from './container-sandbox';

const log = logger.child({ component: 'sandbox-session-manager' });

/** Idle time after which a session's scope directory is deleted. */
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

interface TrackedSession {
  session: SandboxSession;
  lastUsedAt: number;
}

const sessions = new Map<string, TrackedSession>();

/** Identity the scope directory is partitioned by. */
export interface SandboxScopeKey {
  organizationId?: string;
  userId?: string;
}

export function scopeKeyOf(key: SandboxScopeKey): string {
  return `${key.organizationId ?? 'no-org'}:${key.userId ?? 'no-user'}`;
}

/** Evict sessions idle for longer than the TTL. */
function evictExpired(): void {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [key, tracked] of sessions) {
    if (tracked.lastUsedAt < cutoff) {
      sessions.delete(key);
      void disposeSandboxSession(tracked.session);
      log.info({ scopeKey: key }, 'Sandbox session evicted (idle)');
    }
  }
}

/** Get or create the sandbox session for a caller. */
export async function acquireSession(key: SandboxScopeKey): Promise<SandboxSession> {
  evictExpired();
  const mapKey = scopeKeyOf(key);
  const existing = sessions.get(mapKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.session;
  }
  const session = await createSandboxSession();
  sessions.set(mapKey, { session, lastUsedAt: Date.now() });
  log.info({ scopeKey: mapKey, sessionId: session.sessionId }, 'Sandbox session created');
  return session;
}

/** Dispose every live session. Called on shutdown and between tests. */
export async function disposeAllSessions(): Promise<void> {
  const tracked = [...sessions.values()];
  sessions.clear();
  await Promise.all(tracked.map((entry) => disposeSandboxSession(entry.session)));
}

/** Number of live sessions. Exposed for tests and operability. */
export function liveSessionCount(): number {
  return sessions.size;
}
