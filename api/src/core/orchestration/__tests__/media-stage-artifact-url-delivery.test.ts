// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-stage-artifact-url-delivery.test.ts — production incident fix
 * (2026-09-30, "Gere uma imagem de um farol na costa ao por do sol." on
 * ailin.chat, Ailin Auto):
 *
 * The image generator (openai gpt-image-*) returned only bytes; the pipeline
 * fabricated a `data:image/png;base64,...` pseudo-URL to honor
 * responseFormat:'url', duplicated it into both `artifacts[0].url` AND the
 * synthetic `message.content`, and the resulting 4.4MB SSE line degraded the
 * ENTIRE response to "Response too large to deliver over a streaming
 * connection. Retry with stream:false." — image generated, nothing delivered.
 *
 * Fix under test (orchestration-engine.ts + capability-invoker.ts):
 *  - `ensureArtifactDeliveryUrl`: an inline-only payload is uploaded to files
 *    storage and delivered as a REAL signed URL (b64 dropped);
 *  - upload failure (e.g. GCS_FILES_BUCKET unset) degrades gracefully to the
 *    historical inline-b64 artifact instead of failing the stage;
 *  - a real provider http(s) URL is passed through untouched (no upload);
 *  - the synthetic response content only ever appends http(s) URLs — never a
 *    data URI.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type {
  AilinArtifact,
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  TriageStage,
} from '@/types';
import type {
  CapabilityInvoker,
  ImageGenInvokeOptions,
  StoreArtifactOptions,
  StoreArtifactResult,
} from '@/core/orchestration/capability-invoker';

function makeEngine(): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as unknown as ProviderRegistry,
    enableTriaging: false,
  });
}

type ExecuteMediaGenerationStage = (
  modality: 'image' | 'video' | 'audio' | 'file',
  stage: TriageStage,
  stageIndex: number,
  artifactIndex: number,
  context: OrchestrationContext,
  accumulatedContext: string,
  originalRequest: ChatRequest
) => Promise<{
  artifact?: AilinArtifact;
  execution?: unknown;
  cost: number;
  summaryText: string;
  syntheticResponse: ChatResponse;
}>;

function callExecuteMediaGenerationStage(
  engine: OrchestrationEngine,
  modality: 'image' | 'video' | 'audio' | 'file',
  stage: TriageStage,
  context: OrchestrationContext,
  originalRequest: ChatRequest
) {
  return (
    engine as unknown as { executeMediaGenerationStage: ExecuteMediaGenerationStage }
  ).executeMediaGenerationStage(modality, stage, 0, 0, context, '', originalRequest);
}

function imageStage(): TriageStage {
  return {
    name: 'image_generation',
    strategy: 'single',
    modelRoles: [],
    requiredCapabilities: ['image_generation'],
    maxTokens: 1024,
    generationPrompt: 'Gere uma imagem de um farol na costa ao pôr do sol.',
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeContext(invoker: CapabilityInvoker): OrchestrationContext {
  return {
    organizationId: 'org-test',
    requestId: 'req-artifact-url-test',
    models: [],
    taskType: 'general',
    contextSize: 0,
    invoker,
  };
}

function makeImageInvoker(
  generateImage: (options: ImageGenInvokeOptions) => Promise<{
    images: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    provider?: string;
    model?: string;
  }>,
  storeArtifact?: (options: StoreArtifactOptions) => Promise<StoreArtifactResult>
): CapabilityInvoker {
  return {
    generateImage,
    ...(storeArtifact ? { storeArtifact } : {}),
  } as unknown as CapabilityInvoker;
}

const baseRequest: ChatRequest = {
  messages: [{ role: 'user', content: 'Gere uma imagem de um farol na costa ao pôr do sol.' }],
};

describe('executeMediaGenerationStage — URL delivery via files storage', () => {
  it('uploads a b64-only image and delivers a real signed URL (no inline payload, no data URI)', async () => {
    const engine = makeEngine();
    // A PNG-magic-prefixed buffer so the filename sniffer derives .png.
    const pngBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(2048, 0xab)]);
    const storeArtifact = vi.fn(async (): Promise<StoreArtifactResult> => ({
      url: 'https://storage.googleapis.com/test-bucket/org/media_generation/file-x/generated-image-1.png?X-Goog-Signature=abc',
      fileId: 'file-x',
      expiresAt: Date.now() + 6 * 3600_000,
    }));
    const context = makeContext(
      makeImageInvoker(
        async () => ({ images: [{ b64_json: pngBytes.toString('base64') }], provider: 'openai' }),
        storeArtifact
      )
    );

    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'image',
      imageStage(),
      context,
      baseRequest
    );

    expect(storeArtifact).toHaveBeenCalledTimes(1);
    const uploadArg = storeArtifact.mock.calls[0][0];
    expect(uploadArg.purpose).toBe('media_generation');
    expect(uploadArg.filename).toMatch(/\.png$/);
    expect(uploadArg.buffer.equals(pngBytes)).toBe(true);

    const artifact = outcome.artifact;
    expect(artifact?.error).toBeUndefined();
    expect(artifact?.url).toMatch(/^https:\/\//);
    expect(artifact?.b64_json).toBeUndefined();

    // Content carries the real URL for clickability — never a data URI.
    const content = outcome.syntheticResponse.choices[0].message?.content ?? '';
    expect(content).toContain('https://storage.googleapis.com/');
    expect(content).not.toContain('data:');
  });

  it('degrades gracefully to inline b64 when files storage is unavailable (GCS_FILES_BUCKET unset)', async () => {
    const engine = makeEngine();
    const pngBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(512, 0xcd)]);
    const b64 = pngBytes.toString('base64');
    const storeArtifact = vi.fn(async () => {
      throw new Error('File storage is not configured. Set GCS_FILES_BUCKET environment variable.');
    });
    const context = makeContext(
      makeImageInvoker(async () => ({ images: [{ b64_json: b64 }] }), storeArtifact)
    );

    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'image',
      imageStage(),
      context,
      baseRequest
    );

    // The generation itself SUCCEEDED — the artifact ships inline (bounded
    // downstream by ARTIFACT_MAX_B64_CHARS and the SSE line guard), with no
    // spurious error field and no half-populated url.
    expect(outcome.artifact?.error).toBeUndefined();
    expect(outcome.artifact?.url).toBeUndefined();
    expect(outcome.artifact?.b64_json).toBe(b64);
  });

  it('passes a real provider http(s) URL through without uploading', async () => {
    const engine = makeEngine();
    const storeArtifact = vi.fn(async (): Promise<StoreArtifactResult> => ({
      url: 'https://should-not-be-used.example/x.png',
      fileId: 'file-unused',
      expiresAt: Date.now() + 3600_000,
    }));
    const providerUrl = 'https://cdn.provider.example/gen/lighthouse.png';
    const context = makeContext(
      makeImageInvoker(
        async () => ({
          images: [{ url: providerUrl, b64_json: 'redundant-inline-copy==' }],
          provider: 'some-provider',
        }),
        storeArtifact
      )
    );

    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'image',
      imageStage(),
      context,
      baseRequest
    );

    expect(storeArtifact).not.toHaveBeenCalled();
    expect(outcome.artifact?.url).toBe(providerUrl);
    // url-present ⇒ the redundant inline copy is dropped (existing contract).
    expect(outcome.artifact?.b64_json).toBeUndefined();
  });

  it('treats a provider-returned data-URI url as NOT delivered and uploads from the bytes instead', async () => {
    const engine = makeEngine();
    const pngBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(256, 0x11)]);
    const dataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const storeArtifact = vi.fn(async (): Promise<StoreArtifactResult> => ({
      url: 'https://storage.googleapis.com/test-bucket/org/media_generation/file-y/generated-image-2.png',
      fileId: 'file-y',
      expiresAt: Date.now() + 6 * 3600_000,
    }));
    // A defensive shape: the mapper no longer fabricates data-URIs, but a
    // provider could still emit one; the stage must not treat it as delivery.
    const context = makeContext(
      makeImageInvoker(
        async () => ({ images: [{ url: dataUri, b64_json: pngBytes.toString('base64') }] }),
        storeArtifact
      )
    );

    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'image',
      imageStage(),
      context,
      baseRequest
    );

    expect(storeArtifact).toHaveBeenCalledTimes(1);
    expect(outcome.artifact?.url).toMatch(/^https:\/\//);
    expect(outcome.artifact?.b64_json).toBeUndefined();
    expect(outcome.syntheticResponse.choices[0].message?.content ?? '').not.toContain('data:');
  });

  it('uploads file-generation artifacts under the generator-provided filename', async () => {
    const engine = makeEngine();
    const storeArtifact = vi.fn(async (): Promise<StoreArtifactResult> => ({
      url: 'https://storage.googleapis.com/test-bucket/org/media_generation/file-z/generated.zip',
      fileId: 'file-z',
      expiresAt: Date.now() + 6 * 3600_000,
    }));
    const invoker = {
      generateFile: async () => ({
        buffer: Buffer.from('PK\u0003\u0004fake-zip-bytes'),
        filename: 'generated.zip',
        mimeType: 'application/zip',
      }),
      storeArtifact,
    } as unknown as CapabilityInvoker;

    const stage: TriageStage = {
      name: 'zip_generation',
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: ['zip_generation'],
      maxTokens: 1024,
      generationPrompt: 'Crie um zip com 3 arquivos de texto.',
    };
    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'file',
      stage,
      makeContext(invoker),
      { messages: [{ role: 'user', content: 'Crie um zip com 3 arquivos de texto.' }] }
    );

    expect(storeArtifact).toHaveBeenCalledTimes(1);
    expect(storeArtifact.mock.calls[0][0].filename).toBe('generated.zip');
    expect(outcome.artifact?.url).toMatch(/^https:\/\//);
    expect(outcome.artifact?.b64_json).toBeUndefined();
  });

  it('uploads audio artifacts with an extension derived from the audio mime type', async () => {
    const engine = makeEngine();
    const storeArtifact = vi.fn(async (): Promise<StoreArtifactResult> => ({
      url: 'https://storage.googleapis.com/test-bucket/org/media_generation/file-a/generated-audio-3.wav',
      fileId: 'file-a',
      expiresAt: Date.now() + 6 * 3600_000,
    }));
    const invoker = {
      synthesize: async () => ({
        audioBuffer: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 0x00)]),
        format: 'wav',
        provider: 'elevenlabs',
      }),
      storeArtifact,
    } as unknown as CapabilityInvoker;

    const stage: TriageStage = {
      name: 'text_to_speech',
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: ['text_to_speech'],
      maxTokens: 1024,
      generationPrompt: 'Leia este texto em voz alta.',
    };
    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'audio',
      stage,
      makeContext(invoker),
      { messages: [{ role: 'user', content: 'Leia este texto em voz alta.' }] }
    );

    expect(storeArtifact).toHaveBeenCalledTimes(1);
    // RIFF-without-WEBP magic → .wav (and audio/mp3-like mimes would map
    // through the MIME branch — both must land on a real extension, never
    // the octet-stream .bin that would break Content-Type negotiation).
    expect(storeArtifact.mock.calls[0][0].filename).toMatch(/\.(wav|mp3|bin)$/);
    expect(storeArtifact.mock.calls[0][0].filename).not.toMatch(/\.bin$/);
    expect(outcome.artifact?.url).toMatch(/^https:\/\//);
    expect(outcome.artifact?.b64_json).toBeUndefined();
  });
});
