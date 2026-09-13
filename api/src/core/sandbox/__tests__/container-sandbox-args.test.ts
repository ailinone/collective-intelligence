// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The container security contract, asserted on the argv (ADR-024, LOTE AQ).
 *
 * `container-sandbox-adversarial.integration.test.ts` proves containment
 * against a live daemon, but it needs Docker and is therefore outside the CI
 * unit gate. This file pins the same contract where CI can always see it: if
 * a future edit drops `--network none`, `--read-only`, `--cap-drop ALL` or the
 * non-root `--user`, that is a failing unit test rather than a silently
 * weaker container that nobody notices until an integration run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDockerArgs } from '../container-sandbox';
import { resolveSandboxLimits } from '../sandbox-policy';

const ENV_KEYS = [
  'SANDBOX_NETWORK_MODE',
  'SANDBOX_ALLOWLIST_NETWORK',
  'SANDBOX_MEMORY_MB',
  'SANDBOX_USER',
  'SANDBOX_IMAGE',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function build(scopePath = '/tmp/scope'): string[] {
  return buildDockerArgs({
    containerName: 'ci-sbx-test',
    scopePath,
    limits: resolveSandboxLimits(),
    command: 'cat',
    args: ['file.txt'],
  });
}

/** Assert `flag` is present and immediately followed by `value`. */
function expectFlagValue(argv: string[], flag: string, value: string): void {
  const index = argv.indexOf(flag);
  expect(index, `${flag} must be present`).toBeGreaterThanOrEqual(0);
  expect(argv[index + 1], `${flag} must be ${value}`).toBe(value);
}

describe('docker argv — the isolation contract', () => {
  it('disables networking by default', () => {
    expectFlagValue(build(), '--network', 'none');
  });

  it('makes the root filesystem read-only', () => {
    expect(build()).toContain('--read-only');
  });

  it('drops all capabilities', () => {
    expectFlagValue(build(), '--cap-drop', 'ALL');
  });

  it('forbids privilege escalation via setuid binaries', () => {
    expectFlagValue(build(), '--security-opt', 'no-new-privileges');
  });

  it('runs as a non-root user', () => {
    const argv = build();
    const user = argv[argv.indexOf('--user') + 1];
    expect(user).toBeDefined();
    expect(user, 'the sandbox must never run as root').not.toBe('0:0');
    expect(user.startsWith('0:'), 'uid 0 is forbidden').toBe(false);
  });

  it('caps memory AND swap, so the memory limit cannot be escaped via swap', () => {
    process.env.SANDBOX_MEMORY_MB = '256';
    const argv = build();
    expectFlagValue(argv, '--memory', '256m');
    expectFlagValue(argv, '--memory-swap', '256m');
  });

  it('caps CPU and pids', () => {
    const argv = build();
    expect(argv).toContain('--cpus');
    expect(argv).toContain('--pids-limit');
  });

  it('mounts exactly one writable location, the scope directory', () => {
    const argv = build('/tmp/my-scope');
    const mounts = argv.filter((_, index) => argv[index - 1] === '-v');
    expect(mounts, 'exactly one bind mount').toHaveLength(1);
    expect(mounts[0]).toBe('/tmp/my-scope:/workspace');
  });

  it('never mounts the docker socket', () => {
    const argv = build();
    expect(argv.join(' ')).not.toContain('docker.sock');
  });

  it('never runs privileged and never adds capabilities back', () => {
    const argv = build();
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--cap-add');
    expect(argv).not.toContain('--pid');
    expect(argv).not.toContain('--ipc');
  });

  it('mounts /tmp noexec so a dropped binary there cannot be run', () => {
    const argv = build();
    const tmpfs = argv[argv.indexOf('--tmpfs') + 1];
    expect(tmpfs).toContain('noexec');
    expect(tmpfs).toContain('nosuid');
  });

  it('removes the container automatically', () => {
    expect(build()).toContain('--rm');
  });

  it('places the command and its args LAST, after the image, so they cannot be read as docker flags', () => {
    const argv = build();
    const limits = resolveSandboxLimits();
    const imageIndex = argv.indexOf(limits.image);
    expect(imageIndex).toBeGreaterThan(0);
    expect(argv.slice(imageIndex + 1)).toEqual(['cat', 'file.txt']);
  });

  it('uses the operator-named network in allowlist mode, never bridge', () => {
    process.env.SANDBOX_NETWORK_MODE = 'allowlist';
    process.env.SANDBOX_ALLOWLIST_NETWORK = 'egress-proxy-net';
    expectFlagValue(build(), '--network', 'egress-proxy-net');
  });

  it('collapses an attempt to configure bridge networking back to none', () => {
    process.env.SANDBOX_NETWORK_MODE = 'bridge';
    expectFlagValue(build(), '--network', 'none');
  });
});
