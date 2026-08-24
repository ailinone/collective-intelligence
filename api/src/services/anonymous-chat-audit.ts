// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * anonymous-chat-audit.ts — persistence for anonymous chat completions.
 *
 * Writes one `AnonymousChatLog` row per anonymous request: visitor
 * fingerprint/IP/UA (already forwarded by chat-backend as
 * `X-Anonymous-Visitor-*` headers), the full message list, the streamed
 * response text, models that served it, tokens, and outcome. Best-effort IP
 * geolocation is resolved ASYNC after the row exists — geo never blocks, never
 * fails, and never adds latency to the chat response itself.
 *
 * Design constraints:
 *  - FIRE-AND-FORGET: every entry point catches its own errors and logs;
 *    an audit-write failure must NEVER break or delay an anonymous chat.
 *  - CONTENT CAPS: messages and response text are capped to keep rows
 *    bounded (anonymous input is small; the cap only defends against abuse).
 *  - GEO: ip-api.com free tier (no key, 45 req/min) with an in-process
 *    TTL cache. Private/loopback IPs skip lookup. If the platform later
 *    needs offline geo, swap `lookupGeo()` only — the contract is local.
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'anonymous-chat-audit' });

const MAX_MESSAGES_BYTES = 64 * 1024;
const MAX_RESPONSE_CHARS = 100_000;

export interface AnonymousChatAuditInput {
  requestId: string;
  apiKeyId: string;
  visitorFingerprint: string;
  visitorIp?: string;
  userAgent?: string;
  acceptLanguage?: string;
  modelRequested?: string;
  modelsServed: string[];
  messages: unknown[];
  responseText?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

function sha256Hex(value: string): string {
  // Local import to keep this module dependency-light at load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === '' ||
    ip.startsWith('10.') ||
    ip.startsWith('127.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.') ||
    ip.startsWith('::1') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  );
}

// ── Geo (best-effort, async, cached) ─────────────────────────────────────

interface GeoResult {
  country?: string;
  region?: string;
  city?: string;
}

const geoCache = new Map<string, { at: number; geo: GeoResult }>();
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — geo for an IP rarely changes

async function lookupGeo(ip: string): Promise<GeoResult> {
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.geo;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return {};
    const body = (await res.json()) as { status?: string; country?: string; regionName?: string; city?: string };
    const geo: GeoResult =
      body.status === 'success'
        ? { country: body.country, region: body.regionName, city: body.city }
        : {};
    geoCache.set(ip, { at: Date.now(), geo });
    return geo;
  } catch {
    return {};
  }
}

/** Cap the serialized messages payload by dropping OLDEST turns first —
 *  keeps the JSON valid (a mid-string slice would corrupt it) and keeps the
 *  most recent turns, which matter most for abuse investigation. */
function fitMessages(messages: unknown[]): Prisma.InputJsonValue {
  let msgs = Array.isArray(messages) ? messages : [];
  try {
    while (msgs.length > 1 && JSON.stringify(msgs).length > MAX_MESSAGES_BYTES) {
      msgs = msgs.slice(1);
    }
    if (JSON.stringify(msgs).length > MAX_MESSAGES_BYTES && msgs.length > 0) {
      // Single oversized message: keep only its truncated string form.
      msgs = [{ truncated: String(msgs[0]).slice(0, MAX_MESSAGES_BYTES) }];
    }
    return JSON.parse(JSON.stringify(msgs)) as Prisma.InputJsonValue;
  } catch {
    return [];
  }
}

async function enrichWithGeo(id: string, ip: string): Promise<void> {
  const geo = await lookupGeo(ip);
  if (geo.country || geo.region || geo.city) {
    await prisma.anonymousChatLog.update({ where: { id }, data: geo }).catch(() => undefined);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────

export function recordAnonymousChat(input: AnonymousChatAuditInput): void {
  void (async () => {
    try {
      const messagesJson = fitMessages(input.messages ?? []);
      const responseText = input.responseText?.slice(0, MAX_RESPONSE_CHARS);
      const ip = input.visitorIp?.trim() || undefined;

      const row = await prisma.anonymousChatLog.create({
        data: {
          requestId: input.requestId,
          apiKeyId: input.apiKeyId,
          visitorFingerprint: input.visitorFingerprint,
          visitorIp: ip,
          ipHash: ip ? sha256Hex(ip) : undefined,
          userAgent: input.userAgent?.slice(0, 512) || undefined,
          acceptLanguage: input.acceptLanguage?.slice(0, 256) || undefined,
          modelRequested: input.modelRequested,
          modelsServed: (input.modelsServed ?? []) as Prisma.InputJsonValue,
          messages: messagesJson,
          responseText,
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          status: input.status ?? 'success',
          errorCode: input.errorCode,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });

      // Geo enrichment never blocks and never fails the write.
      if (ip && !isPrivateIp(ip)) {
        void enrichWithGeo(row.id, ip);
      }
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error), requestId: input.requestId },
        'anonymous chat audit write failed (non-blocking)'
      );
    }
  })();
}
