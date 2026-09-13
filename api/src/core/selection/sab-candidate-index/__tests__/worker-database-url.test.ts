// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The SAB worker's pg.Pool must follow the main thread's early-captured
 * runtime URL (via workerData), not the process.env snapshot copied at
 * `new Worker()` time, which by then already carries the stale GCP secret
 * host (a stale internal DB hostname, 2026-09-07 incident).
 */
import { describe, expect, it, vi } from 'vitest';

const { CONFIG_URL } = vi.hoisted(() => ({ CONFIG_URL: 'postgresql://ci_user:secret@db:5432/ci_db' }));
const STALE_ENV_URL = 'postgresql://ci_user:secret@stale-db-host:5432/ci_db';

vi.mock('@/config', () => ({
  config: { database: { url: CONFIG_URL } },
}));

import { resolveWorkerDatabaseUrl } from '../worker-database-url';
import { buildSabWorkerData } from '../manager';
import { getRuntimeDatabaseUrl } from '@/database/connection-url';

describe('resolveWorkerDatabaseUrl', () => {
  it('prefers workerData.databaseUrl over a stale process.env.DATABASE_URL', () => {
    expect(resolveWorkerDatabaseUrl({ databaseUrl: CONFIG_URL }, { DATABASE_URL: STALE_ENV_URL })).toBe(CONFIG_URL);
  });

  it('falls back to process.env.DATABASE_URL when workerData carries no URL', () => {
    expect(resolveWorkerDatabaseUrl({}, { DATABASE_URL: STALE_ENV_URL })).toBe(STALE_ENV_URL);
    expect(resolveWorkerDatabaseUrl(undefined, { DATABASE_URL: STALE_ENV_URL })).toBe(STALE_ENV_URL);
  });

  it('throws the existing error when neither is available', () => {
    expect(() => resolveWorkerDatabaseUrl({}, {})).toThrow(/DATABASE_URL is not set in this worker thread/);
  });
});

describe('buildSabWorkerData', () => {
  it('includes databaseUrl = getRuntimeDatabaseUrl() alongside the three shared buffers', () => {
    const buffers = {
      bufferA: new SharedArrayBuffer(8),
      bufferB: new SharedArrayBuffer(8),
      control: new SharedArrayBuffer(64),
    };
    const data = buildSabWorkerData(buffers);
    expect(data.bufferA).toBe(buffers.bufferA);
    expect(data.bufferB).toBe(buffers.bufferB);
    expect(data.control).toBe(buffers.control);
    expect(data.databaseUrl).toBe(getRuntimeDatabaseUrl());
    expect(data.databaseUrl).toBe(CONFIG_URL);
  });
});
