// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script de validação para setup-enterprise-organizations.ts
 * 
 * Valida que todos os serviços necessários estão disponíveis
 * e que o script pode ser executado com segurança.
 */

import 'dotenv/config';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

const log = logger.child({ script: 'validate-setup-script' });

async function validateSetupScript(): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  log.info('Validating setup script prerequisites...');

  // 1. Verificar conexão com banco de dados
  try {
    await prisma.$queryRaw`SELECT 1`;
    log.info('✓ Database connection OK');
  } catch (error) {
    errors.push(`Database connection failed: ${error}`);
  }

  // 2. Verificar se os roles padrão existem ou podem ser criados
  try {
    await syncDefaultRoles();
    const ownerRole = await prisma.role.findUnique({
      where: { name: 'owner' },
    });
    if (!ownerRole) {
      errors.push('Owner role not found after sync');
    } else {
      log.info('✓ RBAC roles OK');
    }
  } catch (error) {
    errors.push(`RBAC sync failed: ${error}`);
  }

  // 3. Verificar se os serviços necessários podem ser importados
  try {
    const { RegisterUserHandler } = await import('@/application/handlers/register-user.handler');
    const { assignRoleToUser } = await import('@/services/rbac-service');
    const { createSubscription } = await import('@/services/billing-service');
    log.info('✓ Required services can be imported');
  } catch (error) {
    errors.push(`Failed to import required services: ${error}`);
  }

  // 4. Verificar variáveis de ambiente (avisos apenas)
  if (!process.env.DATABASE_URL) {
    warnings.push('DATABASE_URL not set');
  }

  // 5. Verificar se há organizações com os nomes que serão criados
  const orgsToCheck = ['Ailin One, Inc.'];
  for (const orgName of orgsToCheck) {
    const existing = await prisma.organization.findFirst({
      where: { name: orgName },
    });
    if (existing) {
      warnings.push(`Organization "${orgName}" already exists (will be reused)`);
    }
  }

  // Resumo
  log.info('Validation completed');
  
  if (warnings.length > 0) {
    log.warn({ warnings }, 'Validation warnings');
  }

  if (errors.length > 0) {
    log.error({ errors }, 'Validation errors');
    throw new Error(`Validation failed: ${errors.join('; ')}`);
  }

  log.info('✓ All validations passed. Script is safe to execute.');
}

if (require.main === module) {
  validateSetupScript()
    .then(() => {
      log.info('Validation script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log.error({ error }, 'Validation script failed');
      process.exit(1);
    });
}

export { validateSetupScript };

