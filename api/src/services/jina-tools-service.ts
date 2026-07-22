// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import type { ToolResult } from '@/services/tool-execution-service';

export type JinaToolName =
  | 'reader'
  | 'search'
  | 'embeddings'
  | 'rerank'
  | 'classify'
  | 'segment'
  | 'deepsearch';

interface ExecuteJinaToolInput {
  toolName: JinaToolName;
  payload: Record<string, unknown>;
  toolCallId: string;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, unknown>;
}

type NormalizedErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_error'
  | 'request_failed';

class JinaToolsServiceError extends Error {
  readonly statusCode: number;
  readonly code: NormalizedErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: NormalizedErrorCode,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'JinaToolsServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.metadata = metadata;
  }
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export class JinaToolsService {
  private readonly log = logger.child({ component: 'jina-tools-service' });
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly deepSearchBaseUrl: string;
  private readonly readerBaseUrl: string;
  private readonly searchBaseUrl: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor() {
    this.apiKey = process.env.JINA_API_KEY || '';
    this.apiBaseUrl = process.env.JINA_API_BASE_URL || 'https://api.jina.ai/v1';
    this.deepSearchBaseUrl = process.env.JINA_DEEPSEARCH_BASE_URL || 'https://deepsearch.jina.ai/v1';
    this.readerBaseUrl = process.env.JINA_READER_BASE_URL || 'https://r.jina.ai';
    this.searchBaseUrl = process.env.JINA_SEARCH_BASE_URL || 'https://s.jina.ai';
    this.maxRetries = this.readIntegerEnv('JINA_TOOLS_MAX_RETRIES', DEFAULT_MAX_RETRIES, 0, 10);
    this.retryDelayMs = this.readIntegerEnv(
      'JINA_TOOLS_RETRY_DELAY_MS',
      DEFAULT_RETRY_DELAY_MS,
      50,
      30_000
    );
    this.timeoutMs = this.readIntegerEnv('JINA_TOOLS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 120_000);
  }

  async executeTool(input: ExecuteJinaToolInput): Promise<ToolResult> {
    this.assertConfigured(input.toolName);
    const payload = this.sanitizePayload(input.payload);

    let request: RequestOptions;
    switch (input.toolName) {
      case 'reader':
        request = this.buildReaderRequest(payload);
        break;
      case 'search':
        request = this.buildSearchRequest(payload);
        break;
      case 'embeddings':
        request = this.buildEmbeddingsRequest(payload);
        break;
      case 'rerank':
        request = this.buildApiPostRequest('/rerank', payload, 'rerank');
        break;
      case 'classify':
        request = this.buildApiPostRequest('/classify', payload, 'classify');
        break;
      case 'segment':
        request = this.buildApiPostRequest('/segment', payload, 'segment');
        break;
      case 'deepsearch':
        request = this.buildDeepSearchRequest(payload);
        break;
      default:
        throw new JinaToolsServiceError(
          `Unsupported Jina tool operation: ${String(input.toolName)}`,
          400,
          'bad_request'
        );
    }

    const response = await this.requestWithRetry(input.toolName, request);
    const contentType = response.headers.get('content-type') || '';
    const output = await this.serializeResponseBody(response, contentType);

    return {
      tool_call_id: input.toolCallId,
      success: true,
      output,
      metadata: {
        tool_name: `jina_${input.toolName}`,
        upstream_status: response.status,
        upstream_content_type: contentType,
        upstream_url: request.url,
      },
    };
  }

  private buildReaderRequest(payload: Record<string, unknown>): RequestOptions {
    const targetUrl = this.requiredString(payload.url, 'url');
    this.assertHttpUrl(targetUrl, 'url');
    const normalizedTarget = targetUrl.replace(/^\/+/, '');
    return {
      method: 'GET',
      url: this.joinUrl(this.readerBaseUrl, normalizedTarget),
    };
  }

  private buildSearchRequest(payload: Record<string, unknown>): RequestOptions {
    const query = this.requiredString(payload.query, 'query');
    const params = new URLSearchParams();
    params.set('q', query);

    for (const [key, value] of Object.entries(payload)) {
      if (key === 'query' || key === 'working_directory' || value === undefined || value === null) {
        continue;
      }

      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params.set(key, String(value));
      }
    }

    const encoded = params.toString();
    return {
      method: 'GET',
      url: encoded
        ? `${this.searchBaseUrl.replace(/\/+$/, '')}/?${encoded}`
        : `${this.searchBaseUrl.replace(/\/+$/, '')}/`,
    };
  }

  private buildEmbeddingsRequest(payload: Record<string, unknown>): RequestOptions {
    if (!('input' in payload)) {
      throw new JinaToolsServiceError(
        'Jina embeddings requires `input` in the request body',
        400,
        'bad_request'
      );
    }
    return this.buildApiPostRequest('/embeddings', payload, 'embeddings');
  }

  private buildDeepSearchRequest(payload: Record<string, unknown>): RequestOptions {
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      throw new JinaToolsServiceError(
        'Jina deepsearch requires `messages` as a non-empty array',
        400,
        'bad_request'
      );
    }

    const body = { ...payload };
    if (typeof body.model !== 'string' || body.model.trim().length === 0) {
      body.model = 'jina-deepsearch-v1';
    }

    return {
      method: 'POST',
      url: this.joinUrl(this.deepSearchBaseUrl, '/chat/completions'),
      body,
    };
  }

  private buildApiPostRequest(
    path: string,
    payload: Record<string, unknown>,
    toolName: JinaToolName
  ): RequestOptions {
    if (Object.keys(payload).length === 0) {
      throw new JinaToolsServiceError(
        `Jina ${toolName} requires a JSON request body`,
        400,
        'bad_request'
      );
    }

    return {
      method: 'POST',
      url: this.joinUrl(this.apiBaseUrl, path),
      body: payload,
    };
  }

  private async requestWithRetry(toolName: JinaToolName, request: RequestOptions): Promise<Response> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: this.buildHeaders(request.method),
          body: request.method === 'POST' && request.body ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429 && attempt <= this.maxRetries) {
          const waitMs = this.resolveRetryDelayMs(response.headers.get('retry-after'), attempt);
          this.log.warn(
            { tool: toolName, attempt, waitMs, status: response.status },
            'Jina tool request rate-limited, retrying'
          );
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const body = await this.safeReadText(response);
          throw this.normalizeUpstreamError(toolName, response.status, body, request.url);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof JinaToolsServiceError) {
          throw error;
        }
        if (attempt > this.maxRetries) {
          break;
        }

        const waitMs = this.retryDelayMs * attempt;
        await this.sleep(waitMs);
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new JinaToolsServiceError(
      `Jina tool request failed: ${message}`,
      502,
      'request_failed'
    );
  }

  private normalizeUpstreamError(
    toolName: JinaToolName,
    statusCode: number,
    upstreamBody: string,
    upstreamUrl: string
  ): JinaToolsServiceError {
    const normalizedBody = upstreamBody.trim();
    const excerpt = normalizedBody.length > 600 ? `${normalizedBody.slice(0, 600)}...` : normalizedBody;
    const code = this.statusToCode(statusCode);
    const message = excerpt
      ? `Jina ${toolName} failed with HTTP ${statusCode}: ${excerpt}`
      : `Jina ${toolName} failed with HTTP ${statusCode}`;

    return new JinaToolsServiceError(message, statusCode, code, {
      upstream_status: statusCode,
      upstream_url: upstreamUrl,
      upstream_body: excerpt,
    });
  }

  private statusToCode(statusCode: number): NormalizedErrorCode {
    if (statusCode === 400 || statusCode === 422) return 'bad_request';
    if (statusCode === 401) return 'unauthorized';
    if (statusCode === 403) return 'forbidden';
    if (statusCode === 404) return 'not_found';
    if (statusCode === 429) return 'rate_limited';
    if (statusCode >= 500) return 'upstream_error';
    return 'request_failed';
  }

  private buildHeaders(method: 'GET' | 'POST'): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async serializeResponseBody(response: Response, contentType: string): Promise<string> {
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = (await response.json()) as unknown;
      return JSON.stringify(payload);
    }
    return await response.text();
  }

  private resolveRetryDelayMs(retryAfterHeader: string | null, attempt: number): number {
    if (retryAfterHeader && retryAfterHeader.trim().length > 0) {
      const asSeconds = Number(retryAfterHeader);
      if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.round(asSeconds * 1000);
      }
      const asDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(asDate)) {
        return Math.max(0, asDate - Date.now());
      }
    }

    return Math.min(this.retryDelayMs * 2 ** Math.max(0, attempt - 1), 30_000);
  }

  private joinUrl(baseUrl: string, pathOrSuffix: string): string {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const normalizedPath = pathOrSuffix.replace(/^\/+/, '');
    return `${normalizedBase}/${normalizedPath}`;
  }

  /**
   * Ensures `value` is an absolute http(s) URL. This is a defense against SSRF:
   * callers must never be able to redirect our outbound request to a
   * non-http(s) scheme (e.g. `file:`), and combined with `joinUrl` no longer
   * special-casing absolute URLs, the request host is always pinned to our
   * configured base URL (e.g. `readerBaseUrl`) rather than attacker input.
   */
  private assertHttpUrl(value: string, fieldName: string): void {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new JinaToolsServiceError(
        `Jina tool field \`${fieldName}\` must be an absolute http(s) URL`,
        400,
        'bad_request'
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new JinaToolsServiceError(
        `Jina tool field \`${fieldName}\` must be an absolute http(s) URL`,
        400,
        'bad_request'
      );
    }
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new JinaToolsServiceError(
        `Jina tool requires a non-empty string field: ${fieldName}`,
        400,
        'bad_request'
      );
    }
    return value.trim();
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...payload };
    delete sanitized.working_directory;
    return sanitized;
  }

  private assertConfigured(toolName: JinaToolName): void {
    if (this.apiKey.trim().length > 0) {
      return;
    }
    throw new JinaToolsServiceError(
      `Jina tool ${toolName} is unavailable because JINA_API_KEY is not configured`,
      401,
      'unauthorized'
    );
  }

  private readIntegerEnv(
    envVar: string,
    fallback: number,
    min: number,
    max: number
  ): number {
    const raw = process.env[envVar];
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

