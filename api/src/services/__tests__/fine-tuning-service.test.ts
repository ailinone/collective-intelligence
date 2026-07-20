// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fine-tuning Service — multi-provider lifecycle unit tests.
 *
 * Validates the REAL OpenAI + Google fine-tuning paths with every external
 * dependency mocked (NO live provider calls, NO database). Covers:
 *  - OpenAI job lifecycle: create → succeeded with fine_tuned_model
 *  - Google job lifecycle: create (real tuning API) → status refresh →
 *    succeeded with fine_tuned_model = the real tunedModels/... resource
 *  - Status mapping (Google CREATING/ACTIVE/FAILED → normalized)
 *  - Missing-credential contract: 503 provider_not_configured
 *  - Unsupported provider: explicit error listing the supported providers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mock state -----------------------------------------------------

const mocks = vi.hoisted(() => {
  // Lightweight adapter classes so `instanceof` checks in the service work.
  // Defined inside vi.hoisted so they are initialized before the hoisted
  // vi.mock factories that reference them.
  class FakeOpenAIAdapter {
    client: {
      fineTuning: {
        jobs: {
          create: ReturnType<typeof vi.fn>;
          cancel: ReturnType<typeof vi.fn>;
          listEvents: ReturnType<typeof vi.fn>;
          checkpoints: { list: ReturnType<typeof vi.fn> };
        };
      };
    };
    constructor() {
      this.client = {
        fineTuning: {
          jobs: {
            create: vi.fn(),
            cancel: vi.fn(),
            listEvents: vi.fn(),
            checkpoints: { list: vi.fn() },
          },
        },
      };
    }
    getClient() {
      return this.client;
    }
    getName() {
      return 'openai';
    }
  }

  class FakeGoogleAdapter {
    private apiKey: string;
    constructor(apiKey = 'AIza_google_test_key') {
      this.apiKey = apiKey;
    }
    getApiKey() {
      return this.apiKey;
    }
    getName() {
      return 'google';
    }
  }

  return {
    prisma: {
      fineTuningJob: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    },
    registryGet: vi.fn(),
    resolveAdapterForModel: vi.fn(),
    getModelById: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    googleClient: {
      createTuningJob: vi.fn(),
      getTunedModel: vi.fn(),
      deleteTunedModel: vi.fn(),
    },
    FakeOpenAIAdapter,
    FakeGoogleAdapter,
  };
});

const { FakeOpenAIAdapter, FakeGoogleAdapter } = mocks;

// ---- Module mocks -----------------------------------------------------------

vi.mock('@/database/client', () => ({
  prisma: mocks.prisma,
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    get: mocks.registryGet,
    resolveAdapterForModel: mocks.resolveAdapterForModel,
  }),
}));

vi.mock('@/providers/openai/openai-adapter', () => ({
  OpenAIAdapter: mocks.FakeOpenAIAdapter,
}));

vi.mock('@/providers/google/google-adapter', () => ({
  GoogleAdapter: mocks.FakeGoogleAdapter,
}));

// Mock the Google tuning client constructor but keep the real status mapper /
// error class so the normalization logic under test is the real one.
vi.mock('@/providers/google/google-fine-tuning-client', async () => {
  const actual = await vi.importActual<
    typeof import('@/providers/google/google-fine-tuning-client')
  >('@/providers/google/google-fine-tuning-client');
  return {
    ...actual,
    GoogleFineTuningClient: vi.fn().mockImplementation((opts: { apiKey: string }) => {
      if (!opts.apiKey || !opts.apiKey.trim()) {
        throw new actual.GoogleTuningNotConfiguredError('no key');
      }
      return mocks.googleClient;
    }),
  };
});

vi.mock('@/services/files-service', () => ({
  FilesService: class {
    getFile = mocks.getFile;
    getFileContent = mocks.getFileContent;
  },
}));

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    getModelById = mocks.getModelById;
  },
}));

// ---- Imports (after mocks) --------------------------------------------------

import { FineTuningService } from '../fine-tuning-service';

// ---- Test fixtures ----------------------------------------------------------

const userContext = {
  requestId: 'req-1',
  organizationId: 'org-1',
  userId: 'user-1',
};

function makeModel(provider: string, name: string) {
  return {
    id: name,
    providerId: provider,
    provider,
    name,
    displayName: name,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: {},
    status: 'active',
  } as never;
}

function trainingFileMeta() {
  return { id: 'file-train', purpose: 'fine-tune', status: 'processed' };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: training file is a valid fine-tune file.
  mocks.getFile.mockResolvedValue(trainingFileMeta());
});

// ---- OpenAI lifecycle -------------------------------------------------------

describe('FineTuningService — OpenAI lifecycle', () => {
  it('creates a job via the real OpenAI client and persists it', async () => {
    const adapter = new FakeOpenAIAdapter();
    adapter.client.fineTuning.jobs.create.mockResolvedValue({
      id: 'ftjob-openai-1',
      object: 'fine_tuning.job',
      created_at: 1_700_000_000,
      finished_at: null,
      model: 'gpt-3.5-turbo',
      fine_tuned_model: null,
      organization_id: 'org-openai',
      result_files: [],
      status: 'queued',
      validation_file: null,
      training_file: 'file-train',
      hyperparameters: { n_epochs: 'auto', batch_size: 'auto', learning_rate_multiplier: 'auto' },
      trained_tokens: null,
      integrations: null,
      seed: 42,
      estimated_finish: null,
    });

    mocks.resolveAdapterForModel.mockReturnValue({
      adapter,
      operability: { nonOperationalReasons: [] },
    });
    mocks.getModelById.mockResolvedValue(makeModel('openai', 'gpt-3.5-turbo'));

    // The persisted row is echoed back as the DB row shape.
    mocks.prisma.fineTuningJob.create.mockResolvedValue({
      id: 'ftjob-openai-1',
      organizationId: 'org-1',
      status: 'queued',
      model: 'gpt-3.5-turbo',
      fineTunedModel: null,
      trainingFileId: 'file-train',
      validationFileId: null,
      hyperparameters: { n_epochs: 'auto', batch_size: 'auto', learning_rate_multiplier: 'auto' },
      integrations: null,
      resultFiles: [],
      trainedTokens: null,
      seed: 42,
      estimatedFinish: null,
      createdAt: new Date(1_700_000_000 * 1000),
      finishedAt: null,
    });

    const service = new FineTuningService();
    const job = await service.createJob({
      training_file: 'file-train',
      model: 'gpt-3.5-turbo',
      userContext,
      requestId: 'req-1',
    });

    expect(adapter.client.fineTuning.jobs.create).toHaveBeenCalledOnce();
    expect(job.id).toBe('ftjob-openai-1');
    expect(job.status).toBe('queued');
    expect(job.object).toBe('fine_tuning.job');
  });

  it('cancels an OpenAI job and reflects fine_tuned_model on succeeded', async () => {
    const adapter = new FakeOpenAIAdapter();
    mocks.prisma.fineTuningJob.findFirst.mockResolvedValue({
      id: 'ftjob-openai-1',
      provider: 'openai',
      providerJobId: 'ftjob-openai-1',
    });
    mocks.registryGet.mockReturnValue(adapter);
    adapter.client.fineTuning.jobs.cancel.mockResolvedValue({
      id: 'ftjob-openai-1',
      object: 'fine_tuning.job',
      created_at: 1_700_000_000,
      finished_at: 1_700_000_500,
      model: 'gpt-3.5-turbo',
      fine_tuned_model: 'ft:gpt-3.5-turbo:org::abc',
      status: 'cancelled',
      result_files: [],
      trained_tokens: 1000,
    });
    mocks.prisma.fineTuningJob.update.mockResolvedValue({
      id: 'ftjob-openai-1',
      organizationId: 'org-1',
      status: 'cancelled',
      model: 'gpt-3.5-turbo',
      fineTunedModel: 'ft:gpt-3.5-turbo:org::abc',
      trainingFileId: 'file-train',
      validationFileId: null,
      hyperparameters: {},
      integrations: null,
      resultFiles: [],
      trainedTokens: 1000,
      seed: null,
      estimatedFinish: null,
      createdAt: new Date(),
      finishedAt: new Date(),
    });

    const service = new FineTuningService();
    const job = await service.cancelJob({
      jobId: 'ftjob-openai-1',
      userContext,
      requestId: 'req-1',
    });

    expect(adapter.client.fineTuning.jobs.cancel).toHaveBeenCalledWith('ftjob-openai-1');
    expect(job.status).toBe('cancelled');
    expect(job.fine_tuned_model).toBe('ft:gpt-3.5-turbo:org::abc');
  });
});

// ---- Google lifecycle -------------------------------------------------------

describe('FineTuningService — Google lifecycle (real Gemini tuning API)', () => {
  beforeEach(() => {
    mocks.getModelById.mockResolvedValue(
      makeModel('google', 'gemini-1.5-flash-001-tuning')
    );
    mocks.resolveAdapterForModel.mockReturnValue({
      adapter: new FakeGoogleAdapter(),
      operability: { nonOperationalReasons: [] },
    });
    // Google client is resolved via registry.get('google').
    mocks.registryGet.mockImplementation((name: string) =>
      name === 'google' ? new FakeGoogleAdapter() : undefined
    );
    // Training file content in OpenAI chat JSONL format.
    mocks.getFileContent.mockResolvedValue({
      content: Buffer.from(
        [
          JSON.stringify({
            messages: [
              { role: 'user', content: 'What is 2+2?' },
              { role: 'assistant', content: '4' },
            ],
          }),
          JSON.stringify({
            messages: [
              { role: 'user', content: 'Capital of France?' },
              { role: 'assistant', content: 'Paris' },
            ],
          }),
        ].join('\n'),
        'utf-8'
      ),
      filename: 'train.jsonl',
      contentType: 'application/jsonl',
    });
  });

  it('creates a real tuning job, captures the tunedModels/... providerJobId, and persists it', async () => {
    mocks.googleClient.createTuningJob.mockResolvedValue({
      name: 'operations/op-1',
      done: false,
      metadata: { tunedModel: 'tunedModels/my-tuned-abc' },
    });

    mocks.prisma.fineTuningJob.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: data.id,
      organizationId: data.organizationId,
      status: data.status,
      model: data.model,
      fineTunedModel: data.fineTunedModel ?? null,
      trainingFileId: data.trainingFileId,
      validationFileId: data.validationFileId,
      hyperparameters: data.hyperparameters,
      integrations: null,
      resultFiles: data.resultFiles,
      trainedTokens: null,
      seed: data.seed ?? null,
      estimatedFinish: null,
      createdAt: new Date(),
      finishedAt: null,
    }));

    const service = new FineTuningService();
    const job = await service.createJob({
      training_file: 'file-train',
      model: 'gemini-1.5-flash-001-tuning',
      userContext,
      requestId: 'req-1',
    });

    // Real tuning client was called with the converted examples.
    expect(mocks.googleClient.createTuningJob).toHaveBeenCalledOnce();
    const createArgs = mocks.googleClient.createTuningJob.mock.calls[0][0];
    expect(createArgs.baseModel).toBe('models/gemini-1.5-flash-001-tuning');
    expect(createArgs.examples).toEqual([
      { textInput: 'What is 2+2?', output: '4' },
      { textInput: 'Capital of France?', output: 'Paris' },
    ]);

    // providerJobId persisted is the REAL tunedModels resource, not a placeholder.
    const persisted = mocks.prisma.fineTuningJob.create.mock.calls[0][0].data;
    expect(persisted.providerJobId).toBe('tunedModels/my-tuned-abc');
    expect(String(persisted.providerJobId)).not.toMatch(/^google-/);
    expect(persisted.provider).toBe('google');

    // While still creating, status is queued/running and fine_tuned_model is null.
    expect(job.status).toBe('queued');
    expect(job.fine_tuned_model).toBeNull();
  });

  it('refreshes a running Google job to succeeded and populates the real fine_tuned_model on getJob', async () => {
    // Persisted row is still "running".
    mocks.prisma.fineTuningJob.findFirst.mockResolvedValue({
      id: 'ftjob-g-1',
      provider: 'google',
      providerJobId: 'tunedModels/my-tuned-abc',
      status: 'running',
    });

    // Live tuning API now reports ACTIVE (=> succeeded).
    mocks.googleClient.getTunedModel.mockResolvedValue({
      name: 'tunedModels/my-tuned-abc',
      state: 'ACTIVE',
      tuningTask: { completeTime: '2026-06-13T00:00:00Z', snapshots: [] },
    });

    mocks.prisma.fineTuningJob.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'ftjob-g-1',
      organizationId: 'org-1',
      status: data.status,
      model: 'gemini-1.5-flash-001-tuning',
      fineTunedModel: data.fineTunedModel ?? null,
      trainingFileId: 'file-train',
      validationFileId: null,
      hyperparameters: {},
      integrations: null,
      resultFiles: [],
      trainedTokens: null,
      seed: null,
      estimatedFinish: null,
      createdAt: new Date(),
      finishedAt: data.finishedAt ?? null,
    }));

    const service = new FineTuningService();
    const job = await service.getJob({
      jobId: 'ftjob-g-1',
      userContext,
      requestId: 'req-1',
    });

    expect(mocks.googleClient.getTunedModel).toHaveBeenCalledWith('tunedModels/my-tuned-abc');
    expect(job.status).toBe('succeeded');
    // fine_tuned_model is the REAL trained model id.
    expect(job.fine_tuned_model).toBe('tunedModels/my-tuned-abc');
  });

  it('maps a FAILED tuned model to a failed job on refresh', async () => {
    mocks.prisma.fineTuningJob.findFirst.mockResolvedValue({
      id: 'ftjob-g-2',
      provider: 'google',
      providerJobId: 'tunedModels/failed-xyz',
      status: 'running',
    });
    mocks.googleClient.getTunedModel.mockResolvedValue({
      name: 'tunedModels/failed-xyz',
      state: 'FAILED',
    });
    mocks.prisma.fineTuningJob.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'ftjob-g-2',
      organizationId: 'org-1',
      status: data.status,
      model: 'gemini-1.5-flash-001-tuning',
      fineTunedModel: data.fineTunedModel ?? null,
      trainingFileId: 'file-train',
      validationFileId: null,
      hyperparameters: {},
      integrations: null,
      resultFiles: [],
      trainedTokens: null,
      seed: null,
      estimatedFinish: null,
      createdAt: new Date(),
      finishedAt: null,
    }));

    const service = new FineTuningService();
    const job = await service.getJob({
      jobId: 'ftjob-g-2',
      userContext,
      requestId: 'req-1',
    });

    expect(job.status).toBe('failed');
    expect(job.fine_tuned_model).toBeNull();
  });

  it('cancels a Google job by deleting the tuned model and marking it cancelled', async () => {
    mocks.prisma.fineTuningJob.findFirst.mockResolvedValue({
      id: 'ftjob-g-3',
      provider: 'google',
      providerJobId: 'tunedModels/to-cancel',
      status: 'running',
    });
    mocks.registryGet.mockReturnValue(new FakeGoogleAdapter());
    mocks.googleClient.deleteTunedModel.mockResolvedValue(undefined);
    mocks.prisma.fineTuningJob.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'ftjob-g-3',
      organizationId: 'org-1',
      status: data.status,
      model: 'gemini-1.5-flash-001-tuning',
      fineTunedModel: null,
      trainingFileId: 'file-train',
      validationFileId: null,
      hyperparameters: {},
      integrations: null,
      resultFiles: [],
      trainedTokens: null,
      seed: null,
      estimatedFinish: null,
      createdAt: new Date(),
      finishedAt: data.finishedAt ?? null,
    }));

    const service = new FineTuningService();
    const job = await service.cancelJob({
      jobId: 'ftjob-g-3',
      userContext,
      requestId: 'req-1',
    });

    expect(mocks.googleClient.deleteTunedModel).toHaveBeenCalledWith('tunedModels/to-cancel');
    expect(job.status).toBe('cancelled');
  });

  it('derives events and checkpoints from live tuning snapshots', async () => {
    mocks.prisma.fineTuningJob.findFirst.mockResolvedValue({
      id: 'ftjob-g-4',
      provider: 'google',
      providerJobId: 'tunedModels/with-snaps',
      status: 'running',
    });
    mocks.registryGet.mockReturnValue(new FakeGoogleAdapter());
    mocks.googleClient.getTunedModel.mockResolvedValue({
      name: 'tunedModels/with-snaps',
      state: 'CREATING',
      tuningTask: {
        snapshots: [
          { step: 1, epoch: 1, meanLoss: 0.9 },
          { step: 2, epoch: 1, meanLoss: 0.5 },
        ],
      },
    });

    const service = new FineTuningService();

    const events = await service.listEvents({
      jobId: 'ftjob-g-4',
      userContext,
      requestId: 'req-1',
    });
    expect(events.events).toHaveLength(2);
    expect(events.events[0].message).toContain('mean_loss=0.9');

    const checkpoints = await service.listCheckpoints({
      jobId: 'ftjob-g-4',
      userContext,
      requestId: 'req-1',
    });
    expect(checkpoints.checkpoints).toHaveLength(2);
    expect(checkpoints.checkpoints[1].metrics.train_loss).toBe(0.5);
    expect(checkpoints.checkpoints[0].fine_tuned_model_checkpoint).toBe(
      'tunedModels/with-snaps'
    );
  });
});

// ---- Missing credential (503) ----------------------------------------------

describe('FineTuningService — missing Google credential', () => {
  it('returns 503 provider_not_configured when the Google adapter is not registered', async () => {
    mocks.getModelById.mockResolvedValue(
      makeModel('google', 'gemini-1.5-flash-001-tuning')
    );
    mocks.resolveAdapterForModel.mockReturnValue({
      adapter: new FakeGoogleAdapter(),
      operability: { nonOperationalReasons: [] },
    });
    // registry.get('google') returns undefined => provider not configured.
    mocks.registryGet.mockReturnValue(undefined);

    const service = new FineTuningService();
    await expect(
      service.createJob({
        training_file: 'file-train',
        model: 'gemini-1.5-flash-001-tuning',
        userContext,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'provider_not_configured' });
  });

  it('returns 503 when the Google adapter is registered but the key is empty', async () => {
    mocks.getModelById.mockResolvedValue(
      makeModel('google', 'gemini-1.5-flash-001-tuning')
    );
    mocks.resolveAdapterForModel.mockReturnValue({
      adapter: new FakeGoogleAdapter(''),
      operability: { nonOperationalReasons: [] },
    });
    mocks.registryGet.mockReturnValue(new FakeGoogleAdapter(''));

    const service = new FineTuningService();
    await expect(
      service.createJob({
        training_file: 'file-train',
        model: 'gemini-1.5-flash-001-tuning',
        userContext,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'provider_not_configured' });
  });
});

// ---- Unsupported provider ---------------------------------------------------

describe('FineTuningService — unsupported provider', () => {
  it('throws an explicit error listing supported providers', async () => {
    mocks.getModelById.mockResolvedValue(makeModel('anthropic', 'claude-3-haiku'));
    mocks.resolveAdapterForModel.mockReturnValue({
      adapter: { getName: () => 'anthropic' },
      operability: { nonOperationalReasons: [] },
    });

    const service = new FineTuningService();
    await expect(
      service.createJob({
        training_file: 'file-train',
        model: 'claude-3-haiku',
        userContext,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ statusCode: 422, code: 'provider_not_supported' });

    await expect(
      service.createJob({
        training_file: 'file-train',
        model: 'claude-3-haiku',
        userContext,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/openai, google/);
  });
});
