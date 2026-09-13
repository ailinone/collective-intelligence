// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-stage-duplicate-and-placeholder.test.ts — production incident fix
 * (2026-09-08), verified live against ailin.chat:
 *
 *  Bug 1 (duplicate artifact): "Crie um zip com 3 arquivos de texto, cada um
 *  com uma piada diferente." returned TWO chat-UI file chips, both literally
 *  named "generated.zip" and both 475.0 B — a single conceptual deliverable
 *  rendered twice. Root cause: nothing stopped a triage plan from containing
 *  two media-generation stages for the exact same deliverable (same
 *  modality/format/generation_prompt); each stage independently calls the
 *  generator and pushes its own artifact, and `FileGenerationService.generate()`
 *  always uses the same generic `filenameBase` default ("generated"), so two
 *  such stages are visually and often byte-for-byte indistinguishable. Fixed
 *  in `executeMultiStagePlan` (and mirrored in `executeCompositeMediaPlan`)
 *  by tracking successfully-delivered (modality, format, generation_prompt)
 *  keys and skipping a later stage that repeats one instead of re-generating.
 *
 *  Bug 2 (placeholder text leak): both the zip test above and a separate PDF
 *  test ("Gere um documento PDF com um resumo de 3 paragrafos sobre a
 *  historia da internet.") returned the literal internal string
 *  "[file generated — see ailin_metadata.artifacts[0]]" as the assistant's
 *  visible chat message — this was not a fallback, it was the ONLY text ever
 *  produced for a successful media/file-generation stage. Fixed by
 *  `buildMediaSuccessMessage()` in orchestration-engine.ts, which builds a
 *  real natural-language sentence (localized PT/EN) instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type {
  AilinArtifact,
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  TriageExecutionPlan,
  TriageStage,
} from '@/types';
import type { CapabilityInvoker, FileGenInvokeOptions } from '@/core/orchestration/capability-invoker';

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

type ExecuteMultiStagePlan = (
  originalRequest: ChatRequest,
  context: OrchestrationContext,
  plan: TriageExecutionPlan,
  requestId: string
) => Promise<OrchestrationResult>;

function callExecuteMultiStagePlan(
  engine: OrchestrationEngine,
  request: ChatRequest,
  context: OrchestrationContext,
  plan: TriageExecutionPlan,
  requestId = 'req-multistage-test'
): Promise<OrchestrationResult> {
  return (
    engine as unknown as { executeMultiStagePlan: ExecuteMultiStagePlan }
  ).executeMultiStagePlan(request, context, plan, requestId);
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

function zipStage(overrides: Partial<TriageStage> = {}): TriageStage {
  return {
    name: 'zip_generation',
    strategy: 'single',
    modelRoles: [],
    requiredCapabilities: ['zip_generation'],
    maxTokens: 1024,
    generationPrompt:
      'Crie um zip com 3 arquivos de texto, cada um com uma piada diferente.',
    ...overrides,
  };
}

function planWithStages(stages: TriageStage[]): TriageExecutionPlan {
  return {
    maxTokens: 4096,
    qualityTarget: 0.8,
    preferSpeed: false,
    requiredCapabilities: stages.flatMap((s) => s.requiredCapabilities),
    estimatedInputTokens: 100,
    strategy: 'single',
    modelCount: 1,
    requiresContinuation: false,
    stages,
  };
}

function baseRequest(content = 'Crie um zip com 3 arquivos de texto.'): ChatRequest {
  return { messages: [{ role: 'user', content }] };
}

function makeFileInvoker(generateFile: (options: FileGenInvokeOptions) => Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
}>): CapabilityInvoker {
  return { generateFile } as unknown as CapabilityInvoker;
}

describe('executeMultiStagePlan — duplicate media-generation stage dedup (Bug 1)', () => {
  it('two zip_generation stages with the IDENTICAL generation_prompt produce exactly ONE artifact and call generateFile only once', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const plan = planWithStages([zipStage(), zipStage()]);
    const result = await callExecuteMultiStagePlan(engine, baseRequest(), context, plan);

    expect(generateFile).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0].modality).toBe('file');
    expect(result.artifacts?.[0].error).toBeUndefined();
  });

  it('two zip_generation stages with DIFFERENT generation_prompt are NOT deduped (genuinely distinct deliverables)', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const plan = planWithStages([
      zipStage({ name: 'zip_a', generationPrompt: 'A zip with 3 jokes as text files.' }),
      zipStage({ name: 'zip_b', generationPrompt: 'A completely separate zip with sales data as CSVs.' }),
    ]);
    const result = await callExecuteMultiStagePlan(engine, baseRequest(), context, plan);

    expect(generateFile).toHaveBeenCalledTimes(2);
    expect(result.artifacts).toHaveLength(2);
  });

  it('a FAILED first attempt does not suppress a legitimate retry-shaped duplicate stage', async () => {
    const engine = makeEngine();
    let call = 0;
    const generateFile = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('provider hiccup');
      return {
        buffer: Buffer.from('PKfake-zip-bytes'),
        filename: 'generated.zip',
        mimeType: 'application/zip',
      };
    });
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const plan = planWithStages([zipStage(), zipStage()]);
    const result = await callExecuteMultiStagePlan(engine, baseRequest(), context, plan);

    // Only a SUCCESSFUL delivery is deduped against — a prior failure must
    // never suppress a legitimate second attempt.
    expect(generateFile).toHaveBeenCalledTimes(2);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts?.[0].error).toBeTruthy();
    expect(result.artifacts?.[1].error).toBeUndefined();
  });

  it('stages with NO explicit generation_prompt are never deduped against each other (avoids suppressing legitimately different content)', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const plan = planWithStages([
      zipStage({ generationPrompt: undefined }),
      zipStage({ generationPrompt: undefined }),
    ]);
    const result = await callExecuteMultiStagePlan(engine, baseRequest(), context, plan);

    expect(generateFile).toHaveBeenCalledTimes(2);
    expect(result.artifacts).toHaveLength(2);
  });
});

describe('mediaStageSuccess / executeMediaGenerationStage — natural-language success text (Bug 2)', () => {
  const PLACEHOLDER_RE = /ailin_metadata\.artifacts\[\d+\]|\[.*generated.*\]/i;

  it('ZIP generation success text is a natural sentence, not the internal placeholder', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const stage = zipStage({
      generationPrompt: 'Crie um zip com 3 arquivos de texto, cada um com uma piada diferente.',
    });
    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'file',
      stage,
      context,
      baseRequest()
    );

    const content = outcome.syntheticResponse.choices?.[0]?.message?.content;
    expect(typeof content).toBe('string');
    expect(content as string).not.toMatch(PLACEHOLDER_RE);
    // Portuguese request -> Portuguese natural sentence naming the format.
    expect(content).toMatch(/arquivo zip/i);
  });

  it('PDF generation success text is a natural sentence, not the internal placeholder', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('%PDF-1.4 fake pdf bytes'),
      filename: 'generated.pdf',
      mimeType: 'application/pdf',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const stage: TriageStage = {
      name: 'pdf_generation',
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: ['pdf_generation'],
      maxTokens: 1024,
      generationPrompt:
        'Gere um documento PDF com um resumo de 3 paragrafos sobre a historia da internet.',
    };
    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'file',
      stage,
      context,
      baseRequest('Gere um documento PDF com um resumo de 3 paragrafos sobre a historia da internet.')
    );

    const content = outcome.syntheticResponse.choices?.[0]?.message?.content;
    expect(typeof content).toBe('string');
    expect(content as string).not.toMatch(PLACEHOLDER_RE);
    expect(content).toMatch(/documento em pdf/i);
  });

  it('uses an English natural sentence for an English request', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const stage = zipStage({
      generationPrompt: 'Create a zip with 3 text files, each containing a different joke.',
    });
    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'file',
      stage,
      context,
      baseRequest('Create a zip with 3 text files, each containing a different joke.')
    );

    const content = outcome.syntheticResponse.choices?.[0]?.message?.content;
    expect(content).toMatch(/here is the zip file you requested/i);
    expect(content as string).not.toMatch(PLACEHOLDER_RE);
  });

  it('the technical ailin_metadata pointer still exists internally (summaryText), just never reaches the user-facing content', async () => {
    const engine = makeEngine();
    const generateFile = vi.fn(async () => ({
      buffer: Buffer.from('PKfake-zip-bytes'),
      filename: 'generated.zip',
      mimeType: 'application/zip',
    }));
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker: makeFileInvoker(generateFile),
    };

    const outcome = await callExecuteMediaGenerationStage(
      engine,
      'file',
      zipStage(),
      context,
      baseRequest()
    );

    expect(outcome.summaryText).toMatch(/ailin_metadata\.artifacts\[0\]/);
    expect(outcome.syntheticResponse.choices?.[0]?.message?.content).not.toMatch(
      /ailin_metadata/i
    );
  });
});
