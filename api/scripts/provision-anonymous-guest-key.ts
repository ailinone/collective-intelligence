// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provisions the anonymous-chat-guest M2M API key end to end: a dedicated
 * "system" Organization + placeholder User (random, never-used password) +
 * ApiKey, following the SAME pattern as `hcra-create-bootstrap-key.ts` and
 * `create-prod-user.ts` — no human signup form involved anywhere.
 *
 * Idempotent: safe to re-run, including concurrently — the whole
 * check-then-create sequence runs inside ONE Prisma interactive transaction
 * (`prisma.$transaction`), which pins every query in it to a single Postgres
 * connection, with `pg_advisory_xact_lock` as the very first statement.
 * That lock is TRANSACTION-scoped (auto-released on commit/rollback, no
 * manual unlock needed) and, unlike a session-scoped `pg_advisory_lock`
 * acquired via ad-hoc top-level calls, is guaranteed to run on the same
 * connection it locks against — including if this codebase's already-
 * scaffolded (not yet deployed) PgBouncer transaction-pooling mode
 * (DATABASE_USE_POOLER) is ever turned on for this service, which would
 * silently break a session-scoped lock instead. Org/user existence are
 * checked INDEPENDENTLY of each other so a partial-failure re-run can't mint
 * a second orphaned Organization.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/provision-anonymous-guest-key.ts
 *
 * Prints the plaintext key ONCE — store it as the `ANONYMOUS_GUEST_API_KEY`
 * GitHub Actions secret in the `chat` repo. Prints the row id — set that as
 * `ANONYMOUS_GUEST_API_KEY_ID` in ci's own production compose/env (see
 * docs/anonymous-chat-guest-key-setup.md).
 *
 * ipWhitelist is left EMPTY here deliberately (see the runbook): chat's real
 * production egress IP isn't knowable from this script, and setting a wrong
 * value would lock the key out entirely rather than fail safe. Tighten it in
 * a follow-up `prisma.apiKey.update` once a real request's observed IP is
 * confirmed (ci-api logs `clientIp` on whitelist checks/violations).
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Prisma } from '@/generated/prisma/index.js';
import { prisma } from '../src/database/client';
import { API_KEY_PREFIX } from '../src/utils/api-key-format';

type Tx = Prisma.TransactionClient;

const SERVICE_EMAIL = 'guest-service@example.com';
const SERVICE_ORG_NAME = 'Ailin Chat Guest';
const SERVICE_USER_NAME = 'Ailin Chat Guest Service';
const API_KEY_NAME = 'chat-anonymous-guest';
const BCRYPT_ROUNDS = 12;
const PROVISIONING_LOCK_KEY = 'provision-anonymous-guest-key';

/**
 * Org and user existence are checked INDEPENDENTLY (not "user exists implies
 * org exists") specifically to stay correct across a partial-failure re-run:
 * if organization.create succeeds but the subsequent user.create throws
 * (DB hiccup, killed mid-run, etc.), a naive "only check for the user" retry
 * would create a SECOND orphaned Organization every time it's re-run. Mirrors
 * create-prod-user.ts's own independent org lookup for the same reason.
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

  // Thrown-away, never-used credential — same pattern as ensureFederatedPrincipal's
  // JIT-provisioned users and create-prod-user.ts. Nobody ever logs in as this user.
  const passwordHash = await bcrypt.hash(`system-${randomBytes(32).toString('hex')}`, BCRYPT_ROUNDS);
  const user = await tx.user.create({
    data: {
      email: SERVICE_EMAIL,
      name: SERVICE_USER_NAME,
      passwordHash,
      organizationId: org.id,
      role: 'viewer', // minimal role — defense-in-depth backstop, see PR #289
      status: 'active',
    },
  });

  console.log(`[OK] ${existingOrg ? 'linked' : 'created'} org ${org.id} + created service user ${user.id}`);
  return { organizationId: org.id, userId: user.id };
}

async function provision(tx: Tx): Promise<void> {
  // FIRST statement in the transaction, before any read/write below — see
  // file header for why this must be pg_advisory_xact_lock (transaction-
  // scoped) rather than a session-scoped lock acquired outside $transaction.
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
      // `permissions` intentionally omitted (defaults to DB NULL) — this
      // codebase's `permissions` field only supports coarse write/admin
      // booleans, no "restrict to one model on one endpoint" concept. Real
      // scoping is the anonymous_key_scope_violation check in
      // chat-routes.ts/responses-routes.ts + the 5 routes PR #289 hardened,
      // keyed off this key's id via ANONYMOUS_GUEST_API_KEY_ID.
      ipWhitelist: [],
      metadata: {
        createdBy: 'provision-anonymous-guest-key.ts',
        purpose: 'anonymous-chat-guest',
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
  console.log('     Set in ci prod env  : ANONYMOUS_GUEST_API_KEY_ID=' + apiKey.id);
  console.log('     Set as chat GH secret: ANONYMOUS_GUEST_API_KEY=' + plaintext);
  console.log('');
  console.log('     ipWhitelist is EMPTY (unrestricted) — tighten it once the real');
  console.log('     egress IP is confirmed from a live request (see runbook step 2).');
}

async function main(): Promise<void> {
  try {
    // 60s timeout: generous for a one-shot manual script, short enough that
    // a genuinely stuck lock (e.g. a prior run that crashed without ever
    // committing/rolling back) fails loudly instead of hanging forever —
    // though a crashed connection itself always releases its locks, so this
    // is a backstop for slow contention, not the primary safety mechanism.
    await prisma.$transaction(provision, { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
