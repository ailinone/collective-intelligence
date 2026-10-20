// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * artifact-delivery.ts — shared media-artifact delivery normalization.
 *
 * Extracted from OrchestrationEngine (PR #696, 2026-09-30 incident) so every
 * artifact-producing path — the engine's multi-stage triage plan AND
 * MediaPlannerStrategy's native-collapse/edits — converts inline base64
 * payloads into real, fetchable delivery URLs through the SAME rules:
 *
 *  - a REAL provider URL (http/https) already satisfies delivery;
 *  - inline-only payloads are uploaded to files storage (GCS + signed URL
 *    via CapabilityInvoker.storeArtifact) and delivered as {url} with no b64;
 *  - upload failure (files storage unconfigured — e.g. GCS_FILES_BUCKET
 *    unset — or a GCS error) degrades GRACEFULLY to the historical
 *    inline-b64 artifact (bounded by ARTIFACT_MAX_B64_CHARS and the SSE
 *    line guard in utils/sse.ts) rather than failing the generation.
 *
 * Why this must be shared: MediaPlannerStrategy pushes artifacts from its own
 * generation calls; without this treatment its b64-only results reach the
 * SSE relay inline and get stripped (omission markers) on streaming —
 * recoverable by the chat-side stream:false retry, but forfeiting the
 * URL-delivery path (no double generation, no multi-MB payloads) that PR
 * #696 established for the triage-plan route.
 */
import type { CapabilityInvoker } from './capability-invoker';
import type { Logger } from 'pino';

/**
 * Best-effort file extension for a generated media buffer destined for files
 * storage. FilesService derives the STORED Content-Type from the filename
 * extension alone (getContentType), and GCS serves that Content-Type on the
 * signed URL — a wrong extension (e.g. image bytes stored as .bin) makes the
 * chat-side renderer refuse the artifact. Order: explicit MIME hint first
 * (audio/file stages have one), then image/video magic-byte sniffing, then a
 * generic binary fallback.
 */
export function sniffMediaFileExtension(buffer: Buffer, mimeType?: string): string {
  if (mimeType) {
    const subtype = mimeType.split('/')[1]?.split(';')[0];
    if (subtype) {
      switch (subtype) {
        case 'jpeg':
          return '.jpg';
        case 'mpeg':
          return mimeType.startsWith('audio/') ? '.mp3' : '.mpeg';
        case 'plain':
          return '.txt';
        case 'zip':
        case 'pdf':
        case 'png':
        case 'gif':
        case 'webp':
        case 'wav':
        case 'ogg':
        case 'opus':
        case 'mp4':
        case 'webm':
        case 'json':
        case 'csv':
          return `.${subtype}`;
        case 'vnd.openxmlformats-officedocument.wordprocessingml.document':
          return '.docx';
        case 'vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          return '.xlsx';
        case 'vnd.openxmlformats-officedocument.presentationml.presentation':
          return '.pptx';
        default:
          break;
      }
    }
  }
  const ascii = (start: number, length: number): string =>
    buffer.subarray(start, start + length).toString('latin1');
  if (buffer.length >= 8 && ascii(0, 4) === '\x89PNG') return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return '.jpg';
  if (buffer.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return '.webp';
  if (buffer.length >= 6 && ascii(0, 3) === 'GIF') return '.gif';
  if (buffer.length >= 12 && ascii(4, 4) === 'ftyp') return '.mp4';
  if (buffer.length >= 12 && ascii(0, 4) === 'RIFF') return '.wav';
  if (buffer.length >= 3 && ascii(0, 3) === 'ID3') return '.mp3';
  if (buffer.length >= 4 && ascii(0, 4) === '%PDF') return '.pdf';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return '.zip';
  return '.bin';
}

/**
 * Convert an inline base64 media payload into a real, fetchable delivery
 * URL by persisting the bytes to files storage. See the module doc comment
 * for the full contract and the 2026-09-30 production incident rationale.
 *
 * Returns the (possibly replaced) {url, b64Json} pair; never throws.
 */
export async function ensureArtifactDeliveryUrl(
  modality: 'image' | 'video' | 'audio' | 'file',
  data: { url?: string; b64Json?: string; mimeType?: string; filename?: string },
  deps: { invoker?: CapabilityInvoker; log: Logger; requestId?: string }
): Promise<{ url?: string; b64Json?: string }> {
  // Only a real http(s) URL counts as delivered-by-URL. Anything else
  // (undefined, or a data: URI — which mapImageDeliveryFields no longer
  // fabricates, but a provider could still emit) means inline-only.
  if (data.url && /^https?:\/\//i.test(data.url)) {
    return { url: data.url, b64Json: data.b64Json };
  }
  if (!data.b64Json || !deps.invoker) {
    return { url: data.url, b64Json: data.b64Json };
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(data.b64Json, 'base64');
  } catch {
    return { url: data.url, b64Json: data.b64Json };
  }
  if (buffer.length === 0) {
    return { url: data.url, b64Json: data.b64Json };
  }
  const filename =
    data.filename ??
    `generated-${modality}-${Date.now()}${sniffMediaFileExtension(buffer, data.mimeType)}`;
  try {
    const stored = await deps.invoker.storeArtifact({
      buffer,
      filename,
      purpose: 'media_generation',
    });
    deps.log.info(
      {
        requestId: deps.requestId,
        modality,
        fileId: stored.fileId,
        bytes: buffer.length,
        filename,
      },
      'Media artifact uploaded to files storage — delivering by URL instead of inline base64'
    );
    return { url: stored.url, b64Json: undefined };
  } catch (err) {
    deps.log.warn(
      {
        requestId: deps.requestId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      },
      'Media artifact upload failed — falling back to inline base64 delivery (check GCS_FILES_BUCKET / files storage health)'
    );
    return { url: data.url, b64Json: data.b64Json };
  }
}
