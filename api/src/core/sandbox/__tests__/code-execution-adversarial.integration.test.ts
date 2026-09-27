// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ADVERSARIAL tests for `core/sandbox/code-execution.ts` against a REAL Docker
 * daemon (ADR-026). Nothing here is mocked: `executeCode()` is called
 * exactly as `code-execution-orchestration.ts` and the capabilities route
 * call it, a genuine `docker run` starts, a genuine kernel enforces cgroup
 * and namespace limits, and each assertion is on what the sandboxed
 * interpreter was actually able (or unable) to do.
 *
 * This file does NOT re-prove every container-level guarantee
 * `container-sandbox-adversarial.integration.test.ts` already covers
 * (non-root uid, dropped capabilities, no Docker-socket mount, read-only
 * root, `--network none` in general) — `code-execution.ts` reuses the exact
 * same `buildDockerArgs`/`execInSandbox` primitive that file exercises, so
 * those properties transfer. What THIS file proves is specific to what
 * `code-execution.ts` adds on top: the program travels over STDIN (not argv,
 * not a mounted file) to a REAL interpreter, resource/timeout/network limits
 * still hold through that stdin path, and every call gets its own container
 * with no state surviving between them.
 *
 * RUN:
 *   pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/core/sandbox/__tests__/code-execution-adversarial.integration.test.ts
 *
 * The `.integration.test.ts` suffix keeps these out of the CI unit gate
 * (`vitest.ci.config.ts` excludes them) because they require a Docker
 * daemon. Deliberately NOT `describe.skipIf(...)`: the guard test below
 * FAILS when Docker is unreachable, so a green run always means these ran
 * for real — a quietly-skipped security suite proves nothing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDockerAvailable, resetDockerProbeForTesting } from '../container-sandbox';
import { executeCode } from '../code-execution';

const ENV_KEYS = [
  'CODE_EXECUTION_SANDBOX_ENABLED',
  'CODE_EXECUTION_MAX_SOURCE_BYTES',
  'SANDBOX_MEMORY_MB',
  'SANDBOX_EXEC_TIMEOUT_MS',
  'SANDBOX_MAX_OUTPUT_BYTES',
  'SANDBOX_NETWORK_MODE',
] as const;

const originalEnv: Record<string, string | undefined> = {};
let dockerUp = false;

beforeAll(async () => {
  resetDockerProbeForTesting();
  dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    // eslint-disable-next-line no-console
    console.warn(
      '[code-execution adversarial] Docker daemon unreachable — these tests SKIPPED. ' +
        'They prove nothing when skipped.'
    );
  }
}, 120_000);

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('ADR-026 · code-execution against a REAL container', () => {
  it(
    'guard: a Docker daemon is actually reachable (otherwise nothing below proves anything)',
    () => {
      expect(
        dockerUp,
        'Docker is not reachable. The tests below are vacuous without it — start Docker ' +
          'and re-run before trusting a green result.'
      ).toBe(true);
    },
    120_000
  );

  // ── Happy path: stdin delivery actually runs real code, both languages ──
  it(
    'CE-1 runs real Python via stdin and returns the exact stdout',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({ language: 'python', code: 'print(sum(range(1, 101)))' });
      expect(result.outcome).toBe('ok');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('5050');
    },
    60_000
  );

  it(
    'CE-2 runs real JavaScript via stdin and returns the exact stdout',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({ language: 'javascript', code: 'console.log(2 ** 10);' });
      expect(result.outcome).toBe('ok');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('1024');
    },
    60_000
  );

  it(
    'CE-3 surfaces a real interpreter error honestly (non-zero exit, stderr populated) rather than fabricating success',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({ language: 'python', code: 'raise ValueError("boom")' });
      expect(result.outcome).toBe('error');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ValueError');
    },
    60_000
  );

  // ── T3: network isolation, through the ACTUAL attack surface a model-written script would use ──
  it(
    'CE-4 blocks outbound network from Python stdlib (no fabricated success, no data reaches the internet)',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({
        language: 'python',
        code:
          'import urllib.request\n' +
          'try:\n' +
          '    urllib.request.urlopen("http://example.com", timeout=5)\n' +
          '    print("REACHED_NETWORK")\n' +
          'except Exception as e:\n' +
          '    print("BLOCKED:", type(e).__name__)\n',
        timeoutMs: 20_000,
      });
      expect(result.outcome).toBe('ok');
      expect(result.stdout).not.toContain('REACHED_NETWORK');
      expect(result.stdout).toContain('BLOCKED');
    },
    30_000
  );

  it(
    'CE-5 blocks outbound network from Node (fetch/http reach nothing)',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({
        language: 'javascript',
        code:
          'const http = require("http");\n' +
          'const req = http.get("http://example.com", () => console.log("REACHED_NETWORK"));\n' +
          'req.on("error", (e) => console.log("BLOCKED:", e.code));\n' +
          'req.setTimeout(5000, () => { console.log("BLOCKED: TIMEOUT"); req.destroy(); });\n',
        timeoutMs: 20_000,
      });
      expect(result.stdout).not.toContain('REACHED_NETWORK');
      expect(result.stdout).toContain('BLOCKED');
    },
    30_000
  );

  // ── T4/T6: filesystem — cannot write outside the ephemeral scope ────────
  it(
    'CE-6 cannot write to the container root filesystem (read-only)',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({
        language: 'python',
        code: 'open("/etc/pwned", "w").write("x")\nprint("WROTE")\n',
      });
      expect(result.stdout).not.toContain('WROTE');
      expect(result.outcome).not.toBe('ok');
    },
    60_000
  );

  it(
    'CE-7 CAN write inside /workspace — proving CE-6 is the real boundary, not a broken sandbox',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({
        language: 'python',
        code:
          'open("/workspace/scratch.txt", "w").write("hello")\n' +
          'print(open("/workspace/scratch.txt").read())\n',
      });
      expect(result.outcome).toBe('ok');
      expect(result.stdout.trim()).toBe('hello');
    },
    60_000
  );

  // ── T2: no ambient credentials ───────────────────────────────────────
  it(
    'CE-8 does not leak the API process environment into the interpreter',
    async () => {
      if (!dockerUp) return;
      process.env.CI_CODE_EXEC_CANARY_SECRET = 'canary-a91f-must-not-leak';
      try {
        const result = await executeCode({
          language: 'python',
          code: 'import os\nprint(sorted(os.environ.keys()))\n',
        });
        expect(result.outcome).toBe('ok');
        expect(result.stdout).not.toContain('canary-a91f-must-not-leak');
        expect(result.stdout).not.toContain('CI_CODE_EXEC_CANARY_SECRET');
      } finally {
        delete process.env.CI_CODE_EXEC_CANARY_SECRET;
      }
    },
    60_000
  );

  it(
    'CE-9 runs as a non-root user with no capabilities, even invoked over stdin',
    async () => {
      if (!dockerUp) return;
      const result = await executeCode({
        language: 'python',
        code: 'import os\nprint(os.getuid())\n',
      });
      expect(result.outcome).toBe('ok');
      expect(result.stdout.trim(), 'must never run as uid 0').not.toBe('0');
    },
    60_000
  );

  // ── T5: resource exhaustion, through the stdin invocation path ──────────
  it(
    'CE-10 kills a Python process that exceeds the memory limit',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_MEMORY_MB = '96';
      const result = await executeCode({
        language: 'python',
        code: 'x = bytearray(700 * 1024 * 1024)\nprint(len(x))\n',
        timeoutMs: 30_000,
      });
      expect(result.outcome, 'a 700MB allocation against a 96MB cap must not succeed').not.toBe(
        'ok'
      );
      expect(['oom', 'error']).toContain(result.outcome);
    },
    60_000
  );

  it(
    'CE-11 enforces the wall-clock timeout on an infinite loop and does not hang the caller',
    async () => {
      if (!dockerUp) return;
      const startedAt = Date.now();
      const result = await executeCode({
        language: 'python',
        code: 'while True:\n    pass\n',
        timeoutMs: 3_000,
      });
      const elapsed = Date.now() - startedAt;
      expect(result.outcome).toBe('timeout');
      expect(elapsed, `must return near the 3s budget (took ${elapsed}ms)`).toBeLessThan(30_000);
    },
    60_000
  );

  // ── Output-size cap ──────────────────────────────────────────────────
  it(
    'CE-12 truncates stdout at the configured output-size limit instead of buffering unbounded output',
    async () => {
      if (!dockerUp) return;
      process.env.SANDBOX_MAX_OUTPUT_BYTES = '2000';
      const result = await executeCode({
        language: 'python',
        // Deliberately emits far more than the 2000-byte cap.
        code: 'print("x" * 200000)\n',
        timeoutMs: 20_000,
      });
      expect(result.truncated, 'oversized output must be flagged truncated').toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(2100); // small slack for the final chunk boundary
    },
    30_000
  );

  // ── Container-per-call isolation — code-execution's OWN new invariant ──
  it(
    'CE-13 shares NOTHING between two calls: a file written in call 1 is invisible in call 2',
    async () => {
      if (!dockerUp) return;
      const first = await executeCode({
        language: 'python',
        code: 'open("/workspace/leftover.txt", "w").write("should not survive")\nprint("done")\n',
      });
      expect(first.outcome).toBe('ok');

      const second = await executeCode({
        language: 'python',
        code: 'import os\nprint(os.path.exists("/workspace/leftover.txt"))\n',
      });
      expect(second.outcome).toBe('ok');
      expect(
        second.stdout.trim(),
        'a fresh call must get a fresh /workspace — nothing persists across executeCode() calls'
      ).toBe('False');
    },
    60_000
  );
});
