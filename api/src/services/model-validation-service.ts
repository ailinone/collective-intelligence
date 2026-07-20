// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Validation Service
 *
 * Serviço de validação contínua que testa capacidades dos modelos em background.
 * Atualiza métricas de performance, qualidade e confiabilidade periodicamente.
 */

import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { getModelRepository } from './model-repository';
import type { Model, ModelCapability } from '@/types';
import { createUniversalClient } from '@/client/provider-registry';
import type { ModelRecord } from '@/types/model-client';
import type { UniversalModelClient } from '@/client/universal-model-client';
import { getCapabilityTest } from '@/tests';
import type { CapabilityId } from '@/tests';
import { calculateCodeModelScore } from '@/scoring/code-scoring';
import { getCodeCapabilityProfile } from '@/tests/code-profile-utils';
import {
  calculateBackendScore,
  calculateFrontendScore,
  calculateDataScienceScore,
} from '@/scoring/code-role-scoring';

export interface ValidationTest {
  capability: ModelCapability;
  testType: 'basic' | 'comprehensive' | 'performance';
  priority: number; // 1 = alta prioridade, 5 = baixa prioridade
  timeoutMs: number;
  maxRetries: number;
}

export interface ValidationResult {
  modelId: string;
  capability: ModelCapability;
  success: boolean;
  responseTime: number;
  error?: string;
  score: number; // 0-1, qualidade da resposta
  metadata?: Record<string, unknown>;
}

export interface ModelValidationStats {
  modelId: string;
  lastValidated: Date;
  capabilitiesValidated: ModelCapability[];
  averageResponseTime: number;
  successRate: number;
  qualityScore: number;
  reliabilityScore: number;
  totalTests: number;
  recentFailures: number;
}

export class ModelValidationService {
  private log = logger.child({ component: 'model-validation' });
  private repository = getModelRepository();
  private validationQueue: Array<{ model: Model; priority: number }> = [];
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private testDefinitions: Partial<Record<ModelCapability, ValidationTest>> = {
    chat: {
      capability: 'chat',
      testType: 'basic',
      priority: 1,
      timeoutMs: 10000,
      maxRetries: 2,
    },
    streaming: {
      capability: 'streaming',
      testType: 'basic',
      priority: 2,
      timeoutMs: 15000,
      maxRetries: 1,
    },
    function_calling: {
      capability: 'function_calling',
      testType: 'comprehensive',
      priority: 2,
      timeoutMs: 20000,
      maxRetries: 3,
    },
    vision: {
      capability: 'vision',
      testType: 'comprehensive',
      priority: 3,
      timeoutMs: 30000,
      maxRetries: 2,
    },
    json_mode: {
      capability: 'json_mode',
      testType: 'basic',
      priority: 2,
      timeoutMs: 12000,
      maxRetries: 2,
    },
    reasoning: {
      capability: 'reasoning',
      testType: 'comprehensive',
      priority: 4,
      timeoutMs: 45000,
      maxRetries: 2,
    },
    code_interpreter: {
      capability: 'code_interpreter',
      testType: 'comprehensive',
      priority: 3,
      timeoutMs: 30000,
      maxRetries: 3,
    },
    text_to_speech: {
      capability: 'text_to_speech',
      testType: 'basic',
      priority: 4,
      timeoutMs: 20000,
      maxRetries: 2,
    },
    speech_to_text: {
      capability: 'speech_to_text',
      testType: 'basic',
      priority: 5,
      timeoutMs: 25000,
      maxRetries: 2,
    },
    embeddings: {
      capability: 'embeddings',
      testType: 'basic',
      priority: 3,
      timeoutMs: 8000,
      maxRetries: 2,
    },
    image_generation: {
      capability: 'image_generation',
      testType: 'comprehensive',
      priority: 4,
      timeoutMs: 60000,
      maxRetries: 1,
    },
  };

  /**
   * Inicia validação contínua em background
   */
  async startContinuousValidation(intervalMinutes = 60): Promise<void> {
    if (this.isRunning) {
      this.log.warn('Continuous validation already running');
      return;
    }

    this.isRunning = true;
    this.log.info({ intervalMinutes }, 'Starting continuous model validation');

    // Executa primeira validação imediatamente
    await this.runValidationCycle();

    // Agenda validações periódicas
    this.intervalId = setInterval(
      async () => {
        if (!this.isRunning) return; // Para se foi parado

        try {
          await this.runValidationCycle();
        } catch (error) {
          this.log.error({ error }, 'Error in validation cycle');
        }
      },
      intervalMinutes * 60 * 1000
    );
  }

  /**
   * Para validação contínua
   */
  stopContinuousValidation(): void {
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.log.info('Stopped continuous model validation');
  }

  /**
   * Processa a fila de validações agendadas
   */
  private async processValidationQueue(): Promise<void> {
    if (this.validationQueue.length === 0) {
      return;
    }

    this.log.info({ queueSize: this.validationQueue.length }, 'Processing validation queue');

    const queueItems = [...this.validationQueue];
    this.validationQueue = []; // Limpa a fila

    // Processa em lotes de 5 para não sobrecarregar
    const batchSize = 5;

    for (let i = 0; i < queueItems.length; i += batchSize) {
      const batch = queueItems.slice(i, i + batchSize);

      const batchPromises = batch.map((item) => this.validateModelCapabilities(item.model));

      try {
        await Promise.all(batchPromises);
        this.log.info(
          { processed: Math.min(i + batchSize, queueItems.length), total: queueItems.length },
          'Processed validation queue batch'
        );
      } catch (error) {
        this.log.error({ error, batchIndex: i }, 'Error processing validation queue batch');
      }

      // Pequena pausa entre lotes para não sobrecarregar
      if (i + batchSize < queueItems.length) {
        await this.sleep(1000);
      }
    }

    this.log.info('Validation queue processing completed');
  }

  /**
   * Executa um ciclo completo de validação
   */
  async runValidationCycle(): Promise<void> {
    this.log.info('Starting validation cycle');

    const startTime = Date.now();

    // Primeiro processa a fila de validações agendadas
    await this.processValidationQueue();

    // Busca todos os modelos ativos para validação geral
    const models = await this.repository.searchModels({
      status: 'active',
      limit: 1000, // Valida os primeiros 1000 modelos
    });

    this.log.info(
      { modelCount: models.length, queueSize: this.validationQueue.length },
      'Found models for validation'
    );

    // Prioriza modelos por ordem de validação necessária
    const prioritizedModels = this.prioritizeModelsForValidation(models);

    // Executa validações em lotes para não sobrecarregar
    const batchSize = 10;
    const results: ValidationResult[] = [];

    for (let i = 0; i < prioritizedModels.length; i += batchSize) {
      const batch = prioritizedModels.slice(i, i + batchSize);

      const batchPromises = batch.map((item) => this.validateModelCapabilities(item.model));

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.flat());

      // Pequena pausa entre lotes para não sobrecarregar APIs
      if (i + batchSize < prioritizedModels.length) {
        await this.sleep(1000);
      }
    }

    // Atualiza estatísticas dos modelos
    await this.updateModelStats(results);

    const duration = Date.now() - startTime;
    this.log.info(
      {
        modelsValidated: prioritizedModels.length,
        testsPerformed: results.length,
        duration,
      },
      'Validation cycle completed'
    );
  }

  /**
   * Valida capacidades específicas de um modelo
   */
  async validateModelCapabilities(
    model: Model,
    capabilities?: ModelCapability[]
  ): Promise<ValidationResult[]> {
    const targetCapabilities =
      capabilities || model.capabilities.filter((cap) => this.testDefinitions[cap] !== undefined);

    const results: ValidationResult[] = [];

    for (const capability of targetCapabilities) {
      const testDef = this.testDefinitions[capability];
      if (!testDef) continue;

      let success = false;
      let responseTime = 0;
      let error: string | undefined;
      let score = 0;
      let metadata: Record<string, unknown> | undefined;

      // Tenta executar o teste com retries
      for (let attempt = 1; attempt <= testDef.maxRetries; attempt++) {
        try {
          const startTime = Date.now();
          const testResult = await this.executeCapabilityTest(model, capability, testDef);
          responseTime = Date.now() - startTime;

          success = testResult.success;
          score = testResult.score;
          metadata = testResult.metadata;

          if (success) break;
        } catch (err) {
          error = getErrorMessage(err);
          responseTime = testDef.timeoutMs; // Timeout atingido

          this.log.warn(
            {
              modelId: model.id,
              capability,
              attempt,
              error,
            },
            'Capability test failed'
          );
        }
      }

      results.push({
        modelId: model.id,
        capability,
        success,
        responseTime,
        error,
        score,
        metadata,
      });
    }

    return results;
  }

  /**
   * Executa teste específico de capacidade
   */
  private async executeCapabilityTest(
    model: Model,
    capability: ModelCapability,
    testDef: ValidationTest
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      // Converter Model para ModelRecord (compatibilidade)
      const modelRecord: ModelRecord = {
        id: model.id,
        name: model.displayName,
        provider: model.provider,
        providerModelId: model.name,
        capabilities: model.capabilities,
        type: 'text', // default, pode ser determinado dinamicamente
        config: {
          baseUrl: process.env[`${model.provider.toUpperCase()}_BASE_URL`],
          apiKeyRef: `${model.provider.toUpperCase()}_API_KEY`,
          extra: {},
        },
      };

      const client = createUniversalClient(modelRecord);
      const tester = getCapabilityTest(capability as CapabilityId);

      if (!tester) {
        return {
          success: false,
          score: 0,
          metadata: {
            validated: false,
            validationSkipped: true,
            reason: 'no_test_implemented',
            capability,
            modelId: model.id,
          },
        };
      }

      // Executar teste com timeout
      return this.runWithTimeout(testDef, () => tester({ model: modelRecord, client }));
    } catch (error) {
      this.log.error(
        { error, model: model.id, capability },
        'Erro ao executar teste de capacidade'
      );
      // Fallback para estado "unknown" se a validação real falhar
      return this.fallbackToUnknownState(model, capability, testDef);
    }
  }

  /**
   * Executa teste com timeout real usando Promise.race
   */
  private async runWithTimeout<T>(testDef: ValidationTest, fn: () => Promise<T>): Promise<T> {
    return Promise.race<T>([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Validation timeout após ${testDef.timeoutMs}ms`)),
          testDef.timeoutMs
        )
      ),
    ]);
  }

  /**
   * Returns unknown state when real validation is not possible
   * This is NOT a simulation with fake success - it honestly reports that validation could not be performed
   */
  private async fallbackToUnknownState(
    model: Model,
    capability: ModelCapability,
    _testDef: ValidationTest
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    this.log.warn({ model: model.id, capability }, 'Cannot validate - real client not available');

    // 100% honest - we cannot validate, so we return unknown/indeterminate state
    // success: false because we cannot confirm the capability works
    // score: 0 because we have no evidence
    return {
      success: false,
      score: 0,
      metadata: {
        validated: false,
        validationSkipped: true,
        reason: 'Real API client not available for validation',
        capability,
        modelId: model.id,
      },
    };
  }

  /**
   * Testa capacidade básica de chat
   */
  private async testChatCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      const prompt =
        "Responda exatamente com: 'Hello, World!' (sem aspas, sem ponto final, sem explicações).";
      const expected = 'Hello, World!';

      const result = await client.text({
        prompt,
        system: 'Você é um assistente de teste. Siga as instruções à risca.',
        temperature: 0,
      });

      const content = result.content.trim();
      const success = content === expected;

      return {
        success,
        score: success ? 1 : 0,
        metadata: {
          prompt,
          response: content,
          expected,
          raw: result.raw,
        },
      };
    } catch (error) {
      this.log.error({ error, model: model.id }, 'Erro no teste de chat');
      return { success: false, score: 0, metadata: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Testa capacidade de streaming
   */
  private async testStreamingCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      const prompt = 'Conte de 1 a 10, um número por linha.';

      const stream = client.streamText({
        prompt,
        temperature: 0,
      });

      const chunks: string[] = [];
      let fullText = '';

      for await (const chunk of stream) {
        chunks.push(chunk.content);
        fullText += chunk.content;
      }

      const chunksCount = chunks.length;
      fullText = fullText.trim();

      const hasMultipleChunks = chunksCount > 1;
      const hasAllNumbers = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].every((n) =>
        fullText.includes(n)
      );

      const success = hasMultipleChunks && hasAllNumbers;

      return {
        success,
        score: success ? 0.9 : 0,
        metadata: {
          chunksCount,
          fullText,
        },
      };
    } catch (error) {
      this.log.error({ error, model: model.id }, 'Erro no teste de streaming');
      return { success: false, score: 0, metadata: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Testa capacidade de function calling
   */
  private async testFunctionCallingCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      const tools = [
        {
          name: 'get_weather',
          description: 'Retorna a temperatura atual em Celsius para uma cidade.',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city', 'unit'],
          },
        },
      ];

      const prompt =
        'Qual é a temperatura em São Paulo em Celsius agora? Não responda você, chame apenas a função adequada.';

      const result = await client.toolChat({
        messages: [
          { role: 'system', content: 'Você é um assistente que pode chamar ferramentas.' },
          { role: 'user', content: prompt }
        ],
        tools,
        toolChoice: 'auto'
      });

      const toolCall = result.toolCalls[0];
      const cityArg = toolCall?.arguments?.city;
      const cityStr = typeof cityArg === 'string' ? cityArg : String(cityArg || '');
      const success =
        toolCall &&
        toolCall.toolName === 'get_weather' &&
        cityStr.toLowerCase().includes('são paulo') &&
        toolCall.arguments.unit === 'celsius';

      return {
        success,
        score: success ? 0.85 : 0,
        metadata: {
          toolCalls: result.toolCalls,
          raw: result.raw,
        },
      };
    } catch (error) {
      this.log.error({ error, model: model.id }, 'Erro no teste de function calling');
      return { success: false, score: 0, metadata: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private logCapabilityTest(
    model: Model,
    client: UniversalModelClient,
    capability: string
  ): void {
    this.log.debug(
      {
        modelId: model.id,
        provider: client.model?.provider,
        capability,
      },
      'Running capability validation test'
    );
  }

  private async capabilityValidationUnavailable(
    model: Model,
    client: UniversalModelClient,
    capability: ModelCapability,
    reason: string
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    this.logCapabilityTest(model, client, capability);
    this.log.warn({ modelId: model.id, capability, reason }, 'Capability validation unavailable');

    return {
      success: false,
      score: 0,
      metadata: {
        validated: false,
        validationSkipped: true,
        reason,
        capability,
        provider: client.model?.provider,
      },
    };
  }

  /**
   * Testa capacidade de visão
   */
  private async testVisionCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'vision',
      'Vision validation requires a dedicated runtime probe and image fixture.'
    );
  }

  /**
   * Testa capacidade de JSON mode
   */
  private async testJsonModeCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'json_mode',
      'JSON mode validation requires schema enforcement assertions per provider.'
    );
  }

  /**
   * Testa capacidade de reasoning
   */
  private async testReasoningCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      const prompt = `
João tem 5 maçãs. Ele compra mais 7 e dá 3 para Maria.
Depois, ele compra o dobro do que sobrou.
Quantas maçãs João tem no final?
Explique o raciocínio e dê a resposta final no formato "Resposta: X".
`;

      const result = await client.text({
        prompt,
        system: 'Resolva passo a passo, com cuidado.',
      });

      const text = result.content;
      const hasCorrectAnswer = /Resposta:\s*16\b/.test(text);

      return {
        success: hasCorrectAnswer,
        score: hasCorrectAnswer ? 0.7 : 0,
        metadata: {
          response: text,
          raw: result.raw,
        },
      };
    } catch (error) {
      this.log.error({ error, model: model.id }, 'Erro no teste de reasoning');
      return { success: false, score: 0, metadata: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Testa capacidade de code interpreter
   */
  private async testCodeInterpreterCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    try {
      const prompt = `
Calcule a soma dos números de 1 a 100000.
Use código para garantir precisão.
Responda no formato "Resultado: X".
`;

      const result = await client.text({
        prompt,
        system: 'Execute código quando necessário para resolver problemas matemáticos.',
      });

      const text = result.content;
      const expected = (100000 * 100001) / 2; // fórmula n(n+1)/2
      const match = text.match(/Resultado:\s*(\d+)/);

      let success = false;
      if (match) {
        const value = Number(match[1]);
        success = value === expected;
      }

      return {
        success,
        score: success ? 0.75 : 0,
        metadata: {
          response: text,
          expected,
          raw: result.raw,
        },
      };
    } catch (error) {
      this.log.error({ error, model: model.id }, 'Erro no teste de code interpreter');
      return { success: false, score: 0, metadata: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Testa capacidade de text-to-speech
   */
  private async testTextToSpeechCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'text_to_speech',
      'TTS validation requires deterministic audio fixture generation and analysis.'
    );
  }

  /**
   * Testa capacidade de speech-to-text
   */
  private async testSpeechToTextCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'speech_to_text',
      'STT validation requires deterministic audio fixtures and transcript assertions.'
    );
  }

  /**
   * Testa capacidade de embeddings
   */
  private async testEmbeddingsCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'embeddings',
      'Embeddings validation requires deterministic vector similarity probes.'
    );
  }

  /**
   * Testa capacidade de image generation
   */
  private async testImageGenerationCapability(
    model: Model,
    client: UniversalModelClient
  ): Promise<{ success: boolean; score: number; metadata?: Record<string, unknown> }> {
    return this.capabilityValidationUnavailable(
      model,
      client,
      'image_generation',
      'Image generation validation requires visual-quality probes and deterministic assertions.'
    );
  }

  /**
   * Prioriza modelos para validação baseado em necessidade
   */
  private prioritizeModelsForValidation(
    models: Model[]
  ): Array<{ model: Model; priority: number }> {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneWeekMs = 7 * oneDayMs;

    return models
      .map((model) => {
        let priority = 5; // Padrão: baixa prioridade

        // Modelos nunca validados têm prioridade máxima
        if (!model.performance?.lastValidated) {
          priority = 1;
        } else {
          const timeSinceValidation = now - new Date(model.performance.lastValidated).getTime();

          // Modelos não validados há mais de uma semana
          if (timeSinceValidation > oneWeekMs) {
            priority = 2;
          }
          // Modelos não validados há mais de um dia
          else if (timeSinceValidation > oneDayMs) {
            priority = 3;
          }
          // Modelos validados recentemente mas com baixa confiabilidade
          else if ((model.performance?.reliability || 0) < 0.8) {
            priority = 2;
          }
        }

        return { model, priority };
      })
      .sort((a, b) => a.priority - b.priority); // Ordena por prioridade (menor = mais urgente)
  }

  /**
   * Atualiza estatísticas dos modelos baseado nos resultados de validação
   */
  private async updateModelStats(results: ValidationResult[]): Promise<void> {
    const modelStats = new Map<
      string,
      {
        results: ValidationResult[];
        totalResponseTime: number;
        successCount: number;
      }
    >();

    // Agrupa resultados por modelo
    for (const result of results) {
      if (!modelStats.has(result.modelId)) {
        modelStats.set(result.modelId, {
          results: [],
          totalResponseTime: 0,
          successCount: 0,
        });
      }

      const stats = modelStats.get(result.modelId)!;
      stats.results.push(result);
      stats.totalResponseTime += result.responseTime;
      if (result.success) stats.successCount++;
    }

    // Atualiza cada modelo
    for (const [modelId, stats] of modelStats) {
      const capabilitiesValidated = stats.results.map((r) => r.capability);
      const averageResponseTime = stats.totalResponseTime / stats.results.length;
      const successRate = stats.successCount / stats.results.length;
      const qualityScore =
        stats.results.reduce((sum, r) => sum + r.score, 0) / stats.results.length;
      const recentFailures = stats.results.filter((r) => !r.success).length;

      // Calcula reliability baseado em histórico e testes recentes
      const reliabilityScore = this.calculateReliabilityScore(modelId, successRate, recentFailures);

      // NOVO: Calcular score específico para "code"
      const codeScoreObj = calculateCodeModelScore(modelId, stats.results);
      const codeScore = codeScoreObj?.score ?? null;
      const codeTier = codeScoreObj?.tier ?? null;

      // NOVO: Calcular scores por role baseado no perfil do modelo
      const model = await this.repository.getModelById(modelId);
      const codeProfile = model ? getCodeCapabilityProfile(model) : null;

      let backendScore: number | undefined;
      let frontendScore: number | undefined;
      let dataScienceScore: number | undefined;

      if (codeProfile?.role === 'backend') {
        const s = calculateBackendScore(modelId, stats.results);
        backendScore = s?.score ?? undefined;
      } else if (codeProfile?.role === 'frontend') {
        const s = calculateFrontendScore(modelId, stats.results);
        frontendScore = s?.score ?? undefined;
      } else if (codeProfile?.role === 'data_science') {
        const s = calculateDataScienceScore(modelId, stats.results);
        dataScienceScore = s?.score ?? undefined;
      }

      await this.repository.updateModelPerformance(modelId, {
        latencyMs: averageResponseTime,
        quality: qualityScore,
        reliability: reliabilityScore,
        codeScore: codeScore ?? undefined,
        codeTier: codeTier ?? undefined,
        codeBackendScore: backendScore,
        codeFrontendScore: frontendScore,
        codeDataScienceScore: dataScienceScore,
      });

      // Log estatísticas
      this.log.debug(
        {
          modelId,
          capabilitiesValidated: capabilitiesValidated.length,
          averageResponseTime: Math.round(averageResponseTime),
          successRate: Math.round(successRate * 100) + '%',
          qualityScore: Math.round(qualityScore * 100) + '%',
          reliabilityScore: Math.round(reliabilityScore * 100) + '%',
          codeScore: codeScore ? Math.round(codeScore * 100) + '%' : 'n/a',
          codeTier: codeTier ?? 'n/a',
          backendScore: backendScore ? Math.round(backendScore * 100) + '%' : 'n/a',
          frontendScore: frontendScore ? Math.round(frontendScore * 100) + '%' : 'n/a',
          dataScienceScore: dataScienceScore ? Math.round(dataScienceScore * 100) + '%' : 'n/a',
        },
        'Updated model validation stats'
      );
    }
  }

  /**
   * Calcula score de confiabilidade baseado em histórico e testes recentes
   */
  private calculateReliabilityScore(
    modelId: string,
    recentSuccessRate: number,
    recentFailures: number
  ): number {
    // Em produção, isso levaria em conta histórico de validações anteriores
    // Por enquanto, usa apenas os resultados recentes

    let reliability = recentSuccessRate;

    // Penaliza falhas recentes
    if (recentFailures > 0) {
      reliability *= Math.max(0.1, 1 - recentFailures * 0.1);
    }

    return Math.max(0, Math.min(1, reliability));
  }

  /**
   * Obtém estatísticas de validação de um modelo
   */
  async getModelValidationStats(modelId: string): Promise<ModelValidationStats | null> {
    const model = await this.repository.getModelById(modelId);
    if (!model || !model.performance) {
      return null;
    }

    // Em produção, isso buscaria histórico de validações do banco
    // Por enquanto, retorna dados atuais
    const lastValidated = model.performance.lastValidated;
    if (!lastValidated) {
      return null;
    }

    const reliability = model.performance.reliability || 0;
    const quality = model.performance.quality || 0;
    const averageResponseTime = model.performance.latencyMs || 0;

    return {
      modelId,
      lastValidated: new Date(lastValidated),
      capabilitiesValidated: model.capabilities,
      averageResponseTime,
      successRate: reliability,
      qualityScore: quality,
      reliabilityScore: reliability,
      totalTests: 0,
      recentFailures: reliability < 1 ? 1 : 0,
    };
  }

  /**
   * Agenda validação de um modelo específico
   */
  async scheduleModelValidation(modelId: string, priority = 3): Promise<void> {
    try {
      const model = await this.repository.getModelById(modelId);
      if (!model) {
        this.log.warn({ modelId }, 'Model not found for validation scheduling');
        return;
      }

      // Adicionar à fila de validação
      this.validationQueue.push({ model, priority });

      // Ordenar por prioridade (menor número = maior prioridade)
      this.validationQueue.sort((a, b) => a.priority - b.priority);

      this.log.info(
        { modelId, priority, queueSize: this.validationQueue.length },
        'Model validation scheduled'
      );
    } catch (error) {
      this.log.error({ error, modelId }, 'Error scheduling model validation');
    }
  }

  /**
   * Utilitário para sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function getModelValidationService(): ModelValidationService {
  return new ModelValidationService();
}
