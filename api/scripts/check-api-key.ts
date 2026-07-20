// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para verificar o estado da API Key no banco de dados
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkApiKey() {
  console.log('🔍 Verificando estado da API Key...\n');

  try {
    const apiKeys = await prisma.apiKey.findMany({
      where: {
        status: 'active',
      },
      include: {
        user: {
          select: {
            email: true,
            name: true,
          },
        },
        organization: {
          select: {
            name: true,
            tier: true,
          },
        },
      },
    });

    console.log(`Encontradas ${apiKeys.length} API Keys ativas:\n`);

    for (const apiKey of apiKeys) {
      console.log(`🔑 API Key: ${apiKey.keyPrefix}...`);
      console.log(`   Usuário: ${apiKey.user.email}`);
      console.log(`   Organização: ${apiKey.organization.name} (${apiKey.organization.tier})`);
      console.log(`   Status: ${apiKey.status}`);
      console.log(`   Permissões: ${apiKey.permissions || 'NENHUMA'}`);
      console.log(`   Criada em: ${apiKey.createdAt}`);
      console.log(`   Último uso: ${apiKey.lastUsedAt || 'Nunca'}`);
      console.log('');
    }

    // Verificar se há roles do usuário
    if (apiKeys.length > 0) {
      const userId = apiKeys[0].userId;
      const organizationId = apiKeys[0].organizationId;

      console.log('👤 Verificando roles do usuário...');
      const userRoles = await prisma.userRole.findMany({
        where: {
          userId,
          organizationId,
        },
        include: {
          role: true,
        },
      });

      console.log(`   Roles encontradas: ${userRoles.length}`);
      userRoles.forEach(ur => {
        console.log(`   - ${ur.role.name}`);
      });
    }

  } catch (error) {
    console.error('❌ Erro ao verificar API Key:', error);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  checkApiKey();
}

export { checkApiKey };
