// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security Audit Service Integration Tests
 * Validates persistence behavior against the database layer.
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  connectDatabase,
  disconnectDatabase,
  prisma,
} from '@/database/client';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { securityEventsTotal } from '@/utils/metrics';

describe('Security Audit Service - Integration', () => {
  let organizationId: string;
  let existingUserId: string;

  beforeAll(async () => {
    await connectDatabase();
    const organization = await prisma.organization.create({
      data: {
        name: 'Security Audit Org',
        tier: 'free',
        status: 'active',
      },
    });
    organizationId = organization.id;

    const passwordHash = await bcrypt.hash('Enterprise@123', 10);
    const user = await prisma.user.create({
      data: {
        email: 'security-audit-user@example.com',
        name: 'Audit User',
        passwordHash,
        organizationId,
        status: 'active',
      },
    });
    existingUserId = user.id;
  });

  beforeEach(async () => {
    await prisma.securityAuditLog.deleteMany({});
  });

  const getSecurityEventTotal = async () => {
    const metric = await securityEventsTotal.get();
    return metric.values?.reduce((sum, value) => sum + value.value, 0) ?? 0;
  };

  it('persists audit event linked to an existing organization', async () => {
    const baselineCount = await getSecurityEventTotal();

    await recordSecurityEvent({
      eventType: 'integration_audit_event',
      severity: 'info',
      message: 'Test audit event for known organization',
      organizationId,
      userId: existingUserId,
      metadata: {
        source: 'integration-test',
      },
    });

    const auditLog = await prisma.securityAuditLog.findFirst({
      where: { eventType: 'integration_audit_event' },
      orderBy: { createdAt: 'desc' },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog?.organizationId).toBe(organizationId);
    expect(auditLog?.userId).toBeDefined();
    const metadata = auditLog?.metadata as Record<string, unknown> | null;
    expect(metadata).not.toBeNull();
    expect(metadata?.source).toBe('integration-test');

    const totalCount = await getSecurityEventTotal();
    expect(totalCount - baselineCount).toBe(1);
  });

  it('persists audit event with null organization when tenant is unknown', async () => {
    const unknownOrganizationId = randomUUID();

    const baselineCount = await getSecurityEventTotal();

    await recordSecurityEvent({
      eventType: 'integration_audit_unknown_org',
      severity: 'warning',
      message: 'Audit event for non-existent tenant',
      organizationId: unknownOrganizationId,
      metadata: {
        scenario: 'unknown-tenant',
      },
    });

    const auditLog = await prisma.securityAuditLog.findFirst({
      where: { eventType: 'integration_audit_unknown_org' },
      orderBy: { createdAt: 'desc' },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog?.organizationId).toBeNull();

    const metadata = auditLog?.metadata as Record<string, unknown> | null;
    expect(metadata).not.toBeNull();
    expect(metadata?.scenario).toBe('unknown-tenant');
    expect(metadata?.attemptedOrganizationId).toBe(unknownOrganizationId);

    const totalCount = await getSecurityEventTotal();
    expect(totalCount - baselineCount).toBe(1);
  });
});


