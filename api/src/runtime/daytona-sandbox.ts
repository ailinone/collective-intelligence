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

interface DaytonaSandboxConfig {
  apiUrl?: string;
  apiKey?: string;
  workspaceImage?: string;
  timeoutMs: number;
}

interface DaytonaExecutionOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DaytonaSandbox implements CodeSandbox {
  private readonly config: DaytonaSandboxConfig;

  constructor(config: DaytonaSandboxConfig) {
    this.config = config;
  }

  private ensureConfigured(): { apiUrl?: string; apiKey: string; workspaceImage?: string } {
    if (!this.config.apiKey || this.config.apiKey.trim().length === 0) {
      throw new Error('Daytona sandbox is not configured (missing DAYTONA_API_KEY)');
    }
    return {
      apiUrl: this.config.apiUrl,
      apiKey: this.config.apiKey,
      workspaceImage: this.config.workspaceImage,
    };
  }

  private buildCommand(lang: SupportedLanguage, script: string): string {
    if (lang === 'python') {
      return `python - <<'PY'\n${script}\nPY`;
    }
    if (lang === 'javascript' || lang === 'typescript') {
      return `node - <<'NODE'\n${script}\nNODE`;
    }
    throw new Error(`Daytona sandbox inline harness not implemented for language: ${lang}`);
  }

  private async executeCommand(command: string, timeoutMs: number): Promise<DaytonaExecutionOutput> {
    const { apiUrl, apiKey, workspaceImage } = this.ensureConfigured();
    const packageName = 'daytona-sdk';
    const module = (await import(packageName)) as Record<string, unknown>;
    const daytonaCtor = module.Daytona || module.default || module['default'];
    if (!daytonaCtor || typeof daytonaCtor !== 'function') {
      throw new Error('Unable to initialize Daytona SDK constructor');
    }

    const client = new (daytonaCtor as new (...args: unknown[]) => Record<string, unknown>)({
      apiKey,
      serverUrl: apiUrl,
    });

    const create = client.create || client.createSandbox || client.sandboxCreate;
    if (typeof create !== 'function') {
      throw new Error('Daytona SDK does not expose sandbox create method');
    }

    const sandbox = (await create.call(client, {
      image: workspaceImage,
      timeout: timeoutMs,
    })) as Record<string, unknown>;

    try {
      const processApi =
        (sandbox.process as Record<string, unknown> | undefined) ??
        (sandbox['processes'] as Record<string, unknown> | undefined);
      const executeCommand =
        processApi?.executeCommand ||
        processApi?.run ||
        sandbox.executeCommand ||
        sandbox.runCommand;
      if (typeof executeCommand !== 'function') {
        throw new Error('Daytona sandbox process API does not expose command execution');
      }

      const raw = (await executeCommand.call(processApi ?? sandbox, command, {
        timeout: timeoutMs,
      })) as Record<string, unknown>;

      const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
      const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
      const exitCode =
        typeof raw.exitCode === 'number'
          ? raw.exitCode
          : typeof raw.code === 'number'
            ? raw.code
            : 0;

      return { stdout, stderr, exitCode };
    } finally {
      const destroy = sandbox.delete || sandbox.destroy || sandbox.stop;
      if (typeof destroy === 'function') {
        await Promise.resolve(destroy.call(sandbox));
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
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const harness = buildInlineHarness(lang, userCode, functionName, tests);
    const command = this.buildCommand(lang, harness.script);
    const output = await this.executeCommand(command, timeoutMs);

    if (output.exitCode !== 0) {
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
              error: `Daytona command failed with exit code ${output.exitCode}`,
            },
          ],
          stdout: output.stdout,
          stderr: output.stderr,
        },
        metadata: {
          backend: 'daytona',
          fallbackChain: ['daytona'],
        },
      };
    }

    return parseHarnessOutput(
      lang,
      functionName,
      tests,
      output.stdout,
      output.stderr,
      'daytona'
    );
  }
}
