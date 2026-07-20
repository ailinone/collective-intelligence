// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'java' | 'csharp' | 'go';

export type SandboxBackend = 'e2b' | 'daytona' | 'local';

export interface SandboxTestCase {
  args: unknown[]; // argumentos para a função

  expected: unknown; // valor esperado
}

export interface SandboxRunOptions {
  timeoutMs?: number;
}

export interface SandboxTestFailure {
  args: unknown[];

  expected: unknown;

  received?: unknown;

  error?: string;
}

export interface SandboxTestResult {
  passed: boolean;

  details: {
    language: SupportedLanguage;

    functionName: string;

    passedCases: number;

    totalCases: number;

    failures: SandboxTestFailure[];

    stdout?: string;

    stderr?: string;
  };

  metadata?: {
    backend: SandboxBackend;
    fallbackChain?: SandboxBackend[];
    backendVersion?: string;
    executionId?: string;
  };
}

export interface CodeSandbox {
  testFunction(
    lang: SupportedLanguage,

    userCode: string,

    functionName: string,

    tests: SandboxTestCase[],

    options?: SandboxRunOptions
  ): Promise<SandboxTestResult>;
}
