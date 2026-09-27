// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * application_name + TCP keepalive shared by every pg.Pool (Prisma adapter,
 * HCRA capability pool, SAB worker). Measured 2026-09-24: every app
 * connection had an empty application_name and the same client_addr (Swarm
 * VIP SNAT), so pg_stat_activity could not attribute connections during the
 * rollout "too many clients" storms.
 */
import { describe, expect, it } from 'vitest';
import {
  PG_APPLICATION_NAME_MAX_LENGTH,
  PG_POOL_KEEPALIVE_INITIAL_DELAY_MS,
  pgPoolIdentityOptions,
  resolvePgApplicationName,
} from '../pg-pool-identity';

describe('resolvePgApplicationName', () => {
  it('is <service>-<pool>@<host>, with the service from SERVICE_NAME first, then OTEL_SERVICE_NAME', () => {
    expect(
      resolvePgApplicationName('prisma', { SERVICE_NAME: 'svc', OTEL_SERVICE_NAME: 'ci-worker' }, 'abc123')
    ).toBe('svc-prisma@abc123');
    expect(resolvePgApplicationName('capability', { OTEL_SERVICE_NAME: 'ci-worker' }, 'abc123')).toBe(
      'ci-worker-capability@abc123'
    );
    expect(resolvePgApplicationName('sab', {}, 'abc123')).toBe('ci-api-sab@abc123');
  });

  it('omits the host part when the hostname is empty', () => {
    expect(resolvePgApplicationName('prisma', { OTEL_SERVICE_NAME: 'ci-api' }, '')).toBe('ci-api-prisma');
  });

  it('keeps the service-pool prefix and truncates to what Postgres stores', () => {
    const name = resolvePgApplicationName('prisma', { OTEL_SERVICE_NAME: 'ci-api' }, 'h'.repeat(200));
    expect(name).toHaveLength(PG_APPLICATION_NAME_MAX_LENGTH);
    expect(name.startsWith('ci-api-prisma@')).toBe(true);
  });

  it('replaces bytes Postgres would not keep (non-printable ASCII)', () => {
    expect(resolvePgApplicationName('prisma', { OTEL_SERVICE_NAME: 'ci-äpi' }, 'h\n1')).toBe(
      'ci-?pi-prisma@h?1'
    );
  });
});

describe('pgPoolIdentityOptions', () => {
  it('enables TCP keepalive with an explicit initial delay (the pg default 0 means the 2 h kernel idle time)', () => {
    const options = pgPoolIdentityOptions('capability', { OTEL_SERVICE_NAME: 'ci-worker' }, 'node1');
    expect(options).toEqual({
      application_name: 'ci-worker-capability@node1',
      keepAlive: true,
      keepAliveInitialDelayMillis: PG_POOL_KEEPALIVE_INITIAL_DELAY_MS,
    });
    expect(PG_POOL_KEEPALIVE_INITIAL_DELAY_MS).toBeGreaterThan(0);
  });
});
