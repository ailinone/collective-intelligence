// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Judge prompts must embed the language-mirror directive (audit F-06):
 *   - ExperimentRunner.judgeResponse — system message of the pinned judge
 *   - calibrateJudge — user prompt of the calibration self-call
 *
 * The directive lets free-text verdict fields (issues, summary, reasoning)
 * follow the evaluated response's language while the JudgeVerdict JSON
 * structure stays canonical/English-keyed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { calibrateJudge } from '../judge-calibration';
import { LANGUAGE_MIRROR_DIRECTIVE } from '@/core/orchestration/prompts/language-directive';

const ORIGINAL_ENV = { ...process.env };
const bodies: string[] = [];

function mockJudgeFetch(respondModel: string): void {
  bodies.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(init?.body ?? '');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            model: respondModel,
            choices: [
              {
                message: {
                  content: JSON.stringify({ score: 0.5, issues: [], summary: 'ok', confidence: 0.9 }),
                },
              },
            ],
            usage: {},
          }),
      } as unknown as Response;
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('judge prompts — language mirror directive (F-06)', () => {
  it('calibrateJudge embeds LANGUAGE_MIRROR_DIRECTIVE in the judge prompt', async () => {
    mockJudgeFetch('test-judge');

    const report = await calibrateJudge({
      runs: 1,
      apiBase: 'http://judge.local',
      bearerToken: 't',
      judgeModel: 'test-judge',
    });

    expect(report).toBeDefined();
    expect(bodies.length).toBeGreaterThan(0);
    const first = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }> };
    const prompt = first.messages[0].content;
    expect(prompt).toContain(LANGUAGE_MIRROR_DIRECTIVE);
    expect(prompt).toContain('"score"'); // JudgeVerdict contract still present
  });

  it('experiment-runner judgeResponse embeds LANGUAGE_MIRROR_DIRECTIVE in the pinned judge system message', { timeout: 120_000 }, async () => {
    mockJudgeFetch('test/judge-1');
    vi.resetModules();
    delete process.env.JUDGE_MODE;
    process.env.EXPERIMENT_JUDGE_MODEL = 'test/judge-1';

    const mod = await import('../experiment-runner');
    const outcome = await mod.judgeResponse('a response to score', 'rubric: be good');

    expect(outcome).toBeDefined();
    expect(bodies.length).toBeGreaterThan(0);
    const body = JSON.parse(bodies[0]) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain(LANGUAGE_MIRROR_DIRECTIVE);
    expect(system!.content).toContain('strict scoring machine');
  });
});
