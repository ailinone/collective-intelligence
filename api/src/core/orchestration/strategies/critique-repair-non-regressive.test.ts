// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CritiqueRepairStrategy — the repair step must be NON-REGRESSIVE.
 *
 * Context: the HumanEval run (oracle-free code_execution axis) showed repairs
 * causing a −0.194 absolute quality drop — the old repair-accept block committed
 * ANY non-empty repair (blind overwrite), so a repair that renamed the primary
 * function (count_nums→count_numss) or merely LOOKED better to the subjective
 * critic replaced correct code. The fix seeds the tracked best with the primary
 * generation and gates the repair-accept: a repair is committed only if it
 * (a) keeps the primary's top-level function name AND (b) either flips an
 * answerVerifier from fail→pass, or (oracle-free) strictly beats the pre-repair
 * re-score by REPAIR_IMPROVEMENT_EPSILON.
 *
 * These tests isolate the loop's accept/reject decision by scripting the
 * primary generation, the critic's scores, and the repairer's output — the
 * model/critic calls are overridden (sibling pattern: subclass + override the
 * protected exec seams, as in single-model-strategy-streaming.test.ts). No
 * provider, adapter, or network is touched.
 */
import { describe, it, expect } from 'vitest';
import { CritiqueRepairStrategy, extractPrimaryDefName } from './critique-repair-strategy';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  ModelRole,
  OrchestrationContext,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

const genModel = { id: 'gen', name: 'gen-model', provider: 'p1' } as Model;
const criticModel = { id: 'crit', name: 'critic-model', provider: 'p2' } as Model;

const stubAdapter = { getName: () => 'stub' } as unknown as ProviderAdapter;

function makeExec(role: ModelRole, content: string): ModelExecution {
  const response = {
    id: `resp-${role}`,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  } as unknown as ChatResponse;
  return {
    modelId: role,
    modelName: role,
    role,
    request: {} as ChatRequest,
    response,
    cost: 0,
    durationMs: 0,
    success: true,
  };
}

const criticJson = (score: number): string =>
  JSON.stringify({
    quality_score: score,
    // Always surface a CRITICAL issue so the loop proceeds to the repair step
    // when the score is below target (a >=target score short-circuits first).
    issues: [
      { severity: 'CRITICAL', location: 'body', description: 'issue', suggested_fix: 'fix' },
    ],
  });

/** Pull the string the critic is scoring out of a critique request. */
function evaluatedContent(request: ChatRequest): string {
  const user = request.messages.find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  return text.split('RESPONSE TO EVALUATE:\n')[1] ?? '';
}

/** Pull the current (pre-repair) content out of a repair request. */
function currentContent(request: ChatRequest): string {
  const user = request.messages.find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  return (text.split('CURRENT RESPONSE:\n')[1] ?? '').split('\n\nISSUES TO FIX:')[0];
}

interface Script {
  primary: string;
  /** Critic score for a given evaluated candidate. */
  score: (evaluated: string) => number;
  /** Repairer output for a given pre-repair candidate. */
  repair: (current: string) => string;
}

/**
 * Scripts the three model seams the loop uses: initial generation
 * (selfCritiqueLoop), critic scoring + repair re-score (executeModelWithRetry
 * role='critic'), and the repair (executeModelWithRetry role='repairer').
 */
class ScriptedStrategy extends CritiqueRepairStrategy {
  constructor(private readonly script: Script) {
    super();
  }

  protected getEligibleModels(_context: OrchestrationContext): Model[] {
    return [genModel, criticModel];
  }

  protected getAdapterForModel(
    _model: Model,
    _context: OrchestrationContext
  ): Promise<ProviderAdapter | null> {
    return Promise.resolve(stubAdapter);
  }

  protected selfCritiqueLoop(): Promise<ModelExecution> {
    return Promise.resolve(makeExec('primary', this.script.primary));
  }

  protected executeModelWithRetry(
    _adapter: ProviderAdapter,
    _model: Model,
    request: ChatRequest,
    role: ModelRole
  ): Promise<ModelExecution> {
    if (role === 'critic') {
      return Promise.resolve(
        makeExec('critic', criticJson(this.script.score(evaluatedContent(request))))
      );
    }
    if (role === 'repairer') {
      return Promise.resolve(makeExec('repairer', this.script.repair(currentContent(request))));
    }
    return Promise.resolve(makeExec(role, 'unused'));
  }
}

const request = { messages: [{ role: 'user', content: 'Solve the task' }] } as ChatRequest;
const context = {
  requestId: 'r1',
  models: [genModel, criticModel],
  taskType: 'code-generation',
} as unknown as OrchestrationContext;

const finalContent = (r: {
  finalResponse?: { choices?: Array<{ message?: { content?: unknown } }> };
}): string => String(r.finalResponse?.choices?.[0]?.message?.content ?? '');

describe('CritiqueRepairStrategy — non-regressive repair gate', () => {
  it('(i) rejects a repair that renames the primary function; keeps the primary output', async () => {
    const primary = 'def count_nums(arr):\n    return len([x for x in arr if x > 0])';
    const strategy = new ScriptedStrategy({
      primary,
      // Sub-target score with a CRITICAL issue → repair is attempted.
      score: () => 0.6,
      // The regression: repairer renames count_nums → count_numss.
      repair: () => 'def count_numss(arr):\n    return len([x for x in arr if x > 0])',
    });

    const r = await strategy.execute(request, context);

    // The rename is rejected by the structural guard → primary is preserved.
    expect(finalContent(r)).toBe(primary);
    expect(finalContent(r)).toContain('def count_nums(');
    expect(finalContent(r)).not.toContain('count_numss');
  });

  it('(ii) discards a repair that does not improve the re-score (oracle-free)', async () => {
    const primary = 'def solve(x):\n    return x + 1';
    const tweaked = 'def solve(x):\n    return x + 1  # tweaked';
    const strategy = new ScriptedStrategy({
      primary,
      // Pre-repair 0.60; repaired only 0.61 — below 0.60 + epsilon(0.02) = 0.62.
      score: (evaluated) => (evaluated.includes('# tweaked') ? 0.61 : 0.6),
      repair: () => tweaked,
    });

    const r = await strategy.execute(request, context);

    // Same function name (passes structural guard) but insufficient improvement
    // → the repair is discarded and the primary kept.
    expect(finalContent(r)).toBe(primary);
    expect(finalContent(r)).not.toContain('# tweaked');
    expect(r.qualityScore).toBeCloseTo(0.6);
  });

  it('(iii) accepts a repair that genuinely improves the re-score', async () => {
    const primary = 'def add(a, b):\n    return a - b  # bug';
    const fixed = 'def add(a, b):\n    return a + b';
    const strategy = new ScriptedStrategy({
      primary,
      // Pre-repair 0.60; repaired 0.90 — clears 0.60 + epsilon and the target.
      score: (evaluated) => (evaluated.includes('a + b') ? 0.9 : 0.6),
      repair: () => fixed,
    });

    const r = await strategy.execute(request, context);

    // Same name + strict improvement → the repair is committed.
    expect(finalContent(r)).toBe(fixed);
    expect(finalContent(r)).toContain('a + b');
    expect(finalContent(r)).not.toContain('a - b');
    expect(r.qualityScore).toBeCloseTo(0.9);
  });

  it('(iv) oracle path: keeps a verifier-passing primary rather than an unverified repair', async () => {
    const primary = 'def parity(n):\n    return n % 2 == 0';
    const broken = 'def parity(n):\n    return n % 2 == 1  # regressed';
    const strategy = new ScriptedStrategy({
      primary,
      // The subjective critic PREFERS the broken repair (0.9 > 0.6) — exactly the
      // trap that fooled the old winner-tracking. The verifier must override it.
      score: (evaluated) => (evaluated.includes('regressed') ? 0.9 : 0.6),
      repair: () => broken,
    });

    // Verifier: only the correct primary passes; the regressed repair fails.
    const verifiedContext = {
      ...context,
      answerVerifier: (answer: string) => answer.includes('n % 2 == 0'),
      answerVerifierScope: 'full' as const,
    } as unknown as OrchestrationContext;

    const r = await strategy.execute(request, verifiedContext);

    expect(finalContent(r)).toBe(primary);
    expect(finalContent(r)).not.toContain('regressed');
  });
});

describe('extractPrimaryDefName', () => {
  it('extracts the first top-level Python def name', () => {
    expect(extractPrimaryDefName('def count_nums(arr):\n    return 0')).toBe('count_nums');
  });

  it('ignores indented (nested) helpers and keys on the top-level def', () => {
    const code = 'def outer(x):\n    def helper(y):\n        return y\n    return helper(x)';
    expect(extractPrimaryDefName(code)).toBe('outer');
  });

  it('returns null for prose / non-code (structural guard then skipped)', () => {
    expect(extractPrimaryDefName('Here is a paragraph of explanation with no code.')).toBeNull();
  });

  it('handles common top-level JS forms as a best-effort', () => {
    expect(extractPrimaryDefName('function foo(a) { return a; }')).toBe('foo');
    expect(extractPrimaryDefName('const bar = (a) => a;')).toBe('bar');
  });
});
