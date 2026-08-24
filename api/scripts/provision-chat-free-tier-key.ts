// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provisions the chat-authenticated-free-tier M2M API key end to end: a
 * dedicated "system" Organization + placeholder User (random, never-used
 * password) + ApiKey — the exact same pattern as
 * `provision-anonymous-guest-key.ts` (see that script's header for the full
 * rationale on the transaction/advisory-lock shape), applied to the
 * AUTHENTICATED free-tier case instead of the anonymous one.
 *
 * WHY THIS KEY EXISTS: `free-tier-quota-gate.ts` needs a scoping signal that
 * can never accidentally apply to financial/guide/id traffic sharing the same
 * `organizationId`. Just like the anonymous gate is safe because it only ever
 * fires for ONE designated API key id, this key gives chat's backend the same
 * property for authenticated users who have no explicit paid model selected:
 * chat calls ci through THIS key (not its normal per-user session auth) only
 * for that one case, and `isInChatFreeTierScope` in `free-tier-quota-gate.ts`
 * only ever matches this one key id.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/provision-chat-free-tier-key.ts
 *
 * Prints the plaintext key ONCE — store it as the `CHAT_FREE_TIER_API_KEY`
 * GitHub Actions secret in the `chat` repo. Prints the row id — set that as
 * `CHAT_FREE_TIER_API_KEY_ID` in ci's own production compose/env (see
 * docs/chat-free-tier-key-setup.md).
 *
 * ipWhitelist is left EMPTY here deliberately, same reasoning as the
 * anonymous script: chat's real production egress IP isn't knowable from
 * this script, and a wrong value would lock the key out entirely rather than
 * fail safe. Tighten it in a follow-up `prisma.apiKey.update` once a real
 * request's observed IP is confirmed.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Prisma } from '@/generated/prisma/index.js';
import { prisma } from '../src/database/client';
import { API_KEY_PREFIX } from '../src/utils/api-key-format';

type Tx = Prisma.TransactionClient;

const SERVICE_EMAIL = 'free-tier-service@example.com';
const SERVICE_ORG_NAME = 'Ailin Chat Free Tier';
const SERVICE_USER_NAME = 'Ailin Chat Free Tier Service';
const API_KEY_NAME = 'chat-free-tier';
const BCRYPT_ROUNDS = 12;
const PROVISIONING_LOCK_KEY = 'provision-chat-free-tier-key';

/**
 * Org and user existence are checked INDEPENDENTLY — see
 * provision-anonymous-guest-key.ts's `ensureOrgAndUser` for why (protects a
 * partial-failure re-run from minting a second orphaned Organization).
 */
async function ensureOrgAndUser(tx: Tx): Promise<{ organizationId: string; userId: string }> {
  const existingUser = await tx.user.findUnique({ where: { email: SERVICE_EMAIL } });
  if (existingUser) {
    console.log(`[OK] reusing existing service user ${existingUser.id} (org ${existingUser.organizationId})`);
    return { organizationId: existingUser.organizationId, userId: existingUser.id };
  }

  const existingOrg = await tx.organization.findFirst({ where: { name: SERVICE_ORG_NAME } });
  const org =
    existingOrg ??
    (await tx.organization.create({
      data: { name: SERVICE_ORG_NAME, tier: 'free', status: 'active' },
    }));
  if (existingOrg) {
    console.log(`[OK] reusing existing org ${org.id} (found without a linked service user — prior partial run?)`);
  }

  // Thrown-away, never-used credential — same pattern as
  // provision-anonymous-guest-key.ts. Nobody ever logs in as this user.
  const passwordHash = await bcrypt.hash(`system-${randomBytes(32).toString('hex')}`, BCRYPT_ROUNDS);
  const user = await tx.user.create({
    data: {
      email: SERVICE_EMAIL,
      name: SERVICE_USER_NAME,
      passwordHash,
      organizationId: org.id,
      role: 'viewer', // minimal role — defense-in-depth backstop, same as the anonymous guest user
      status: 'active',
    },
  });

  console.log(`[OK] ${existingOrg ? 'linked' : 'created'} org ${org.id} + created service user ${user.id}`);
  return { organizationId: org.id, userId: user.id };
}

async function provision(tx: Tx): Promise<void> {
  // FIRST statement in the transaction — see provision-anonymous-guest-key.ts's
  // header for why pg_advisory_xact_lock (transaction-scoped), not a
  // session-scoped lock acquired outside $transaction.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PROVISIONING_LOCK_KEY}))`;

  const { organizationId, userId } = await ensureOrgAndUser(tx);

  const existingActiveKey = await tx.apiKey.findFirst({
    where: { userId, name: API_KEY_NAME, status: 'active' },
  });
  if (existingActiveKey) {
    console.log(`[SKIP] an active "${API_KEY_NAME}" key already exists: ${existingActiveKey.id}`);
    console.log('       Delete/revoke it first if you need to mint a fresh one.');
    return;
  }

  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const keyHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  const quickHash = createHash('sha256').update(plaintext).digest('hex');
  const keyPrefix = plaintext.slice(0, 15);

  const apiKey = await tx.apiKey.create({
    data: {
      name: API_KEY_NAME,
      keyHash,
      quickHash,
      keyPrefix,
      userId,
      organizationId,
      status: 'active',
      // `permissions` intentionally omitted (defaults to DB NULL) — same
      // reasoning as the anonymous guest key: this codebase's `permissions`
      // field has no "restrict to one model" concept. Real scoping is
      // `isInChatFreeTierScope` in free-tier-quota-gate.ts, keyed off this
      // key's id via CHAT_FREE_TIER_API_KEY_ID.
      ipWhitelist: [],
      metadata: {
        createdBy: 'provision-chat-free-tier-key.ts',
        purpose: 'chat-authenticated-free-tier',
      },
    },
    select: { id: true, keyPrefix: true, createdAt: true },
  });

  console.log('[OK] api_key created');
  console.log(`     id                 = ${apiKey.id}`);
  console.log(`     key_prefix         = ${apiKey.keyPrefix}`);
  console.log(`     organization_id    = ${organizationId}`);
  console.log(`     user_id            = ${userId}`);
  console.log('');
  console.log('     Set in ci prod env  : CHAT_FREE_TIER_API_KEY_ID=' + apiKey.id);
  console.log('     Set as chat GH secret: CHAT_FREE_TIER_API_KEY=' + plaintext);
  console.log('');
  console.log('     ipWhitelist is EMPTY (unrestricted) — tighten it once the real');
  console.log('     egress IP is confirmed from a live request.');
  console.log('');
  console.log('     FREE_TIER_AUTO_QUOTA_ENABLED must ALSO be set to "true" on ci-api');
  console.log('     for this gate to actually run — see docs/chat-free-tier-key-setup.md.');
}

async function main(): Promise<void> {
  try {
    // 60s timeout — see provision-anonymous-guest-key.ts's header for why.
    await prisma.$transaction(provision, { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
