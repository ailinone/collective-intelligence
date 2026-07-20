// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the CapabilitySearchService singleton getter.
 *
 * The contract this suite locks down:
 *
 *   1. **Identity across calls** — repeated `getCapabilitySearchService()`
 *      returns the same instance. If a future refactor accidentally
 *      reconstructed it per call, the embedder cache would be cold on
 *      every selector invocation (the embedder lazy-loads its model on
 *      first embed).
 *
 *   2. **Test stub injection** — `setCapabilitySearchServiceForTests`
 *      replaces the cached instance and is observable through the
 *      next `get` call. This is the integration shape every consumer
 *      test will use to inject mocks.
 *
 *   3. **Reset semantics** — `resetCapabilitySearchService()` clears
 *      the cache so a subsequent `get` lazy-constructs again. Test
 *      hygiene: ensures stubs from one file don't leak into another.
 *
 * Why no DB-backed assertion: the singleton's job is identity / lifecycle.
 * Whether the underlying `CapabilitySearchService` actually queries
 * Postgres is the responsibility of `capability-search-service` itself
 * and its integration tests. This test stays at the wiring layer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilitySearchService } from '../capability-search-service';
import {
  getCapabilitySearchService,
  resetCapabilitySearchService,
  setCapabilitySearchServiceForTests,
} from '../capability-search-singleton';

// Set DATABASE_URL once for the whole file — getCapabilityPool throws
// without it. The pool itself is not actually connected to during these
// tests because we stub the service before any get() reaches the pool.
process.env.DATABASE_URL ||= 'postgres://noop:noop@localhost:5432/noop';

describe('capability-search-singleton', () => {
  afterEach(() => {
    resetCapabilitySearchService();
  });

  describe('Invariant 1: identity across calls', () => {
    it('returns the same instance on repeated calls', () => {
      // Stub to avoid touching the real pg.Pool — this test cares about
      // identity, not construction.
      const stub = {} as CapabilitySearchService;
      setCapabilitySearchServiceForTests(stub);

      const a = getCapabilitySearchService();
      const b = getCapabilitySearchService();
      expect(a).toBe(b);
      expect(a).toBe(stub);
    });
  });

  describe('Invariant 2: test stub injection', () => {
    it('setCapabilitySearchServiceForTests replaces the cached instance', () => {
      const first = {} as CapabilitySearchService;
      const second = {} as CapabilitySearchService;

      setCapabilitySearchServiceForTests(first);
      expect(getCapabilitySearchService()).toBe(first);

      setCapabilitySearchServiceForTests(second);
      expect(getCapabilitySearchService()).toBe(second);
      expect(getCapabilitySearchService()).not.toBe(first);
    });
  });

  describe('Invariant 3: reset semantics', () => {
    it('resetCapabilitySearchService clears the cached stub', () => {
      const stub = {} as CapabilitySearchService;
      setCapabilitySearchServiceForTests(stub);
      expect(getCapabilitySearchService()).toBe(stub);

      resetCapabilitySearchService();
      // After reset, the next get() lazy-constructs a real instance.
      // We don't assert exact identity here because that would require
      // DB connectivity. Instead we assert the stub is no longer
      // returned — the singleton has detached from it.
      const next = getCapabilitySearchService();
      expect(next).not.toBe(stub);
    });
  });
});
