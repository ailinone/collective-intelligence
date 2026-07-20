// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  EXPERIMENT_SUITE,
  getCodeVerifiedTaskIndices,
  CODE_VERIFIED_TASK_TYPE,
  getToolCallingTaskIndices,
  TOOL_CALLING_TASK_TYPE,
} from '../experiment-suite';
import { EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS } from '../experiment-tool-catalog';
import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';

describe('real-capability task coverage (2026-07-12)', () => {
  it('CODE-VERIFIED: 5 executed tasks carry a language/functionName/tests spec (no answerCheck)', () => {
    const code = EXPERIMENT_SUITE.filter((t) => t.taskType === CODE_VERIFIED_TASK_TYPE);
    expect(code).toHaveLength(5);
    expect(getCodeVerifiedTaskIndices()).toEqual([156, 157, 158, 159, 160]);
    for (const t of code) {
      expect(t.codeTest?.language).toBe('javascript');
      expect(typeof t.codeTest?.functionName).toBe('string');
      expect((t.codeTest?.tests.length ?? 0)).toBeGreaterThanOrEqual(4);
      expect(t.answerCheck).toBeUndefined(); // graded by execution, not the pure checker
      expect(t.prompt).toMatch(/ONLY the function/i);
    }
  });

  it("CODE-VERIFIED: the hidden test vectors match a reference implementation (answers are correct)", () => {
    const refs: Record<string, (...a: never[]) => unknown> = {
      clamp: ((v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v))) as never,
      romanToInt: ((s: string) => {
        const m: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let t = 0;
        for (let i = 0; i < s.length; i++) t += (i + 1 < s.length && m[s[i]] < m[s[i + 1]]) ? -m[s[i]] : m[s[i]];
        return t;
      }) as never,
      isValidParens: ((s: string) => {
        const st: string[] = []; const p: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
        for (const c of s) { if ('([{'.includes(c)) st.push(c); else if (st.pop() !== p[c]) return false; }
        return st.length === 0;
      }) as never,
      longestCommonPrefix: ((a: string[]) => {
        if (!a.length) return ''; let pre = a[0];
        for (const s of a) while (!s.startsWith(pre)) pre = pre.slice(0, -1);
        return pre;
      }) as never,
      countPrimesBelow: ((n: number) => {
        let c = 0;
        for (let k = 2; k < n; k++) { let pr = true; for (let d = 2; d * d <= k; d++) if (k % d === 0) { pr = false; break; } if (pr) c++; }
        return c;
      }) as never,
    };
    for (const t of EXPERIMENT_SUITE.filter((x) => x.taskType === CODE_VERIFIED_TASK_TYPE)) {
      const fn = refs[t.codeTest!.functionName];
      for (const tc of t.codeTest!.tests) {
        expect(fn(...(tc.args as never[])), `${t.codeTest!.functionName}(${JSON.stringify(tc.args)})`).toEqual(tc.expected);
      }
    }
  });

  it('RESEARCH: closed-book multi-hop tasks (161-163) verify a synthesized FINAL', () => {
    const research = EXPERIMENT_SUITE.filter((t) => t.taskType === 'research-synthesis');
    expect(research.map((t) => t.index)).toEqual([161, 162, 163]);
    for (const t of research) {
      expect(t.prompt).toMatch(/ONLY these|Using ONLY/i); // sources embedded, closed-book
      expect(t.answerCheck).toBeDefined();
    }
    const c161 = resolveAnswerChecker(EXPERIMENT_SUITE.find((t) => t.index === 161)!.answerCheck as AnswerCheckSpec)!;
    expect(c161('108000000')).toBe(true);
    expect(c161('96000000')).toBe(false); // forgot the 2022 shrink
  });

  it('LONG-GENERATION: tasks (164-165) carry an objective minWords gate + explicit maxTokens', () => {
    const long = EXPERIMENT_SUITE.filter((t) => t.taskType === 'long-generation');
    expect(long.map((t) => t.index)).toEqual([164, 165]);
    for (const t of long) {
      expect((t.minWords ?? 0)).toBeGreaterThanOrEqual(500);
      expect((t.maxTokens ?? 0)).toBeGreaterThanOrEqual(4096); // headroom, not clipped
    }
  });

  it('TOOL-CALLING: tasks (166-169) ship — the answer is ONLY reachable by calling the tool', () => {
    // Follow-up CLOSED (2026-07-13): the server tool-loop is verified
    // (base-strategy.executeModelWithTools executes each tool_call via the
    // registry and feeds the result back — see tool-calling-loop-integration.test),
    // so the benchmark now ships. Each task offers a deterministic tool whose
    // FICTIONAL result cannot be known without calling it, and is graded
    // objectively (answerCheck on the post-loop FINAL, OR a matching tool_call).
    const withTools = EXPERIMENT_SUITE.filter((t) => t.tools && t.tools.length > 0);
    expect(withTools.map((t) => t.index)).toEqual([166, 167, 168, 169]);
    expect(getToolCallingTaskIndices()).toEqual([166, 167, 168, 169]);
    for (const t of withTools) {
      expect(t.taskType).toBe(TOOL_CALLING_TASK_TYPE);
      expect(t.toolChoice).toBe('auto'); // the model must DECIDE to call it
      expect(t.expectTool?.name, `task ${t.index} expectTool`).toBeTruthy();
      expect(t.answerCheck, `task ${t.index} answerCheck`).toBeDefined();
      expect(t.prompt).toMatch(/FINAL:/);
      // The offered tools must be the registered benchmark ones (executable by
      // the loop) — an unregistered tool could never produce the checked answer.
      for (const spec of t.tools!) {
        expect(
          EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS.some((r) => r.name === spec.function.name),
          `task ${t.index} offers unregistered tool ${spec.function.name}`,
        ).toBe(true);
      }
    }
  });
});
