// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script simples para contar modelos no banco
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function countModels() {
  try {
    const totalModels = await prisma.model.count();
    const modelsByProvider = await prisma.model.groupBy({
      by: ['providerId'],
      _count: { id: true }
    });

    console.log('📊 CONTAGEM DE MODELOS NO BANCO\n');
    console.log('=' .repeat(50));
    console.log(`📈 Total de Modelos: ${totalModels}\n`);

    console.log('🏢 Modelos por Provedor:');
    modelsByProvider.forEach(provider => {
      console.log(`  ${provider.providerId}: ${provider._count.id} modelo(s)`);
    });

    // Verificar especificamente OpenRouter
    const openRouterModels = await prisma.model.findMany({
      where: { providerId: 'openrouter' },
      select: { id: true, name: true }
    });

    if (openRouterModels.length > 0) {
      console.log(`\n🎯 OpenRouter: ${openRouterModels.length} modelos`);
      console.log('   Primeiros 5 modelos:');
      openRouterModels.slice(0, 5).forEach(model => {
        console.log(`     • ${model.name}`);
      });
    }

  } catch (error) {
    console.error('Erro ao contar modelos:', error);
  } finally {
    await prisma.$disconnect();
  }
}

countModels();
