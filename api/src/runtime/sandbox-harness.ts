// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  SandboxTestCase,
  SandboxTestFailure,
  SandboxTestResult,
  SupportedLanguage,
} from './code-sandbox';

function escapeForSingleQuotedPython(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface SandboxInlineScript {
  runtime: 'python' | 'node';
  script: string;
}

export function buildInlineHarness(
  lang: SupportedLanguage,
  userCode: string,
  functionName: string,
  tests: SandboxTestCase[]
): SandboxInlineScript {
  if (lang === 'python') {
    const testsJson = escapeForSingleQuotedPython(JSON.stringify(tests));
    return {
      runtime: 'python',
      script: `
import json
${userCode}
tests = json.loads('${testsJson}')
results = []
for t in tests:
    try:
        received = ${functionName}(*t["args"])
        results.append({"ok": received == t["expected"], "received": received})
    except Exception as e:
        results.append({"ok": False, "error": str(e)})
print(json.dumps({"results": results}, ensure_ascii=False))
`.trim(),
    };
  }

  if (lang === 'javascript' || lang === 'typescript') {
    const testsJson = JSON.stringify(tests);
    return {
      runtime: 'node',
      script: `
const tests = ${testsJson};
${userCode}
const results = tests.map((t) => {
  try {
    const received = ${functionName}(...t.args);
    return { ok: received === t.expected, received };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
console.log(JSON.stringify({ results }));
`.trim(),
    };
  }

  throw new Error(`Inline harness not implemented for language: ${lang}`);
}

export function parseHarnessOutput(
  lang: SupportedLanguage,
  functionName: string,
  tests: SandboxTestCase[],
  stdout: string,
  stderr: string,
  backend: 'e2b' | 'daytona'
): SandboxTestResult {
  let parsed: { results?: Array<{ ok: boolean; received?: unknown; error?: string }> };
  try {
    parsed = JSON.parse(stdout) as { results?: Array<{ ok: boolean; received?: unknown; error?: string }> };
  } catch (error) {
    return {
      passed: false,
      details: {
        language: lang,
        functionName,
        passedCases: 0,
        totalCases: tests.length,
        failures: [
          {
            args: [],
            expected: null,
            error: `Invalid JSON in sandbox stdout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        stdout,
        stderr,
      },
      metadata: {
        backend,
        fallbackChain: [backend],
      },
    };
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const failures: SandboxTestFailure[] = [];
  let passedCases = 0;

  results.forEach((entry, index) => {
    if (entry.ok) {
      passedCases += 1;
      return;
    }
    failures.push({
      args: tests[index]?.args ?? [],
      expected: tests[index]?.expected,
      received: entry.received,
      error: entry.error,
    });
  });

  return {
    passed: failures.length === 0 && results.length === tests.length,
    details: {
      language: lang,
      functionName,
      passedCases,
      totalCases: tests.length,
      failures,
      stdout,
      stderr,
    },
    metadata: {
      backend,
      fallbackChain: [backend],
    },
  };
}
