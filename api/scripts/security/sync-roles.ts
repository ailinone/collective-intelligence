// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { prisma } from '@/database/client';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

async function main(): Promise<void> {
  try {
    await syncDefaultRoles();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Failed to sync roles:', error);
  process.exit(1);
});

