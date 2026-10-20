// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * defaultRequestLimit decision tests (audit 2026-09-29 item 12: an org with
 * NO configured usage_quotas row was silently UNLIMITED).
 *
 * The contract being pinned:
 *  - DEFAULT_ORG_REQUEST_QUOTA unset => INT_MAX (the historic unlimited
 *    behaviour — this change is behavior-preserving until an operator
 *    deliberately sets the env; the same dark-wire shape the gates use);
 *  - a positive integer => that finite ceiling for every org that has no
 *    explicit configuration row;
 *  - garbage (zero, negative, non-numeric) => back to unlimited, never a
 *    quota of 0 that would hard-block every request at boot of a typo.
 *
 * Exercised through getCurrentQuotaOrUnlimited's read-only synthesis path
 * (createIfMissing: false), which is the same default both synthesis sites
 * share via defaultRequestLimit().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/database/client', async () => {
  const actual = await vi.importActual<typeof import('@/database/client')>(
    '@/database/client'
  );
  return {
    ...actual,
    prisma: {
      usageQuota: {
        findFirst: vi.fn().mockResolvedValue(null), // no configured row
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
});

const { checkQuota } = await import('../quota-service');

describe('defaultRequestLimit (DEFAULT_ORG_REQUEST_QUOTA)', () => {
  beforeEach(() => {
    delete process.env.DEFAULT_ORG_REQUEST_QUOTA;
  });
  afterEach(() => {
    delete process.env.DEFAULT_ORG_REQUEST_QUOTA;
  });

  it('unset keeps the historic unlimited behaviour (allow at absurd counts)', async () => {
    const r = await checkQuota(
      'org-unconfigured',
      { organizationId: 'org-unconfigured', operation: { requests: 10_000_000 } },
      { createIfMissing: false }
    );
    expect(r.allowed).toBe(true);
  });

  it('a positive integer becomes the default ceiling for unconfigured orgs', async () => {
    process.env.DEFAULT_ORG_REQUEST_QUOTA = '5';
    const within = await checkQuota(
      'org-unconfigured',
      { organizationId: 'org-unconfigured', operation: { requests: 5 } },
      { createIfMissing: false }
    );
    expect(within.allowed).toBe(true);

    const beyond = await checkQuota(
      'org-unconfigured',
      { organizationId: 'org-unconfigured', operation: { requests: 6 } },
      { createIfMissing: false }
    );
    expect(beyond.allowed).toBe(false);
  });

  it('garbage values degrade to unlimited, never to a zero-quota lockout', async () => {
    for (const bad of ['0', '-3', 'not-a-number']) {
      process.env.DEFAULT_ORG_REQUEST_QUOTA = bad;
      const r = await checkQuota(
        'org-unconfigured',
        { organizationId: 'org-unconfigured', operation: { requests: 10_000_000 } },
        { createIfMissing: false }
      );
      expect(r.allowed, `DEFAULT_ORG_REQUEST_QUOTA=${bad}`).toBe(true);
    }
  });
});
