// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-media-pipeline-characterization.test.ts — Track E (E2 + E3).
 *
 * Characterization: the composite `<family>:<tier>` dispatch introduced by
 * the strategy catalog must leave the media/artifact pipeline EXACTLY as it
 * is for the legacy `ailin-*` preset dispatch. Three properties, per
 * phase-1-plan.md Track E:
 *
 *  (E2) the streaming media gate's decision is MODEL-AGNOSTIC by
 *       construction: `detectStreamingMediaGateModality` consumes
 *       Pick<ChatRequest, 'messages' | 'tools' | 'max_tokens'> — the model
 *       field (the only thing the two dispatch identities differ on, both
 *       being 'auto' post-normalization) is not even an input. Pinned both
 *       at the type/source level and behaviorally.
 *
 *  (E3a) the 2026-09-30 "Response too large" incident fix holds:
 *       `ensureArtifactDeliveryUrl` (PR #696's shared normalization, extracted
 *       from OrchestrationEngine) delivers a REAL http(s) URL — a provider URL
 *       passes through, an inline-b64 payload is uploaded to files storage and
 *       delivered as {url} with the b64 dropped. No data URI is fabricated.
 *
 *  (E3b) the SSE relay's artifact guard (`formatSSE` →
 *       stripUnsafeInlineArtifacts) passes an http-URL artifact through
 *       UNTOUCHED and strips the incident's data-URI-in-url shape with the
 *       honest stream:false retry hint — and the A1/A3 layers are pure
 *       readers: neither the descriptor builders nor the target-policy gate
 *       ever reads or mutates artifact fields (pinned behaviorally + at
 *       source level).
 */

import { describe, expect, it, vi } from 'vitest';

// Workaround for a pre-existing worktree-environment break (NOT a code issue):
// importing chat-routes pulls chat-request-processor → file-generation-service,
// whose `pptxgenjs` resolves through the node_modules junction's pnpm store
// and fails to load under vite in this checkout. The module is irrelevant to
// everything under test here — stub its default export so the import chain
// resolves. (The pre-existing streaming-media-gate-* tests fail to even
// COLLECT with the same error today.)
vi.mock('pptxgenjs', () => ({ default: class PptxGenJSStub {} }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { ChatMessage, ChatRequest, ChatResponse } from '@/types';
import { logger } from '@/utils/logger';

import {
  detectStreamingMediaGateModality,
  detectStreamingMediaGateModalities,
} from '../chat-routes';
import { ensureArtifactDeliveryUrl } from '@/core/orchestration/artifact-delivery';
import { formatSSE } from '@/utils/sse';
import { evaluateTargetPolicyGate } from '@/services/strategy-target-policy';
import { buildStrategyCatalog } from '../../models/strategy-descriptors';

const IMAGE_PROMPT = 'generate an image of a red bicycle';

function reqWithModel(model: string, extra: Record<string, unknown> = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: IMAGE_PROMPT }],
    max_tokens: 256,
    model,
    ...extra,
  } as ChatRequest;
}

/** The four dispatch identities, post-normalization. The first two are the
 * pair Track E2 requires to be indistinguishable to the pipeline; the last
 * two are the other shapes the gate sees. */
const DISPATCH_IDENTITIES: Array<[string, ChatRequest]> = [
  ['composite best:large (server tier carrier)', reqWithModel('auto', {
    ailin_alias: 'best:large',
    ailin_tier: 'large',
    ailin_tier_rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 },
  })],
  ['legacy preset ailin-best', reqWithModel('auto', { ailin_alias: 'ailin-best' })],
  ['raw provider id', reqWithModel('gpt-4o-mini')],
  ['literal auto', reqWithModel('auto')],
];

// ── E2: the media gate cannot see the dispatch identity ─────────────────────
describe('E2 — the streaming media gate is model-agnostic across dispatch identities', () => {
  it('the gate decision consumes NO model field (type-level, pinned at source)', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../chat-routes.ts', import.meta.url)),
      'utf8'
    );
    // The Pick type of BOTH gate entry points lists exactly these keys —
    // 'model' is structurally absent, for every caller.
    const picks = code.match(/Pick<ChatRequest, 'messages' \| 'tools' \| 'max_tokens'>/g);
    expect(picks?.length).toBeGreaterThanOrEqual(2);
  });

  it('every dispatch identity gets the IDENTICAL modality decision for the same prompt', () => {
    const decisions = DISPATCH_IDENTITIES.map(
      ([label, request]) => [label, detectStreamingMediaGateModality(request)] as const
    );
    for (const [label, decision] of decisions) {
      expect(decision, label).toBe('image');
    }
    expect(new Set(decisions.map(([, d]) => d)).size).toBe(1);
  });

  it('same for a NON-media prompt: identical null decision everywhere (no spurious redirect)', () => {
    for (const [, request] of DISPATCH_IDENTITIES) {
      const nonMedia = { ...request, messages: [{ role: 'user', content: 'explain quaternions' }] };
      expect(detectStreamingMediaGateModality(nonMedia as ChatRequest)).toBeNull();
    }
  });

  it('the observability plural reports the same modalities for every identity', () => {
    const sets = DISPATCH_IDENTITIES.map(([, request]) =>
      detectStreamingMediaGateModalities(request)
    );
    expect(new Set(sets.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(sets[0]).toContain('image');
  });
});

// ── E3a: real-URL artifact delivery (the incident fix) ──────────────────────
describe('E3a — ensureArtifactDeliveryUrl delivers REAL URLs (no data-URI fabrication)', () => {
  const log = logger.child({ component: 'strategy-media-pipeline-characterization' });

  it('a real provider http(s) URL passes through untouched, b64 as-is', async () => {
    const result = await ensureArtifactDeliveryUrl(
      'image',
      { url: 'https://cdn.example.com/generated/img.png', b64Json: 'aaaa' },
      { log }
    );
    expect(result).toEqual({ url: 'https://cdn.example.com/generated/img.png', b64Json: 'aaaa' });
  });

  it('an inline-b64 payload is UPLOADED and delivered as a real URL with the b64 dropped', async () => {
    const uploads: Array<{ filename: string; purpose: string }> = [];
    const invoker = {
      storeArtifact: async (input: { buffer: Buffer; filename: string; purpose: string }) => {
        uploads.push({ filename: input.filename, purpose: input.purpose });
        return { fileId: 'file-123', url: 'https://files.internal/signed/file-123' };
      },
    } as unknown as CapabilityInvoker;

    const result = await ensureArtifactDeliveryUrl(
      'image',
      { b64Json: Buffer.from('fake-png-bytes').toString('base64'), mimeType: 'image/png' },
      { invoker, log, requestId: 'req-e3' }
    );
    expect(result).toEqual({ url: 'https://files.internal/signed/file-123', b64Json: undefined });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].purpose).toBe('media_generation');
    expect(uploads[0].filename.endsWith('.png')).toBe(true);
  });

  it('a data-URI in url is NOT trusted as delivered-by-URL (inline-only → upload path)', async () => {
    const invoker = {
      storeArtifact: async () => ({ fileId: 'file-9', url: 'https://files.internal/signed/file-9' }),
    } as unknown as CapabilityInvoker;
    const dataUri = 'data:image/png;base64,' + Buffer.from('x').toString('base64');

    const result = await ensureArtifactDeliveryUrl('image', { url: dataUri, b64Json: Buffer.from('y').toString('base64') }, { invoker, log });
    // The fabricated-era shape is replaced by the real upload URL.
    expect(result.url).toBe('https://files.internal/signed/file-9');
    expect(result.b64Json).toBeUndefined();
  });

  it('upload failure degrades to the inline artifact (never fails the generation)', async () => {
    const invoker = {
      storeArtifact: async () => {
        throw new Error('gcs unavailable');
      },
    } as unknown as CapabilityInvoker;
    const b64 = Buffer.from('bytes').toString('base64');
    const result = await ensureArtifactDeliveryUrl('image', { b64Json: b64 }, { invoker, log });
    expect(result).toEqual({ url: undefined, b64Json: b64 });
  });
});

// ── E3b: SSE guard + A1/A3 purity ────────────────────────────────────────────
describe('E3b — the SSE artifact guard and the A1/A3 layers', () => {
  function chunkWithArtifact(artifact: { url?: string; b64_json?: string }): ChatResponse {
    return {
      id: 'chatcmpl-e3',
      object: 'chat.completion',
      created: 1,
      model: 'auto',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      ailin_metadata: { artifacts: [artifact] },
    } as unknown as ChatResponse;
  }

  it('an http-URL artifact passes formatSSE COMPLETELY untouched', () => {
    const artifact = { url: 'https://files.internal/signed/file-123' };
    const line = formatSSE(chunkWithArtifact(artifact));
    const parsed = JSON.parse(line.replace(/^data: /, '').trim()) as {
      ailin_metadata?: { artifacts?: Array<Record<string, unknown>> };
    };
    expect(parsed.ailin_metadata?.artifacts).toEqual([artifact]);
    expect(line).toContain('https://files.internal/signed/file-123');
    expect(line).not.toContain('retry with stream:false');
  });

  it('the incident shape (2MB data-URI in url) is stripped with the stream:false hint', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(2_190_000);
    const line = formatSSE(chunkWithArtifact({ url: huge }));
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(70_000);
    expect(line).toContain('retry with stream:false');
    expect(line).not.toContain(huge);
  });

  it('the A3 gate is a pure reader: a media-bearing request is not mutated and yields no artifact fields', async () => {
    const request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'red bicycle' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      model: 'auto',
      ailin_alias: 'best:large',
      ailin_tier: 'large',
      ailin_tier_rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 },
    } as unknown as ChatRequest;
    const snapshot = JSON.parse(JSON.stringify(request)) as ChatRequest;

    const result = await evaluateTargetPolicyGate('org-e3', request);

    // Off/shadow default policy: applied (it IS a composite) and allowed.
    expect(result.applied).toBe(true);
    expect(result.allowed).toBe(true);
    // And the request passed through byte-identical — the gate reads the tier
    // carrier, nothing else, and writes nothing back.
    expect(JSON.parse(JSON.stringify(request)) as ChatRequest).toEqual(snapshot);
    expect(JSON.stringify(result)).not.toContain('artifacts');
  });

  it('the A1 descriptor layer never reads or emits artifact fields (catalog is payload-free)', () => {
    // GET /v1/models/strategies takes no request payload at all; the builder
    // output must not mention artifacts (behavioral).
    expect(JSON.stringify(buildStrategyCatalog())).not.toContain('artifact');
    // And at source: neither A1 module nor the policy module touches the
    // artifact fields anywhere (positive-anchor source scan, house pattern).
    for (const rel of [
      '../../models/strategy-descriptors.ts',
      '../../models/models-strategies-routes.ts',
      '../../../services/strategy-target-policy.ts',
      '../../../services/strategy-family.ts',
    ]) {
      const code = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(code, rel).not.toMatch(/b64_json|image_url|artifacts?\b/);
    }
  });
});
