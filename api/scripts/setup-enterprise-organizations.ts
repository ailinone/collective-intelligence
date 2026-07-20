// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para configurar organizações enterprise em produção
 * 
 * Este script usa os serviços existentes da aplicação para:
 * 1. Criar/verificar usuários
 * 2. Criar/verificar organizações
 * 3. Atribuir role owner aos usuários
 * 4. Atualizar tier para enterprise
 * 5. Criar subscription enterprise (opcional)
 * 
 * IMPORTANTE: Este script NÃO hardcodeia dados no código.
 * Todos os dados são criados através dos serviços existentes,
 * como um cliente real faria ao se cadastrar.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { logger } from '@/utils/logger';
import { RegisterUserHandler } from '@/application/handlers/register-user.handler';
import { RegisterUserCommand } from '@/application/commands/register-user.command';
import { container } from 'tsyringe';
import { initializeDIContainer } from '@/di/container';
import { assignRoleToUser } from '@/services/rbac-service';
import { createSubscription } from '@/services/billing-service';
import { prisma } from '@/database/client';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

const log = logger.child({ script: 'setup-enterprise-organizations' });

interface OrganizationSetup {
  name: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  tier: 'enterprise';
  trialDays?: number;
}

/**
 * Configuração das organizações a serem criadas
 * 
 * IMPORTANTE: Este array deve ser configurado via variáveis de ambiente
 * ou passado como parâmetro. NÃO hardcode dados de clientes aqui.
 * 
 * Para adicionar uma nova organização, configure as variáveis de ambiente:
 * - SETUP_ORG_NAME: Nome da organização
 * - SETUP_OWNER_EMAIL: Email do owner
 * - SETUP_OWNER_NAME: Nome do owner
 * - SETUP_OWNER_PASSWORD: Senha do owner (ou use padrão)
 * - SETUP_TRIAL_DAYS: Dias de trial (opcional)
 */
const ORGANIZATIONS_TO_SETUP: OrganizationSetup[] = [];

// Carregar configuração da Ailin One, Inc. (organização interna)
if (process.env.SETUP_AILIN_ORG === 'true' || process.env.SETUP_ALL_ORGS === 'true') {
  ORGANIZATIONS_TO_SETUP.push({
    name: process.env.AILIN_ORG_NAME || 'Ailin One, Inc.',
    ownerEmail: process.env.AILIN_OWNER_EMAIL || 'admin@ailin.one',
    ownerName: process.env.AILIN_OWNER_NAME || 'Ailin Admin',
    ownerPassword: process.env.AILIN_OWNER_PASSWORD || process.env.SETUP_OWNER_PASSWORD || 'ChangeMeNow!123',
    tier: 'enterprise',
  });
}

// Permitir configuração via variáveis de ambiente para organizações adicionais
// Formato: SETUP_ORG_1_NAME, SETUP_ORG_1_OWNER_EMAIL, etc.
let orgIndex = 1;
while (process.env[`SETUP_ORG_${orgIndex}_NAME`]) {
  const name = process.env[`SETUP_ORG_${orgIndex}_NAME`]!;
  const ownerEmail = process.env[`SETUP_ORG_${orgIndex}_OWNER_EMAIL`];
  const ownerName = process.env[`SETUP_ORG_${orgIndex}_OWNER_NAME`] || ownerEmail?.split('@')[0] || 'Owner';
  const ownerPassword = process.env[`SETUP_ORG_${orgIndex}_OWNER_PASSWORD`] || process.env.SETUP_OWNER_PASSWORD || 'ChangeMeNow!123';
  const trialDays = process.env[`SETUP_ORG_${orgIndex}_TRIAL_DAYS`] ? parseInt(process.env[`SETUP_ORG_${orgIndex}_TRIAL_DAYS`]!, 10) : undefined;

  if (!ownerEmail) {
    log.warn({ orgIndex, name }, 'Skipping organization: missing owner email');
    orgIndex++;
    continue;
  }

  ORGANIZATIONS_TO_SETUP.push({
    name,
    ownerEmail,
    ownerName,
    ownerPassword,
    tier: 'enterprise',
    trialDays,
  });

  orgIndex++;
}

/**
 * Verifica se um usuário existe
 */
async function userExists(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { email },
  });
  return user !== null;
}

/**
 * Verifica se uma organização existe pelo nome
 */
async function organizationExists(name: string): Promise<string | null> {
  const org = await prisma.organization.findFirst({
    where: { name },
    select: { id: true },
  });
  return org?.id ?? null;
}

/**
 * Cria ou obtém um usuário
 */
async function ensureUser(
  email: string,
  name: string,
  password: string,
  organizationName: string
): Promise<{ userId: string; organizationId: string; created: boolean }> {
  const exists = await userExists(email);
  
  if (exists) {
    log.info({ email }, 'User already exists, retrieving');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, organizationId: true },
    });
    return {
      userId: user.id,
      organizationId: user.organizationId,
      created: false,
    };
  }

  log.info({ email, organizationName }, 'Creating new user via RegisterUserHandler');
  
  // Usar o handler existente para criar o usuário
  initializeDIContainer();
  const registerHandler = container.resolve(RegisterUserHandler);
  
  const command = new RegisterUserCommand(email, password, name, organizationName);
  const result = await registerHandler.execute(command);

  if (!result.success) {
    throw new Error(`Failed to create user: ${result.error}`);
  }

  if (!result.userId || !result.organizationId) {
    throw new Error('User creation succeeded but missing userId or organizationId');
  }

  return {
    userId: result.userId,
    organizationId: result.organizationId,
    created: true,
  };
}

/**
 * Atribui role owner a um usuário em uma organização
 */
async function ensureOwnerRole(userId: string, organizationId: string): Promise<void> {
  // Verificar se o role owner já está atribuído
  const ownerRole = await prisma.role.findUnique({
    where: { name: 'owner' },
  });

  if (!ownerRole) {
    throw new Error('Owner role not found. Ensure default RBAC roles are created.');
  }

  const existingAssignment = await prisma.userRole.findUnique({
    where: {
      userId_organizationId_roleId: {
        userId,
        organizationId,
        roleId: ownerRole.id,
      },
    },
  });

  if (existingAssignment) {
    log.info({ userId, organizationId }, 'User already has owner role');
    return;
  }

  log.info({ userId, organizationId }, 'Assigning owner role');
  await assignRoleToUser(userId, organizationId, 'owner');
  
  // Atualizar o role primário do usuário
  await prisma.user.update({
    where: { id: userId },
    data: { role: 'owner' },
  });
}

/**
 * Atualiza o tier de uma organização
 */
async function updateOrganizationTier(
  organizationId: string,
  tier: 'free' | 'starter' | 'pro' | 'enterprise'
): Promise<void> {
  const current = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { tier: true },
  });

  if (current?.tier === tier) {
    log.info({ organizationId, tier }, 'Organization already has this tier');
    return;
  }

  log.info({ organizationId, oldTier: current?.tier, newTier: tier }, 'Updating organization tier');
  
  await prisma.organization.update({
    where: { id: organizationId },
    data: { tier },
  });
}

/**
 * Cria uma subscription enterprise para uma organização
 */
async function ensureEnterpriseSubscription(
  organizationId: string,
  trialDays?: number
): Promise<void> {
  // Verificar se já existe uma subscription ativa
  const existingSubscription = await prisma.billingSubscription.findFirst({
    where: {
      organizationId,
      status: 'active',
      plan: 'enterprise',
    },
  });

  if (existingSubscription) {
    log.info({ organizationId, subscriptionId: existingSubscription.id }, 'Enterprise subscription already exists');
    return;
  }

  log.info({ organizationId, trialDays }, 'Creating enterprise subscription');

  // Criar subscription usando o serviço existente
  // Nota: Se não houver preço configurado, criamos uma subscription sem Stripe
  try {
    await createSubscription({
      organizationId,
      plan: 'enterprise',
      billingCycle: 'monthly',
      amount: 0, // Pode ser ajustado conforme necessário
      currency: 'USD',
      trialDays,
      metadata: {
        source: 'admin_setup',
        setupDate: new Date().toISOString(),
      },
    });
    log.info({ organizationId }, 'Enterprise subscription created successfully');
  } catch (error) {
    // Se falhar (ex: Stripe não configurado), apenas logar aviso
    log.warn({ organizationId, error }, 'Failed to create subscription, but continuing (subscription may be optional)');
  }
}

/**
 * Função principal
 */
async function setupEnterpriseOrganizations(): Promise<void> {
  try {
    log.info('Starting enterprise organization setup');

    // Validar que há organizações para configurar
    if (ORGANIZATIONS_TO_SETUP.length === 0) {
      log.warn('No organizations configured to setup');
      log.info('Configure organizations via environment variables:');
      log.info('  - SETUP_AILIN_ORG=true (for Ailin One, Inc.)');
      log.info('  - SETUP_ORG_1_NAME, SETUP_ORG_1_OWNER_EMAIL, etc. (for additional orgs)');
      return;
    }

    log.info({ count: ORGANIZATIONS_TO_SETUP.length }, 'Organizations to setup');

    // 1. Garantir que os roles padrão existem
    log.info('Syncing default RBAC roles');
    await syncDefaultRoles();

    // 2. Processar cada organização
    for (const orgSetup of ORGANIZATIONS_TO_SETUP) {
      log.info({ organizationName: orgSetup.name, ownerEmail: orgSetup.ownerEmail }, 'Processing organization');

      // 2.1. Criar ou obter usuário e organização
      const { userId, organizationId, created } = await ensureUser(
        orgSetup.ownerEmail,
        orgSetup.ownerName,
        orgSetup.ownerPassword,
        orgSetup.name
      );

      log.info(
        {
          userId,
          organizationId,
          userCreated: created,
        },
        'User and organization ready'
      );

      // 2.2. Atribuir role owner
      await ensureOwnerRole(userId, organizationId);

      // 2.3. Atualizar tier para enterprise
      await updateOrganizationTier(organizationId, orgSetup.tier);

      // 2.4. Criar subscription enterprise (opcional, se trialDays for especificado)
      if (orgSetup.trialDays !== undefined) {
        await ensureEnterpriseSubscription(organizationId, orgSetup.trialDays);
      }

      log.info(
        {
          organizationId,
          organizationName: orgSetup.name,
          ownerEmail: orgSetup.ownerEmail,
        },
        'Organization setup completed'
      );
    }

    log.info('Enterprise organization setup completed successfully');
  } catch (error) {
    log.error({ error }, 'Failed to setup enterprise organizations');
    throw error;
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  setupEnterpriseOrganizations()
    .then(() => {
      log.info('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log.error({ error }, 'Script failed');
      process.exit(1);
    });
}

export { setupEnterpriseOrganizations };

