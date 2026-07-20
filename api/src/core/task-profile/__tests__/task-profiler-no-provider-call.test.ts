// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-no-provider-call.test.ts — MVP 6A
 *
 * Installs a global fetch spy that THROWS. Asserts the profiler
 * NEVER calls fetch / DB / TEI / HNSW.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { profileTask } from '../task-profiler';

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('profileTask MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe('profileTask — no fetch in any path', () => {
  it('empty input does not call fetch', () => {
    profileTask({ requestId: 'r-1' });
    expect(fetchCalls).toBe(0);
  });

  it('rich input does not call fetch', () => {
    profileTask({
      requestId: 'r-1',
      text: 'analyze this legal contract step by step in JSON',
      approximateInputTokens: 50_000,
      attachments: [
        { kind: 'document', approximateTokens: 10_000 },
        { kind: 'image' },
      ],
      explicitPrivacyMode: 'local_required',
      explicitOutputFormat: 'json',
      explicitToolUse: 'required',
    });
    expect(fetchCalls).toBe(0);
  });

  it('1000 invocations stay fetch-free', () => {
    for (let i = 0; i < 1000; i += 1) {
      profileTask({ requestId: 'r-1', text: 'hi' });
    }
    expect(fetchCalls).toBe(0);
  });
});

describe('task-profile module-load safety', () => {
  it('importing task-profiler.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../task-profiler');
    expect(fetchCalls).toBe(0);
  });

  it('importing task-profile-types.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../task-profile-types');
    expect(fetchCalls).toBe(0);
  });

  it('importing task-profiler-policy.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../task-profiler-policy');
    expect(fetchCalls).toBe(0);
  });

  it('importing task-profile-trace.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../task-profile-trace');
    expect(fetchCalls).toBe(0);
  });

  it('importing task-profile-normalizer.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../task-profile-normalizer');
    expect(fetchCalls).toBe(0);
  });
});
