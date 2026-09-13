// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared production-shaped fixture for the SAB index tests, built from the
 * 2026-09-11 live audit (ADR-027, "Canary 2"):
 *   - 112,140 active rows;
 *   - metadata JSONB averaging 934 bytes/row, max 13,757 bytes, with a
 *     long tail of large rows (the previous fixtures used 2 to 102 bytes
 *     per row, which is how a 64 MiB blob passed every test and overflowed
 *     on the first real build);
 *   - exactly 64 distinct legacy capability strings (the ones the canary's
 *     encoder logged: the 32 it kept plus the 32 it dropped).
 */
import type { Model, ModelCapability } from '@/types';
import { narrowAs } from '@/utils/type-guards';

export const PROD_ACTIVE_ROWS = 112_140;
export const PROD_MAX_METADATA_BYTES = 13_757;

/** Kept by the 32-bit encoder on 2026-09-11 (alphabetically first 32). */
export const PROD_CAPABILITIES_KEPT_BY_OLD_MASK = [
  'agents',
  'analysis',
  'audio',
  'audio_generation',
  'audio_input',
  'audio_output',
  'audio_to_audio',
  'chat',
  'code_completion',
  'code_edit',
  'code_generation',
  'code_interpreter',
  'code_review',
  'coding',
  'completions',
  'computer_use',
  'debugging',
  'deep_compute',
  'deep_research',
  'deep_search',
  'diarization',
  'documentation',
  'embedding',
  'embeddings',
  'file_search',
  'function_calling',
  'health',
  'image_captioning',
  'image_editing',
  'image_generation',
  'image_to_video',
  'json_mode',
] as const;

/** The `dropped` list from the canary's own encoder log, verbatim. */
export const PROD_CAPABILITIES_DROPPED_BY_OLD_MASK = [
  'long_context',
  'mcp',
  'moderation',
  'multimodal',
  'music_generation',
  'pdf_understanding',
  'qa',
  'realtime',
  'realtime_audio',
  'reasoning',
  'reranking',
  'research',
  'retrieval',
  'safety',
  'speech_to_text',
  'streaming',
  'text_generation',
  'text_to_speech',
  'thinking_mode',
  'tool_use',
  'transcription',
  'translation',
  'tts',
  'video_editing',
  'video_generation',
  'video_to_text',
  'video_to_video',
  'video_transcription',
  'video_understanding',
  'vision',
  'visual_question_answering',
  'web_search',
] as const;

export const PROD_CAPABILITIES_64: readonly string[] = [
  ...PROD_CAPABILITIES_KEPT_BY_OLD_MASK,
  ...PROD_CAPABILITIES_DROPPED_BY_OLD_MASK,
];

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Builds a metadata object whose compact JSON is EXACTLY `targetBytes`
 *  long (UTF-8), including the `lastSyncedAt` stamp `mapPrismaModel`
 *  injects in production. */
export function metadataOfExactBytes(
  targetBytes: number,
  seed: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    discoverySource: 'fetcher',
    executionProvider: seed % 3 === 0 ? 'hf-inference' : 'native',
    version: `2026-09-${String((seed % 28) + 1).padStart(2, '0')}`,
    tools: ['search', 'calculator'],
    lastSyncedAt: '2026-09-11T00:00:00.000Z',
    ...extra,
    pad: '',
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  if (targetBytes < baseBytes) throw new Error(`metadataOfExactBytes: target ${targetBytes} < base ${baseBytes}`);
  base.pad = 'x'.repeat(targetBytes - baseBytes);
  return base;
}

/** Deterministic per-row metadata size: 1 row in 100 is a large-tail row
 *  (4,000 .. 13,756 bytes), row 0 is exactly the observed maximum, the rest
 *  sit between 780 and 929 bytes. Mean lands at ~935 bytes, matching the
 *  934-byte production average. */
export function prodMetadataBytesForRow(i: number): number {
  if (i === 0) return PROD_MAX_METADATA_BYTES;
  if (i % 100 === 0) return 4_000 + ((i * 7_919) % 9_757);
  return 780 + (i % 150);
}

/** `chat` plus 1..4 more capabilities drawn from the given pool by hash, so
 *  every capability in the pool (including those past bit 31/63/95) has
 *  thousands of models and filters on them narrow the pool rather than
 *  fail open. */
export function capabilitiesForRow(id: string, pool: readonly string[]): ModelCapability[] {
  const h = hashStr(id);
  const caps = new Set<string>(['chat']);
  const extra = 1 + (h % 4);
  for (let k = 0; k < extra; k++) caps.add(pool[(h + k * 31 + (h >>> 8) * k) % pool.length]);
  return [...caps].map((c) => narrowAs<ModelCapability>(c));
}

export interface ProdFixtureOptions {
  rows?: number;
  capabilityPool?: readonly string[];
  /** When false, metadata stays tiny (for tests that only care about
   *  capabilities). */
  realisticMetadata?: boolean;
}

/** Real bucket proportions (2026-09 audit): ~33.7% curated across 95
 *  providers, ~66.1% aggregated (serverless HF index), ~0.2% orphan. */
export function buildProdShapedModels(options: ProdFixtureOptions = {}): Model[] {
  const rows = options.rows ?? PROD_ACTIVE_ROWS;
  const pool = options.capabilityPool ?? PROD_CAPABILITIES_64;
  const realistic = options.realisticMetadata ?? true;
  const curatedRows = Math.round(rows * 0.337);
  const orphanRows = Math.max(1, Math.round(rows * 0.002));
  const aggregatedRows = rows - curatedRows - orphanRows;
  const providers = 95;

  const models: Model[] = new Array<Model>(rows);
  let i = 0;
  const push = (id: string, providerName: string, contextWindow: number, extraMetadata: Record<string, unknown>) => {
    const metadata = realistic
      ? metadataOfExactBytes(prodMetadataBytesForRow(i), i, extraMetadata)
      : { ...extraMetadata };
    models[i] = {
      id,
      providerId: `${providerName}-provider-id`,
      provider: providerName,
      name: id,
      displayName: id,
      contextWindow,
      maxOutputTokens: 4_096,
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.03,
      capabilities: capabilitiesForRow(id, pool),
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
      status: 'active',
      metadata,
    };
    i += 1;
  };

  for (let c = 0; c < curatedRows; c++) {
    push(`curated-${c}`, `provider-${c % providers}`, 128_000, {});
  }
  for (let a = 0; a < aggregatedRows; a++) {
    push(`hf-${a}`, 'huggingface', 32_000, { serverless_callable: true, hubInventoryClass: 'aggregated_index' });
  }
  for (let o = 0; o < orphanRows; o++) {
    push(`orphan-${o}`, 'orphan-provider', 128_000, { hubInventoryClass: 'aggregated_index' });
  }
  return models;
}
