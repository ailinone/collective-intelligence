// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fine-tuning Service
 * Manages fine-tuning jobs across multiple providers
 * 
 * Features:
 * - Multi-provider orchestration (OpenAI, Google Gemini, etc.)
 * - Job lifecycle management
 * - Event streaming
 * - Checkpoint management
 * - Metrics tracking
 * 
 * NO HARDCODED - Provider selection based on base model availability
 * REAL IMPLEMENTATION - Integrates with OpenAI/Gemini fine-tuning APIs
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import { getProviderRegistry } from '@/providers/provider-registry';
import { ModelRepository } from '@/services/model-repository';
import { FilesService } from '@/services/files-service';
import { toPrismaJsonValue, toPrismaNullableJsonValue } from '@/services/assistants-service-helpers';
import { Prisma } from '@/generated/prisma/index.js';
import type {
  CreateFineTuningJobRequest,
  ListFineTuningJobsRequest,
  GetFineTuningJobRequest,
  CancelFineTuningJobRequest,
  ListFineTuningEventsRequest,
  ListFineTuningCheckpointsRequest,
  DeleteFineTuningJobRequest,
  FineTuningJob,
  FineTuningHyperparameters,
  FineTuningIntegration,
  FineTuningEvent,
  FineTuningCheckpoint,
  ListFineTuningJobsResponse,
  ListFineTuningEventsResponse,
  ListFineTuningCheckpointsResponse,
  DeleteFineTuningJobResponse,
} from '@/types/fine-tuning';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import {
  GoogleFineTuningClient,
  GoogleTuningNotConfiguredError,
  mapGoogleStateToNormalizedStatus,
  type GoogleTunedModel,
  type GoogleTuningExample,
  type GoogleTuningHyperparameters,
  type GoogleTuningSnapshot,
} from '@/providers/google/google-fine-tuning-client';
import type { Model } from '@/types';

const log = logger.child({ service: 'fine-tuning' });

/**
 * Providers with a REAL, fully-implemented fine-tuning lifecycle in this
 * service. Surfaced in error messages so callers know what's supported.
 */
const SUPPORTED_FINE_TUNING_PROVIDERS = ['openai', 'google'] as const;

/**
 * Default Gemini base model used for tuning when the requested model is not a
 * dedicated `*-tuning` resource. The Gemini tuning API requires the base model
 * to be tuning-enabled (resource form `models/<id>`).
 */
function toGoogleTuningBaseModel(modelName: string): string {
  const trimmed = (modelName || '').trim();
  if (!trimmed) {
    return 'models/gemini-1.5-flash-001-tuning';
  }
  // Already a fully-qualified resource name.
  if (trimmed.startsWith('models/') || trimmed.startsWith('tunedModels/')) {
    return trimmed;
  }
  // Strip a leading google provider prefix if present (e.g. "google/gemini-...").
  const bare = trimmed.replace(/^google[/:_-]/i, '');
  return `models/${bare}`;
}

/**
 * Parse a fine-tune training file (OpenAI chat JSONL) into Gemini supervised
 * tuning examples `{ textInput, output }`. Supports both the chat format
 * (`{"messages":[...]}`) and the legacy prompt/completion format
 * (`{"prompt":"...","completion":"..."}`).
 *
 * Returns an empty array if no usable examples are found; the caller decides
 * how to surface that.
 */
function parseTrainingFileToGoogleExamples(
  raw: string
): GoogleTuningExample[] {
  const examples: GoogleTuningExample[] = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;

    // Legacy prompt/completion format.
    if (typeof obj.prompt === 'string' && typeof obj.completion === 'string') {
      const textInput = obj.prompt.trim();
      const output = obj.completion.trim();
      if (textInput && output) {
        examples.push({ textInput, output });
      }
      continue;
    }

    // OpenAI chat format: { messages: [{ role, content }, ...] }.
    if (Array.isArray(obj.messages)) {
      const messages = obj.messages as Array<Record<string, unknown>>;
      const inputParts: string[] = [];
      let output = '';

      for (const message of messages) {
        const role = typeof message.role === 'string' ? message.role : '';
        const content =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? (message.content as Array<Record<string, unknown>>)
                  .map((part) =>
                    typeof part.text === 'string' ? part.text : ''
                  )
                  .join('')
              : '';

        if (role === 'assistant') {
          // Last assistant turn is the target output.
          output = content;
        } else if (role === 'system' || role === 'user') {
          if (content) inputParts.push(content);
        }
      }

      const textInput = inputParts.join('\n').trim();
      if (textInput && output.trim()) {
        examples.push({ textInput, output: output.trim() });
      }
    }
  }

  return examples;
}

/**
 * Map normalized hyperparameters (OpenAI vocabulary) to the Gemini tuning
 * hyperparameter shape. "auto" / undefined values are dropped so Google picks
 * its own defaults.
 */
function toGoogleHyperparameters(
  hyperparameters: FineTuningHyperparameters | undefined
): GoogleTuningHyperparameters | undefined {
  if (!hyperparameters) return undefined;
  const hp: GoogleTuningHyperparameters = {};
  if (typeof hyperparameters.n_epochs === 'number') {
    hp.epochCount = hyperparameters.n_epochs;
  }
  if (typeof hyperparameters.batch_size === 'number') {
    hp.batchSize = hyperparameters.batch_size;
  }
  if (typeof hyperparameters.learning_rate_multiplier === 'number') {
    hp.learningRateMultiplier = hyperparameters.learning_rate_multiplier;
  }
  return Object.keys(hp).length > 0 ? hp : undefined;
}

/**
 * Extract the `tunedModels/...` resource name (our Google providerJobId) from
 * a tunedModels.create Operation. Prefers `response.name`, falls back to
 * `metadata.tunedModel`, then the operation `name`.
 */
function extractGoogleTunedModelName(operation: {
  name?: string;
  metadata?: { tunedModel?: string };
  response?: { name?: string };
}): string | null {
  if (operation.response?.name && operation.response.name.trim()) {
    return operation.response.name.trim();
  }
  if (operation.metadata?.tunedModel && operation.metadata.tunedModel.trim()) {
    return operation.metadata.tunedModel.trim();
  }
  if (operation.name && operation.name.trim()) {
    return operation.name.trim();
  }
  return null;
}

/**
 * Build normalized FineTuningEvents from Gemini tuning snapshots. Snapshots
 * are the closest analogue to OpenAI's training events (per-step metrics).
 */
function googleSnapshotsToEvents(
  snapshots: GoogleTuningSnapshot[] | undefined
): FineTuningEvent[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.map((snapshot, index): FineTuningEvent => {
    const step = typeof snapshot.step === 'number' ? snapshot.step : index;
    const loss =
      typeof snapshot.meanLoss === 'number' ? snapshot.meanLoss : undefined;
    const epoch =
      typeof snapshot.epoch === 'number' ? snapshot.epoch : undefined;
    const message =
      loss !== undefined
        ? `Step ${step}${epoch !== undefined ? ` (epoch ${epoch})` : ''}: mean_loss=${loss}`
        : `Step ${step}`;
    const data: Record<string, unknown> = { step };
    if (loss !== undefined) data.mean_loss = loss;
    if (epoch !== undefined) data.epoch = epoch;
    return {
      id: `ftevent-google-${step}-${index}`,
      object: 'fine_tuning.job.event',
      created_at: Math.floor(Date.now() / 1000),
      level: 'info',
      message,
      data,
    };
  });
}

/**
 * Build normalized FineTuningCheckpoints from Gemini tuning snapshots.
 */
function googleSnapshotsToCheckpoints(
  tunedModelName: string,
  snapshots: GoogleTuningSnapshot[] | undefined
): FineTuningCheckpoint[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.map((snapshot, index): FineTuningCheckpoint => {
    const step = typeof snapshot.step === 'number' ? snapshot.step : index;
    const loss = typeof snapshot.meanLoss === 'number' ? snapshot.meanLoss : 0;
    return {
      id: `ftckpt-google-${step}-${index}`,
      object: 'fine_tuning.job.checkpoint',
      created_at: Math.floor(Date.now() / 1000),
      fine_tuned_model_checkpoint: tunedModelName,
      step_number: step,
      metrics: {
        step,
        train_loss: loss,
        train_mean_token_accuracy: 0,
      },
    };
  });
}

/**
 * OpenAI Fine-tuning Job response types
 * Type-safe interfaces for OpenAI API responses
 */
interface OpenAIHyperparameters {
  n_epochs?: number | string;
  batch_size?: number | string;
  learning_rate_multiplier?: number | string;
}

interface OpenAIJobIntegration {
  type: string;
  wandb?: {
    project: string;
    name?: string;
    entity?: string;
    tags?: string[];
  };
}

interface OpenAIFineTuningJob {
  id: string;
  object: string;
  created_at: number;
  finished_at: number | null;
  model: string;
  fine_tuned_model: string | null;
  organization_id: string;
  result_files: string[];
  status: string;
  validation_file: string | null;
  training_file: string;
  hyperparameters: OpenAIHyperparameters;
  trained_tokens: number | null;
  integrations: OpenAIJobIntegration[] | null;
  seed: number | null;
  estimated_finish: number | null;
}

// OpenAIFineTuningJobsListResponse intentionally not exported; callers
// inline the shape. Removed to keep the file lint-clean.

interface OpenAIFineTuningEvent {
  id: string;
  object: string;
  created_at: number;
  level: string;
  message: string;
  data: Record<string, unknown> | null;
}

interface OpenAIFineTuningEventsListResponse {
  data: OpenAIFineTuningEvent[];
  has_more: boolean;
}

/**
 * Map OpenAI status string to FineTuningJob status
 */
function mapOpenAIStatusToFineTuningStatus(
  status: string
): FineTuningJob['status'] {
  const validStatuses: FineTuningJob['status'][] = [
    'validating_files',
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ];
  if (validStatuses.includes(status as FineTuningJob['status'])) {
    return status as FineTuningJob['status'];
  }
  // Default to 'queued' if status is unknown
  return 'queued';
}

/**
 * Type guard for OpenAI integration
 */
function isValidWandbIntegration(integration: unknown): integration is OpenAIJobIntegration {
  if (!integration || typeof integration !== 'object') return false;
  const i = integration as Record<string, unknown>;
  if (typeof i.type !== 'string') return false;
  if (i.type === 'wandb' && i.wandb) {
    const w = i.wandb as Record<string, unknown>;
    return typeof w.project === 'string';
  }
  return true;
}

/**
 * Map OpenAI integrations to FineTuningIntegration[]. Handles unknown input
 * safely with type guards.
 *
 * Currently unused — wired in once OpenAI integrations endpoint surfaces
 * structured data. Underscore prefix marks intent (kept for future use,
 * not dead code).
 */
function _mapOpenAIIntegrations(
  integrations: unknown
): FineTuningIntegration[] | undefined {
  if (!integrations || !Array.isArray(integrations)) {
    return undefined;
  }
  
  const validIntegrations: FineTuningIntegration[] = [];
  
  for (const integration of integrations) {
    if (!isValidWandbIntegration(integration)) {
      continue;
    }
    
    if (integration.type === 'wandb' && integration.wandb) {
      validIntegrations.push({
        type: 'wandb',
        wandb: {
          project: integration.wandb.project,
          name: integration.wandb.name,
          entity: integration.wandb.entity,
          tags: integration.wandb.tags,
        },
      });
    } else {
      validIntegrations.push({
        type: integration.type,
      });
    }
  }
  
  return validIntegrations.length > 0 ? validIntegrations : undefined;
}

export class FineTuningService {
  private filesService: FilesService;
  private modelRepo: ModelRepository;

  constructor() {
    this.filesService = new FilesService();
    this.modelRepo = new ModelRepository();
  }

  /**
   * Resolve a real Google fine-tuning client from the registered Google
   * adapter. Throws a 503 `provider_not_configured` error when the Google
   * adapter is not registered (no credential) — NEVER a placeholder.
   */
  private getGoogleFineTuningClient(): GoogleFineTuningClient {
    const providerRegistry = getProviderRegistry();
    const adapter = providerRegistry.get('google');

    if (!(adapter instanceof GoogleAdapter)) {
      const err = new Error(
        'Google fine-tuning requires a configured Gemini API key. ' +
          'The Google provider is not registered (missing GEMINI_API_KEY/GOOGLE credential).'
      ) as Error & { statusCode: number; code: string };
      err.statusCode = 503;
      err.code = 'provider_not_configured';
      throw err;
    }

    // GoogleFineTuningClient throws GoogleTuningNotConfiguredError (503) if the
    // key is empty; surface it consistently as a 503 here.
    try {
      return new GoogleFineTuningClient({ apiKey: adapter.getApiKey() });
    } catch (error) {
      if (error instanceof GoogleTuningNotConfiguredError) {
        const err = error as Error & { statusCode: number; code: string };
        throw err;
      }
      throw error;
    }
  }

  private createCapabilityNotOperationalError(params: {
    capability: string;
    model: Model;
    nonOperationalReasons: string[];
  }): Error & { statusCode: number; code: string; details: Record<string, unknown> } {
    const reasonList =
      params.nonOperationalReasons.length > 0
        ? params.nonOperationalReasons
        : ['no_registered_execution_provider'];
    const err = new Error(
      `Model ${params.model.name} is not operational for capability ${params.capability}: ${reasonList.join(', ')}`
    ) as Error & { statusCode: number; code: string; details: Record<string, unknown> };
    err.statusCode = 422;
    err.code = 'capability_not_operational';
    err.details = {
      capability: params.capability,
      model: params.model.name,
      provider: params.model.provider,
      reasons: reasonList,
    };
    return err;
  }

  /**
   * Map database FineTuningJob to API FineTuningJob format
   */
  private mapDbJobToApiJob(dbJob: {
    id: string;
    organizationId: string;
    status: string;
    model: string;
    fineTunedModel: string | null;
    trainingFileId: string;
    validationFileId: string | null;
    hyperparameters: unknown;
    integrations: unknown;
    resultFiles: string[];
    trainedTokens: number | null;
    seed: number | null;
    estimatedFinish: number | null;
    createdAt: Date;
    finishedAt: Date | null;
  }): FineTuningJob {
    // Parse hyperparameters from JSON
    const hyperparams = typeof dbJob.hyperparameters === 'object' && dbJob.hyperparameters !== null
      ? dbJob.hyperparameters as Record<string, unknown>
      : {};
    
    const hyperparameters: FineTuningHyperparameters = {
      n_epochs: typeof hyperparams.n_epochs === 'number' ? hyperparams.n_epochs : 'auto',
      batch_size: typeof hyperparams.batch_size === 'number' ? hyperparams.batch_size : 'auto',
      learning_rate_multiplier: typeof hyperparams.learning_rate_multiplier === 'number' 
        ? hyperparams.learning_rate_multiplier 
        : 'auto',
    };

    // Parse integrations from JSON
    let parsedIntegrations: FineTuningIntegration[] | undefined = undefined;
    if (dbJob.integrations) {
      if (Array.isArray(dbJob.integrations)) {
        parsedIntegrations = dbJob.integrations as FineTuningIntegration[];
      } else if (typeof dbJob.integrations === 'string') {
        try {
          parsedIntegrations = JSON.parse(dbJob.integrations) as FineTuningIntegration[];
        } catch {
          parsedIntegrations = undefined;
        }
      }
    }

    return {
      id: dbJob.id,
      object: 'fine_tuning.job',
      created_at: Math.floor(dbJob.createdAt.getTime() / 1000),
      finished_at: dbJob.finishedAt ? Math.floor(dbJob.finishedAt.getTime() / 1000) : null,
      model: dbJob.model,
      fine_tuned_model: dbJob.fineTunedModel || null,
      organization_id: dbJob.organizationId,
      result_files: dbJob.resultFiles,
      status: dbJob.status as FineTuningJob['status'],
      validation_file: dbJob.validationFileId || null,
      training_file: dbJob.trainingFileId,
      hyperparameters,
      trained_tokens: dbJob.trainedTokens || null,
      integrations: parsedIntegrations,
      seed: dbJob.seed || undefined,
      estimated_finish: dbJob.estimatedFinish || null,
    };
  }

  /**
   * Create fine-tuning job
   * REAL IMPLEMENTATION - Integrates with OpenAI/Gemini fine-tuning APIs
   */
  async createJob(options: CreateFineTuningJobRequest): Promise<FineTuningJob> {
    const { training_file, validation_file, model, hyperparameters, suffix, integrations, seed, userContext, requestId } = options;
    
    const jobId = `ftjob-${nanoid(24)}`;
    // `createdAt` previously captured here was unused — the DB row's
    // `createdAt` (auto-set) is the authoritative timestamp.

    log.info({ requestId, jobId, model, training_file }, 'Creating fine-tuning job');

    try {
      // Step 1: Validate training file exists and is accessible
      const trainingFile = await this.filesService.getFile({
        fileId: training_file,
        userContext,
        requestId,
      });

      if (trainingFile.purpose !== 'fine-tune') {
        throw new Error(`Training file purpose must be "fine-tune", got "${trainingFile.purpose}"`);
      }

      // Step 2: Validate validation file if provided
      if (validation_file) {
        const validationFile = await this.filesService.getFile({
          fileId: validation_file,
          userContext,
          requestId,
        });

        if (validationFile.purpose !== 'fine-tune') {
          throw new Error(`Validation file purpose must be "fine-tune", got "${validationFile.purpose}"`);
        }
      }

      // Step 3: Select provider based on base model dynamically
      // Determine provider from model name (e.g., gpt-* -> openai, gemini-* -> google)
      const selectedModel = await this.modelRepo.getModelById(model);
      if (!selectedModel) {
        throw new Error(`Base model ${model} not found in model catalog`);
      }

      const providerRegistry = getProviderRegistry();
      const resolution = providerRegistry.resolveAdapterForModel(selectedModel);
      const adapter = resolution.adapter;

      if (!adapter) {
        throw this.createCapabilityNotOperationalError({
          capability: 'fine_tuning',
          model: selectedModel,
          nonOperationalReasons: resolution.operability.nonOperationalReasons,
        });
      }

      // Step 4: Call provider's fine-tuning API
      // For OpenAI, use client.fineTuning.jobs.create()
      if (selectedModel.provider === 'openai' && adapter instanceof OpenAIAdapter) {
        // Access OpenAI client from adapter using public method
        const openaiClient = adapter.getClient();
        
        if (!openaiClient.fineTuning || !openaiClient.fineTuning.jobs) {
          throw new Error('OpenAI client does not support fine-tuning API');
        }

        // Create fine-tuning job via OpenAI API
        const openaiJobResponse = await openaiClient.fineTuning.jobs.create({
          training_file: training_file,
          validation_file: validation_file || undefined,
          model: model,
          hyperparameters: hyperparameters ? {
            n_epochs: hyperparameters.n_epochs === 'auto' ? undefined : (typeof hyperparameters.n_epochs === 'number' ? hyperparameters.n_epochs : undefined),
            batch_size: hyperparameters.batch_size === 'auto' ? undefined : (typeof hyperparameters.batch_size === 'number' ? hyperparameters.batch_size : undefined),
            learning_rate_multiplier: hyperparameters.learning_rate_multiplier === 'auto' ? undefined : (typeof hyperparameters.learning_rate_multiplier === 'number' ? hyperparameters.learning_rate_multiplier : undefined),
          } : undefined,
          suffix: suffix || undefined,
          integrations: integrations ? integrations.filter((integration) => integration.type === 'wandb' && integration.wandb).map((integration) => ({
            type: 'wandb' as const,
            wandb: {
              project: integration.wandb!.project,
              name: integration.wandb!.name,
              entity: integration.wandb!.entity,
              tags: integration.wandb!.tags,
            },
          })) : undefined,
          seed: seed || undefined,
        });
        
        // Type guard to validate OpenAI job response structure
        const isValidOpenAIJob = (job: unknown): job is OpenAIFineTuningJob => {
          if (!job || typeof job !== 'object') return false;
          const j = job as Record<string, unknown>;
          return (
            typeof j.id === 'string' &&
            typeof j.object === 'string' &&
            typeof j.created_at === 'number' &&
            typeof j.model === 'string' &&
            typeof j.status === 'string'
          );
        };
        
        if (!isValidOpenAIJob(openaiJobResponse)) {
          throw new Error('Invalid response from OpenAI fine-tuning jobs.create API');
        }
        
        const openaiJob: OpenAIFineTuningJob = openaiJobResponse;

        // Step 5: Store job metadata in database
        const jobStatus = mapOpenAIStatusToFineTuningStatus(openaiJob.status);
        const hyperparams: Record<string, unknown> = {
          n_epochs: typeof openaiJob.hyperparameters.n_epochs === 'number' ? openaiJob.hyperparameters.n_epochs : 'auto',
          batch_size: typeof openaiJob.hyperparameters.batch_size === 'number' ? openaiJob.hyperparameters.batch_size : 'auto',
          learning_rate_multiplier: typeof openaiJob.hyperparameters.learning_rate_multiplier === 'number' ? openaiJob.hyperparameters.learning_rate_multiplier : 'auto',
        };
        
        const createData: {
          id: string;
          organizationId: string;
          userId: string | null;
          provider: string;
          providerJobId: string;
          model: string;
          fineTunedModel: string | null;
          trainingFileId: string;
          validationFileId: string | null;
          status: string;
          hyperparameters: Prisma.InputJsonValue;
          integrations?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
          resultFiles: string[];
          trainedTokens: number | null;
          seed: number | null;
          estimatedFinish: number | null;
          finishedAt: Date | null;
        } = {
          id: openaiJob.id,
          organizationId: userContext.organizationId,
          userId: userContext.userId || null,
          provider: selectedModel.provider,
          providerJobId: openaiJob.id,
          model: openaiJob.model,
          fineTunedModel: openaiJob.fine_tuned_model || null,
          trainingFileId: openaiJob.training_file,
          validationFileId: openaiJob.validation_file || null,
          status: jobStatus,
          hyperparameters: toPrismaJsonValue(hyperparams),
          resultFiles: openaiJob.result_files,
          trainedTokens: openaiJob.trained_tokens || null,
          seed: openaiJob.seed || null,
          estimatedFinish: openaiJob.estimated_finish || null,
          finishedAt: openaiJob.finished_at ? new Date(openaiJob.finished_at * 1000) : null,
        };

        if (integrations) {
          createData.integrations = toPrismaNullableJsonValue(integrations);
        }

        const dbJob = await prisma.fineTuningJob.create({
          data: createData,
        });
        
        log.info({ requestId, jobId: dbJob.id, openaiJobId: openaiJob.id }, 'Fine-tuning job created and persisted in database');

        return this.mapDbJobToApiJob(dbJob);
      } else if (selectedModel.provider === 'google') {
        // REAL Google Gemini tuning. Resolves the registered Google adapter's
        // credential and hits the live tunedModels.create endpoint. If the
        // credential/project is missing, getGoogleFineTuningClient() throws a
        // 503 provider_not_configured (NEVER a placeholder).
        const googleClient = this.getGoogleFineTuningClient();

        // Pull the training file content and convert it to Gemini supervised
        // tuning examples.
        const trainingContent = await this.filesService.getFileContent({
          fileId: training_file,
          userContext,
          requestId,
        });
        const examples = parseTrainingFileToGoogleExamples(
          trainingContent.content.toString('utf-8')
        );

        if (examples.length === 0) {
          const err = new Error(
            'Training file produced no usable Gemini tuning examples. Expected JSONL with ' +
              'OpenAI chat format ({"messages":[...]}) or prompt/completion pairs.'
          ) as Error & { statusCode: number; code: string };
          err.statusCode = 400;
          err.code = 'invalid_training_file';
          throw err;
        }

        const baseModel = toGoogleTuningBaseModel(model);
        const operation = await googleClient.createTuningJob({
          baseModel,
          displayName: suffix || `ft-${jobId}`,
          hyperparameters: toGoogleHyperparameters(hyperparameters),
          examples,
        });

        const tunedModelName = extractGoogleTunedModelName(operation);
        if (!tunedModelName) {
          throw new Error(
            'Google tuning API did not return a tunedModel resource name'
          );
        }

        // Normalize the lifecycle: a freshly-created tuning op is queued/running.
        const responseState = operation.response?.state;
        const normalizedStatus = operation.done
          ? mapGoogleStateToNormalizedStatus(responseState)
          : mapGoogleStateToNormalizedStatus(responseState ?? 'STATE_UNSPECIFIED');
        const fineTunedModel =
          normalizedStatus === 'succeeded' ? tunedModelName : null;

        const hyperparametersJson: Record<string, unknown> = {
          n_epochs:
            typeof hyperparameters?.n_epochs === 'number'
              ? hyperparameters.n_epochs
              : 'auto',
          batch_size:
            typeof hyperparameters?.batch_size === 'number'
              ? hyperparameters.batch_size
              : 'auto',
          learning_rate_multiplier:
            typeof hyperparameters?.learning_rate_multiplier === 'number'
              ? hyperparameters.learning_rate_multiplier
              : 'auto',
        };

        const createData: {
          id: string;
          organizationId: string;
          userId: string | null;
          provider: string;
          providerJobId: string;
          model: string;
          fineTunedModel: string | null;
          trainingFileId: string;
          validationFileId: string | null;
          status: string;
          hyperparameters: Prisma.InputJsonValue;
          integrations?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
          resultFiles: string[];
          seed: number | null;
        } = {
          id: jobId,
          organizationId: userContext.organizationId,
          userId: userContext.userId || null,
          provider: selectedModel.provider,
          providerJobId: tunedModelName, // REAL Gemini tunedModels/... resource
          model: model,
          fineTunedModel,
          trainingFileId: training_file,
          validationFileId: validation_file || null,
          status: normalizedStatus,
          hyperparameters: toPrismaJsonValue(hyperparametersJson),
          resultFiles: [],
          seed: seed || null,
        };

        if (integrations) {
          createData.integrations = toPrismaNullableJsonValue(integrations);
        }

        const dbJob = await prisma.fineTuningJob.create({ data: createData });

        log.info(
          { requestId, jobId: dbJob.id, tunedModelName, status: normalizedStatus },
          'Google fine-tuning job created and persisted (real Gemini tuning API)'
        );

        return this.mapDbJobToApiJob(dbJob);
      } else {
        // Other providers - explicit, clear unsupported error (lists what works).
        const errorMessage = `Fine-tuning is not supported for provider "${selectedModel.provider}". Supported providers: ${SUPPORTED_FINE_TUNING_PROVIDERS.join(', ')}.`;
        log.warn({ requestId, jobId, provider: selectedModel.provider }, errorMessage);
        const err = new Error(errorMessage) as Error & { statusCode: number; code: string };
        err.statusCode = 422;
        err.code = 'provider_not_supported';
        throw err;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'Fine-tuning job creation failed');
      throw error;
    }
  }

  async listJobs(options: ListFineTuningJobsRequest): Promise<ListFineTuningJobsResponse> {
    const { limit = 20, after, before, userContext, requestId } = options;

    log.info({ requestId, limit, after, before }, 'Listing fine-tuning jobs');

    try {
      // Query jobs from database
      const where: {
        organizationId: string;
        id?: { gt?: string; lt?: string };
      } = {
        organizationId: userContext.organizationId,
      };

      if (after) {
        where.id = { gt: after };
      }

      if (before) {
        where.id = { lt: before };
      }

      const dbJobs = await prisma.fineTuningJob.findMany({
        where,
        take: limit + 1, // Get one extra to check has_more
        orderBy: { createdAt: 'desc' },
      });

      const has_more = dbJobs.length > limit;
      const jobsToReturn = has_more ? dbJobs.slice(0, limit) : dbJobs;

      const jobs: FineTuningJob[] = jobsToReturn.map((dbJob) => this.mapDbJobToApiJob(dbJob));

      return { jobs, has_more };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'List fine-tuning jobs failed');
      throw error;
    }
  }

  async getJob(options: GetFineTuningJobRequest): Promise<FineTuningJob> {
    const { jobId, userContext, requestId } = options;

    log.info({ requestId, jobId }, 'Getting fine-tuning job');

    try {
      // Query job from database
      const dbJob = await prisma.fineTuningJob.findFirst({
        where: {
          id: jobId,
          organizationId: userContext.organizationId,
        },
      });

      if (!dbJob) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }

      // For Google jobs that are still in-flight, refresh status from the live
      // Gemini tuning API and persist any transition (queued/running →
      // succeeded/failed), populating fine_tuned_model on success.
      if (
        dbJob.provider === 'google' &&
        !['succeeded', 'failed', 'cancelled'].includes(dbJob.status)
      ) {
        const refreshed = await this.refreshGoogleJobStatus(
          dbJob.id,
          dbJob.providerJobId,
          requestId
        );
        if (refreshed) {
          return this.mapDbJobToApiJob(refreshed);
        }
      }

      return this.mapDbJobToApiJob(dbJob);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'Get fine-tuning job failed');

      if (errorMessage.includes('not found')) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }
      throw error;
    }
  }

  /**
   * Refresh a Google fine-tuning job's status from the live Gemini tuning API
   * and persist the transition. Returns the updated DB row, or null if no
   * refresh could be performed (best-effort — a transient API error must not
   * break a GET; the persisted state is returned instead).
   */
  private async refreshGoogleJobStatus(
    jobId: string,
    providerJobId: string,
    requestId: string
  ): Promise<{
    id: string;
    organizationId: string;
    status: string;
    model: string;
    fineTunedModel: string | null;
    trainingFileId: string;
    validationFileId: string | null;
    hyperparameters: unknown;
    integrations: unknown;
    resultFiles: string[];
    trainedTokens: number | null;
    seed: number | null;
    estimatedFinish: number | null;
    createdAt: Date;
    finishedAt: Date | null;
  } | null> {
    try {
      const googleClient = this.getGoogleFineTuningClient();
      const tunedModel: GoogleTunedModel =
        await googleClient.getTunedModel(providerJobId);

      const normalizedStatus = mapGoogleStateToNormalizedStatus(tunedModel.state);
      const isTerminal = ['succeeded', 'failed'].includes(normalizedStatus);
      const fineTunedModel =
        normalizedStatus === 'succeeded'
          ? tunedModel.name || providerJobId
          : null;
      const completeTime = tunedModel.tuningTask?.completeTime;
      const finishedAt =
        isTerminal && completeTime ? new Date(completeTime) : null;

      const updated = await prisma.fineTuningJob.update({
        where: { id: jobId },
        data: {
          status: normalizedStatus,
          fineTunedModel,
          finishedAt,
        },
      });

      log.info(
        { requestId, jobId, status: normalizedStatus, fineTunedModel },
        'Google fine-tuning job status refreshed from live tuning API'
      );

      return updated;
    } catch (error: unknown) {
      // 503 provider_not_configured must surface to the caller; transient API
      // errors are swallowed so the persisted state is returned.
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 503) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.warn(
        { requestId, jobId, error: errorMessage },
        'Google fine-tuning status refresh failed; returning persisted state'
      );
      return null;
    }
  }

  async cancelJob(options: CancelFineTuningJobRequest): Promise<FineTuningJob> {
    const { jobId, userContext, requestId } = options;

    log.info({ requestId, jobId }, 'Cancelling fine-tuning job');

    try {
      // Get job from database to determine provider
      const dbJob = await prisma.fineTuningJob.findFirst({
        where: {
          id: jobId,
          organizationId: userContext.organizationId,
        },
      });

      if (!dbJob) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }

      // Cancel job via provider API
      const providerRegistry = getProviderRegistry();
      const adapter = providerRegistry.get(dbJob.provider);
      if (!adapter) {
        const err = new Error(
          `Fine-tuning provider ${dbJob.provider} is not operational for cancellation`
        ) as Error & { statusCode: number; code: string; details: Record<string, unknown> };
        err.statusCode = 422;
        err.code = 'capability_not_operational';
        err.details = {
          capability: 'fine_tuning',
          provider: dbJob.provider,
          reasons: [`provider_not_registered:${dbJob.provider}`],
        };
        throw err;
      }

      if (dbJob.provider === 'openai' && adapter instanceof OpenAIAdapter) {
        const openaiClient = adapter.getClient();
        
        if (openaiClient.fineTuning && openaiClient.fineTuning.jobs) {
          const openaiJobResponse = await openaiClient.fineTuning.jobs.cancel(dbJob.providerJobId);
          
          // Type guard to validate OpenAI job response structure
          const isValidOpenAIJob = (job: unknown): job is OpenAIFineTuningJob => {
            if (!job || typeof job !== 'object') return false;
            const j = job as Record<string, unknown>;
            return (
              typeof j.id === 'string' &&
              typeof j.object === 'string' &&
              typeof j.created_at === 'number' &&
              typeof j.model === 'string' &&
              typeof j.status === 'string'
            );
          };
          
          if (!isValidOpenAIJob(openaiJobResponse)) {
            throw new Error('Invalid response from OpenAI fine-tuning jobs.cancel API');
          }
          
          const openaiJob: OpenAIFineTuningJob = openaiJobResponse;
          const jobStatus = mapOpenAIStatusToFineTuningStatus(openaiJob.status);

          // Update job in database
          const updatedDbJob = await prisma.fineTuningJob.update({
            where: { id: jobId },
            data: {
              status: jobStatus,
              finishedAt: openaiJob.finished_at ? new Date(openaiJob.finished_at * 1000) : null,
              fineTunedModel: openaiJob.fine_tuned_model || null,
              resultFiles: openaiJob.result_files,
              trainedTokens: openaiJob.trained_tokens || null,
            },
          });

          return this.mapDbJobToApiJob(updatedDbJob);
        }
      }

      if (dbJob.provider === 'google') {
        // The Gemini tuning API stops/removes a job by deleting the tuned
        // model. Mark the job cancelled locally after the live delete succeeds.
        const googleClient = this.getGoogleFineTuningClient();
        await googleClient.deleteTunedModel(dbJob.providerJobId);

        const updatedDbJob = await prisma.fineTuningJob.update({
          where: { id: jobId },
          data: {
            status: 'cancelled',
            finishedAt: new Date(),
          },
        });

        log.info(
          { requestId, jobId, tunedModelName: dbJob.providerJobId },
          'Google fine-tuning job cancelled (tuned model deleted via live API)'
        );

        return this.mapDbJobToApiJob(updatedDbJob);
      }

      throw new Error(
        `Fine-tuning cancellation is not supported for provider "${dbJob.provider}". Supported providers: ${SUPPORTED_FINE_TUNING_PROVIDERS.join(', ')}.`
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'Cancel fine-tuning job failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }
      throw error;
    }
  }

  async listEvents(options: ListFineTuningEventsRequest): Promise<ListFineTuningEventsResponse> {
    const { jobId, limit = 20, after, before, userContext, requestId } = options;

    log.info({ requestId, jobId, limit, after, before }, 'Listing fine-tuning events');

    try {
      // Resolve the job's provider so events route to the right backend.
      const dbJob = await prisma.fineTuningJob.findFirst({
        where: { id: jobId, organizationId: userContext.organizationId },
      });

      // Google: derive events from the live tuned model's per-step snapshots.
      if (dbJob && dbJob.provider === 'google') {
        const googleClient = this.getGoogleFineTuningClient();
        const tunedModel = await googleClient.getTunedModel(dbJob.providerJobId);
        const events = googleSnapshotsToEvents(
          tunedModel.tuningTask?.snapshots
        );
        return { events, has_more: false };
      }

      // List events via OpenAI API
      const providerRegistry = getProviderRegistry();
      const openaiAdapter = providerRegistry.get('openai');

      if (openaiAdapter instanceof OpenAIAdapter) {
        const openaiClient = openaiAdapter.getClient();
        
        if (openaiClient.fineTuning && openaiClient.fineTuning.jobs) {
          // Build query params - OpenAI SDK doesn't support 'before' directly
          const queryParams: { limit?: number; after?: string } = {};
          if (limit) {
            queryParams.limit = limit;
          }
          if (after) {
            queryParams.after = after;
          }
          // Note: 'before' is not supported in OpenAI SDK JobListEventsParams
          const openaiEventsResponse = await openaiClient.fineTuning.jobs.listEvents(jobId, queryParams);
          
          // Type guard to validate OpenAI events response structure
          const isValidOpenAIEventsListResponse = (response: unknown): response is OpenAIFineTuningEventsListResponse => {
            if (!response || typeof response !== 'object') return false;
            const r = response as Record<string, unknown>;
            if (!Array.isArray(r.data)) return false;
            if (typeof r.has_more !== 'boolean') return false;
            return true;
          };
          
          if (!isValidOpenAIEventsListResponse(openaiEventsResponse)) {
            throw new Error('Invalid response from OpenAI fine-tuning jobs.listEvents API');
          }
          
          const openaiEvents: OpenAIFineTuningEventsListResponse = openaiEventsResponse;

          const events: FineTuningEvent[] = openaiEvents.data.map((event): FineTuningEvent => {
            // Validate level is one of the expected values
            const validLevels: Array<'info' | 'warn' | 'error'> = ['info', 'warn', 'error'];
            const level: 'info' | 'warn' | 'error' = 
              validLevels.includes(event.level as 'info' | 'warn' | 'error')
                ? (event.level as 'info' | 'warn' | 'error')
                : 'info';
            
            // Validate data is an object (not array, not null)
            let eventData: Record<string, unknown> | undefined = undefined;
            if (event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data !== null) {
              eventData = event.data as Record<string, unknown>;
            }
            
            return {
              id: event.id,
              object: 'fine_tuning.job.event',
              created_at: event.created_at,
              level,
              message: event.message,
              data: eventData,
            };
          });

          return { events, has_more: openaiEvents.has_more };
        }
      }

      return { events: [], has_more: false };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'List fine-tuning events failed');
      throw error;
    }
  }

  async listCheckpoints(options: ListFineTuningCheckpointsRequest): Promise<ListFineTuningCheckpointsResponse> {
    const { jobId, limit = 20, after, before, userContext, requestId } = options;

    log.info({ requestId, jobId, limit, after, before }, 'Listing fine-tuning checkpoints');

    try {
      // Resolve the job's provider so checkpoints route to the right backend.
      const dbJob = await prisma.fineTuningJob.findFirst({
        where: { id: jobId, organizationId: userContext.organizationId },
      });

      // Google: derive checkpoints from the live tuned model's snapshots.
      if (dbJob && dbJob.provider === 'google') {
        const googleClient = this.getGoogleFineTuningClient();
        const tunedModel = await googleClient.getTunedModel(dbJob.providerJobId);
        const checkpoints = googleSnapshotsToCheckpoints(
          tunedModel.name || dbJob.providerJobId,
          tunedModel.tuningTask?.snapshots
        );
        return { checkpoints, has_more: false };
      }

      // List checkpoints via OpenAI API
      const providerRegistry = getProviderRegistry();
      const openaiAdapter = providerRegistry.get('openai');

      if (openaiAdapter instanceof OpenAIAdapter) {
        const openaiClient = openaiAdapter.getClient();
        
        if (openaiClient.fineTuning && openaiClient.fineTuning.jobs && openaiClient.fineTuning.jobs.checkpoints) {
          // Build query params - OpenAI SDK doesn't support 'before' directly
          const queryParams: { limit?: number; after?: string } = {};
          if (limit) {
            queryParams.limit = limit;
          }
          if (after) {
            queryParams.after = after;
          }
          // Note: 'before' is not supported in OpenAI SDK checkpoint list params
          const openaiCheckpoints = await openaiClient.fineTuning.jobs.checkpoints.list(jobId, queryParams) as {
            data: Array<{
              id: string;
              object: string;
              created_at: number;
              fine_tuned_model_checkpoint: string;
              step_number: number;
              metrics: {
                train_loss?: number;
                train_mean_token_accuracy?: number;
                valid_loss?: number;
                valid_mean_token_accuracy?: number;
                full_valid_loss?: number;
                full_valid_mean_token_accuracy?: number;
              };
            }>;
            has_more: boolean;
          };

          const checkpoints: FineTuningCheckpoint[] = openaiCheckpoints.data.map((checkpoint) => ({
            id: checkpoint.id,
            object: 'fine_tuning.job.checkpoint' as const,
            created_at: checkpoint.created_at,
            fine_tuned_model_checkpoint: checkpoint.fine_tuned_model_checkpoint,
            step_number: checkpoint.step_number,
            metrics: {
              step: checkpoint.step_number,
              train_loss: checkpoint.metrics.train_loss ?? 0,
              train_mean_token_accuracy: checkpoint.metrics.train_mean_token_accuracy ?? 0,
              valid_loss: checkpoint.metrics.valid_loss,
              valid_mean_token_accuracy: checkpoint.metrics.valid_mean_token_accuracy,
              full_valid_loss: checkpoint.metrics.full_valid_loss,
              full_valid_mean_token_accuracy: checkpoint.metrics.full_valid_mean_token_accuracy,
            },
          }));

          return { checkpoints, has_more: openaiCheckpoints.has_more };
        }
      }

      return { checkpoints: [], has_more: false };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'List fine-tuning checkpoints failed');
      throw error;
    }
  }

  async deleteJob(options: DeleteFineTuningJobRequest): Promise<DeleteFineTuningJobResponse> {
    const { jobId, userContext, requestId } = options;

    log.info({ requestId, jobId }, 'Deleting fine-tuning job');

    try {
      // Delete job from database
      // Note: OpenAI API doesn't have a delete endpoint for fine-tuning jobs
      // Jobs are automatically deleted after a period of time on OpenAI's side
      // We delete from our database to mark it as removed
      const dbJob = await prisma.fineTuningJob.findFirst({
        where: {
          id: jobId,
          organizationId: userContext.organizationId,
        },
      });

      if (!dbJob) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }

      await prisma.fineTuningJob.delete({
        where: {
          id: jobId,
        },
      });

      log.info({ requestId, jobId }, 'Fine-tuning job deleted from database');

      return { id: jobId, object: 'fine_tuning.job', deleted: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, jobId, error: errorMessage }, 'Delete fine-tuning job failed');
      
      if (errorMessage.includes('not found')) {
        throw new Error(`Fine-tuning job ${jobId} not found`);
      }
      throw error;
    }
  }
}
