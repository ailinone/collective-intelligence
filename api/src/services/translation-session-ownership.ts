// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tenant ownership of real-time translation sessions.
 *
 * The session id is minted by Palabra.ai and handed straight to the client;
 * nothing on Palabra's side ties it to one of our tenants. Without this record,
 * any authenticated caller who learns another tenant's session id can delete
 * that tenant's live call (DELETE /v1/translation/session/:id).
 */

import { getRedisClient } from '@/cache/redis-client';

const KEY_PREFIX = 'translation:session-owner:';

// Palabra returns no expiry for a session, so the record only has to outlive a
// realistic live call; an orphaned record expires on its own instead of leaking.
export const TRANSLATION_SESSION_OWNER_TTL_SECONDS = 24 * 60 * 60;

export class TranslationSessionOwnershipConflictError extends Error {
  constructor(sessionId: string) {
    super(`Translation session ${sessionId} is already owned by another organization`);
    this.name = 'TranslationSessionOwnershipConflictError';
  }
}

function keyFor(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

export async function recordTranslationSessionOwner(
  sessionId: string,
  organizationId: string
): Promise<void> {
  const redis = getRedisClient();
  const created = await redis.set(
    keyFor(sessionId),
    organizationId,
    'EX',
    TRANSLATION_SESSION_OWNER_TTL_SECONDS,
    'NX'
  );
  if (created === 'OK') return;

  const existingOwner = await redis.get(keyFor(sessionId));
  if (existingOwner !== organizationId) {
    throw new TranslationSessionOwnershipConflictError(sessionId);
  }
}

export async function isTranslationSessionOwnedBy(
  sessionId: string,
  organizationId: string
): Promise<boolean> {
  const owner = await getRedisClient().get(keyFor(sessionId));
  return owner !== null && owner === organizationId;
}

export async function forgetTranslationSessionOwner(sessionId: string): Promise<void> {
  await getRedisClient().del(keyFor(sessionId));
}
