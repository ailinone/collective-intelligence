// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: AzureOpenAIModelFetcher credential guard (2026-09-10
 * discovery audit).
 *
 * Reported bug: this fetcher (logger component tag `azure-openai-fetcher`,
 * a code path distinct from the `azure-openai-hub` discovery source in
 * central-model-discovery-service.ts) allegedly built the Azure OpenAI SDK
 * client without checking AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT
 * first, crashing with the SDK/URL constructor's "Invalid URL" instead of a
 * clean no-op — unlike `azure-openai-hub`, which already guards and logs at
 * `.info()`.
 *
 * Investigation found the crash-preventing guard already existed (added
 * 2026-02-16, hardened 2026-07-22) — getModels() never reaches the SDK
 * construction step when endpoint/apiKey are absent. What was NOT aligned
 * with the hub's convention: a genuinely-unconfigured provider (the common,
 * expected case) logged at `.warn()` instead of `.info()`, same level as an
 * actual misconfiguration (a mock/test-looking value present). This file
 * locks in both: (1) getModels() never throws regardless of what's missing,
 * confirming the crash cannot happen, and (2) the log-level split now
 * matches the hub's own convention.
 */
import { describe, expect, it, vi } from 'vitest';
import { AzureOpenAIModelFetcher } from '@/services/model-fetchers/azure-openai-model-fetcher';

type Internals = { log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } };

describe('AzureOpenAIModelFetcher — credential guard', () => {
  // tests/test-env.ts globally defaults process.env.AZURE_OPENAI_API_KEY to
  // 'test-azure-key' (so unrelated suites don't trip this fetcher's mock
  // guard). Passing an explicit empty string in config (not omitting the
  // field) beats that fallback: `config?.apiKey ?? process.env...` only
  // falls through to the env var on null/undefined, never on ''. This keeps
  // "genuinely absent" deterministic regardless of the global test fixture.
  it('never throws when both endpoint and apiKey are absent (regression: reported "Invalid URL" crash)', async () => {
    const fetcher = new AzureOpenAIModelFetcher({ endpoint: '', apiKey: '' });
    await expect(fetcher.getModels()).resolves.toEqual([]);
  });

  it('logs at .info() (not .warn()) when the endpoint is simply unconfigured — matches azure-openai-hub convention', async () => {
    const fetcher = new AzureOpenAIModelFetcher({ endpoint: '', apiKey: 'sk-real-looking-key' });
    const infoSpy = vi.spyOn((fetcher as unknown as Internals).log, 'info');
    const warnSpy = vi.spyOn((fetcher as unknown as Internals).log, 'warn');

    await expect(fetcher.getModels()).resolves.toEqual([]);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/endpoint not configured/i)
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs at .info() (not .warn()) when the API key is simply unconfigured', async () => {
    const fetcher = new AzureOpenAIModelFetcher({
      endpoint: 'https://real-resource.openai.azure.com',
      apiKey: '',
    });
    const infoSpy = vi.spyOn((fetcher as unknown as Internals).log, 'info');
    const warnSpy = vi.spyOn((fetcher as unknown as Internals).log, 'warn');

    await expect(fetcher.getModels()).resolves.toEqual([]);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/api key not configured/i));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still logs at .warn() when the endpoint looks like a mock value (real misconfiguration, not absence)', async () => {
    const fetcher = new AzureOpenAIModelFetcher({
      endpoint: 'https://mock-azure.example.com',
      apiKey: 'sk-real-looking-key',
    });
    const warnSpy = vi.spyOn((fetcher as unknown as Internals).log, 'warn');

    await expect(fetcher.getModels()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://mock-azure.example.com' }),
      expect.stringMatching(/mock/i)
    );
  });

  it('still logs at .warn() when the API key looks like a mock/test value (real misconfiguration, not absence)', async () => {
    const fetcher = new AzureOpenAIModelFetcher({
      endpoint: 'https://real-resource.openai.azure.com',
      apiKey: 'test-abc123',
    });
    const warnSpy = vi.spyOn((fetcher as unknown as Internals).log, 'warn');

    await expect(fetcher.getModels()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ keyPresent: true }),
      expect.stringMatching(/mock\/test/i)
    );
  });
});
