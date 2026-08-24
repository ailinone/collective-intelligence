// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Plain-JS runtime twin of api/scripts/provision-chat-free-tier-key.ts.
 * Same deployment mechanics as provision-anonymous-guest-key.runtime.js (see
 * that file's header for the full path/Prisma-adapter reasoning) — the
 * production ci-api image has no tsx/ts-node, so this runs directly via
 * `node` inside the already-running container.
 *
 * MUST be run from /app inside the ci_api container. Logic must stay in
 * lockstep with the .ts source of truth in the repo.
 */
const { createHash, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('./dist/generated/prisma');

/** See provision-anonymous-guest-key.runtime.js's identical function for why. */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = readFileSync(process.env.DB_PASSWORD_FILE || '/run/secrets/db_password', 'utf8').trim();
  return `postgresql://${process.env.DB_USER || 'postgres'}:${password}@${process.env.DB_HOST || 'db'}:5432/${process.env.DB_NAME || 'postgres'}`;
}

const pool = new Pool({ connectionString: resolveDatabaseUrl() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const SERVICE_EMAIL = 'free-tier-service@example.com';
const SERVICE_ORG_NAME = 'Ailin Chat Free Tier';
const SERVICE_USER_NAME = 'Ailin Chat Free Tier Service';
const API_KEY_NAME = 'chat-free-tier';
const API_KEY_PREFIX = 'ai1sk_';
const BCRYPT_ROUNDS = 12;
const PROVISIONING_LOCK_KEY = 'provision-chat-free-tier-key';

async function ensureOrgAndUser(tx) {
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
    console.log(`[OK] reusing existing org ${org.id} (found without a linked service user -- prior partial run?)`);
  }

  const passwordHash = await bcrypt.hash(`system-${randomBytes(32).toString('hex')}`, BCRYPT_ROUNDS);
  const user = await tx.user.create({
    data: {
      email: SERVICE_EMAIL,
      name: SERVICE_USER_NAME,
      passwordHash,
      organizationId: org.id,
      role: 'viewer',
      status: 'active',
    },
  });

  console.log(`[OK] ${existingOrg ? 'linked' : 'created'} org ${org.id} + created service user ${user.id}`);
  return { organizationId: org.id, userId: user.id };
}

async function provision(tx) {
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
  console.log('     PLAINTEXT_KEY=' + plaintext);
  console.log('     KEY_ID=' + apiKey.id);
}

async function main() {
  try {
    await prisma.$transaction(provision, { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
