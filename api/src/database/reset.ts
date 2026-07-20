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
import { prismaSchemaPath, runPrismaCommand } from './prisma-runner';
import { serializeError } from '@/utils/type-guards';
import { seedDatabase } from './seed';

async function main(): Promise<void> {
  logger.warn(
    {
      schema: prismaSchemaPath,
      databaseUrl: process.env.DATABASE_URL,
    },
    'Resetting database: this will drop all data and re-apply migrations'
  );

  await runPrismaCommand(['migrate', 'deploy', '--schema', prismaSchemaPath]);

  await runPrismaCommand([
    'migrate',
    'reset',
    '--force',
    '--skip-generate',
    '--schema',
    prismaSchemaPath,
  ]);

  logger.info('Database reset complete. Running seed routine...');

  await seedDatabase();

  logger.info('✅ Database reset and seeding completed successfully');
}

main().catch((error) => {
  logger.fatal({ error: serializeError(error) }, 'Failed to reset database');
  process.exit(1);
});
