// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * WandbAdapter — verifies the `wandb-project` header injection.
 *
 * W&B Inference speaks OpenAI-compat on every route, so we don't retest the
 * hub's chat/embeddings shape — we only assert that the adapter's one
 * substantive addition (the required `wandb-project` header) is composed
 * correctly, respects env-var changes at call time, and falls through with a
 * warn when absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WandbAdapter } from '../wandb-adapter';

function headersOf(adapter: WandbAdapter, includeJson = true): Record<string, string> {
  // Access the protected hook through a typed cast — we're testing the exact
  // header composition the hub layer will see.
  const protectedAccess = adapter as unknown as {
    buildRequestHeaders: (includeJsonContentType: boolean) => Record<string, string>;
  };
  return protectedAccess.buildRequestHeaders(includeJson);
}

function makeAdapter(overrides: {
  projectResolver?: () => string | undefined;
  apiKey?: string;
} = {}): WandbAdapter {
  return new WandbAdapter({
    name: 'wandb',
    enabled: true,
    apiKey: overrides.apiKey ?? 'wandb-key-xyz',
    baseUrl: 'https://api.inference.wandb.ai/v1',
    providerName: 'wandb',
    metadata: {
      authScheme: 'Bearer',
    },
    projectResolver: overrides.projectResolver,
  });
}

beforeEach(() => {
  WandbAdapter.resetWarnLatchForTests();
});
afterEach(() => {
  delete process.env.WANDB_PROJECT;
});

describe('WandbAdapter — header composition', () => {
  it('emits wandb-project header when env var is set', () => {
    process.env.WANDB_PROJECT = 'acme/prod-chat';
    const h = headersOf(makeAdapter());
    expect(h['wandb-project']).toBe('acme/prod-chat');
    expect(h['Authorization']).toBe('Bearer wandb-key-xyz');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('honors a custom projectResolver over the env var', () => {
    process.env.WANDB_PROJECT = 'unused';
    const h = headersOf(makeAdapter({ projectResolver: () => 'override/team-x' }));
    expect(h['wandb-project']).toBe('override/team-x');
  });

  it('omits the header when the resolver returns undefined', () => {
    const h = headersOf(makeAdapter({ projectResolver: () => undefined }));
    expect(h['wandb-project']).toBeUndefined();
    // Auth still present.
    expect(h['Authorization']).toBe('Bearer wandb-key-xyz');
  });

  it('treats empty and whitespace env var as absent', () => {
    process.env.WANDB_PROJECT = '   ';
    const h = headersOf(makeAdapter());
    expect(h['wandb-project']).toBeUndefined();
  });

  it('reads env var on every header build (hot-swap safe)', () => {
    process.env.WANDB_PROJECT = 'first';
    const adapter = makeAdapter();
    expect(headersOf(adapter)['wandb-project']).toBe('first');
    process.env.WANDB_PROJECT = 'second';
    expect(headersOf(adapter)['wandb-project']).toBe('second');
  });

  it('skips the Content-Type header when includeJson is false (preflight)', () => {
    process.env.WANDB_PROJECT = 'p';
    const h = headersOf(makeAdapter(), false);
    expect(h['Content-Type']).toBeUndefined();
    expect(h['wandb-project']).toBe('p');
  });
});
