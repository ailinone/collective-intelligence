// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import 'dotenv/config';
import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import { prismaSchemaPath, runPrismaCommand } from './prisma-runner';

async function main(): Promise<void> {
  logger.info(
    {
      schema: prismaSchemaPath,
      databaseUrl: process.env.DATABASE_URL,
    },
    'Applying Prisma migrations to database'
  );

  await runPrismaCommand(['migrate', 'deploy', '--schema', prismaSchemaPath]);

  logger.info('✅ Prisma migrations applied successfully');
}

main().catch((error) => {
  logger.fatal({ error: serializeError(error) }, 'Failed to apply Prisma migrations');
  process.exit(1);
});
