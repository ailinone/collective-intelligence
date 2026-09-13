// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for a real production incident (2026-09): a chat request
 * whose text merely contained the word "Execute" ("Execute este codigo
 * Python em sandbox e me mostre o resultado real: print(sum(range(1, 101)))")
 * got a single garbage letter ("y") as its entire response instead of the
 * correct answer (5050).
 *
 * Root-causing that incident surfaced a separate, pre-existing catalog data
 * bug that made it worse: three model fetchers (Alibaba, DeepSeek, Mistral)
 * tagged any model whose id merely contains "coder"/"code"/"codestral" with
 * `code_interpreter` — a capability whose canonical meaning
 * (capability-ontology.ts) is a REAL, provider-declared server-side sandbox/
 * execution tool, the same tag `CodeExecutionService.searchModels()` filters
 * on expecting genuine execution support. No Alibaba/DeepSeek/Mistral model
 * declares any such provider parameter (model-capability-inference.ts's
 * `code_interpreter`/`sandbox` declared-parameter rule is the only
 * legitimate source, and grepping providers.catalog.ts confirms zero
 * providers declare it) — these fetchers were purely pattern-matching the
 * model ID and mislabeling "this model is good at writing code" (the
 * correct tag for that is `code_generation`) as "this model can execute
 * code for you".
 *
 * That mislabeling was harmless while `code_interpreter`/`code_execution`
 * was never hard-filtered (nothing enforced the tag), but is exactly the
 * kind of catalog corruption that becomes dangerous the moment any caller
 * hard-requires the capability — it silently narrows selection to these
 * name-tagged coder models instead of emptying the pool or picking a
 * genuinely capable general model. Fixed by using `code_generation` instead,
 * the tag that already means what these fetchers actually intended.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@/types';
import { AlibabaModelFetcher } from '@/services/model-fetchers/alibaba-model-fetcher';
import { DeepSeekModelFetcher } from '@/services/model-fetchers/deepseek-model-fetcher';
import { MistralModelFetcher } from '@/services/model-fetchers/mistral-model-fetcher';

describe('coder-named models are tagged code_generation, NOT code_interpreter', () => {
  it('AlibabaModelFetcher: qwen coder models get code_generation, never code_interpreter', () => {
    const fetcher = new AlibabaModelFetcher('test-key');
    const caps: ModelCapability[] = fetcher['extractCapabilitiesFromAlibaba']({
      id: 'qwen2.5-coder-32b-instruct',
    } as never);
    expect(caps).toContain('code_generation');
    expect(caps).not.toContain('code_interpreter');
  });

  it('DeepSeekModelFetcher: coder models get code_generation, never code_interpreter', () => {
    const fetcher = new DeepSeekModelFetcher('test-key');
    const caps: ModelCapability[] = fetcher['extractCapabilitiesFromDeepSeek']({
      id: 'deepseek-coder',
    } as never);
    expect(caps).toContain('code_generation');
    expect(caps).not.toContain('code_interpreter');
  });

  it('MistralModelFetcher: codestral models get code_generation, never code_interpreter', () => {
    const fetcher = new MistralModelFetcher('test-key');
    const caps: ModelCapability[] = fetcher['extractCapabilitiesFromMistral']({
      id: 'codestral-2508',
    });
    expect(caps).toContain('code_generation');
    expect(caps).not.toContain('code_interpreter');
  });

  it('MistralModelFetcher: "large" models also get code_generation (not code_interpreter) from the reasoning branch', () => {
    const fetcher = new MistralModelFetcher('test-key');
    const caps: ModelCapability[] = fetcher['extractCapabilitiesFromMistral']({
      id: 'mistral-large-2411',
    });
    expect(caps).toContain('code_generation');
    expect(caps).not.toContain('code_interpreter');
  });
});
