// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Host-side scope-directory creation, and the mount-priming argv, for the
 * container sandbox (ADR-024).
 *
 * These are hermetic — no Docker required — unlike
 * `container-sandbox-adversarial.integration.test.ts`, which proves the
 * directory these pieces prepare is actually writable from INSIDE a real
 * container (ADV-5). This file pins the two things that make that true:
 *
 *  1. `createSandboxSession` chmods the directory it creates to 0777, so a
 *     fixed non-root container uid (65534) that never matches whatever uid
 *     the API process runs as still has a shot at writing into it.
 *  2. `buildScopePrimingArgs` produces the argv for the helper container
 *     that ACTUALLY guarantees the write succeeds — see the rationale on
 *     `ensureScopeWritable` in `container-sandbox.ts`. (1) alone was proven
 *     insufficient against the real CI runner: ADV-5 failed identically
 *     whether the scope directory was rooted under the runner's own `/tmp`
 *     or under `RUNNER_TEMP`, because the runner's Docker daemon does not
 *     necessarily resolve either path the way this process's own chmod call
 *     assumed. Priming the SAME `-v` mount from a throwaway root container
 *     sidesteps that entirely: Docker guarantees both `docker run`
 *     invocations bind the identical source, whatever/wherever it is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import {
  buildFileIoArgs,
  buildScopePrimingArgs,
  createSandboxSession,
  disposeSandboxSession,
  toContainerPath,
  type SandboxSession,
} from '../container-sandbox';
import { resolveSandboxLimits } from '../sandbox-policy';

describe('createSandboxSession — the host-side half of the /workspace mount', () => {
  let session: SandboxSession | undefined;

  afterEach(async () => {
    if (session) {
      await disposeSandboxSession(session);
      session = undefined;
    }
  });

  it('creates a scope directory that exists on disk', async () => {
    session = await createSandboxSession();
    await expect(fs.stat(session.scopePath)).resolves.toBeDefined();
  });

  // The regression this test guards: a container running as a fixed
  // non-root uid (65534) must be able to write into the bind-mounted scope
  // directory even though the host process that created it runs as a
  // different uid entirely. This alone is NOT the fix for the CI
  // regression (see the file header) but it remains a necessary condition
  // on hosts where the daemon does resolve the path this process sees.
  it.skipIf(process.platform === 'win32')(
    'chmods the scope directory to 0777',
    async () => {
      session = await createSandboxSession();
      const stat = await fs.stat(session.scopePath);
      expect(stat.mode & 0o777).toBe(0o777);
    }
  );
});

describe('buildScopePrimingArgs — the mount-priming helper container argv', () => {
  function build(scopePath = '/tmp/scope'): string[] {
    return buildScopePrimingArgs({
      containerName: 'ci-sbx-prime-test',
      scopePath,
      limits: resolveSandboxLimits(),
    });
  }

  it('runs as root by omitting --user entirely — that is the whole point', () => {
    expect(build()).not.toContain('--user');
  });

  it('mounts exactly the same scope path the real command will use', () => {
    const argv = build('/tmp/my-scope');
    const mounts = argv.filter((_, index) => argv[index - 1] === '-v');
    expect(mounts).toEqual(['/tmp/my-scope:/workspace']);
  });

  it('runs a single fixed command with no caller-supplied input', () => {
    const argv = build();
    const imageIndex = argv.indexOf(resolveSandboxLimits().image);
    expect(imageIndex).toBeGreaterThan(0);
    expect(argv.slice(imageIndex + 1)).toEqual(['chmod', '777', '/workspace']);
  });

  it('still disables networking', () => {
    const argv = build();
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
  });

  it('still makes the root filesystem read-only', () => {
    expect(build()).toContain('--read-only');
  });

  it('still drops all capabilities and forbids privilege escalation', () => {
    const argv = build();
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('never mounts the docker socket and never runs privileged', () => {
    const argv = build();
    expect(argv.join(' ')).not.toContain('docker.sock');
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--cap-add');
  });

  it('removes the container automatically', () => {
    expect(build()).toContain('--rm');
  });
});

describe('toContainerPath — the actual close-out of the host-fs/container-fs gap', () => {
  it('re-roots a bare relative path under /workspace', () => {
    expect(toContainerPath('todo.txt')).toBe('/workspace/todo.txt');
  });

  it('re-roots a nested relative path under /workspace', () => {
    expect(toContainerPath('notes/todo.txt')).toBe('/workspace/notes/todo.txt');
  });

  it('maps the scope root itself (empty or ".") to /workspace, not /workspace/. or /workspace/', () => {
    expect(toContainerPath('.')).toBe('/workspace');
    expect(toContainerPath('')).toBe('/workspace');
  });

  it(
    'converts Windows-style separators to POSIX — the container is always Linux ' +
      'even when the API host is Windows',
    () => {
      expect(toContainerPath('notes\\todo.txt')).toBe('/workspace/notes/todo.txt');
    }
  );

  it('collapses redundant "." segments', () => {
    expect(toContainerPath('./notes/./todo.txt')).toBe('/workspace/notes/todo.txt');
  });
});

describe('buildFileIoArgs — the argv that closes the host-fs/container-fs gap for file content', () => {
  function build(containerPath = '/workspace/notes/todo.txt', script = 'cat -- "$1"'): string[] {
    return buildFileIoArgs({
      containerName: 'ci-sbx-io-test',
      scopePath: '/tmp/scope',
      limits: resolveSandboxLimits(),
      script,
      containerPath,
    });
  }

  it(
    'runs as the SAME fixed non-root uid execInSandbox uses — unlike the priming ' +
      'helper, there is no ownership mismatch to bypass here',
    () => {
      const argv = build();
      const user = argv[argv.indexOf('--user') + 1];
      expect(user).toBe(resolveSandboxLimits().user);
      expect(user.startsWith('0:'), 'must never run as root').toBe(false);
    }
  );

  it('keeps stdin open (-i), the whole point being to pipe file content in for a write', () => {
    expect(build()).toContain('-i');
  });

  it('mounts exactly the same scope path a real sandboxed command would use', () => {
    const argv = build();
    const mounts = argv.filter((_, index) => argv[index - 1] === '-v');
    expect(mounts).toEqual(['/tmp/scope:/workspace']);
  });

  it('passes the in-scope path as sh -c\'s own $1, never interpolated into the script text', () => {
    const weirdPath = '/workspace/a b/weird"quote.txt';
    const script = 'cat -- "$1"';
    const argv = build(weirdPath, script);
    // The path is the LAST two argv elements (sh's $0 placeholder, then $1) —
    // a completely separate slot from the script string itself.
    expect(argv.slice(-2)).toEqual(['sh', weirdPath]);
    // The script argument is untouched by the path's content: it appears
    // verbatim, exactly once, as a single argv element.
    expect(argv.filter((entry) => entry === script)).toHaveLength(1);
    expect(argv.some((entry) => entry.includes(weirdPath) && entry !== weirdPath)).toBe(false);
  });

  it('still disables networking, makes the root filesystem read-only, and drops all capabilities', () => {
    const argv = build();
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
    expect(argv).toContain('--read-only');
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('never mounts the docker socket and never runs privileged', () => {
    const argv = build();
    expect(argv.join(' ')).not.toContain('docker.sock');
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--cap-add');
  });

  it('removes the container automatically', () => {
    expect(build()).toContain('--rm');
  });
});
