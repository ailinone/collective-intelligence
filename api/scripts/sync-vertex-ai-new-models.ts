// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para sincronizar todos os novos modelos Vertex AI de diversos provedores
 * Inclui: Moonshot AI, DeepSeek AI, MiniMax AI, Qwen (Alibaba), OpenAI, Google
 */

import { PrismaClient } from '@prisma/client';
import { syncModelCatalog } from '../src/services/model-catalog-service';

const prisma = new PrismaClient();

async function syncNewVertexAIModels() {
  console.log('🚀 Iniciando sincronização dos novos modelos Vertex AI...\n');

  try {
    // Novos modelos a serem sincronizados - formato correto para syncModelCatalog
    const newVertexAIModels = [
      // Moonshot AI
      {
        id: 'kimi-k2-thinking',
        name: 'moonshotai/kimi-k2-thinking-maas',
        displayName: 'Kimi K2 Thinking (Vertex AI)',
        contextWindow: 256000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.002, // convertido de per 1M (2.00)
        outputCostPer1K: 0.008, // convertido de per 1M (8.00)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'reasoning', 'tool_orchestration', 'agentic_tasks', 'deep_thinking',
          'long_horizon_agency', 'stable_tool_use', 'int4_quantization'
        ],
        metadata: {
          family: 'Kimi K2',
          tier: 'thinking_agent',
          year: 2025,
          publisher: 'moonshot',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '1T total, 32B activated',
          layers: 61,
          experts: 384,
          expertsActivated: 8,
          knowledgeCutoff: '2024-08',
          supportedLanguages: ['Arabic', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Portuguese', 'Spanish', 'Tagalog', 'Thai', 'Vietnamese'],
          features: ['deep_thinking', 'tool_orchestration', 'int4_quantization', 'mla_attention', 'swiglu_activation']
        }
      },
      // DeepSeek AI
      {
        id: 'deepseek-ocr',
        name: 'deepseek-ai/deepseek-ocr-maas',
        displayName: 'DeepSeek OCR (Vertex AI)',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        inputCostPer1K: 0.0005, // convertido de per 1M (0.50)
        outputCostPer1K: 0.001, // convertido de per 1M (1.00)
        capabilities: [
          'vision', 'ocr', 'document_processing', 'pdf_processing',
          'image_to_text', 'multilingual', 'structured_output'
        ],
        metadata: {
          family: 'DeepSeek OCR',
          tier: 'specialized',
          year: 2025,
          publisher: 'deepseek',
          via: 'vertex-ai',
          architecture: 'transformer',
          features: ['optical_2d_mapping', 'vision_text_compression', 'large_scale_pretraining'],
          supportedFormats: ['PDF', 'images']
        }
      },
      {
        id: 'deepseek-v3.1',
        name: 'deepseek-ai/deepseek-v3.1-maas',
        displayName: 'DeepSeek V3.1 (Vertex AI)',
        contextWindow: 128000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.001, // convertido de per 1M (1.00)
        outputCostPer1K: 0.0025, // convertido de per 1M (2.50)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'thinking_mode', 'non_thinking_mode', 'reasoning', 'tool_use',
          'agentic_search', 'code_generation', 'hybrid_inference'
        ],
        metadata: {
          family: 'DeepSeek V3',
          tier: 'versatile',
          year: 2025,
          publisher: 'deepseek',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '671B total, 37B activated'
        }
      },
      {
        id: 'deepseek-v3-1-terminus',
        name: 'deepseek-ai/deepseek-v3-1-terminus',
        displayName: 'DeepSeek V3.1 Terminus (Vertex AI)',
        contextWindow: 128000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.001, // convertido de per 1M (1.00)
        outputCostPer1K: 0.0025, // convertido de per 1M (2.50)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'thinking_mode', 'non_thinking_mode', 'reasoning', 'tool_use',
          'agentic_search', 'code_generation', 'hybrid_inference',
          'language_consistency', 'optimized_agents'
        ],
        metadata: {
          family: 'DeepSeek V3',
          tier: 'optimized',
          year: 2025,
          publisher: 'deepseek',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '671B total, 37B activated'
        }
      },
      {
        id: 'deepseek-r1-0528',
        name: 'deepseek-ai/deepseek-r1-0528-maas',
        displayName: 'DeepSeek R1 0528 (Vertex AI)',
        contextWindow: 128000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.0015, // convertido de per 1M (1.50)
        outputCostPer1K: 0.0035, // convertido de per 1M (3.50)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'reasoning', 'mathematical_reasoning', 'code_generation',
          'reinforcement_learning', 'cold_start_data', 'distillation'
        ],
        metadata: {
          family: 'DeepSeek R1',
          tier: 'reasoning_specialist',
          year: 2025,
          publisher: 'deepseek',
          via: 'vertex-ai',
          architecture: 'reinforcement_learning_based'
        }
      },
      // MiniMax AI
      {
        id: 'minimax-m2',
        name: 'minimaxai/minimax-m2-maas',
        displayName: 'MiniMax M2 (Vertex AI)',
        contextWindow: 131072,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.0015, // convertido de per 1M (1.50)
        outputCostPer1K: 0.006, // convertido de per 1M (6.00)
        capabilities: [
          'chat', 'function_calling', 'vision', 'streaming', 'multilingual',
          'reasoning', 'coding', 'agentic_workflows', 'tool_use',
          'mathematical_reasoning', 'instruction_following', 'code_execution'
        ],
        metadata: {
          family: 'MiniMax M2',
          tier: 'elite_agent',
          year: 2025,
          publisher: 'minimax',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '230B total, 10B activated'
        }
      },
      // Qwen (Alibaba)
      {
        id: 'qwen3-next-80b-a3b-instruct',
        name: 'qwen/qwen3-next-80b-a3b-instruct-maas',
        displayName: 'Qwen3 Next 80B A3B Instruct (Vertex AI)',
        contextWindow: 256000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.001, // convertido de per 1M (1.00)
        outputCostPer1K: 0.002, // convertido de per 1M (2.00)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'reasoning', 'long_context', 'instruction_following',
          'hybrid_attention', 'ultra_sparse_moe'
        ],
        metadata: {
          family: 'Qwen3 Next',
          tier: 'efficient_reasoning',
          year: 2025,
          publisher: 'alibaba',
          via: 'vertex-ai',
          architecture: 'hybrid_attention_moe',
          params: '80B total, ~3B activated',
          experts: { total: 512, routed: 10, shared: 1 }
        }
      },
      {
        id: 'qwen3-next-80b-a3b-thinking',
        name: 'qwen/qwen3-next-80b-a3b-thinking-maas',
        displayName: 'Qwen3 Next 80B A3B Thinking (Vertex AI)',
        contextWindow: 256000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.0015, // convertido de per 1M (1.50)
        outputCostPer1K: 0.003, // convertido de per 1M (3.00)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'reasoning', 'complex_reasoning', 'long_context', 'thinking_mode',
          'hybrid_attention', 'ultra_sparse_moe', 'mathematical_reasoning'
        ],
        metadata: {
          family: 'Qwen3 Next',
          tier: 'complex_reasoning',
          year: 2025,
          publisher: 'alibaba',
          via: 'vertex-ai',
          architecture: 'hybrid_attention_moe',
          params: '80B total, ~3B activated'
        }
      },
      {
        id: 'qwen3-coder-480b-a35b-instruct',
        name: 'qwen/qwen3-coder-480b-a35b-instruct-maas',
        displayName: 'Qwen3 Coder 480B A35B Instruct (Vertex AI)',
        contextWindow: 256000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.002, // convertido de per 1M (2.00)
        outputCostPer1K: 0.004, // convertido de per 1M (4.00)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'code_generation', 'agentic_coding', 'browser_use', 'tool_use',
          'repository_scale', 'multi_turn_development', 'automated_engineering'
        ],
        metadata: {
          family: 'Qwen3 Coder',
          tier: 'agentic_coding',
          year: 2025,
          publisher: 'alibaba',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '480B total, 35B activated',
          experts: { total: 160, activated_per_forward: 8 }
        }
      },
      {
        id: 'qwen3-235b-a22b-instruct-2507',
        name: 'qwen/qwen3-235b-a22b-instruct-2507-maas',
        displayName: 'Qwen3 235B A22B Instruct 2507 (Vertex AI)',
        contextWindow: 256000,
        maxOutputTokens: 32768,
        inputCostPer1K: 0.0015, // convertido de per 1M (1.50)
        outputCostPer1K: 0.003, // convertido de per 1M (3.00)
        capabilities: [
          'chat', 'function_calling', 'vision', 'streaming', 'multilingual',
          'reasoning', 'instruction_following', 'hybrid_thinking',
          'agent_capabilities', 'mathematical_reasoning', 'coding',
          'commonsense_reasoning', 'human_preference_alignment'
        ],
        metadata: {
          family: 'Qwen3',
          tier: 'flagship',
          year: 2025,
          publisher: 'alibaba',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '235B total, 22B activated',
          trainingData: '36T tokens (2x Qwen2.5)'
        }
      },
      // OpenAI
      {
        id: 'gpt-oss-120b',
        name: 'openai/gpt-oss-120b-maas',
        displayName: 'GPT OSS 120B (Vertex AI)',
        contextWindow: 131072,
        maxOutputTokens: 16384,
        inputCostPer1K: 0.00125, // convertido de per 1M (1.25)
        outputCostPer1K: 0.005, // convertido de per 1M (5.00)
        capabilities: [
          'chat', 'function_calling', 'streaming', 'multilingual',
          'reasoning', 'configurable_effort', 'full_chain_thought',
          'agentic_capabilities', 'web_browsing', 'python_execution',
          'structured_outputs', 'fine_tunable'
        ],
        metadata: {
          family: 'GPT OSS',
          tier: 'production_reasoning',
          year: 2025,
          publisher: 'openai',
          via: 'vertex-ai',
          architecture: 'mixture_of_experts',
          params: '117B (5.1B activated in single GPU)',
          quantization: 'native_mxfp4',
          license: 'apache_2_0'
        }
      },
      // Google
      {
        id: 'virtual-try-on-preview-08-04',
        name: 'google/virtual-try-on-preview-08-04',
        displayName: 'Virtual Try-On Preview (Vertex AI)',
        contextWindow: 512,
        maxOutputTokens: 1024,
        inputCostPer1K: 0.005, // convertido de per 1M (5.00)
        outputCostPer1K: 0.00125, // convertido de per 1M (1.25)
        capabilities: [
          'image_generation', 'virtual_try_on', 'fashion_retail',
          'product_visualization', 'clothing_try_on'
        ],
        metadata: {
          family: 'Virtual Try-On',
          tier: 'specialized',
          year: 2025,
          publisher: 'google',
          via: 'vertex-ai',
          supportedProducts: ['tops', 'bottoms', 'footwear'],
          features: ['high_quality_photos', 'clothing_try_on', 'retail_applications'],
          region: 'us-central1'
        }
      }
    ];

    // Criar catalogData no formato correto
    const catalogData: any[] = [{
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status: 'active',
      metadata: {
        provider: 'google',
        platform: 'vertex-ai',
        regions: ['us-central1', 'us-east5', 'us-west2', 'europe-west4', 'global'],
        authentication: ['gcloud', 'api_key'],
        features: ['model_garden', 'custom_training', 'batch_processing', 'online_prediction']
      },
      models: newVertexAIModels
    }];

    console.log(`📊 Sincronizando ${newVertexAIModels.length} novos modelos Vertex AI...\n`);

    // Executar sync
    await syncModelCatalog(catalogData);

    console.log('✅ Novos modelos Vertex AI sincronizados com sucesso!\n');

    console.log('🎉 Sincronização dos novos modelos Vertex AI concluída!\n');

    // Verificar quantos modelos foram sincronizados
    const allModels = await prisma.model.findMany({
      select: { id: true, metadata: true }
    });

    const vertexAIModels = allModels.filter(model =>
      (model.metadata as Record<string, unknown>)?.via === 'vertex-ai'
    );

    console.log(`📈 Total de modelos Vertex AI no banco: ${vertexAIModels.length}`);

    // Listar modelos por provedor
    console.log('\n📋 Distribuição por provedor:');
    const publisherStats: Record<string, number> = {};

    vertexAIModels.forEach(model => {
      const publisher = (model.metadata as Record<string, unknown>)?.publisher;
      if (publisher) {
        publisherStats[publisher] = (publisherStats[publisher] || 0) + 1;
      }
    });

    Object.entries(publisherStats)
      .sort(([,a], [,b]) => b - a)
      .forEach(([publisher, count]) => {
        console.log(`  ${publisher}: ${count} modelo(s)`);
      });

    console.log('\n📋 Novos modelos adicionados:');
    newVertexAIModels.forEach(model => {
      const publisher = model.metadata?.publisher;
      console.log(`  • ${model.displayName} (${publisher})`);
    });

  } catch (error) {
    console.error('❌ Erro durante a sincronização:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Executar sincronização
syncNewVertexAIModels()
  .then(() => {
    console.log('✅ Script executado com sucesso!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Erro na execução do script:', error);
    process.exit(1);
  });
