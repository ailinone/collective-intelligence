// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VisionOrchestrationService — LOTE AP.
 *
 * `vision`, `image_captioning` and `visual_question_answering` all DECLARED
 * `executionPath: ['native_adapter', ...]` while no native executor existed,
 * so every request threw, logged a failed attempt, and fell through to chat
 * orchestration. These tests pin the executor that makes the declared path
 * real, and the prompt framing that distinguishes the three tasks without
 * duplicating the pipeline.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Model, OrchestrationContext } from '@/types';

const searchModelsComplete = vi.fn();
const searchModels = vi.fn();
const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModelsComplete;
    searchModels = searchModels;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

const resolveAdapterForModel = vi.fn();
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ resolveAdapterForModel }),
}));

vi.mock('@/providers/provider-operability', () => ({
  // `vision` has a working base implementation on ProviderAdapter, so every
  // adapter is vision-operable — mirrored here rather than depending on
  // BASE_FALLBACK_METHODS from a prototype.
  isAdapterMethodImplemented: () => true,
}));

import { VisionOrchestrationService } from '../vision-orchestration-service';
import { ValidationError } from '@/utils/custom-errors';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'vision-fixture',
    name: 'vision-fixture',
    displayName: 'Vision Fixture',
    provider: 'fixture-provider',
    capabilities: ['vision', 'multimodal'],
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

function wire(content = 'a description'): Mock {
  const vision = vi.fn().mockResolvedValue({ content, raw: {} });
  searchModelsComplete.mockResolvedValue([makeModel()]);
  resolveAdapterForModel.mockReturnValue({
    adapter: { vision, getName: () => 'fixture-provider' },
  });
  return vision;
}

const IMAGE = Buffer.from('fake-png-bytes');

describe('VisionOrchestrationService', () => {
  let service: VisionOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VisionOrchestrationService();
  });

  describe('real vision path', () => {
    it('executes through adapter.vision() with the image and resolved model', async () => {
      const vision = wire('two cats on a sofa');

      const result = await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        userContext: USER_CONTEXT,
        requestId: 'req_1',
      });

      expect(vision).toHaveBeenCalledTimes(1);
      const [model, request] = vision.mock.calls[0];
      expect(model.id).toBe('vision-fixture');
      expect(request.image).toBe(IMAGE);
      expect(result.content).toBe('two cats on a sofa');
      expect(result.provider).toBe('fixture-provider');
    });

    it('pools the whole catalog by capability, never via the capped searchModels', async () => {
      wire();

      await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        userContext: USER_CONTEXT,
        requestId: 'req_2',
      });

      expect(searchModelsComplete).toHaveBeenCalledWith({
        capabilities: ['vision'],
        status: 'active',
      });
      expect(searchModelsComplete).toHaveBeenCalledWith({
        capabilities: ['multimodal'],
        status: 'active',
      });
      expect(searchModels).not.toHaveBeenCalled();
    });

    it('resolves an explicit model across every provider row carrying it', async () => {
      const vision = vi.fn().mockResolvedValue({ content: 'ok', raw: {} });
      findModelsByIdOrName.mockResolvedValue([makeModel({ provider: 'provider-b' })]);
      resolveAdapterForModel.mockReturnValue({ adapter: { vision, getName: () => 'provider-b' } });

      const result = await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        model: 'vision-fixture',
        userContext: USER_CONTEXT,
        requestId: 'req_3',
      });

      expect(findModelsByIdOrName).toHaveBeenCalledWith('vision-fixture');
      expect(result.provider).toBe('provider-b');
    });
  });

  describe('task framing', () => {
    it('vision uses a descriptive default prompt', async () => {
      const vision = wire();

      await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        userContext: USER_CONTEXT,
        requestId: 'req_4',
      });

      expect(vision.mock.calls[0][1].prompt).toMatch(/Describe this image in detail/);
    });

    it('vision honours a caller prompt verbatim', async () => {
      const vision = wire();

      await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        prompt: 'What brand is the laptop?',
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      });

      expect(vision.mock.calls[0][1].prompt).toBe('What brand is the laptop?');
    });

    it('captioning asks for one alt-text sentence, not a paragraph', async () => {
      const vision = wire('A tabby cat sleeping on a grey sofa.');

      const result = await service.analyzeImage({
        task: 'image_captioning',
        image: IMAGE,
        userContext: USER_CONTEXT,
        requestId: 'req_6',
      });

      const prompt = vision.mock.calls[0][1].prompt;
      expect(prompt).toMatch(/single concise caption/i);
      expect(prompt).toMatch(/alt text/i);
      expect(result.task).toBe('image_captioning');
    });

    it('captioning REFINES with a caller prompt instead of replacing the framing', async () => {
      const vision = wire();

      await service.analyzeImage({
        task: 'image_captioning',
        image: IMAGE,
        prompt: 'focus on the product',
        userContext: USER_CONTEXT,
        requestId: 'req_7',
      });

      const prompt = vision.mock.calls[0][1].prompt;
      expect(prompt).toMatch(/single concise caption/i);
      expect(prompt).toMatch(/focus on the product/);
    });

    it('VQA constrains the model to the image and refuses to guess', async () => {
      const vision = wire('Blue.');

      await service.analyzeImage({
        task: 'visual_question_answering',
        image: IMAGE,
        prompt: 'What colour is the car?',
        userContext: USER_CONTEXT,
        requestId: 'req_8',
      });

      const prompt = vision.mock.calls[0][1].prompt;
      expect(prompt).toMatch(/ONLY what is visible in the image/);
      expect(prompt).toMatch(/Question: What colour is the car\?/);
    });

    it('VQA without a question is a caller error, not silent captioning', async () => {
      wire();

      await expect(
        service.analyzeImage({
          task: 'visual_question_answering',
          image: IMAGE,
          userContext: USER_CONTEXT,
          requestId: 'req_9',
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('validation and fallback', () => {
    it('rejects an empty image before touching the catalog', async () => {
      await expect(
        service.analyzeImage({
          task: 'vision',
          image: '   ',
          userContext: USER_CONTEXT,
          requestId: 'req_10',
        })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(searchModelsComplete).not.toHaveBeenCalled();
    });

    it('falls through to the next provider when one fails', async () => {
      const broken = vi.fn().mockRejectedValue(new Error('vision 500'));
      const healthy = vi.fn().mockResolvedValue({ content: 'recovered', raw: {} });

      searchModelsComplete.mockResolvedValue([
        makeModel({ id: 'vision-broken', provider: 'broken', inputCostPer1k: 0.001 }),
        makeModel({ id: 'vision-healthy', provider: 'healthy', inputCostPer1k: 0.002 }),
      ]);
      resolveAdapterForModel.mockImplementation((model: Model) => ({
        adapter:
          model.provider === 'broken'
            ? { vision: broken, getName: () => 'broken' }
            : { vision: healthy, getName: () => 'healthy' },
      }));

      const result = await service.analyzeImage({
        task: 'vision',
        image: IMAGE,
        strategy: 'cost',
        userContext: USER_CONTEXT,
        requestId: 'req_11',
      });

      expect(broken).toHaveBeenCalled();
      expect(result.content).toBe('recovered');
      expect(result.fallbackUsed).toBe(true);
    });
  });
});
