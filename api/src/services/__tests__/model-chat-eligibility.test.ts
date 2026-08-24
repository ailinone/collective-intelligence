// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { isChatEligibleModel } from '../model-catalog-service';

/**
 * Chat-eligibility predicate (extracted from getChatEligibleModels for
 * testability). Regression guard for the 2026-08-17 production incident:
 * cost-cascade picked Groq's `llama-prompt-guard-2-22m` (a prompt
 * classification endpoint tagged 'chat' by the catalog) as a synthesis rung
 * and burned a ladder slot on guaranteed HTTP 400s.
 */
const base = {
  id: 'some-model',
  name: 'Some Model',
  provider: 'openai',
  capabilities: ['chat', 'streaming'],
};

describe('isChatEligibleModel', () => {
  it('accepts a regular chat model', () => {
    expect(isChatEligibleModel(base, new Set())).toBe(true);
  });

  it('excludes prompt-guard classifier models (chat wire format, not synthesis)', () => {
    expect(isChatEligibleModel({ ...base, id: 'meta-llama/llama-prompt-guard-2-22m' }, new Set())).toBe(false);
    expect(isChatEligibleModel({ ...base, id: 'llama-prompt-guard-2-8b' }, new Set())).toBe(false);
    expect(isChatEligibleModel({ ...base, id: 'my-prompt-guard-v2' }, new Set())).toBe(false);
  });

  it('excludes llama-guard safety models', () => {
    expect(isChatEligibleModel({ ...base, id: 'meta-llama/llama-guard-3-8b' }, new Set())).toBe(false);
  });

  it('does not exclude models that merely contain "guard" as a substring of a larger word', () => {
    // e.g. a hypothetical chat model named "bodyguard-7b" IS excluded by
    // `guardian|^guard-`? No — "bodyguard" matches none of the anchors.
    expect(isChatEligibleModel({ ...base, id: 'bodyguard-7b' }, new Set())).toBe(true);
  });

  it('still excludes embeddings-only and self-hosted models', () => {
    expect(isChatEligibleModel({ ...base, capabilities: ['embeddings'] }, new Set())).toBe(false);
    expect(isChatEligibleModel({ ...base, provider: 'ollama' }, new Set())).toBe(false);
    expect(isChatEligibleModel({ ...base, provider: 'ollama' }, new Set(['some-model']))).toBe(true);
  });
});
