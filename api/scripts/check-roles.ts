// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para verificar roles disponíveis no sistema
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkRoles() {
  console.log('🔍 Verificando roles disponíveis...\n');

  try {
    const roles = await prisma.role.findMany({
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    console.log(`Encontradas ${roles.length} roles:\n`);

    for (const role of roles) {
      console.log(`👤 Role: ${role.name}`);
      console.log(`   Descrição: ${role.description}`);
      console.log(`   Permissões: ${role.permissions.map(p => p.permission.name).join(', ') || 'Nenhuma'}`);
      console.log('');
    }

    // Verificar permissões disponíveis
    console.log('🔑 Verificando permissões disponíveis...');
    const permissions = await prisma.permission.findMany();

    console.log(`Encontradas ${permissions.length} permissões:\n`);

    for (const permission of permissions) {
      console.log(`   • ${permission.name}: ${permission.description}`);
    }

  } catch (error) {
    console.error('❌ Erro ao verificar roles:', error);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  checkRoles();
}

export { checkRoles };
