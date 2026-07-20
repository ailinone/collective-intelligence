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
  SandboxBackend,
  SandboxRunOptions,
  SandboxTestCase,
  SandboxTestResult,
  SupportedLanguage,
} from './code-sandbox';
import { LocalProcessSandbox } from './local-process-sandbox';
import { E2BSandbox } from './e2b-sandbox';
import { DaytonaSandbox } from './daytona-sandbox';

interface BackendEntry {
  backend: SandboxBackend;
  sandbox: CodeSandbox;
}

function parseBackendOrder(value: string | undefined): SandboxBackend[] {
  const defaults: SandboxBackend[] = ['e2b', 'daytona', 'local'];
  if (!value || value.trim().length === 0) return defaults;

  const parsed = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry): entry is SandboxBackend => entry === 'e2b' || entry === 'daytona' || entry === 'local');
  return parsed.length > 0 ? parsed : defaults;
}

function shouldEnableLocalBackend(): boolean {
  if ((process.env.ALLOW_LOCAL_SANDBOX_FALLBACK || '').toLowerCase() === 'true') return true;
  return (process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function getDefaultTimeoutMs(): number {
  const parsed = Number(process.env.SANDBOX_DEFAULT_TIMEOUT_MS || 30000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

// ── Per-backend circuit breaker ───────────────────────────────────────────────
// The fallback chain is strictly sequential and each backend gets a FULL
// timeout (default 30s) before the next is tried — a dead E2B meant every
// /v1/code/execute call waited ~30s (or ~60s with Daytona also down) before
// reaching the local backend, on every single request. Running backends
// concurrently is NOT an option here (this executes user code — duplicated
// side effects/cost), so instead a small breaker skips a backend for a
// cooldown window after consecutive failures: the first failing request pays
// the timeout once, subsequent requests go straight to the next backend. The
// LAST backend in the chain is always attempted (final resort — never skip
// everything).
const BREAKER_THRESHOLD = Number(process.env.SANDBOX_BREAKER_THRESHOLD) || 2;
const BREAKER_COOLDOWN_MS = Number(process.env.SANDBOX_BREAKER_COOLDOWN_MS) || 60_000;

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

export class MultiBackendSandbox implements CodeSandbox {
  private readonly backends: BackendEntry[];
  private readonly breaker = new Map<SandboxBackend, BreakerState>();

  constructor(order: SandboxBackend[]) {
    const timeoutMs = getDefaultTimeoutMs();
    const enableLocal = shouldEnableLocalBackend();
    const entries: BackendEntry[] = [];

    for (const backend of order) {
      if (backend === 'e2b') {
        entries.push({
          backend,
          sandbox: new E2BSandbox({
            apiKey: process.env.E2B_API_KEY,
            template: process.env.E2B_TEMPLATE,
            region: process.env.E2B_REGION,
            timeoutMs,
          }),
        });
        continue;
      }

      if (backend === 'daytona') {
        entries.push({
          backend,
          sandbox: new DaytonaSandbox({
            apiUrl: process.env.DAYTONA_API_URL,
            apiKey: process.env.DAYTONA_API_KEY,
            workspaceImage: process.env.DAYTONA_WORKSPACE_IMAGE,
            timeoutMs,
          }),
        });
        continue;
      }

      if (backend === 'local' && enableLocal) {
        entries.push({
          backend,
          sandbox: new LocalProcessSandbox(),
        });
      }
    }

    if (entries.length === 0) {
      entries.push({
        backend: 'local',
        sandbox: new LocalProcessSandbox(),
      });
    }

    this.backends = entries;
  }

  async testFunction(
    lang: SupportedLanguage,
    userCode: string,
    functionName: string,
    tests: SandboxTestCase[],
    options?: SandboxRunOptions
  ): Promise<SandboxTestResult> {
    const fallbackChain: SandboxBackend[] = [];
    const errors: Array<{ backend: SandboxBackend; reason: string }> = [];

    for (let index = 0; index < this.backends.length; index += 1) {
      const entry = this.backends[index];
      const isLastResort = index === this.backends.length - 1;

      // Circuit open → skip without paying the timeout, EXCEPT the last
      // backend, which is always attempted so a fully-open board still runs.
      const state = this.breaker.get(entry.backend);
      if (!isLastResort && state && Date.now() < state.openUntil) {
        errors.push({ backend: entry.backend, reason: 'circuit_open (skipped)' });
        continue;
      }

      fallbackChain.push(entry.backend);
      try {
        const result = await entry.sandbox.testFunction(lang, userCode, functionName, tests, options);
        this.breaker.delete(entry.backend); // success closes the circuit
        result.metadata = {
          ...(result.metadata ?? {}),
          backend: entry.backend,
          fallbackChain,
        };
        return result;
      } catch (error) {
        const failures = (state?.consecutiveFailures ?? 0) + 1;
        this.breaker.set(entry.backend, {
          consecutiveFailures: failures,
          openUntil: failures >= BREAKER_THRESHOLD ? Date.now() + BREAKER_COOLDOWN_MS : 0,
        });
        errors.push({
          backend: entry.backend,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw new Error(
      `All sandbox backends failed for ${lang}. Attempts: ${errors
        .map((item) => `${item.backend}:${item.reason}`)
        .join(' | ')}`
    );
  }
}

export function createCodeSandbox(): CodeSandbox {
  const order = parseBackendOrder(process.env.SANDBOX_BACKENDS_ORDER);
  return new MultiBackendSandbox(order);
}
