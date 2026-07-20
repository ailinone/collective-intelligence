// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for rehydrateReplayTenant — the DLQ-replay fix for
 * privacy-redacted envelope snapshots.
 *
 * Background: the privacy redactor may replace tenant UUIDs in a DLQ entry's
 * envelope snapshot with the '[REDACTED]' sentinel or a 'pseudo:' pseudonym
 * (GDPR Recital 26 treatment). TenantContext requires uuid-or-null, the outbox
 * tenant columns are @db.Uuid, and DefaultDestinationResolver binds ::uuid —
 * so an un-rehydrated redacted snapshot makes replay throw Prisma P2007/P2010.
 * rehydrateReplayTenant restores tenant identity from the DLQ entry's
 * destination row (tenant_type/tenant_id — already stored in plaintext as the
 * resolution key), keeping the redaction policy intact while making redacted
 * entries replayable.
 *
 * No DB required: the helper is a pure function.
 */

import { describe, it, expect } from 'vitest';
import { rehydrateReplayTenant } from '@/broadcast/application/broadcast-admin-service';

const ORG_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const API_KEY_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const DEST_TENANT_ID = '01234567-89ab-4cde-8f01-23456789abcd';

const orgDestination = { tenantType: 'organization', tenantId: DEST_TENANT_ID };
const userDestination = { tenantType: 'user', tenantId: DEST_TENANT_ID };

describe('rehydrateReplayTenant', () => {
  it('passes valid snapshot UUIDs through untouched (pass-mode policies)', () => {
    const tenant = rehydrateReplayTenant(
      {
        organizationId: ORG_ID,
        userId: USER_ID,
        apiKeyId: API_KEY_ID,
        resolutionScope: 'organization',
      },
      orgDestination,
    );
    expect(tenant).toEqual({
      organizationId: ORG_ID,
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      resolutionScope: 'organization',
    });
  });

  it('rehydrates a fully redacted snapshot from an org-scoped destination', () => {
    const tenant = rehydrateReplayTenant(
      {
        organizationId: '[REDACTED]',
        userId: '[REDACTED]',
        apiKeyId: '[REDACTED]',
        resolutionScope: 'organization',
      },
      orgDestination,
    );
    // The org id comes back from the destination's plaintext resolution key;
    // the user/api-key ids stay null (nothing plaintext to restore them from).
    expect(tenant.organizationId).toBe(DEST_TENANT_ID);
    expect(tenant.userId).toBeNull();
    expect(tenant.apiKeyId).toBeNull();
    expect(tenant.resolutionScope).toBe('organization');
  });

  it('rehydrates a pseudonymized snapshot from a user-scoped destination', () => {
    const tenant = rehydrateReplayTenant(
      {
        organizationId: 'pseudo:2f5a1c',
        userId: 'pseudo:9d3b7e',
        apiKeyId: null,
        resolutionScope: 'user',
      },
      userDestination,
    );
    expect(tenant.userId).toBe(DEST_TENANT_ID);
    expect(tenant.organizationId).toBeNull();
    expect(tenant.apiKeyId).toBeNull();
    expect(tenant.resolutionScope).toBe('user');
  });

  it('prefers a surviving valid UUID over the destination fallback', () => {
    const tenant = rehydrateReplayTenant(
      {
        organizationId: ORG_ID, // survived redaction (pass mode for this field)
        userId: '[REDACTED]',
        resolutionScope: 'organization',
      },
      orgDestination,
    );
    expect(tenant.organizationId).toBe(ORG_ID); // snapshot wins
    expect(tenant.userId).toBeNull(); // org destination cannot restore a user id
  });

  it('derives resolutionScope from the destination when the snapshot value is invalid', () => {
    const fromOrg = rehydrateReplayTenant(
      { organizationId: '[REDACTED]', resolutionScope: '[REDACTED]' },
      orgDestination,
    );
    expect(fromOrg.resolutionScope).toBe('organization');

    const fromUser = rehydrateReplayTenant({}, userDestination);
    expect(fromUser.resolutionScope).toBe('user');
  });

  it('preserves a valid chatroom resolutionScope', () => {
    const tenant = rehydrateReplayTenant(
      { organizationId: ORG_ID, resolutionScope: 'chatroom' },
      orgDestination,
    );
    expect(tenant.resolutionScope).toBe('chatroom');
  });

  it('always yields uuid-or-null fields (TenantContextSchema-safe)', () => {
    const tenant = rehydrateReplayTenant(
      {
        organizationId: 'not-a-uuid',
        userId: 42,
        apiKeyId: { nested: true },
        resolutionScope: 7,
      },
      orgDestination,
    );
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const v of [tenant.organizationId, tenant.userId, tenant.apiKeyId]) {
      expect(v === null || UUID_RE.test(v)).toBe(true);
    }
    expect(['organization', 'user', 'chatroom']).toContain(tenant.resolutionScope);
  });
});
