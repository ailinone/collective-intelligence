// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { config } from '@/config';
import { prisma } from '@/database/client';
import { organizationSettingsService } from '@/services/organization-settings-service';
import { getAuthService } from '@/services/auth-service';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

const TEST_ORG_NAME = 'Settings Integration Org';

describe('Organization Settings Integration', () => {
  const mutatedEnv = new Map<string, string | undefined>();
  let organizationId: string;

  beforeAll(async () => {
    const setEnv = (key: string, value: string) => {
      if (!mutatedEnv.has(key)) {
        mutatedEnv.set(key, process.env[key]);
      }
      process.env[key] = value;
    };

    setEnv('TEST_USE_LOCAL_SERVICES', 'true');
    setEnv('QUEUE_ENABLED', 'false');

    await startTestEnvironment();

    // Ensure default roles are synchronized
    await syncDefaultRoles();

    const organization = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: TEST_ORG_NAME,
        tier: 'pro',
        status: 'active',
        settings: {},
      },
    });

    organizationId = organization.id;
  }, 60_000);

  beforeEach(() => {
    if (organizationId) {
      organizationSettingsService.invalidate(organizationId);
    }
  });

  afterAll(async () => {
    await prisma.authLoginChallenge.deleteMany({ where: { organizationId } });
    await prisma.apiKey.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { organizationId, email: { startsWith: 'tenant' } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });

    organizationSettingsService.invalidate(organizationId);

    await stopTestEnvironment();

    mutatedEnv.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }, 60_000);

  it('returns tier defaults when no overrides are present', async () => {
    const settings = await organizationSettingsService.getSettings(organizationId);

    expect(settings.auth.defaultMode).toBe(config.auth.defaultMode);
    expect(settings.auth.allowPasswordFallback).toBe(config.auth.allowPasswordFallback);
    expect(settings.auth.mfaRequired).toBe(false);
    expect(settings.features.multiModelExecution).toBe(true);
    expect(settings.quotas.requestsPerHour).toBeGreaterThan(0);
  });

  it('persists overrides and applies them to auth flows', async () => {
    await organizationSettingsService.updateSettings(organizationId, {
      auth: {
        defaultMode: 'sso',
        allowPasswordFallback: false,
        mfaRequired: true,
      },
      features: {
        prioritySupport: true,
      },
      quotas: {
        requestsPerHour: 25,
      },
    });

    const settings = await organizationSettingsService.getSettings(organizationId);
    expect(settings.auth.defaultMode).toBe('sso');
    expect(settings.auth.allowPasswordFallback).toBe(false);
    expect(settings.auth.mfaRequired).toBe(true);
    expect(settings.features.prioritySupport).toBe(true);
    expect(settings.quotas.requestsPerHour).toBe(25);

    await prisma.user.deleteMany({ where: { organizationId, email: 'tenantadmin@example.com' } });

    const passwordHash = await bcrypt.hash('TestPassword123!', 12);
    await prisma.user.create({
      data: {
        email: 'tenantadmin@example.com',
        passwordHash,
        name: 'Tenant Admin',
        organizationId,
        status: 'active',
        role: 'admin',
      },
    });

    const authService = getAuthService();
    const effectiveAuth = await (
      authService as unknown as {
        resolveAuthSettings: (
          organizationId?: string
        ) => Promise<{ mode: string; allowPasswordFallback: boolean }>;
      }
    ).resolveAuthSettings(organizationId);
    expect(effectiveAuth.mode).toBe('sso');
    expect(effectiveAuth.allowPasswordFallback).toBe(false);

    const result = await authService.login('tenantadmin@example.com', 'TestPassword123!');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('enforces email code fallback rules per organization', async () => {
    await organizationSettingsService.updateSettings(organizationId, {
      auth: {
        defaultMode: 'email_code',
        allowPasswordFallback: false,
      },
    });

    await prisma.user.deleteMany({ where: { organizationId, email: 'tenantuser@example.com' } });

    const passwordHash = await bcrypt.hash('AnotherPassword123!', 12);
    await prisma.user.create({
      data: {
        email: 'tenantuser@example.com',
        passwordHash,
        name: 'Tenant User',
        organizationId,
        status: 'active',
        role: 'developer',
      },
    });

    const authService = getAuthService();
    const effectiveAuth = await (
      authService as unknown as {
        resolveAuthSettings: (
          organizationId?: string
        ) => Promise<{ mode: string; allowPasswordFallback: boolean }>;
      }
    ).resolveAuthSettings(organizationId);
    expect(effectiveAuth.mode).toBe('email_code');
    expect(effectiveAuth.allowPasswordFallback).toBe(false);

    const result = await authService.login('tenantuser@example.com', 'AnotherPassword123!');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
