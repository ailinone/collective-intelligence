// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Credential-guard regression tests — 2026-09-08 incident, Problem 1.
 *
 * Real production evidence: discovery failed for openai-native, and the
 * IDENTICAL error also appeared for deepseek-native and xai-native:
 *
 *   "Missing credentials. Please pass an `apiKey`, `workloadIdentity`,
 *    `adminAPIKey`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY`
 *    environment variable."
 *
 * Root cause (traced to openai@7.5.0's own client.ts constructor): all
 * three fetchers construct the raw `openai` SDK client eagerly with
 * `apiKey: process.env.<X>_API_KEY || ''`. When the env var is empty, an
 * explicit `''` is passed (not `undefined`), which bypasses the SDK's own
 * `OPENAI_API_KEY` env fallback and trips its constructor's credential
 * validation, throwing synchronously — BEFORE each fetcher's own
 * getModels() ever runs its already-existing graceful mock/missing-key
 * check. DeepSeekModelFetcher and XAIModelFetcher legitimately reuse this
 * SDK class as a thin OpenAI-COMPATIBLE HTTP client (DeepSeek/xAI expose
 * OpenAI-shaped APIs) — the SDK's own error text is generic and
 * OpenAI-branded regardless of which provider's credential is actually
 * missing, which is why the identical OpenAI-specific message appeared for
 * two non-OpenAI providers.
 *
 * The fix: construct the SDK client lazily, only once the key looks usable,
 * so a missing/mock/test key always surfaces through each fetcher's own
 * correctly-branded getModels() log line and an empty array — never a
 * synchronous, wrong-provider-branded exception. This also means a
 * discovery source that would previously have logged an "error" for this
 * case now cleanly reports `modelsDiscovered: 0, errors: []`, the same
 * shape anthropic-native/google-native/aws-bedrock-hub already produced —
 * see central-model-discovery-unhealthy-providers.test.ts for the
 * consuming safety net.
 */
import { describe, expect, it } from 'vitest';
import { OpenAIModelFetcher } from '@/services/model-fetchers/openai-model-fetcher';
import { DeepSeekModelFetcher } from '@/services/model-fetchers/deepseek-model-fetcher';
import { XAIModelFetcher } from '@/services/model-fetchers/xai-model-fetcher';

type FetcherCtor = new (apiKey: string) => { getModels: () => Promise<unknown[]> };

const FETCHERS: Array<{ name: string; Ctor: FetcherCtor }> = [
  { name: 'OpenAIModelFetcher', Ctor: OpenAIModelFetcher as unknown as FetcherCtor },
  { name: 'DeepSeekModelFetcher', Ctor: DeepSeekModelFetcher as unknown as FetcherCtor },
  { name: 'XAIModelFetcher', Ctor: XAIModelFetcher as unknown as FetcherCtor },
];

describe.each(FETCHERS)('$name — credential guard (empty/mock apiKey)', ({ Ctor }) => {
  it('constructing with an empty apiKey does not throw (regression: the openai SDK previously threw synchronously here)', () => {
    expect(() => new Ctor('')).not.toThrow();
  });

  it('getModels() resolves to [] for an empty apiKey instead of rejecting', async () => {
    const fetcher = new Ctor('');
    await expect(fetcher.getModels()).resolves.toEqual([]);
  });

  it('constructing with a mock-looking apiKey does not throw, and getModels() resolves to []', async () => {
    const fetcher = new Ctor('mock-key-123');
    expect(() => fetcher).not.toThrow();
    await expect(fetcher.getModels()).resolves.toEqual([]);
  });

  it('constructing with a test-looking apiKey does not throw, and getModels() resolves to []', async () => {
    const fetcher = new Ctor('sk-test-abc123');
    await expect(fetcher.getModels()).resolves.toEqual([]);
  });
});

describe('credential guard — client construction only skipped for unusable keys', () => {
  it('OpenAIModelFetcher constructs a real client for a usable-looking key (does not neuter normal operation)', () => {
    const fetcher = new OpenAIModelFetcher('sk-genuinely-real-looking-key-789');
    expect((fetcher as unknown as { client: unknown }).client).not.toBeNull();
  });

  it('DeepSeekModelFetcher constructs a real client for a usable-looking key', () => {
    const fetcher = new DeepSeekModelFetcher('ds-genuinely-real-looking-key-789');
    expect((fetcher as unknown as { client: unknown }).client).not.toBeNull();
  });

  it('XAIModelFetcher constructs a real client for a usable-looking key', () => {
    const fetcher = new XAIModelFetcher('xai-genuinely-real-looking-key-789');
    expect((fetcher as unknown as { client: unknown }).client).not.toBeNull();
  });
});
