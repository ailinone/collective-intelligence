// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  CodeSandbox,
  SupportedLanguage,
  SandboxTestCase,
  SandboxRunOptions,
  SandboxTestResult,
  SandboxTestFailure,
} from './code-sandbox';

import { promises as fs } from 'fs';

import { mkdtempSync } from 'fs';

import { tmpdir } from 'os';

import { join } from 'path';

import { spawn } from 'child_process';
import { getErrorMessage } from '@/utils/type-guards';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'code-sandbox-'));
}

async function writeFile(dir: string, file: string, content: string) {
  await fs.writeFile(join(dir, file), content, 'utf8');
}

function runProcess(
  cmd: string,

  args: string[],

  cwd: string,

  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';

    let stderr = '';

    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;

        child.kill('SIGKILL');

        reject(new Error(`Process timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += typeof data === 'string' ? data : data.toString();
    });

    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += typeof data === 'string' ? data : data.toString();
    });

    child.on('error', (err) => {
      if (finished) return;

      finished = true;

      clearTimeout(timer);

      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;

      finished = true;

      clearTimeout(timer);

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// Helpers para gerar harness de cada linguagem

function buildJsHarness(functionName: string): string {
  return `

const fs = require('fs');

${'// user code will be concatenated above this comment'}

const data = JSON.parse(fs.readFileSync('tests.json', 'utf8'));

const { tests } = data;

function run() {

  const results = [];

  for (const t of tests) {

    try {

      const result = ${functionName}(...t.args);

      results.push({ ok: result === t.expected, received: result });

    } catch (err) {

      results.push({ ok: false, error: String(err) });

    }

  }

  console.log(JSON.stringify({ results }));

}

run();

`;
}

function buildPythonHarness(functionName: string): string {
  return `

import json

# user code will be concatenated above this comment

def _run():

    with open('tests.json', 'r', encoding='utf-8') as f:

        data = json.load(f)

    tests = data['tests']

    results = []

    for t in tests:

        try:

            result = ${functionName}(*t['args'])

            results.append({ "ok": result == t['expected'], "received": result })

        except Exception as e:

            results.append({ "ok": False, "error": str(e) })

    print(json.dumps({ "results": results }, ensure_ascii=False))

if __name__ == "__main__":

    _run()

`;
}

function buildGoHarness(functionName: string): string {
  return (
    `

package main

import (

  "encoding/json"

  "fmt"

  "os"

)

type TestCase struct {

  Args     []interface{}   ` +
    '`json:"args"`' +
    `

  Expected interface{}     ` +
    '`json:"expected"`' +
    `

}

type Input struct {

  Tests []TestCase ` +
    '`json:"tests"`' +
    `

}

type Result struct {

  Ok       bool        ` +
    '`json:"ok"`' +
    `

  Received interface{} ` +
    '`json:"received,omitempty"`' +
    `

  Error    string      ` +
    '`json:"error,omitempty"`' +
    `

}

type Output struct {

  Results []Result ` +
    '`json:"results"`' +
    `

}

// user code will be concatenated above this comment

func main() {

  f, err := os.ReadFile("tests.json")

  if err != nil {

    panic(err)

  }

  var input Input

  if err := json.Unmarshal(f, &input); err != nil {

    panic(err)

  }

  results := make([]Result, 0, len(input.Tests))

  for _, t := range input.Tests {

    ok := false

    var received interface{} = nil

    var errStr string = ""

    func() {

      defer func() {

        if r := recover(); r != nil {

          errStr = fmt.Sprint(r)

        }

      }()

      if len(t.Args) == 2 {

        a := int(t.Args[0].(float64))

        b := int(t.Args[1].(float64))

        r := ${functionName}(a, b)

        received = r

        ok = (interface{}(r) == t.Expected)

      } else {

        errStr = "unsupported args length"

      }

    }()

    results = append(results, Result{

      Ok:       ok,

      Received: received,

      Error:    errStr,

    })

  }

  out := Output{Results: results}

  enc, _ := json.Marshal(out)

  fmt.Println(string(enc))

}

`
  );
}

// Fábrica de harness por linguagem

function getHarnessForLanguage(lang: SupportedLanguage, functionName: string): string {
  switch (lang) {
    case 'javascript':
    // falls through
    case 'typescript':
      return buildJsHarness(functionName);

    case 'python':
      return buildPythonHarness(functionName);

    case 'go':
      return buildGoHarness(functionName);

    default:
      throw new Error(`Language not supported in harness generator: ${lang}`);
  }
}

// Implementação do CodeSandbox

export class LocalProcessSandbox implements CodeSandbox {
  async testFunction(
    lang: SupportedLanguage,

    userCode: string,

    functionName: string,

    tests: SandboxTestCase[],

    options: SandboxRunOptions = {}
  ): Promise<SandboxTestResult> {
    const timeoutMs = options.timeoutMs ?? 10_000;

    const dir = createTempDir();

    // 1) escrever tests.json

    await writeFile(dir, 'tests.json', JSON.stringify({ tests }, null, 2));

    // 2) gerar arquivo de código + harness conforme linguagem

    let mainFile: string;

    let cmd: string;

    let args: string[];

    const harness = getHarnessForLanguage(lang, functionName);

    switch (lang) {
      case 'javascript': {
        mainFile = 'main.js';

        const content = `${userCode}\n\n${harness}`;

        await writeFile(dir, mainFile, content);

        cmd = 'node';

        args = [mainFile];

        break;
      }

      case 'typescript': {
        mainFile = 'main.ts';

        const content = `${userCode}\n\n${harness}`;

        await writeFile(dir, mainFile, content);

        cmd = 'npx';

        args = ['ts-node', mainFile];

        break;
      }

      case 'python': {
        mainFile = 'main.py';

        const content = `${userCode}\n\n${harness}`;

        await writeFile(dir, mainFile, content);

        cmd = 'python';

        args = [mainFile];

        break;
      }

      case 'go': {
        mainFile = 'main.go';

        const content = `${userCode}\n\n${harness}`;

        await writeFile(dir, mainFile, content);

        cmd = 'go';

        args = ['run', mainFile];

        break;
      }

      case 'java':
      // falls through
      case 'csharp': {
        throw new Error(`Languages not yet implemented in LocalProcessSandbox: ${lang}`);
      }

      default:
        throw new Error(`Unsupported language: ${lang}`);
    }

    let stdout = '';

    let stderr = '';

    let exitCode: number | null = null;

    try {
      const result = await runProcess(cmd, args, dir, timeoutMs);

      stdout = result.stdout;

      stderr = result.stderr;

      exitCode = result.exitCode;
    } catch (err) {
      return {
        passed: false,

        details: {
          language: lang,

          functionName,

          passedCases: 0,

          totalCases: tests.length,

          failures: [{ args: [], expected: null, error: getErrorMessage(err) }],

          stdout,

          stderr,
        },
        metadata: {
          backend: 'local',
          fallbackChain: ['local'],
        },
      };
    }

    if (exitCode !== 0) {
      return {
        passed: false,

        details: {
          language: lang,

          functionName,

          passedCases: 0,

          totalCases: tests.length,

          failures: [{ args: [], expected: null, error: `Exit code ${exitCode}` }],

          stdout,

          stderr,
        },
        metadata: {
          backend: 'local',
          fallbackChain: ['local'],
        },
      };
    }

    let parsed: { success: boolean; output?: string; error?: string; [key: string]: unknown };

    try {
      parsed = JSON.parse(stdout) as { success: boolean; output?: string; error?: string; [key: string]: unknown };
    } catch (err) {
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
              error: `Invalid JSON in stdout: ${getErrorMessage(err)}`,
            },
          ],

          stdout,

          stderr,
        },
        metadata: {
          backend: 'local',
          fallbackChain: ['local'],
        },
      };
    }

    const results = (parsed.results || []) as Array<{
      ok: boolean;
      received?: unknown;
      error?: string;
    }>;

    const failures: SandboxTestFailure[] = [];

    let passedCases = 0;

    results.forEach((r, idx) => {
      if (r.ok) {
        passedCases++;
      } else {
        failures.push({
          args: tests[idx]?.args ?? [],

          expected: tests[idx]?.expected,

          received: r.received,

          error: r.error,
        });
      }
    });

    return {
      passed: failures.length === 0,

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
        backend: 'local',
        fallbackChain: ['local'],
      },
    };
  }
}
