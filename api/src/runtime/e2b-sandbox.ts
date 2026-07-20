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
  SandboxRunOptions,
  SandboxTestCase,
  SandboxTestResult,
  SupportedLanguage,
} from './code-sandbox';
import { buildInlineHarness, parseHarnessOutput } from './sandbox-harness';

interface E2BSandboxConfig {
  apiKey?: string;
  template?: string;
  region?: string;
  timeoutMs: number;
}

interface E2BExecutionOutput {
  stdout: string;
  stderr: string;
  executionId?: string;
}

export class E2BSandbox implements CodeSandbox {
  private readonly config: E2BSandboxConfig;

  constructor(config: E2BSandboxConfig) {
    this.config = config;
  }

  private ensureConfigured(): string {
    if (!this.config.apiKey || this.config.apiKey.trim().length === 0) {
      throw new Error('E2B sandbox is not configured (missing E2B_API_KEY)');
    }
    return this.config.apiKey;
  }

  private async executePythonOnE2B(
    script: string,
    timeoutMs: number
  ): Promise<E2BExecutionOutput> {
    const apiKey = this.ensureConfigured();
    const packageName = '@e2b/code-interpreter';
    const module = (await import(packageName)) as Record<string, unknown>;
    const sandboxCtor =
      module.Sandbox || module.CodeInterpreter || module.default || module['default'];
    if (!sandboxCtor || typeof sandboxCtor !== 'function') {
      throw new Error('Unable to initialize E2B SDK constructor');
    }

    let sandbox: Record<string, unknown> | null = null;
    try {
      const createMethod = (sandboxCtor as { create?: (...args: unknown[]) => Promise<unknown> }).create;
      if (typeof createMethod === 'function') {
        sandbox = (await createMethod({
          apiKey,
          template: this.config.template,
          region: this.config.region,
        })) as Record<string, unknown>;
      } else {
        sandbox = (await new (sandboxCtor as new (...args: unknown[]) => unknown)({
          apiKey,
          template: this.config.template,
          region: this.config.region,
        })) as Record<string, unknown>;
      }

      const runCode = sandbox?.runCode;
      if (typeof runCode !== 'function') {
        throw new Error('E2B SDK does not expose runCode for code execution');
      }

      const execution = (await runCode.call(sandbox, script, {
        language: 'python',
        timeoutMs,
      })) as Record<string, unknown>;

      const stdout = typeof execution.text === 'string' ? execution.text : '';
      const stderr = typeof execution.stderr === 'string' ? execution.stderr : '';
      const executionId = typeof execution.executionId === 'string' ? execution.executionId : undefined;
      return {
        stdout,
        stderr,
        executionId,
      };
    } finally {
      const kill = sandbox?.kill;
      const close = sandbox?.close;
      if (typeof kill === 'function') {
        await Promise.resolve(kill.call(sandbox));
      } else if (typeof close === 'function') {
        await Promise.resolve(close.call(sandbox));
      }
    }
  }

  async testFunction(
    lang: SupportedLanguage,
    userCode: string,
    functionName: string,
    tests: SandboxTestCase[],
    options: SandboxRunOptions = {}
  ): Promise<SandboxTestResult> {
    if (lang !== 'python') {
      throw new Error(`E2B sandbox currently supports python test harness only. Requested: ${lang}`);
    }

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const harness = buildInlineHarness(lang, userCode, functionName, tests);
    const execution = await this.executePythonOnE2B(harness.script, timeoutMs);
    const result = parseHarnessOutput(
      lang,
      functionName,
      tests,
      execution.stdout,
      execution.stderr,
      'e2b'
    );
    result.metadata = {
      backend: 'e2b',
      fallbackChain: ['e2b'],
      executionId: execution.executionId,
    };
    return result;
  }
}
