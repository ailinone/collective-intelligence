// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

// Regression test for the unbound-`this` bug: generateImages/editImage/
// createVariations used to destructure `adapter.imageGenerate` etc. into a
// bare function reference and invoke it detached from `adapter`, so any
// adapter implementation that reads `this.*` (e.g. `this.normalizeModelName`)
// crashed with "Cannot read properties of undefined" for every candidate.

const FAKE_MODEL: Model = {
  id: 'fake/image-model',
  name: 'fake/image-model',
  provider: 'fake-provider',
  capabilities: ['image_generation', 'image_editing'],
  status: 'active',
} as Model;

class FakeImageAdapter {
  // Non-arrow instance methods so a detached call has `this === undefined`
  // (strict mode / ESM), mirroring real adapters like openai-compatible-hub.
  private marker = 'bound';

  getName(): string {
    return 'fake-provider';
  }

  private assertBound(): void {
    if (!this || this.marker !== 'bound') {
      throw new Error("Cannot read properties of undefined (reading 'normalizeModelName')");
    }
  }

  async imageGenerate() {
    this.assertBound();
    return { image: { url: 'https://fake.test/generated.png' } };
  }

  async imageEdit() {
    this.assertBound();
    return { image: { url: 'https://fake.test/edited.png' } };
  }

  async imageVariation() {
    this.assertBound();
    return { image: { url: 'https://fake.test/variation.png' } };
  }
}

const fakeAdapter = new FakeImageAdapter() as unknown as ProviderAdapter;

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModels = vi.fn().mockResolvedValue([FAKE_MODEL]);
  },
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: vi.fn(() => ({
    resolveAdapterForModel: vi.fn(() => ({
      adapter: fakeAdapter,
      operability: { runnable: true, resolvedProvider: 'fake-provider', nonOperationalReasons: [] },
    })),
  })),
}));

import { ImagesOrchestrationService } from '@/services/images-orchestration-service';

describe('ImagesOrchestrationService — adapter method binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseOptions = {
    userContext: {} as never,
    requestId: 'req-1',
  };

  it('generateImages calls adapter.imageGenerate with `this` bound to the adapter', async () => {
    const service = new ImagesOrchestrationService();
    const result = await service.generateImages({
      ...baseOptions,
      prompt: 'a red bicycle',
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      responseFormat: 'url',
      style: 'vivid',
    });
    expect(result.images[0]?.url).toBe('https://fake.test/generated.png');
  });

  it('editImage calls adapter.imageEdit with `this` bound to the adapter', async () => {
    const service = new ImagesOrchestrationService();
    const result = await service.editImage({
      ...baseOptions,
      image: Buffer.from('fake'),
      prompt: 'make it blue',
      n: 1,
      size: '1024x1024',
      responseFormat: 'url',
    });
    expect(result.images[0]?.url).toBe('https://fake.test/edited.png');
  });

  it('createVariations calls adapter.imageVariation with `this` bound to the adapter', async () => {
    const service = new ImagesOrchestrationService();
    const result = await service.createVariations({
      ...baseOptions,
      image: Buffer.from('fake'),
      n: 1,
      size: '1024x1024',
      responseFormat: 'url',
    });
    expect(result.images[0]?.url).toBe('https://fake.test/variation.png');
  });
});
