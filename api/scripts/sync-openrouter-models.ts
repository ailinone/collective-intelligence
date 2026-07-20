// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para sincronizar modelos do OpenRouter
 * Busca todos os modelos disponíveis via API e os sincroniza no sistema
 */

import 'dotenv/config';
import { ProviderRegistry } from '../src/providers/provider-registry';
import { OpenRouterAdapter, type OpenRouterConfig } from '../src/providers/openrouter/openrouter-adapter';
import { syncModelCatalog } from '../src/services/model-catalog-service';
import { logger } from '../src/utils/logger';

async function syncOpenRouterModels() {
  console.log('🚀 Iniciando sincronização dos modelos OpenRouter...\n');

  try {
    // Configuração do OpenRouter
    const openRouterConfig: OpenRouterConfig = {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      appUrl: process.env.OPENROUTER_APP_URL,
      appName: process.env.OPENROUTER_APP_NAME,
    };

    if (!openRouterConfig.apiKey) {
      throw new Error('OPENROUTER_API_KEY não configurada. Configure no arquivo .env');
    }

    // Inicializar adapter OpenRouter
    console.log('🔧 Inicializando OpenRouter Adapter...');
    const openRouterAdapter = new OpenRouterAdapter(openRouterConfig);

    // Registrar no ProviderRegistry
    const registry = new ProviderRegistry();
    registry.register(openRouterAdapter);
    console.log('✅ OpenRouter Adapter registrado\n');

    // Descobrir modelos via API
    console.log('🔍 Descobrindo modelos via OpenRouter API...');
    const models = await openRouterAdapter.getModels();
    console.log(`📊 ${models.length} modelos descobertos\n`);

    if (models.length === 0) {
      console.log('⚠️ Nenhum modelo foi descoberto. Verifique a configuração da API key.');
      return;
    }

    // Criar dados do catálogo para sincronização
    const catalogData = [{
      name: 'openrouter',
      displayName: 'OpenRouter',
      status: 'active' as const,
      metadata: {
        provider: 'openrouter',
        description: 'Unified API access to 400+ AI models from multiple providers',
        apiEndpoint: 'https://openrouter.ai/api/v1',
        totalModels: models.length,
        lastSync: new Date().toISOString(),
        features: [
          'unified_api',
          'multiple_providers',
          'web_search',
          'streaming',
          'function_calling',
          'structured_outputs'
        ]
      },
      models: models.map(model => ({
        id: model.id,
        name: model.name,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        inputCostPer1K: model.pricing?.inputCostPer1M ? model.pricing.inputCostPer1M / 1000 : 0,
        outputCostPer1K: model.pricing?.outputCostPer1M ? model.pricing.outputCostPer1M / 1000 : 0,
        capabilities: model.capabilities,
        metadata: model.metadata
      }))
    }];

    // Sincronizar com banco de dados
    console.log('💾 Sincronizando modelos com banco de dados...');
    await syncModelCatalog(catalogData);
    console.log('✅ Modelos sincronizados com sucesso!\n');

    // Estatísticas detalhadas
    console.log('📊 ESTATÍSTICAS DOS MODELOS OPENROUTER\n');
    console.log('=' .repeat(80));

    // Distribuição por provedor original
    const providerStats: Record<string, number> = {};
    const tierStats: Record<string, number> = {};
    const capabilityStats: Record<string, number> = {};

    models.forEach(model => {
      // Contar por provedor
      const provider = (model.metadata as Record<string, unknown>)?.provider || 'unknown';
      providerStats[provider] = (providerStats[provider] || 0) + 1;

      // Contar por tier (se disponível)
      const tier = (model.metadata as Record<string, unknown>)?.tier || 'unknown';
      tierStats[tier] = (tierStats[tier] || 0) + 1;

      // Contar capacidades
      model.capabilities.forEach(cap => {
        capabilityStats[cap] = (capabilityStats[cap] || 0) + 1;
      });
    });

    console.log(`📈 Total de Modelos: ${models.length}`);
    console.log(`🏢 Provedores Originais: ${Object.keys(providerStats).length}\n`);

    // Top provedores
    console.log('🏢 Top Provedores Originais:');
    Object.entries(providerStats)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .forEach(([provider, count]) => {
        console.log(`  ${provider}: ${count} modelo(s)`);
      });

    console.log('\n🏆 Distribuição por Tier:');
    Object.entries(tierStats)
      .sort(([,a], [,b]) => b - a)
      .forEach(([tier, count]) => {
        console.log(`  ${tier}: ${count} modelo(s)`);
      });

    console.log('\n🎯 Capacidades Mais Comuns:');
    Object.entries(capabilityStats)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 15)
      .forEach(([cap, count]) => {
        console.log(`  ${cap}: ${count} modelo(s)`);
      });

    // Modelos especiais
    const reasoningModels = models.filter(m => m.capabilities.includes('reasoning'));
    const visionModels = models.filter(m => m.capabilities.includes('vision'));
    const functionCallingModels = models.filter(m => m.capabilities.includes('function_calling'));
    const webSearchModels = models.filter(m => (m.metadata as Record<string, unknown>)?.features?.includes('web_search'));

    console.log('\n🎨 Modelos Especiais:');
    console.log(`  🤔 Reasoning/Thinking: ${reasoningModels.length} modelos`);
    console.log(`  👁️ Vision/Multimodal: ${visionModels.length} modelos`);
    console.log(`  🛠️ Function Calling: ${functionCallingModels.length} modelos`);
    console.log(`  🌐 Web Search: ${webSearchModels.length} modelos`);

    // Top 5 modelos por contexto
    console.log('\n📏 Top 5 Modelos por Contexto:');
    models
      .sort((a, b) => b.contextWindow - a.contextWindow)
      .slice(0, 5)
      .forEach((model, index) => {
        console.log(`  ${index + 1}. ${model.displayName}: ${model.contextWindow.toLocaleString()} tokens`);
      });

    console.log('\n✅ Sincronização dos modelos OpenRouter concluída!');
    console.log('💡 Todos os modelos estão prontos para uso no sistema de orquestração.');

  } catch (error) {
    console.error('❌ Erro durante a sincronização:', error);

    if (error instanceof Error) {
      if (error.message.includes('OPENROUTER_API_KEY')) {
        console.log('\n💡 Para resolver: Configure OPENROUTER_API_KEY no arquivo .env');
        console.log('   Obtenha sua chave em: https://openrouter.ai/keys');
      }
    }

    process.exit(1);
  }
}

// Executar sincronização
syncOpenRouterModels()
  .then(() => {
    console.log('\n✅ Script de sincronização executado com sucesso!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erro na execução do script:', error);
    process.exit(1);
  });

