// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { syncModelCatalog } from '../src/services/model-catalog-service';

// Definição direta dos modelos Claude via Vertex AI
const vertexAIAnthropicModels = [
  // Claude Haiku 4.5 via Vertex AI
  {
    id: 'claude-haiku-4-5@20251001',
    name: 'claude-haiku-4-5@20251001',
    displayName: 'Claude Haiku 4.5 (Vertex AI)',
    contextWindow: 200000, // 200K tokens
    maxOutputTokens: 64000, // 64K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'extended_thinking', 'prompt_caching', 'batch_prediction', 'web_search',
      'memory_tool', 'global_endpoint'
    ],
    inputCostPer1K: 0.00100, outputCostPer1K: 0.00500,
    performance: { latencyMs: 500, throughput: 200, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Claude 4.5',
      tier: 'fast',
      year: 2025,
      publisher: 'anthropic',
      via: 'vertex-ai',
      release_date: '2025-10-15',
      thinking_budget: 'dynamic',
      features: ['extended_thinking', 'memory_tool', 'near_frontier_performance', 'coding_excellence', 'agent_models', 'free_tier_ready']
    },
  },
  // Claude Sonnet 4.5 via Vertex AI
  {
    id: 'claude-sonnet-4-5@20250929',
    name: 'claude-sonnet-4-5@20250929',
    displayName: 'Claude Sonnet 4.5 (Vertex AI)',
    contextWindow: 1000000, // 1M tokens (beta)
    maxOutputTokens: 64000, // 64K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'extended_thinking', 'prompt_caching', 'batch_prediction', 'web_search',
      'memory_tool', 'global_endpoint', 'computer_use', 'enhanced_tool_orchestration',
      'parallel_tool_execution'
    ],
    inputCostPer1K: 0.00300, outputCostPer1K: 0.01500,
    performance: { latencyMs: 800, throughput: 150, quality: 0.96, reliability: 0.98 },
    metadata: {
      family: 'Claude 4.5',
      tier: 'balanced',
      year: 2025,
      publisher: 'anthropic',
      via: 'vertex-ai',
      release_date: '2025-09-29',
      thinking_budget: 'dynamic',
      features: ['industry_leading_agents', 'coding_excellence', 'computer_use', 'office_files', 'long_running_agents', 'cybersecurity']
    },
  },
  // Claude Opus 4.1 via Vertex AI
  {
    id: 'claude-opus-4-1@20250805',
    name: 'claude-opus-4-1@20250805',
    displayName: 'Claude Opus 4.1 (Vertex AI)',
    contextWindow: 200000, // 200K tokens
    maxOutputTokens: 32000, // 32K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'extended_thinking', 'prompt_caching', 'batch_prediction', 'web_search',
      'memory_tool', 'global_endpoint', 'advanced_coding', 'agentic_search',
      'long_horizon_tasks', 'content_creation'
    ],
    inputCostPer1K: 0.01500, outputCostPer1K: 0.07500,
    performance: { latencyMs: 1500, throughput: 80, quality: 0.98, reliability: 0.99 },
    metadata: {
      family: 'Claude 4.1',
      tier: 'ultra',
      year: 2025,
      publisher: 'anthropic',
      via: 'vertex-ai',
      release_date: '2025-08-05',
      thinking_budget: 'dynamic',
      features: ['frontier_intelligence', 'advanced_coding', 'ai_agents', 'agentic_search', 'memory_context', 'complex_reasoning']
    },
  },
];

async function syncVertexAIAnthropicModels() {
  console.log('🔄 SINCRONIZANDO MODELOS CLAUDE VIA VERTEX AI\n');
  console.log('='.repeat(60));

  try {
    // Modelos já definidos diretamente no script
    console.log('📋 Modelos Claude via Vertex AI carregados...');
    console.log(`📊 Encontrados ${vertexAIAnthropicModels.length} modelos`);

    // Preparar dados para sync
    const catalogData = [{
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status: 'active' as const,
      metadata: {
        modelGarden: true,
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'your-gcp-project',
        location: 'us-central1',
        anthropicIntegration: true
      },
      models: vertexAIAnthropicModels
    }];

    console.log('🔄 Sincronizando com banco de dados...');

    // Executar sync
    await syncModelCatalog(catalogData);

    console.log('✅ Modelos Claude via Vertex AI sincronizados com sucesso!');
    console.log(`   • Provider: vertex-ai`);
    console.log(`   • Modelos Claude: ${vertexAIAnthropicModels.length}`);
    console.log(`   • Status: active`);

    // Listar modelos sincronizados
    console.log('\n📋 Modelos Claude sincronizados:');
    vertexAIAnthropicModels.forEach(model => {
      console.log(`   • ${model.name}: ${model.displayName}`);
      console.log(`     Context: ${model.contextWindow} tokens, Max Output: ${model.maxOutputTokens} tokens`);
      console.log(`     Capabilities: ${model.capabilities.slice(0, 5).join(', ')}${model.capabilities.length > 5 ? '...' : ''}`);
      console.log('');
    });

  } catch (error: any) {
    console.error('❌ Falha na sincronização:', error.message);
    process.exit(1);
  }
}

syncVertexAIAnthropicModels().catch(console.error);
