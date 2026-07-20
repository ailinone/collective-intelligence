// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { syncModelCatalog } from '../src/services/model-catalog-service';

// Definição direta dos modelos Vertex AI (copiada do model-discovery-service.ts)
const vertexAIModels = [
  // Gemini 2.5 Flash-Lite Preview via Vertex AI (latest preview)
  {
    id: 'gemini-2.5-flash-lite-preview-09-2025',
    name: 'gemini-2.5-flash-lite-preview-09-2025',
    displayName: 'Gemini 2.5 Flash-Lite Preview (Vertex AI)',
    contextWindow: 1048576, // 1M tokens
    maxOutputTokens: 65536, // 65K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'grounding', 'code_execution', 'context_caching',
      'implicit_caching', 'batch', 'thinking_mode'
    ],
    inputCostPer1K: 0.00010, outputCostPer1K: 0.00040,
    performance: { latencyMs: 400, throughput: 250, quality: 0.90, reliability: 0.97 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'fast',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      thinking_budget: '512-24576 tokens',
      features: ['thinking_mode', 'low_latency', 'structured_output', 'grounding', 'code_execution', 'context_caching']
    },
  },
  // Gemini 2.5 Flash-Lite via Vertex AI
  {
    id: 'gemini-2.5-flash-lite',
    name: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite (Vertex AI)',
    contextWindow: 1048576, // 1M tokens
    maxOutputTokens: 65536, // 65K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'grounding', 'code_execution', 'context_caching',
      'implicit_caching', 'batch', 'thinking_mode'
    ],
    inputCostPer1K: 0.00010, outputCostPer1K: 0.00040,
    performance: { latencyMs: 400, throughput: 250, quality: 0.90, reliability: 0.97 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'fast',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      thinking_budget: '512-24576 tokens',
      features: ['thinking_mode', 'low_latency', 'structured_output', 'grounding', 'code_execution', 'context_caching']
    },
  },
  // Gemini 2.5 Flash via Vertex AI
  {
    id: 'gemini-2.5-flash',
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash (Vertex AI)',
    contextWindow: 1048576, // 1M tokens
    maxOutputTokens: 65536, // 65K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'grounding', 'code_execution', 'context_caching',
      'implicit_caching', 'batch', 'thinking_mode'
    ],
    inputCostPer1K: 0.00030, outputCostPer1K: 0.00250,
    performance: { latencyMs: 600, throughput: 200, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'balanced',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      thinking_budget: '512-24576 tokens',
      features: ['thinking_mode', 'structured_output', 'grounding', 'code_execution', 'context_caching']
    },
  },
  // Gemini 2.5 Flash Preview via Vertex AI
  {
    id: 'gemini-2.5-flash-preview-09-2025',
    name: 'gemini-2.5-flash-preview-09-2025',
    displayName: 'Gemini 2.5 Flash Preview (Vertex AI)',
    contextWindow: 1048576, // 1M tokens
    maxOutputTokens: 65536, // 65K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'grounding', 'code_execution', 'context_caching',
      'implicit_caching', 'batch', 'thinking_mode'
    ],
    inputCostPer1K: 0.00030, outputCostPer1K: 0.00250,
    performance: { latencyMs: 600, throughput: 200, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'balanced',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      thinking_budget: '512-24576 tokens',
      features: ['thinking_mode', 'structured_output', 'grounding', 'code_execution', 'context_caching']
    },
  },
  // Gemini 2.0 Flash-001 via Vertex AI
  {
    id: 'gemini-2.0-flash-001',
    name: 'gemini-2.0-flash-001',
    displayName: 'Gemini 2.0 Flash-001 (Vertex AI)',
    contextWindow: 1048576, // 1M tokens
    maxOutputTokens: 8192,
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'grounding', 'code_execution', 'context_caching',
      'batch', 'live_api'
    ],
    inputCostPer1K: 0.00010, outputCostPer1K: 0.00040,
    performance: { latencyMs: 600, throughput: 200, quality: 0.92, reliability: 0.98 },
    metadata: {
      family: 'Gemini 2.0',
      tier: 'fast',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['live_api', 'context_caching', 'grounding', 'code_execution', 'batch']
    },
  },
  // Gemini 2.5 Computer Use Preview via Vertex AI
  {
    id: 'gemini-2.5-computer-use-preview-10-2025',
    name: 'gemini-2.5-computer-use-preview-10-2025',
    displayName: 'Gemini 2.5 Computer Use Preview (Vertex AI)',
    contextWindow: 131072, // 128k tokens
    maxOutputTokens: 65536, // 65K tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'structured_output', 'computer_use'
    ],
    inputCostPer1K: 0.00200, outputCostPer1K: 0.00800,
    performance: { latencyMs: 1000, throughput: 100, quality: 0.95, reliability: 0.97 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'computer_use',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      thinking_budget: 'dynamic',
      features: ['computer_use', 'vision', 'function_calling', 'dynamic_shared_quotas', 'global_endpoint']
    },
  },
  // Gemini 2.5 Flash Image via Vertex AI
  {
    id: 'gemini-2.5-flash-image',
    name: 'gemini-2.5-flash-image',
    displayName: 'Gemini 2.5 Flash Image (Vertex AI)',
    contextWindow: 32768, // 32k tokens
    maxOutputTokens: 32768, // 32k tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'image_generation', 'image_editing'
    ],
    inputCostPer1K: 0.00030, outputCostPer1K: 0.000039,
    performance: { latencyMs: 800, throughput: 150, quality: 0.93, reliability: 0.97 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'image_generation',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['native_image_generation', 'image_editing', 'flexibility', 'contextual_understanding']
    },
  },
  // Gemini 2.5 Flash Image Preview via Vertex AI
  {
    id: 'gemini-2.5-flash-image-preview',
    name: 'gemini-2.5-flash-image-preview',
    displayName: 'Gemini 2.5 Flash Image Preview (Vertex AI)',
    contextWindow: 32768, // 32k tokens
    maxOutputTokens: 32768, // 32k tokens
    capabilities: [
      'chat', 'vision', 'multimodal', 'function_calling', 'streaming',
      'image_generation', 'image_editing'
    ],
    inputCostPer1K: 0.00030, outputCostPer1K: 0.000039,
    performance: { latencyMs: 800, throughput: 150, quality: 0.93, reliability: 0.97 },
    metadata: {
      family: 'Gemini 2.5',
      tier: 'image_generation',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['native_image_generation', 'image_editing', 'preview_features']
    },
  },
  // Veo 3.1 Generate Preview via Vertex AI
  {
    id: 'veo-3.1-generate-preview',
    name: 'veo-3.1-generate-preview',
    displayName: 'Veo 3.1 Generate Preview (Vertex AI)',
    contextWindow: 1024, // 1k tokens for text prompt
    maxOutputTokens: 0, // Video output
    capabilities: [
      'video_generation', 'text_to_video', 'image_to_video', 'video_extension',
      'frame_interpolation', 'video_inpainting', 'video_outpainting'
    ],
    inputCostPer1K: 0.00040, outputCostPer1K: 0.00015,
    performance: { latencyMs: 20000, throughput: 10, quality: 0.92, reliability: 0.95 },
    metadata: {
      family: 'Veo',
      tier: 'video_generation',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_video', 'image_to_video', 'reference_to_video', 'frame_interpolation', 'inpainting', 'outpainting']
    },
  },
  // Imagen 4.0 Ultra Generate-001 via Vertex AI
  {
    id: 'imagen-4.0-ultra-generate-001',
    name: 'imagen-4.0-ultra-generate-001',
    displayName: 'Imagen 4.0 Ultra Generate-001 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00006, outputCostPer1K: 0.00006,
    performance: { latencyMs: 3000, throughput: 50, quality: 0.96, reliability: 0.98 },
    metadata: {
      family: 'Imagen 4',
      tier: 'ultra',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'high_quality', 'slow_speed']
    },
  },
  // Imagen 4.0 Generate-001 via Vertex AI
  {
    id: 'imagen-4.0-generate-001',
    name: 'imagen-4.0-generate-001',
    displayName: 'Imagen 4.0 Generate-001 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00004, outputCostPer1K: 0.00004,
    performance: { latencyMs: 2000, throughput: 75, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Imagen 4',
      tier: 'standard',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'balanced_performance']
    },
  },
  // Imagen 4.0 Fast Generate-001 via Vertex AI
  {
    id: 'imagen-4.0-fast-generate-001',
    name: 'imagen-4.0-fast-generate-001',
    displayName: 'Imagen 4.0 Fast Generate-001 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00002, outputCostPer1K: 0.00002,
    performance: { latencyMs: 1000, throughput: 150, quality: 0.90, reliability: 0.97 },
    metadata: {
      family: 'Imagen 4',
      tier: 'fast',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'high_speed', 'lower_quality']
    },
  },
  // Imagen 3.0 Capability-002 via Vertex AI
  {
    id: 'imagen-3.0-capability-002',
    name: 'imagen-3.0-capability-002',
    displayName: 'Imagen 3.0 Capability-002 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'image_editing', 'inpainting', 'outpainting',
      'background_replacement', 'subject_customization', 'style_customization',
      'controlled_customization', 'instruct_customization'
    ],
    inputCostPer1K: 0.00003, outputCostPer1K: 0.00003,
    performance: { latencyMs: 2500, throughput: 60, quality: 0.93, reliability: 0.97 },
    metadata: {
      family: 'Imagen 3',
      tier: 'capability',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['editing_suite', 'mask_editing', 'customization', 'reference_images']
    },
  },
  // Veo 3.0 Generate-001 via Vertex AI
  {
    id: 'veo-3.0-generate-001',
    name: 'veo-3.0-generate-001',
    displayName: 'Veo 3.0 Generate-001 (Vertex AI)',
    contextWindow: 1024, // 1k tokens for text prompt
    maxOutputTokens: 0, // Video output
    capabilities: [
      'video_generation', 'text_to_video', 'image_to_video', 'video_extension',
      'frame_interpolation', 'video_inpainting', 'video_outpainting'
    ],
    inputCostPer1K: 0.00040, outputCostPer1K: 0.00015,
    performance: { latencyMs: 20000, throughput: 10, quality: 0.92, reliability: 0.95 },
    metadata: {
      family: 'Veo',
      tier: 'video_generation',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_video', 'image_to_video', 'reference_to_video', 'frame_interpolation', 'inpainting', 'outpainting']
    },
  },
  // Veo 3.0 Fast Generate-001 via Vertex AI
  {
    id: 'veo-3.0-fast-generate-001',
    name: 'veo-3.0-fast-generate-001',
    displayName: 'Veo 3.0 Fast Generate-001 (Vertex AI)',
    contextWindow: 1024, // 1k tokens for text prompt
    maxOutputTokens: 0, // Video output
    capabilities: [
      'video_generation', 'text_to_video', 'image_to_video', 'video_extension',
      'frame_interpolation', 'video_inpainting', 'video_outpainting'
    ],
    inputCostPer1K: 0.00015, outputCostPer1K: 0.00015,
    performance: { latencyMs: 15000, throughput: 15, quality: 0.89, reliability: 0.94 },
    metadata: {
      family: 'Veo',
      tier: 'fast_video_generation',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_video', 'image_to_video', 'reference_to_video', 'fast_generation']
    },
  },
  // Imagen 4.0 Ultra Generate Preview-06-06 via Vertex AI
  {
    id: 'imagen-4.0-ultra-generate-preview-06-06',
    name: 'imagen-4.0-ultra-generate-preview-06-06',
    displayName: 'Imagen 4.0 Ultra Generate Preview-06-06 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00006, outputCostPer1K: 0.00006,
    performance: { latencyMs: 3000, throughput: 50, quality: 0.96, reliability: 0.98 },
    metadata: {
      family: 'Imagen 4',
      tier: 'ultra_preview',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'high_quality', 'preview_features']
    },
  },
  // Imagen 4.0 Fast Generate Preview-06-06 via Vertex AI
  {
    id: 'imagen-4.0-fast-generate-preview-06-06',
    name: 'imagen-4.0-fast-generate-preview-06-06',
    displayName: 'Imagen 4.0 Fast Generate Preview-06-06 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00002, outputCostPer1K: 0.00002,
    performance: { latencyMs: 1000, throughput: 150, quality: 0.90, reliability: 0.97 },
    metadata: {
      family: 'Imagen 4',
      tier: 'fast_preview',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'high_speed', 'preview_features']
    },
  },
  // Imagen 4.0 Generate Preview-06-06 via Vertex AI
  {
    id: 'imagen-4.0-generate-preview-06-06',
    name: 'imagen-4.0-generate-preview-06-06',
    displayName: 'Imagen 4.0 Generate Preview-06-06 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00004, outputCostPer1K: 0.00004,
    performance: { latencyMs: 2000, throughput: 75, quality: 0.94, reliability: 0.98 },
    metadata: {
      family: 'Imagen 4',
      tier: 'standard_preview',
      year: 2025,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'prompt_enhancement', 'preview_features']
    },
  },
  // Lyria-002 via Vertex AI
  {
    id: 'lyria-002',
    name: 'lyria-002',
    displayName: 'Lyria-002 (Vertex AI)',
    contextWindow: 1000, // For text prompts
    maxOutputTokens: 0, // Audio output
    capabilities: [
      'music_generation', 'text_to_music', 'negative_prompting',
      'reproducibility', 'multiple_samples'
    ],
    inputCostPer1K: 0.01000, outputCostPer1K: 0.01000,
    performance: { latencyMs: 20000, throughput: 5, quality: 0.88, reliability: 0.93 },
    metadata: {
      family: 'Lyria',
      tier: 'music_generation',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_music', 'instrumental_only', '30_seconds', 'watermarking']
    },
  },
  // Imagen 3.0 Generate-002 via Vertex AI
  {
    id: 'imagen-3.0-generate-002',
    name: 'imagen-3.0-generate-002',
    displayName: 'Imagen 3.0 Generate-002 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'text_to_image', 'negative_prompt', 'prompt_enhancement'
    ],
    inputCostPer1K: 0.00003, outputCostPer1K: 0.00003,
    performance: { latencyMs: 2500, throughput: 60, quality: 0.93, reliability: 0.97 },
    metadata: {
      family: 'Imagen 3',
      tier: 'generate',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'negative_prompt', 'prompt_enhancement', 'english_only']
    },
  },
  // Imagen 3.0 Capability-001 via Vertex AI
  {
    id: 'imagen-3.0-capability-001',
    name: 'imagen-3.0-capability-001',
    displayName: 'Imagen 3.0 Capability-001 (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'image_editing', 'inpainting', 'outpainting',
      'background_replacement', 'subject_customization', 'style_customization',
      'controlled_customization', 'instruct_customization'
    ],
    inputCostPer1K: 0.00003, outputCostPer1K: 0.00003,
    performance: { latencyMs: 2500, throughput: 60, quality: 0.93, reliability: 0.97 },
    metadata: {
      family: 'Imagen 3',
      tier: 'capability',
      year: 2024,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['editing_suite', 'mask_editing', 'customization', 'reference_images']
    },
  },
  // Imagegeneration (Imagen 2) via Vertex AI
  {
    id: 'imagegeneration',
    name: 'imagegeneration',
    displayName: 'Imagegeneration (Imagen 2) (Vertex AI)',
    contextWindow: 480, // 480 tokens for text prompt
    maxOutputTokens: 0, // Image output
    capabilities: [
      'image_generation', 'image_editing', 'inpainting', 'outpainting',
      'product_editing', 'mask_editing', 'background_replacement'
    ],
    inputCostPer1K: 0.00003, outputCostPer1K: 0.00003,
    performance: { latencyMs: 3000, throughput: 50, quality: 0.91, reliability: 0.96 },
    metadata: {
      family: 'Imagen 2',
      tier: 'generation_editing',
      year: 2023,
      publisher: 'google',
      via: 'vertex-ai',
      features: ['text_to_image', 'mask_editing', 'segmentation', 'product_editing', 'multi_language']
    },
  },
];

async function syncVertexAIModels() {
  console.log('🔄 SINCRONIZANDO MODELOS VERTEX AI\n');
  console.log('='.repeat(60));

  try {
    // Modelos já definidos diretamente no script
    console.log('📋 Modelos Vertex AI carregados...');
    console.log(`📊 Encontrados ${vertexAIModels.length} modelos`);

    // Preparar dados para sync
    const catalogData = [{
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status: 'active' as const,
      metadata: {
        modelGarden: true,
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'YOUR_PROJECT_ID',
        location: 'us-central1'
      },
      models: vertexAIModels
    }];

    console.log('🔄 Sincronizando com banco de dados...');

    // Executar sync
    await syncModelCatalog(catalogData);

    console.log('✅ Modelos Vertex AI sincronizados com sucesso!');
    console.log(`   • Provider: vertex-ai`);
    console.log(`   • Modelos: ${vertexAIModels.length}`);
    console.log(`   • Status: active`);

    // Listar modelos sincronizados
    console.log('\n📋 Modelos sincronizados:');
    vertexAIModels.forEach(model => {
      console.log(`   • ${model.name}: ${model.displayName}`);
    });

  } catch (error: any) {
    console.error('❌ Falha na sincronização:', error.message);
    process.exit(1);
  }
}

syncVertexAIModels().catch(console.error);
