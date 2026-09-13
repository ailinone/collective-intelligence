// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ADVERSARIAL tests for the `computer_use` TOOL SURFACE (ADR-024, LOTE AQ).
 *
 * `container-sandbox-adversarial.integration.test.ts` attacks the container.
 * This file attacks the layer above it — the tools an LLM actually calls —
 * because a perfectly isolated container is no help if the tool wrapper
 * writes to the host before ever reaching it. The decisive assertions here are
 * on the HOST filesystem: after a refused write, the file must not exist.
 *
 * Real Docker is required for the shell tests; when the daemon is unreachable
 * the guard test FAILS rather than skipping, so a green run always means the
 * containment was genuinely exercised.
 *
 * RUN:
 *   pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/core/sandbox/__tests__/computer-use-tools.integration.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import {
  __resetComputerUseRegistrationForTest,
  registerComputerUseTools,
} from '../computer-use-tools';
import { isDockerAvailable, resetDockerProbeForTesting } from '../container-sandbox';
import { acquireSession, disposeAllSessions } from '../sandbox-session-manager';

const ENV_KEYS = [
  'AGENTIC_COMPUTER_USE_ENABLED',
  'SANDBOX_COMMAND_ALLOWLIST',
  'SANDBOX_EXEC_TIMEOUT_MS',
] as const;
const saved: Record<string, string | undefined> = {};

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  log: logger.child({ component: 'computer-use-integration-test' }),
  organizationId: 'org-adversarial',
  userId: 'user-adversarial',
};

let dockerUp = false;

beforeAll(async () => {
  resetDockerProbeForTesting();
  dockerUp = await isDockerAvailable();
}, 120_000);

afterAll(async () => {
  await disposeAllSessions();
});

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.AGENTIC_COMPUTER_USE_ENABLED = 'true';
  __resetComputerUseRegistrationForTest();
  registerComputerUseTools();
  toolRegistry.markInitialized();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('computer_use tool surface · adversarial', () => {
  it('guard: Docker is reachable (otherwise the containment tests below are vacuous)', () => {
    expect(
      dockerUp,
      'Docker is not reachable — start it and re-run before trusting a green result.'
    ).toBe(true);
  });

  it(
    'refuses a traversal write AND leaves nothing on the host outside the scope',
    async () => {
      const session = await acquireSession({
        organizationId: context.organizationId,
        userId: context.userId,
      });
      const escapePath = join(session.scopePath, '..', 'ci-tool-escape.txt');
      await fs.rm(escapePath, { force: true });

      const result = await toolRegistry.execute(
        'computer_write_file',
        { path: '../ci-tool-escape.txt', content: 'pwned' },
        'call-escape',
        context
      );

      expect(result.success, 'a traversal write must be refused').toBe(false);
      expect(result.error).toContain('escapes the sandbox scope');
      expect(result.metadata?.violation).toBe('path_escape');

      // The assertion that actually matters.
      await expect(
        fs.access(escapePath),
        'the file must NOT exist on the host outside the scope'
      ).rejects.toThrow();
    },
    120_000
  );

  it(
    'refuses an absolute-path write to a sensitive host location',
    async () => {
      for (const path of ['/etc/passwd', 'C:\\Windows\\System32\\drivers\\etc\\hosts']) {
        const result = await toolRegistry.execute(
          'computer_write_file',
          { path, content: 'pwned' },
          'call-abs',
          context
        );
        expect(result.success, `${path} must be refused`).toBe(false);
        expect(result.metadata?.violation).toBe('path_escape');
      }
    },
    120_000
  );

  it(
    'refuses a non-allowlisted command before any container starts',
    async () => {
      for (const command of ['curl', 'wget', 'sh', 'bash', 'python']) {
        const result = await toolRegistry.execute(
          'computer_shell',
          { command, args: ['-c', 'echo pwned'] },
          'call-cmd',
          context
        );
        expect(result.success, `${command} must be refused`).toBe(false);
        expect(result.error).toMatch(/not in the sandbox allowlist|bare program name/);
      }
    },
    120_000
  );

  it(
    'does not let a shell metacharacter in an argument become a second command',
    async () => {
      if (!dockerUp) return;
      // `echo` is allowlisted; the injected `; touch /tmp/pwned` must be
      // treated as literal text because there is no shell in the pipeline.
      const result = await toolRegistry.execute(
        'computer_shell',
        { command: 'echo', args: ['hello; touch /etc/pwned && echo INJECTED'] },
        'call-inject',
        context
      );

      expect(result.success).toBe(true);
      expect(
        result.output?.trim(),
        'the metacharacters must be echoed verbatim, proving no shell interpreted them'
      ).toBe('hello; touch /etc/pwned && echo INJECTED');
      // Exactly one line of output. A shell would have produced two: the
      // echoed prefix, then a second `echo INJECTED` after the `&&`.
      expect(
        result.output?.trim().split('\n'),
        'a shell would have split this into two commands and produced two lines'
      ).toHaveLength(1);

      // And the injected `touch` never happened: /etc is read-only, but the
      // stronger statement is that it was never even attempted as a command.
      const probe = await toolRegistry.execute(
        'computer_shell',
        { command: 'ls', args: ['-1', '/etc/pwned'] },
        'call-inject-probe',
        context
      );
      expect(probe.success, 'the injected touch must not have created /etc/pwned').toBe(false);
    },
    120_000
  );

  it(
    'round-trips a legitimate write → shell read inside the scope',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'cat,ls';

      const wrote = await toolRegistry.execute(
        'computer_write_file',
        { path: 'notes/todo.txt', content: 'legitimate-content' },
        'call-write',
        context
      );
      expect(wrote.success, wrote.error).toBe(true);

      const read = await toolRegistry.execute(
        'computer_shell',
        { command: 'cat', args: ['notes/todo.txt'] },
        'call-read',
        context
      );
      expect(read.success, read.error).toBe(true);
      expect(read.output).toContain('legitimate-content');

      const listed = await toolRegistry.execute(
        'computer_list_files',
        { path: 'notes' },
        'call-list',
        context
      );
      expect(listed.output).toContain('todo.txt');
    },
    120_000
  );

  it(
    'reports a timeout as a clean tool failure rather than hanging the caller',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'sleep';
      process.env.SANDBOX_EXEC_TIMEOUT_MS = '3000';

      const startedAt = Date.now();
      const result = await toolRegistry.execute(
        'computer_shell',
        { command: 'sleep', args: ['120'] },
        'call-timeout',
        context
      );
      const elapsed = Date.now() - startedAt;

      expect(result.success).toBe(false);
      expect(result.metadata?.outcome).toBe('timeout');
      expect(elapsed, `must return near the budget, not the 120s sleep (${elapsed}ms)`).toBeLessThan(
        30_000
      );
    },
    120_000
  );

  it(
    'keeps two different callers in separate scope directories',
    async () => {
      const a = await acquireSession({ organizationId: 'org-a', userId: 'user-a' });
      const b = await acquireSession({ organizationId: 'org-b', userId: 'user-b' });
      expect(a.scopePath).not.toBe(b.scopePath);
      expect(a.sessionId).not.toBe(b.sessionId);
    },
    120_000
  );
});
