// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provision organizations and users with email-code authentication enforced.
 *
 * Usage:
 *   pnpm tsx scripts/provision-email-code-users.ts ./path/to/setup-organizations.json
 *
 * The JSON file must follow the structure documented in
 * `scripts/setup-organizations.template.json`. Each organization entry is
 * processed in order:
 *   1. Organization is created (or updated) with tier = enterprise
 *   2. Organization auth settings -> defaultMode=email_code, allowPasswordFallback=false
 *   3. User owner is registered (or fetched) and assigned owner role
 *   4. Enterprise subscription is created if missing
 *   5. API key is generated
 *   6. JWT access/refresh tokens are issued
 *
 * Output: a JSON summary printed to stdout containing organization, user,
 * API key, and tokens. Store it in a secure vault immediately.
 */

import 'reflect-metadata';
import 'dotenv/config';

import { randomBytes } from 'crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { container } from 'tsyringe';

import { initializeDIContainer } from '@/di/container';
import { config } from '@/config';
import type { JWTPayload } from '@/services/auth-service';
import { RegisterUserHandler } from '@/application/handlers/register-user.handler';
import { RegisterUserCommand } from '@/application/commands/register-user.command';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { assignRoleToUser, getUserRoles } from '@/services/rbac-service';
import {
  listSubscriptions,
  createSubscription,
} from '@/services/billing-service';
import {
  organizationSettingsService,
} from '@/services/organization-settings-service';
import {
  createApiKey,
  type ApiKeyGenerationOptions,
} from '@/services/api-key-rotation';

interface OrganizationConfig {
  name: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;
  tier: 'enterprise';
  trialDays?: number;
  apiKeyName?: string;
}

interface SetupFile {
  apiUrl?: string;
  organizations: OrganizationConfig[];
}

interface ProvisionResult {
  organizationId: string;
  organizationName: string;
  userId: string;
  email: string;
  loginMode: 'email_code';
  roles: string[];
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  apiKey?: string;
  temporaryPassword?: string;
}

const prisma = new PrismaClient();

function randomPassword(): string {
  return randomBytes(24).toString('base64url');
}

function parseDurationToSeconds(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)(s|m|h|d)$/i.exec(trimmed);
  if (!match) {
    return 0;
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    default:
      return 0;
  }
}

function generateJwtPair(payload: JWTPayload): {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
} {
  const secret = config.security.jwtSecret;
  if (!secret || typeof secret !== 'string') {
    throw new Error('JWT secret is not configured');
  }

  const accessDuration = config.security.jwtExpiresIn || '24h';
  const accessExpiresInSeconds =
    parseDurationToSeconds(accessDuration) || 24 * 60 * 60;

  const refreshDuration =
    process.env.JWT_REFRESH_EXPIRES_IN || '30d';
  const refreshExpiresInSeconds =
    parseDurationToSeconds(refreshDuration) || 30 * 24 * 60 * 60;

  const nonce = randomBytes(8).toString('hex');
  const accessOptions: SignOptions = {
    expiresIn: accessExpiresInSeconds,
    jwtid: `${nonce}-access`,
  };
  const refreshOptions: SignOptions = {
    expiresIn: refreshExpiresInSeconds,
    jwtid: `${nonce}-refresh`,
  };

  const signingSecret: Secret = secret;
  const accessToken = jwt.sign(payload, signingSecret, accessOptions);
  const refreshToken = jwt.sign(payload, signingSecret, refreshOptions);

  return {
    accessToken,
    refreshToken,
    expiresInSeconds: accessExpiresInSeconds,
  };
}

async function loadConfig(pathArg: string): Promise<SetupFile> {
  const filePath = resolve(process.cwd(), pathArg);
  const raw = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as SetupFile;

  if (!parsed.organizations || parsed.organizations.length === 0) {
    throw new Error('Configuration file must include at least one organization');
  }

  return parsed;
}

async function ensureOrganization(
  configEntry: OrganizationConfig
): Promise<{ id: string; name: string }> {
  const existing = await prisma.organization.findFirst({
    where: { name: configEntry.name },
  });

  if (existing) {
    if (existing.tier !== configEntry.tier || existing.status !== 'active') {
      await prisma.organization.update({
        where: { id: existing.id },
        data: {
          tier: configEntry.tier,
          status: 'active',
        },
      });
    }
    return { id: existing.id, name: existing.name };
  }

  const created = await prisma.organization.create({
    data: {
      name: configEntry.name,
      tier: configEntry.tier,
      status: 'active',
    },
  });
  return { id: created.id, name: created.name };
}

async function ensureEmailCodeAuth(organizationId: string): Promise<void> {
  await organizationSettingsService.updateSettings(organizationId, {
    auth: {
      defaultMode: 'email_code',
      allowPasswordFallback: false,
    },
  });
}

async function ensureEnterpriseSubscription(
  organizationId: string,
  trialDays?: number
): Promise<void> {
  const subscriptions = await listSubscriptions(organizationId);
  const hasActiveEnterprise = subscriptions.some(
    (subscription) =>
      subscription.plan === 'enterprise' && subscription.status === 'active'
  );

  if (hasActiveEnterprise) {
    return;
  }

  await createSubscription({
    organizationId,
    plan: 'enterprise',
    billingCycle: 'monthly',
    amount: 0,
    currency: 'USD',
    trialDays,
    metadata: {
      source: 'provision-script',
      createdAt: new Date().toISOString(),
    },
  });
}

async function ensureUser(
  org: { id: string; name: string },
  configEntry: OrganizationConfig,
  registerHandler: RegisterUserHandler
): Promise<{ userId: string; temporaryPassword?: string }> {
  const normalizedEmail = configEntry.ownerEmail.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    if (existing.name !== configEntry.ownerName) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { name: configEntry.ownerName },
      });
    }
    return { userId: existing.id };
  }

  const password = configEntry.ownerPassword ?? randomPassword();
  const command = new RegisterUserCommand(
    normalizedEmail,
    password,
    configEntry.ownerName,
    configEntry.name
  );
  const result = await registerHandler.execute(command);
  if (!result.success || !result.userId) {
    throw new Error(
      `Failed to register user ${normalizedEmail}: ${result.error ?? 'unknown error'}`
    );
  }

  return { userId: result.userId, temporaryPassword: password };
}

async function createApiKeyForUser(
  userId: string,
  organizationId: string,
  apiKeyName: string
): Promise<string> {
  const options: ApiKeyGenerationOptions = {
    userId,
    organizationId,
    name: apiKeyName,
  };
  const { plainKey } = await createApiKey(options);
  return plainKey;
}

async function provisionOrganization(
  configEntry: OrganizationConfig,
  registerHandler: RegisterUserHandler
): Promise<ProvisionResult> {
  // 1. Organization
  const organization = await ensureOrganization(configEntry);

  // 2. Auth settings
  await ensureEmailCodeAuth(organization.id);

  // 3. User
  const { userId, temporaryPassword } = await ensureUser(
    organization,
    configEntry,
    registerHandler
  );

  // 4. Assign owner role
  const roles = await assignRoleToUser(
    userId,
    organization.id,
    'owner'
  );

  // 5. Subscription
  await ensureEnterpriseSubscription(organization.id, configEntry.trialDays);

  // 6. API key
  const apiKeyName =
    configEntry.apiKeyName ?? `${configEntry.name} Root Key`;
  const apiKey = await createApiKeyForUser(
    userId,
    organization.id,
    apiKeyName
  );

  // 7. Tokens
  const jwtPayload: JWTPayload = {
    userId,
    organizationId: organization.id,
    email: configEntry.ownerEmail,
    roles,
  };
  const tokens = generateJwtPair(jwtPayload);

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    userId,
    email: configEntry.ownerEmail,
    loginMode: 'email_code',
    roles,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresInSeconds: tokens.expiresInSeconds,
    apiKey,
    temporaryPassword,
  };
}

async function main(): Promise<void> {
  const configPathArg = process.argv[2];
  if (!configPathArg) {
    console.error(
      'Missing configuration file path. Usage: pnpm tsx scripts/provision-email-code-users.ts ./path/to/setup-organizations.json'
    );
    process.exit(1);
  }

  try {
    const setup = await loadConfig(configPathArg);

    initializeDIContainer();
    await prisma.$connect();
    await syncDefaultRoles();

    const registerHandler = container.resolve(RegisterUserHandler);

    const results: Record<string, ProvisionResult> = {};

    for (const orgConfig of setup.organizations) {
      const result = await provisionOrganization(orgConfig, registerHandler);

      // Refresh cached roles to ensure future requests see fresh data
      await getUserRoles(result.userId, result.organizationId);

      results[orgConfig.ownerEmail.toLowerCase()] = result;
    }

    console.log('========================================');
    console.log('Provisioning completed successfully.');
    console.log('Store this output securely (never commit to git):');
    console.log('========================================');
    console.log(JSON.stringify(results, null, 2));
    console.log('========================================');
  } catch (error) {
    console.error('Provisioning failed:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}


