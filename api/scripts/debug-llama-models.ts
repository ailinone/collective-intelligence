// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { prisma } from '../src/lib/prisma';

async function debugLlamaModels() {
  console.log('🔍 DEBUG: VERIFICANDO MODELOS LLAMA NO BANCO DE DADOS\n');
  console.log('='.repeat(70));

  try {
    // Buscar todos os modelos
    const allModels = await prisma.model.findMany({
      where: { providerName: 'vertex-ai' },
      select: {
        id: true,
        name: true,
        displayName: true,
        metadata: true
      }
    });

    console.log(`📊 Total de modelos Vertex AI no banco: ${allModels.length}`);

    // Filtrar modelos Llama
    const llamaModels = allModels.filter(model =>
      model.name.includes('llama-') &&
      model.metadata?.publisher === 'meta'
    );

    console.log(`🦙 Modelos Llama encontrados: ${llamaModels.length}`);

    // Mostrar todos os modelos para debug
    console.log('\n🔍 TODOS OS MODELOS VERTEX AI:');
    allModels.slice(0, 20).forEach(model => {
      console.log(`   • ${model.name} - Publisher: ${model.metadata?.publisher || 'undefined'} - Via: ${model.metadata?.via || 'undefined'}`);
    });

    if (allModels.length > 20) {
      console.log(`   ... e mais ${allModels.length - 20} modelos`);
    }

    // Mostrar modelos Llama se encontrados
    if (llamaModels.length > 0) {
      console.log('\n🦙 MODELOS LLAMA DETALHADOS:');
      llamaModels.forEach(model => {
        console.log(`   • ${model.name}`);
        console.log(`     Display: ${model.displayName}`);
        console.log(`     Metadata: ${JSON.stringify(model.metadata, null, 2)}`);
        console.log('');
      });
    } else {
      console.log('\n❌ NENHUM MODELO LLAMA ENCONTRADO NO BANCO!');
      console.log('\n🔧 POSSÍVEIS SOLUÇÕES:');
      console.log('   1. Executar novamente: npx tsx scripts/sync-vertex-ai-llama-models.ts');
      console.log('   2. Verificar se o banco está rodando');
      console.log('   3. Verificar logs de sincronização');
    }

  } catch (error: any) {
    console.error('❌ ERRO:', error.message);
    console.log('\n🔧 Verificar:');
    console.log('   • Banco PostgreSQL está rodando?');
    console.log('   • Conexão DATABASE_URL está correta?');
  }
}

debugLlamaModels().catch(console.error);
