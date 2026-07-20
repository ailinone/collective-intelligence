// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { syncModelCatalog } from '../src/services/model-catalog-service';

// Definição direta dos modelos Llama via Vertex AI
const vertexAILlamaModels = [
  // Llama 4 Maverick via Vertex AI
  {
    id: 'llama-4-maverick-17b-128e-instruct-maas',
    name: 'llama-4-maverick-17b-128e-instruct-maas',
    displayName: 'Llama 4 Maverick (17B x 128E) (Vertex AI)',
    contextWindow: 1000000, // 1M tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'multilingual', 'code_generation', 'reasoning', 'mixture_of_experts'
    ],
    inputCostPer1K: 0.00050, outputCostPer1K: 0.00150,
    performance: { latencyMs: 1200, throughput: 100, quality: 0.96, reliability: 0.98 },
    metadata: {
      family: 'Llama 4',
      tier: 'flagship',
      year: 2025,
      publisher: 'meta',
      via: 'vertex-ai',
      architecture: 'MoE',
      activatedParams: '17B',
      totalParams: '400B',
      experts: 128,
      knowledgeCutoff: '2024-08',
      supportedLanguages: ['Arabic', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Portuguese', 'Spanish', 'Tagalog', 'Thai', 'Vietnamese'],
      trainingTokens: '~22T',
      features: ['mixture_of_experts', 'multimodal', 'native_multilinguality', 'early_fusion']
    },
  },
  // Llama 3.3 70B Instruct via Vertex AI
  {
    id: 'llama-3.3-70b-instruct-maas',
    name: 'llama-3.3-70b-instruct-maas',
    displayName: 'Llama 3.3 70B Instruct (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'instruction_tuned'
    ],
    inputCostPer1K: 0.00030, outputCostPer1K: 0.00090,
    performance: { latencyMs: 1500, throughput: 120, quality: 0.95, reliability: 0.98 },
    metadata: {
      family: 'Llama 3.3',
      tier: 'balanced',
      year: 2024,
      publisher: 'meta',
      via: 'vertex-ai',
      architecture: 'transformer',
      params: '70B',
      gqa: true,
      knowledgeCutoff: '2023-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      trainingTokens: '15T+',
      features: ['multilingual', 'instruction_tuned', 'grouped_query_attention', 'rlhf_aligned']
    },
  },
  // Llama 3.1 405B Instruct via Vertex AI
  {
    id: 'llama-3.1-405b-instruct-maas',
    name: 'llama-3.1-405b-instruct-maas',
    displayName: 'Llama 3.1 405B Instruct (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'instruction_tuned'
    ],
    inputCostPer1K: 0.00200, outputCostPer1K: 0.00600,
    performance: { latencyMs: 2000, throughput: 80, quality: 0.97, reliability: 0.99 },
    metadata: {
      family: 'Llama 3.1',
      tier: 'flagship',
      year: 2024,
      publisher: 'meta',
      via: 'vertex-ai',
      architecture: 'transformer',
      params: '405B',
      gqa: true,
      knowledgeCutoff: '2023-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      trainingTokens: '15T+',
      features: ['multilingual', 'instruction_tuned', 'grouped_query_attention', 'rlhf_aligned', 'massive_scale']
    },
  },
  // Llama 3.1 70B Instruct via Vertex AI
  {
    id: 'llama-3.1-70b-instruct-maas',
    name: 'llama-3.1-70b-instruct-maas',
    displayName: 'Llama 3.1 70B Instruct (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'instruction_tuned'
    ],
    inputCostPer1K: 0.00050, outputCostPer1K: 0.00150,
    performance: { latencyMs: 1400, throughput: 100, quality: 0.96, reliability: 0.98 },
    metadata: {
      family: 'Llama 3.1',
      tier: 'balanced',
      year: 2024,
      publisher: 'meta',
      via: 'vertex-ai',
      architecture: 'transformer',
      params: '70B',
      gqa: true,
      knowledgeCutoff: '2023-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      trainingTokens: '15T+',
      features: ['multilingual', 'instruction_tuned', 'grouped_query_attention', 'rlhf_aligned']
    },
  },
  // Llama 3.1 8B Instruct via Vertex AI
  {
    id: 'llama-3.1-8b-instruct-maas',
    name: 'llama-3.1-8b-instruct-maas',
    displayName: 'Llama 3.1 8B Instruct (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'instruction_tuned'
    ],
    inputCostPer1K: 0.00010, outputCostPer1K: 0.00030,
    performance: { latencyMs: 800, throughput: 200, quality: 0.92, reliability: 0.97 },
    metadata: {
      family: 'Llama 3.1',
      tier: 'fast',
      year: 2024,
      publisher: 'meta',
      via: 'vertex-ai',
      architecture: 'transformer',
      params: '8B',
      gqa: true,
      knowledgeCutoff: '2023-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      trainingTokens: '15T+',
      features: ['multilingual', 'instruction_tuned', 'grouped_query_attention', 'rlhf_aligned', 'efficient']
    },
  },
];

async function syncVertexAILlamaModels() {
  console.log('🦙 SINCRONIZANDO MODELOS LLAMA VIA VERTEX AI\n');
  console.log('='.repeat(70));

  try {
    // Modelos já definidos diretamente no script
    console.log('📋 Modelos Llama via Vertex AI carregados...');
    console.log(`📊 Encontrados ${vertexAILlamaModels.length} modelos`);

    // Preparar dados para sync
    const catalogData = [{
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status: 'active' as const,
      metadata: {
        modelGarden: true,
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'your-gcp-project',
        location: 'us-central1',
        metaIntegration: true
      },
      models: vertexAILlamaModels
    }];

    console.log('🔄 Sincronizando com banco de dados...');

    // Executar sync
    await syncModelCatalog(catalogData);

    console.log('✅ Modelos Llama via Vertex AI sincronizados com sucesso!');
    console.log(`   • Provider: vertex-ai`);
    console.log(`   • Modelos Llama: ${vertexAILlamaModels.length}`);
    console.log(`   • Status: active`);

    // Listar modelos sincronizados
    console.log('\n📋 Modelos Llama sincronizados:');
    vertexAILlamaModels.forEach(model => {
      console.log(`   • ${model.name}: ${model.displayName}`);
      console.log(`     Context: ${model.contextWindow} tokens, Max Output: ${model.maxOutputTokens} tokens`);
      console.log(`     Capabilities: ${model.capabilities.slice(0, 4).join(', ')}${model.capabilities.length > 4 ? '...' : ''}`);
      console.log('');
    });

  } catch (error: any) {
    console.error('❌ Falha na sincronização:', error.message);
    console.log('\n🔧 POSSÍVEIS SOLUÇÕES:');
    console.log('   1. Verificar se o banco PostgreSQL está rodando');
    console.log('   2. Verificar conexão com Redis');
    console.log('   3. Executar: docker-compose up -d postgres redis');
    process.exit(1);
  }
}

syncVertexAILlamaModels().catch(console.error);
