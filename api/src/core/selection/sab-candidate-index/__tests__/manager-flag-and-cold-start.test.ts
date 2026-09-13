// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fast, hermetic unit tests for manager.ts's flag-reading and cold-start
 * fail-open behavior — deliberately does NOT spawn a real worker_threads
 * Worker (that requires a real or reachable DATABASE_URL and is covered,
 * end to end, by sab-worker-concurrent-load-benchmark.test.ts's real
 * Testcontainers-backed suite). This file only exercises the pure,
 * synchronous parts of the manager's public surface that don't depend on
 * the worker actually running.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSabCandidateIndexEnabled, getSabCandidateModels, getSabCandidateIndexStatus } from '../manager';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sab-candidate-index/manager — flag + cold-start', () => {
  it('isSabCandidateIndexEnabled reads the env var live (not module-load cached)', () => {
    vi.stubEnv('SELECTION_USE_SAB_CANDIDATE_INDEX', 'true');
    expect(isSabCandidateIndexEnabled()).toBe(true);
    vi.stubEnv('SELECTION_USE_SAB_CANDIDATE_INDEX', 'false');
    expect(isSabCandidateIndexEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(isSabCandidateIndexEnabled()).toBe(false); // default OFF
  });

  it('defaults OFF when the env var is unset', () => {
    expect(isSabCandidateIndexEnabled()).toBe(false);
  });

  it('getSabCandidateModels returns null before the index has ever been started (fail open — caller falls through)', () => {
    const result = getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15);
    expect(result).toBeNull();
  });

  it('getSabCandidateIndexStatus reports not-started/not-ready before ensureSabCandidateIndexStarted has ever run', () => {
    const status = getSabCandidateIndexStatus();
    expect(status.started).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.activeGen).toBe(-1);
    expect(status.builds).toBe(0);
    expect(status.crashes).toBe(0);
  });
});
