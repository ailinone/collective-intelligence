// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ADVERSARIAL sandbox tests (ADR-024, LOTE AQ, 2026-09-05).
 *
 * These are NOT happy-path tests. Each one attempts a real attack against a
 * real container and passes only because the attack was actually contained.
 * Nothing at the isolation boundary is mocked: a genuine `docker run` starts,
 * a genuine kernel enforces the cgroup and namespace limits, and the assertion
 * is on what the container was unable to do.
 *
 * The command allowlist is deliberately WIDENED in most of these tests, to
 * `wget`, `touch`, `sleep`, `env`, `tail` and friends. That is the point: the
 * allowlist is the first layer, and testing only the allowlist would prove
 * nothing about the container. These tests assume the allowlist has already
 * been defeated and ask whether the container still holds. (The allowlist
 * itself is covered by the unit tests in `sandbox-policy.test.ts`.)
 *
 * RUN:
 *   pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/core/sandbox/__tests__/container-sandbox-adversarial.integration.test.ts
 *
 * The `.integration.test.ts` suffix keeps these out of the CI unit gate
 * (`vitest.ci.config.ts` excludes `src/**` + '/*.integration.test.ts'), because
 * they require a Docker daemon. When Docker is unavailable they SKIP LOUDLY
 * rather than pass vacuously — a green run with no Docker must never be
 * mistakable for a proven sandbox.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  createSandboxSession,
  disposeSandboxSession,
  execInSandbox,
  isDockerAvailable,
  resetDockerProbeForTesting,
  type SandboxSession,
} from '../container-sandbox';
import { resolveScopedPath, SandboxPolicyError } from '../sandbox-policy';

const ENV_KEYS = [
  'SANDBOX_COMMAND_ALLOWLIST',
  'SANDBOX_EXEC_TIMEOUT_MS',
  'SANDBOX_MEMORY_MB',
  'SANDBOX_NETWORK_MODE',
  'SANDBOX_IMAGE',
] as const;

const originalEnv: Record<string, string | undefined> = {};

let dockerUp = false;

beforeAll(async () => {
  resetDockerProbeForTesting();
  dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    // eslint-disable-next-line no-console
    console.warn(
      '[adversarial] Docker daemon unreachable — sandbox containment tests SKIPPED. ' +
        'These tests prove nothing when skipped.'
    );
  }
}, 120_000);

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

// Deliberately NOT `describe.skipIf(...)`. A security test that quietly skips
// is worse than one that fails: a green suite with no Docker would read as
// "containment proven". The guard test below FAILS when the daemon is
// unreachable, so a passing run always means a real container was exercised.
describe('ADR-024 · adversarial containment against a REAL container', () => {
  let session: SandboxSession;

  beforeAll(async () => {
    if (!dockerUp) return;
    session = await createSandboxSession();
  }, 120_000);

  afterAll(async () => {
    if (session) await disposeSandboxSession(session);
  });

  it(
    'guard: a Docker daemon is actually reachable (otherwise nothing below proves anything)',
    () => {
      expect(
        dockerUp,
        'Docker is not reachable. The containment tests below are vacuous without it — ' +
          'start Docker and re-run before trusting a green result.'
      ).toBe(true);
    },
    120_000
  );

  // ── T3: network exfiltration ─────────────────────────────────────────
  it(
    'ADV-1 blocks outbound network even when the network client is allowlisted',
    async () => {
      if (!dockerUp) return;
      // Assume the allowlist has been defeated: wget is explicitly permitted.
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'wget';
      process.env.SANDBOX_EXEC_TIMEOUT_MS = '20000';

      const result = await execInSandbox(session, 'wget', [
        '-T',
        '3',
        '-q',
        '-O',
        '-',
        'http://1.1.1.1/',
      ]);

      expect(result.outcome, 'network egress must NOT succeed').not.toBe('ok');
      expect(result.exitCode, 'wget must report failure').not.toBe(0);
      // busybox wget reports the DNS/route failure on stderr.
      expect(
        `${result.stderr} ${result.stdout}`.toLowerCase(),
        'failure must be a network failure, not a missing binary'
      ).toMatch(/bad address|network|unreachable|resolve|download timed out/);
    },
    120_000
  );

  it(
    'ADV-2 blocks raw-IP egress (no DNS involved) even with ping allowlisted',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'ping';
      process.env.SANDBOX_EXEC_TIMEOUT_MS = '20000';

      const result = await execInSandbox(session, 'ping', ['-c', '1', '-W', '2', '1.1.1.1']);

      expect(result.outcome, 'ICMP egress must NOT succeed').not.toBe('ok');
      expect(`${result.stderr} ${result.stdout}`.toLowerCase()).toMatch(
        /unreachable|permission denied|network is down|operation not permitted/
      );
    },
    120_000
  );

  // ── T4: writing outside the scope ────────────────────────────────────
  it(
    'ADV-3 blocks writing to the container root filesystem (read-only)',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'touch';

      const result = await execInSandbox(session, 'touch', ['/etc/pwned']);

      expect(result.outcome, 'writing outside /workspace must fail').not.toBe('ok');
      expect(result.stderr.toLowerCase()).toContain('read-only file system');
    },
    120_000
  );

  it(
    'ADV-4 blocks writing to the container root even at a path that normally exists and is writable',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'touch';

      const result = await execInSandbox(session, 'touch', ['/var/pwned']);

      expect(result.outcome).not.toBe('ok');
      expect(result.stderr.toLowerCase()).toContain('read-only file system');
    },
    120_000
  );

  it(
    'ADV-5 permits writing INSIDE the scope (proving the previous refusals are the boundary, not a broken sandbox)',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'touch,ls';

      const created = await execInSandbox(session, 'touch', ['allowed-write.txt']);
      expect(
        created.outcome,
        'a write inside /workspace must succeed — otherwise ADV-3/ADV-4 could be passing for the wrong reason'
      ).toBe('ok');

      // Deliberately NOT `fs.readdir(session.scopePath)` on the host: on this
      // project's actual CI runner (a container reaching the *host's* Docker
      // daemon over a shared `docker.sock`), the API process's own
      // filesystem view of `session.scopePath` and the daemon's view of the
      // identical `-v` mount argument are not guaranteed to be the same
      // directory — a file the container above just wrote can be genuinely
      // absent from a same-process `fs.readdir` right after, even though the
      // write itself succeeded (see `container-sandbox.ts`'s module header
      // and `ensureScopeWritable`). A second container reading the SAME `-v`
      // argument is the one view guaranteed to agree with the first, so that
      // — not the host `fs` module — is what proves the write actually
      // landed in the mounted scope and nowhere else.
      const listed = await execInSandbox(session, 'ls', ['-1']);
      expect(
        listed.stdout,
        'a second container mounting the identical scope path must see what the first wrote'
      ).toContain('allowed-write.txt');
    },
    120_000
  );

  // ── T2: credential exfiltration ──────────────────────────────────────
  it(
    'ADV-6 does not leak the API process environment into the container',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'env';
      // A canary that unambiguously belongs to the parent process.
      process.env.CI_SANDBOX_CANARY_SECRET = 'canary-9f2b7d4e-must-not-leak';

      try {
        const result = await execInSandbox(session, 'env', []);
        expect(result.outcome).toBe('ok');
        expect(
          result.stdout,
          'the parent process environment (provider keys, JWT_SECRET, DATABASE_URL) must not be visible inside the sandbox'
        ).not.toContain('canary-9f2b7d4e-must-not-leak');
        expect(result.stdout).not.toContain('CI_SANDBOX_CANARY_SECRET');
      } finally {
        delete process.env.CI_SANDBOX_CANARY_SECRET;
      }
    },
    120_000
  );

  // ── T5: resource exhaustion ──────────────────────────────────────────
  it(
    'ADV-7 kills a process that exceeds the memory limit',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'tail';
      process.env.SANDBOX_MEMORY_MB = '64';
      process.env.SANDBOX_EXEC_TIMEOUT_MS = '60000';

      // `tail -c <huge> /dev/zero` buffers in memory — a genuine balloon.
      const result = await execInSandbox(session, 'tail', ['-c', '900m', '/dev/zero']);

      expect(result.outcome, 'a memory balloon must be killed, not completed').not.toBe('ok');
      expect(
        ['oom', 'error'],
        `expected an OOM kill, got outcome=${result.outcome} exit=${result.exitCode}`
      ).toContain(result.outcome);
      expect(result.exitCode, 'SIGKILL from the kernel OOM killer').toBe(137);
    },
    120_000
  );

  it(
    'ADV-8 enforces the hard wall-clock timeout and does not hang',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'sleep';
      process.env.SANDBOX_EXEC_TIMEOUT_MS = '3000';

      const startedAt = Date.now();
      const result = await execInSandbox(session, 'sleep', ['120']);
      const elapsed = Date.now() - startedAt;

      expect(result.outcome, 'an over-running command must time out').toBe('timeout');
      expect(
        elapsed,
        `the call must return near the 3s budget, not near the 120s sleep (took ${elapsed}ms)`
      ).toBeLessThan(30_000);
      expect(result.reason).toContain('3000ms');
    },
    120_000
  );

  // ── T1/T6: privilege ─────────────────────────────────────────────────
  it(
    'ADV-9 runs as a non-root user with no capabilities',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'id,cat';

      const who = await execInSandbox(session, 'id', ['-u']);
      expect(who.outcome).toBe('ok');
      expect(who.stdout.trim(), 'the sandbox must never run as uid 0').not.toBe('0');

      // CapEff is the effective capability bitmask; --cap-drop ALL zeroes it.
      const caps = await execInSandbox(session, 'cat', ['/proc/self/status']);
      const capEff = /CapEff:\s*([0-9a-f]+)/i.exec(caps.stdout)?.[1];
      expect(capEff, 'CapEff must be present in /proc/self/status').toBeDefined();
      expect(
        Number.parseInt(capEff ?? 'ffff', 16),
        `all capabilities must be dropped (CapEff=${capEff})`
      ).toBe(0);
    },
    120_000
  );

  it(
    'ADV-10 cannot see the Docker socket (no trivial escape to the host daemon)',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_COMMAND_ALLOWLIST = 'ls';

      const result = await execInSandbox(session, 'ls', ['-l', '/var/run/docker.sock']);

      expect(result.outcome, 'the docker socket must not be mounted').not.toBe('ok');
      expect(result.stderr.toLowerCase()).toMatch(/no such file|cannot access/);
    },
    120_000
  );

  // ── T4 (host side): path containment, proven on the real filesystem ──
  it(
    'ADV-11 refuses a traversal path and leaves nothing on the host outside the scope',
    async () => {
      if (!dockerUp) return;
      const escapeTarget = join(session.scopePath, '..', 'ci-adversarial-escape.txt');
      await fs.rm(escapeTarget, { force: true });

      expect(() => resolveScopedPath(session.scopePath, '../ci-adversarial-escape.txt')).toThrow(
        SandboxPolicyError
      );
      expect(() => resolveScopedPath(session.scopePath, '../../../../etc/passwd')).toThrow(
        SandboxPolicyError
      );

      // The decisive assertion: nothing was created outside the scope.
      await expect(fs.access(escapeTarget)).rejects.toThrow();
    },
    120_000
  );

  it(
    'ADV-12 refuses a symlink that points out of the scope',
    async () => {
      if (!dockerUp) return;
      const linkName = 'escape-link';
      const linkPath = join(session.scopePath, linkName);
      await fs.rm(linkPath, { force: true });

      let symlinkSupported = true;
      try {
        // Point at the scope's PARENT — outside the boundary.
        await fs.symlink(join(session.scopePath, '..'), linkPath, 'dir');
      } catch {
        symlinkSupported = false;
      }
      if (!symlinkSupported) {
        // eslint-disable-next-line no-console
        console.warn('[adversarial] symlink creation unavailable (Windows without privilege) — ADV-12 skipped');
        return;
      }

      try {
        expect(
          () => resolveScopedPath(session.scopePath, `${linkName}/ci-symlink-escape.txt`),
          'a path resolving through a symlink out of the scope must be refused'
        ).toThrow(SandboxPolicyError);
      } finally {
        await fs.rm(linkPath, { force: true, recursive: false });
      }
    },
    120_000
  );
});
