// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Creates a bootstrap API key for calling admin/discovery endpoints locally.
 *
 * Writes plaintext key to `.bootstrap-key.tmp` (gitignored by .env pattern).
 * Reuses an existing admin user + org (set BOOTSTRAP_USER_ID / BOOTSTRAP_ORG_ID).
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcrypt';
import { prisma } from '../src/database/client';

const USER_ID = process.env.BOOTSTRAP_USER_ID ?? '';
const ORG_ID = process.env.BOOTSTRAP_ORG_ID ?? '';

if (!USER_ID || !ORG_ID) {
  console.error('ERROR: Set BOOTSTRAP_USER_ID and BOOTSTRAP_ORG_ID to an existing admin user/org id.');
  process.exit(1);
}

async function main(): Promise<void> {
  const plaintext = `ak_local_${randomBytes(24).toString('base64url')}`;
  const keyHash = await bcrypt.hash(plaintext, 10);
  const quickHash = createHash('sha256').update(plaintext).digest('hex');
  const keyPrefix = plaintext.slice(0, 16);

  const row = await prisma.apiKey.create({
    data: {
      name: 'HCRA Rollout Bootstrap',
      keyHash,
      quickHash,
      keyPrefix,
      userId: USER_ID,
      organizationId: ORG_ID,
      status: 'active',
      permissions: { admin: true, discovery: true },
      metadata: { createdBy: 'hcra-create-bootstrap-key.ts', purpose: 'rollout-validation' },
    },
    select: { id: true, keyPrefix: true, createdAt: true },
  });

  writeFileSync('.bootstrap-key.tmp', plaintext, { encoding: 'utf8' });
  console.log('[OK] api_key created');
  console.log(`     id          = ${row.id}`);
  console.log(`     key_prefix  = ${row.keyPrefix}`);
  console.log(`     created_at  = ${row.createdAt.toISOString()}`);
  console.log(`     plaintext   = saved to .bootstrap-key.tmp (${plaintext.length} bytes)`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[FAIL]', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
