// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { syncModelCatalog } from '../src/services/model-catalog-service';

// Definição direta dos modelos Mistral via Vertex AI
const vertexAIMistralModels = [
  // Codestral 2 via Vertex AI
  {
    id: 'codestral-2',
    name: 'codestral-2',
    displayName: 'Codestral 2 (Vertex AI)',
    contextWindow: 128000, // Standard for Mistral models
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'streaming', 'multilingual',
      'code_generation', 'code_completion', 'fill_in_middle', 'reasoning'
    ],
    inputCostPer1K: 0.00015, outputCostPer1K: 0.00030,
    performance: { latencyMs: 600, throughput: 200, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Codestral',
      tier: 'code_specialist',
      year: 2025,
      publisher: 'mistral',
      via: 'vertex-ai',
      architecture: 'transformer',
      params: '22B',
      knowledgeCutoff: '2024-08',
      supportedLanguages: ['Arabic', 'English', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Portuguese', 'Spanish', 'Tagalog', 'Thai', 'Vietnamese'],
      trainingTokens: '~40T',
      features: ['fill_in_middle', 'code_generation', 'multilingual', 'instruction_tuned']
    },
  },
  // Mistral Medium 3 via Vertex AI
  {
    id: 'mistral-medium-3',
    name: 'mistral-medium-3',
    displayName: 'Mistral Medium 3 (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'vision', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'agentic_workflows', 'multimodal'
    ],
    inputCostPer1K: 0.00100, outputCostPer1K: 0.00250,
    performance: { latencyMs: 1200, throughput: 100, quality: 0.96, reliability: 0.99 },
    metadata: {
      family: 'Mistral Medium',
      tier: 'versatile',
      year: 2025,
      publisher: 'mistral',
      via: 'vertex-ai',
      architecture: 'transformer',
      knowledgeCutoff: '2024-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      features: ['multimodal', 'agentic_workflows', 'advanced_reasoning', 'single_node_inference', 'long_context']
    },
  },
  // Mistral OCR 2505 via Vertex AI
  {
    id: 'mistral-ocr-2505',
    name: 'mistral-ocr-2505',
    displayName: 'Mistral OCR 2505 (Vertex AI)',
    contextWindow: 0, // Document input
    maxOutputTokens: 0, // Document output
    capabilities: [
      'document_processing', 'ocr', 'image_to_text', 'pdf_processing',
      'table_extraction', 'equation_recognition', 'markdown_output'
    ],
    inputCostPer1K: 0.00050, outputCostPer1K: 0.00100,
    performance: { latencyMs: 3000, throughput: 50, quality: 0.95, reliability: 0.97 },
    metadata: {
      family: 'Mistral OCR',
      tier: 'document_processing',
      year: 2025,
      publisher: 'mistral',
      via: 'vertex-ai',
      architecture: 'transformer',
      maxPages: 30,
      maxFileSize: '50MB',
      supportedFormats: ['PDF', 'images'],
      features: ['optical_character_recognition', 'document_understanding', 'table_extraction', 'equation_processing', 'high_throughput']
    },
  },
  // Mistral Small 2503 via Vertex AI
  {
    id: 'mistral-small-2503',
    name: 'mistral-small-2503',
    displayName: 'Mistral Small 2503 (Vertex AI)',
    contextWindow: 128000, // 128K tokens
    maxOutputTokens: 4096,
    capabilities: [
      'chat', 'function_calling', 'vision', 'streaming', 'multilingual',
      'code_generation', 'reasoning', 'multimodal', 'low_latency'
    ],
    inputCostPer1K: 0.00010, outputCostPer1K: 0.00025,
    performance: { latencyMs: 500, throughput: 250, quality: 0.90, reliability: 0.97 },
    metadata: {
      family: 'Mistral Small',
      tier: 'efficient',
      year: 2025,
      publisher: 'mistral',
      via: 'vertex-ai',
      architecture: 'transformer',
      knowledgeCutoff: '2024-12',
      supportedLanguages: ['English', 'German', 'French', 'Italian', 'Portuguese', 'Hindi', 'Spanish', 'Thai'],
      features: ['multimodal', 'low_latency', 'instruction_aligned', 'efficient_inference', 'long_context']
    },
  },
];

async function syncVertexAIMistralModels() {
  console.log('🌪️ SINCRONIZANDO MODELOS MISTRAL VIA VERTEX AI\n');
  console.log('='.repeat(70));

  try {
    // Modelos já definidos diretamente no script
    console.log('📋 Modelos Mistral via Vertex AI carregados...');
    console.log(`📊 Encontrados ${vertexAIMistralModels.length} modelos`);

    // Preparar dados para sync
    const catalogData = [{
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status: 'active' as const,
      metadata: {
        modelGarden: true,
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'YOUR_PROJECT_ID',
        location: 'us-central1',
        mistralIntegration: true
      },
      models: vertexAIMistralModels
    }];

    console.log('🔄 Sincronizando com banco de dados...');

    // Executar sync
    await syncModelCatalog(catalogData);

    console.log('✅ Modelos Mistral via Vertex AI sincronizados com sucesso!');
    console.log(`   • Provider: vertex-ai`);
    console.log(`   • Modelos Mistral: ${vertexAIMistralModels.length}`);
    console.log(`   • Status: active`);

    // Listar modelos sincronizados
    console.log('\n📋 Modelos Mistral sincronizados:');
    vertexAIMistralModels.forEach(model => {
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

syncVertexAIMistralModels().catch(console.error);
