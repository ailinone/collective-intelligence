// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ImagesOrchestrationService.enhanceImage — LOTE AP.
 *
 * `image_upscale` and `image_denoise` had no executor: the dispatcher's
 * `image`-substring default routed them to `native_adapter`, which had no
 * branch, so they threw and fell through to chat orchestration. The catalog
 * had carried a real provider for them the whole time (Topaz, via
 * `TopazAdapter.imageEdit`).
 *
 * The load-bearing assertion here is the CANDIDATE POOL. `editImage`
 * deliberately widens itself to `image_editing` OR `image_generation` because
 * some providers tag generation models as edit-capable. Enhancement must NOT
 * do that: a generative editor handed an upscale request returns a different
 * picture, which is a silent correctness failure — much worse than a 404.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';

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
  isAdapterMethodImplemented: (adapter: { imageEdit?: unknown }) =>
    typeof adapter.imageEdit === 'function',
}));

import { ImagesOrchestrationService } from '../images-orchestration-service';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(capabilities: string[], overrides: Partial<Model> = {}): Model {
  return {
    id: 'standard',
    name: 'standard',
    displayName: 'Topaz Standard',
    provider: 'topaz',
    capabilities,
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

function wire(imageEdit: Mock, models: Model[]) {
  searchModelsComplete.mockResolvedValue(models);
  resolveAdapterForModel.mockReturnValue({ adapter: { imageEdit, getName: () => 'topaz' } });
}

const IMAGE = Buffer.from('fake-image-bytes');

describe('ImagesOrchestrationService.enhanceImage', () => {
  let service: ImagesOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImagesOrchestrationService();
  });

  it('pools ONLY the enhancement capability — never widens to editing/generation', async () => {
    const imageEdit = vi.fn().mockResolvedValue({ image: Buffer.from('out'), format: 'png' });
    wire(imageEdit, [makeModel(['image_upscale', 'image_editing', 'image_denoise'])]);

    await service.enhanceImage({
      image: IMAGE,
      capability: 'image_upscale' as ModelCapability,
      responseFormat: 'b64_json',
      userContext: USER_CONTEXT,
      requestId: 'req_1',
    });

    expect(searchModelsComplete).toHaveBeenCalledTimes(1);
    expect(searchModelsComplete).toHaveBeenCalledWith({
      capabilities: ['image_upscale'],
      status: 'active',
    });
    // Never the 100-row-capped variant (LOTE AN).
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('forwards enhancement parameters and only the ones the caller set', async () => {
    const imageEdit = vi.fn().mockResolvedValue({ image: Buffer.from('out'), format: 'png' });
    wire(imageEdit, [makeModel(['image_upscale'])]);

    await service.enhanceImage({
      image: IMAGE,
      capability: 'image_upscale' as ModelCapability,
      upscaleFactor: 4,
      responseFormat: 'b64_json',
      userContext: USER_CONTEXT,
      requestId: 'req_2',
    });

    const [, request] = imageEdit.mock.calls[0];
    expect(request.image).toBe(IMAGE);
    expect(request.options.upscale_factor).toBe(4);
    expect(request.options.enhancement).toBe('image_upscale');
    // Never sent because the caller never asked for them.
    expect(request.options).not.toHaveProperty('noise_reduction');
    expect(request.options).not.toHaveProperty('sharpen');
    // Enhancement is parameter-driven: no invented instruction.
    expect(request.prompt).toBe('');
  });

  it('routes denoise on its own capability', async () => {
    const imageEdit = vi.fn().mockResolvedValue({ image: Buffer.from('out'), format: 'png' });
    wire(imageEdit, [makeModel(['image_denoise'])]);

    await service.enhanceImage({
      image: IMAGE,
      capability: 'image_denoise' as ModelCapability,
      noiseReduction: 60,
      responseFormat: 'b64_json',
      userContext: USER_CONTEXT,
      requestId: 'req_3',
    });

    expect(searchModelsComplete).toHaveBeenCalledWith({
      capabilities: ['image_denoise'],
      status: 'active',
    });
    expect(imageEdit.mock.calls[0][1].options.noise_reduction).toBe(60);
  });

  it('returns base64 output and names the resolving provider', async () => {
    const imageEdit = vi.fn().mockResolvedValue({ image: Buffer.from('enhanced'), format: 'png' });
    wire(imageEdit, [makeModel(['image_upscale'])]);

    const result = await service.enhanceImage({
      image: IMAGE,
      capability: 'image_upscale' as ModelCapability,
      responseFormat: 'b64_json',
      userContext: USER_CONTEXT,
      requestId: 'req_4',
    });

    expect(result.provider).toBe('topaz');
    expect(result.modelUsed).toBe('standard');
    expect(result.images[0].b64_json).toBe(Buffer.from('enhanced').toString('base64'));
  });

  it('fails closed when no catalog model advertises the enhancement capability', async () => {
    // Editing/generation rows exist, but none claims upscale — the caller must
    // learn that, not silently receive a regenerated picture.
    const imageEdit = vi.fn();
    wire(imageEdit, []);

    await expect(
      service.enhanceImage({
        image: IMAGE,
        capability: 'image_upscale' as ModelCapability,
        responseFormat: 'b64_json',
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      })
    ).rejects.toThrow();
    expect(imageEdit).not.toHaveBeenCalled();
  });
});
