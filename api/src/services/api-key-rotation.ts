// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Rotation Service (v5.0)
 *
 * Implements secure, zero-downtime API key rotation with:
 * - Cryptographically secure key generation
 * - Grace period support (dual-key validation)
 * - Automated rotation scheduling
 * - Complete audit trail
 * - Email/webhook notifications
 *
 * Security: OWASP compliant, SOC 2 ready
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { prisma } from '@/database/client';
import { serializeError } from '@/utils/type-guards';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { getEmailService } from './email-service';
import { invalidateApiKeyAuthCache } from '@/api/middleware/api-key-auth-middleware';
import type { ApiKey, User, Organization } from '@/generated/prisma/index.js';
import { Prisma } from '@/generated/prisma/index.js';

// ============================================
// Types & Interfaces
// ============================================

export interface ApiKeyRotationOptions {
  keyId: string;
  gracePeriodDays?: number;
  reason?: string;
  performedBy?: string; // User ID
}

export interface ApiKeyGenerationOptions {
  userId: string;
  organizationId: string;
  name: string;
  autoRotate?: boolean;
  rotationIntervalDays?: number;
  gracePeriodDays?: number;
  ipWhitelist?: string[];
  permissions?: Record<string, boolean | string | string[]>;
  expiresAt?: Date;
}

export interface ApiKeyValidationResult {
  isValid: boolean;
  apiKey?: ApiKey & { user?: User; organization?: Organization };
  reason?: string;
}

// ============================================
// Constants
// ============================================

const KEY_PREFIX = 'ak_';
const KEY_LENGTH_BYTES = 32; // 256 bits
const BCRYPT_ROUNDS = 12;
const DEFAULT_GRACE_PERIOD_DAYS = 7;
const DEFAULT_ROTATION_INTERVAL_DAYS = 90;

const notificationLogger = logger.child({ service: 'api-key-rotation-notifications' });

interface ApiKeyRotationNotificationContext {
  userId?: string;
  userEmail?: string | null;
  userName?: string | null;
  organizationId: string;
  organizationName?: string | null;
  keyName?: string | null;
  oldKeyPrefix: string;
  newKeyPrefix: string;
  gracePeriodEnds: Date;
  plainKey?: string;
  automatic: boolean;
  reason?: string;
}

// ============================================
// Key Generation & Hashing
// ============================================

/**
 * Key generator implementation (mutable for deterministic testing)
 */
let keyGeneratorImpl: () => string = () => {
  const randomBytes = crypto.randomBytes(KEY_LENGTH_BYTES);
  const key = randomBytes.toString('base64url');
  return `${KEY_PREFIX}${key}`;
};

export function setApiKeyGenerator(generator: () => string): void {
  keyGeneratorImpl = generator;
}

export function resetApiKeyGenerator(): void {
  keyGeneratorImpl = () => {
    const randomBytes = crypto.randomBytes(KEY_LENGTH_BYTES);
    const key = randomBytes.toString('base64url');
    return `${KEY_PREFIX}${key}`;
  };
}

/**
 * Generate a cryptographically secure API key
 * Format: ak_<base64url-encoded-random-bytes>
 */
export function generateApiKey(): string {
  return keyGeneratorImpl();
}

/**
 * Hash API key using bcrypt (slow hash, resistant to brute force)
 */
export async function hashApiKey(key: string): Promise<string> {
  return await bcrypt.hash(key, BCRYPT_ROUNDS);
}

/**
 * Generate quick lookup hash using SHA-256
 * Used for fast database queries before expensive bcrypt verification
 */
export function quickHash(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Extract key prefix for display (e.g., "ak_abc123")
 * Shows first 8 chars after prefix
 */
export function getKeyPrefix(key: string): string {
  if (!key.startsWith(KEY_PREFIX)) {
    throw new Error('Invalid API key format');
  }
  const displayLength = KEY_PREFIX.length + 8;
  return key.substring(0, Math.min(displayLength, key.length));
}

// ============================================
// Key Validation
// ============================================

/**
 * Validate API key with constant-time comparison
 * Prevents timing attacks
 *
 * Returns both active and rotating keys during grace period
 */
export async function validateApiKey(
  providedKey: string,
  updateUsageStats: boolean = true
): Promise<ApiKeyValidationResult> {
  try {
    // 1. Quick lookup by SHA-256 hash
    const keyHash = quickHash(providedKey);

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        quickHash: keyHash,
        status: { in: ['active', 'rotating'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            status: true,
          },
        },
        organization: {
          select: {
            id: true,
            name: true,
            tier: true,
            status: true,
          },
        },
      },
    });

    if (!apiKey) {
      logger.warn({ keyPrefix: getKeyPrefix(providedKey) }, 'API key not found');
      return { isValid: false, reason: 'Key not found or expired' };
    }

    // 2. Full bcrypt comparison (constant-time)
    const isValid = await bcrypt.compare(providedKey, apiKey.keyHash);

    if (!isValid) {
      logger.warn({ apiKeyId: apiKey.id }, 'API key hash mismatch');
      return { isValid: false, reason: 'Invalid key' };
    }

    // 3. Check user and org status
    if (apiKey.user.status !== 'active') {
      logger.warn({ userId: apiKey.userId }, 'User is not active');
      return { isValid: false, reason: 'User inactive' };
    }

    if (apiKey.organization.status !== 'active') {
      logger.warn({ organizationId: apiKey.organizationId }, 'Organization is not active');
      return { isValid: false, reason: 'Organization inactive' };
    }

    // 4. Update usage statistics
    if (updateUsageStats) {
      await prisma.apiKey
        .update({
          where: { id: apiKey.id },
          data: {
            lastUsedAt: new Date(),
            requestCount: { increment: 1 },
          },
        })
        .catch((err) => {
          // Don't fail validation if stats update fails
          logger.warn({ error: serializeError(err), apiKeyId: apiKey.id }, 'Failed to update usage stats');
        });
    }

    logger.info(
      {
        apiKeyId: apiKey.id,
        userId: apiKey.userId,
        organizationId: apiKey.organizationId,
        status: apiKey.status,
      },
      'API key validated successfully'
    );

    // Type assertion is safe here because we've selected the required fields
    // and the structure matches the expected type
    return { isValid: true, apiKey: apiKey as ApiKey & { user?: User; organization?: Organization } };
  } catch (error) {
    logger.error({ error }, 'Error validating API key');
    return { isValid: false, reason: 'Validation error' };
  }
}

// ============================================
// Key Creation
// ============================================

/**
 * Create new API key with optional auto-rotation
 */
export async function createApiKey(
  options: ApiKeyGenerationOptions
): Promise<{ apiKey: ApiKey & { user: User; organization: Organization }; plainKey: string }> {
  const plainKey = generateApiKey();
  const keyHash = await hashApiKey(plainKey);
  const keyQuickHash = quickHash(plainKey);
  const keyPrefix = getKeyPrefix(plainKey);

  const apiKey = await prisma.apiKey.create({
    data: {
      userId: options.userId,
      organizationId: options.organizationId,
      name: options.name,
      keyHash,
      quickHash: keyQuickHash,
      keyPrefix,
      autoRotate: options.autoRotate ?? false,
      rotationIntervalDays: options.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS,
      gracePeriodDays: options.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS,
      ipWhitelist: options.ipWhitelist ?? [],
      permissions: options.permissions ? (options.permissions as Prisma.InputJsonValue) : undefined,
      expiresAt: options.expiresAt,
    },
    include: {
      user: true,
      organization: true,
    },
  });

  // Log creation
  await prisma.apiKeyRotationLog.create({
    data: {
      apiKeyId: apiKey.id,
      action: 'created',
      reason: 'New key created',
      newKeyId: apiKey.id,
      performedBy: options.userId,
      metadata: {
        autoRotate: options.autoRotate,
        rotationIntervalDays: options.rotationIntervalDays,
      },
    },
  });

  logger.info(
    {
      apiKeyId: apiKey.id,
      userId: options.userId,
      organizationId: options.organizationId,
      autoRotate: options.autoRotate,
    },
    'API key created'
  );

  return { apiKey, plainKey };
}

// ============================================
// Key Rotation
// ============================================

/**
 * Rotate API key (manual or automated)
 *
 * Process:
 * 1. Generate new key
 * 2. Mark old key as 'rotating' with expiration
 * 3. Link keys (previous/next)
 * 4. Log rotation
 * 5. Notify user
 *
 * During grace period, both keys are valid
 */
export async function rotateApiKey(
  options: ApiKeyRotationOptions
): Promise<{ oldKey: ApiKey & { user: User; organization: Organization }; newKey: ApiKey & { user: User; organization: Organization }; plainKey: string }> {
  const gracePeriodDays = options.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS;
  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + gracePeriodDays);

  // 1. Get existing key
  const oldKey = await prisma.apiKey.findUnique({
    where: { id: options.keyId },
    include: {
      user: true,
      organization: true,
    },
  });

  if (!oldKey) {
    throw new Error(`API key not found: ${options.keyId}`);
  }

  if (oldKey.status !== 'active') {
    throw new Error(`Cannot rotate key with status: ${oldKey.status}`);
  }

  // 2. Generate new key
  const plainKey = generateApiKey();
  const keyHash = await hashApiKey(plainKey);
  const keyQuickHash = quickHash(plainKey);
  const keyPrefix = getKeyPrefix(plainKey);

  // 3. Create new key (transaction for atomicity)
  const result = await prisma.$transaction(async (tx) => {
    // Create new key
    const newKey = await tx.apiKey.create({
      data: {
        userId: oldKey.userId,
        organizationId: oldKey.organizationId,
        name: oldKey.name,
        keyHash,
        quickHash: keyQuickHash,
        keyPrefix,
        autoRotate: oldKey.autoRotate,
        rotationIntervalDays: oldKey.rotationIntervalDays,
        gracePeriodDays: oldKey.gracePeriodDays,
        ipWhitelist: oldKey.ipWhitelist,
        permissions: oldKey.permissions ? (oldKey.permissions as Prisma.InputJsonValue) : Prisma.JsonNull,
        expiresAt: null, // New key doesn't expire
        rotationCount: oldKey.rotationCount + 1,
        previousKeyId: oldKey.id,
      },
      include: {
        user: true,
        organization: true,
      },
    });

    // Update old key
    const updatedOldKey = await tx.apiKey.update({
      where: { id: oldKey.id },
      data: {
        status: 'rotating',
        expiresAt: expirationDate,
        rotatedAt: new Date(),
        nextKeyId: newKey.id,
      },
      include: {
        user: true,
        organization: true,
      },
    });

    // Log rotation
    await tx.apiKeyRotationLog.create({
      data: {
        apiKeyId: newKey.id,
        action: 'rotated',
        reason: options.reason ?? 'Key rotation',
        oldKeyId: oldKey.id,
        newKeyId: newKey.id,
        performedBy: options.performedBy,
        metadata: {
          gracePeriodDays,
          expiresAt: expirationDate,
          automatic: !options.performedBy,
        },
      },
    });

    return { updatedOldKey, newKey };
  });

  logger.info(
    {
      oldKeyId: oldKey.id,
      newKeyId: result.newKey.id,
      userId: oldKey.userId,
      organizationId: oldKey.organizationId,
      gracePeriodDays,
      expiresAt: expirationDate,
      performedBy: options.performedBy,
    },
    'API key rotated successfully'
  );

  const oldKeyDisplayPrefix =
    oldKey.keyPrefix ??
    (oldKey.quickHash
      ? `${KEY_PREFIX}${oldKey.quickHash.substring(0, 8)}`
      : `${KEY_PREFIX}${oldKey.id.substring(0, 8)}`);

  await notifyApiKeyRotation({
    userId: oldKey.userId,
    userEmail: oldKey.user?.email,
    userName: oldKey.user?.name,
    organizationId: oldKey.organizationId,
    organizationName: oldKey.organization?.name,
    keyName: oldKey.name,
    oldKeyPrefix: oldKeyDisplayPrefix,
    newKeyPrefix: result.newKey.keyPrefix,
    gracePeriodEnds: expirationDate,
    plainKey,
    automatic: !options.performedBy,
    reason: options.reason,
  });

  return {
    oldKey: result.updatedOldKey,
    newKey: result.newKey,
    plainKey,
  };
}

// ============================================
// Key Revocation
// ============================================

/**
 * Revoke API key immediately
 */
export async function revokeApiKey(
  keyId: string,
  reason?: string,
  performedBy?: string
): Promise<void> {
  const revoked = await prisma.apiKey.update({
    where: { id: keyId },
    data: {
      status: 'revoked',
      revokedAt: new Date(),
    },
  });
  // Best-effort: shrink the auth-cache staleness window below its TTL bound.
  invalidateApiKeyAuthCache(revoked.quickHash);

  // Log revocation
  await prisma.apiKeyRotationLog.create({
    data: {
      apiKeyId: keyId,
      action: 'revoked',
      reason: reason ?? 'Key revoked',
      performedBy,
    },
  });

  logger.info({ apiKeyId: keyId, reason, performedBy }, 'API key revoked');
}

async function notifyApiKeyRotation(context: ApiKeyRotationNotificationContext): Promise<void> {
  const notificationConfig = config.notifications.apiKeys;

  await Promise.all([
    maybeSendRotationEmail(notificationConfig, context),
    maybePostRotationWebhook(notificationConfig, context),
  ]);
}

async function maybeSendRotationEmail(
  notificationConfig: typeof config.notifications.apiKeys,
  context: ApiKeyRotationNotificationContext
): Promise<void> {
  if (!notificationConfig.emailEnabled) {
    return;
  }

  if (!context.userEmail) {
    notificationLogger.debug(
      { reason: 'missing_email', oldKeyPrefix: context.oldKeyPrefix },
      'Skipping rotation email notification'
    );
    return;
  }

  const emailService = getEmailService();
  const displayOrganization = context.organizationName ?? context.organizationId;
  const displayKey = context.keyName ?? context.oldKeyPrefix;
  const greetingName = context.userName ?? 'there';
  const rotatedAt = new Date();
  const expiresAtDisplay = context.gracePeriodEnds.toUTCString();

  const lines: string[] = [
    `Hello ${greetingName},`,
    '',
    `Your API key "${displayKey}" for organization "${displayOrganization}" was rotated ${context.automatic ? 'automatically' : 'manually'} on ${rotatedAt.toUTCString()}.`,
    `The previous key will remain valid until ${expiresAtDisplay}. Please update your integrations before the grace period ends.`,
    '',
    `New key prefix: ${context.newKeyPrefix}`,
    `Previous key prefix: ${context.oldKeyPrefix}`,
  ];

  if (context.reason) {
    lines.push('', `Reason: ${context.reason}`);
  }

  if (notificationConfig.includePlainKeyInEmail && typeof context.plainKey === 'string') {
    lines.push('', 'New API key (store securely and do not share):', '', `    ${context.plainKey}`);
  }

  lines.push(
    '',
    'Next steps:',
    '1. Update services that use this key to the new value.',
    '2. Verify traffic with the new key before the grace period ends.',
    '3. Remove the old key value from configuration stores once decommissioned.'
  );

  const text = lines.join('\n');
  const htmlParts: string[] = [
    `<p>Hello ${escapeHtml(greetingName)},</p>`,
    `<p>Your API key <strong>${escapeHtml(displayKey)}</strong> for organization <strong>${escapeHtml(displayOrganization)}</strong> was rotated ${escapeHtml(context.automatic ? 'automatically' : 'manually')} on ${escapeHtml(rotatedAt.toUTCString())}.</p>`,
    `<p>The previous key will remain valid until <strong>${escapeHtml(expiresAtDisplay)}</strong>. Please update your integrations before the grace period ends.</p>`,
    `<p>New key prefix: <code>${escapeHtml(context.newKeyPrefix)}</code><br/>Previous key prefix: <code>${escapeHtml(context.oldKeyPrefix)}</code></p>`,
  ];

  if (context.reason) {
    htmlParts.push(`<p>Reason: ${escapeHtml(context.reason)}</p>`);
  }

  if (notificationConfig.includePlainKeyInEmail && typeof context.plainKey === 'string') {
    htmlParts.push('<p><strong>New API key (store securely and do not share):</strong></p>');
    htmlParts.push(
      `<pre style="background:#f5f5f5;padding:12px;border-radius:4px;">${escapeHtml(context.plainKey)}</pre>`
    );
  }

  htmlParts.push('<p><strong>Next steps:</strong></p>');
  htmlParts.push('<ol>');
  htmlParts.push('<li>Update services that use this key to the new value.</li>');
  htmlParts.push('<li>Verify traffic with the new key before the grace period ends.</li>');
  htmlParts.push(
    '<li>Remove the old key value from configuration stores once decommissioned.</li>'
  );
  htmlParts.push('</ol>');

  const htmlBody = htmlParts.join('');

  try {
    await emailService.send({
      to: context.userEmail,
      subject: `API key rotated: ${displayKey}`,
      text,
      html: htmlBody,
    });
    notificationLogger.info(
      { channel: 'email', userEmail: context.userEmail, oldKeyPrefix: context.oldKeyPrefix },
      'API key rotation email sent'
    );
  } catch (error) {
    notificationLogger.warn(
      { error, channel: 'email', userEmail: context.userEmail },
      'Failed to send API key rotation email'
    );
  }
}

async function maybePostRotationWebhook(
  notificationConfig: typeof config.notifications.apiKeys,
  context: ApiKeyRotationNotificationContext
): Promise<void> {
  if (!notificationConfig.webhookEnabled || !notificationConfig.webhookUrl) {
    return;
  }

  interface GlobalWithFetch {
    fetch?: typeof fetch;
  }
  const fetchImpl: typeof fetch | undefined = (globalThis as GlobalWithFetch).fetch;
  if (!fetchImpl) {
    notificationLogger.warn(
      { reason: 'fetch_unavailable' },
      'Webhook delivery skipped because fetch is not available in runtime'
    );
    return;
  }

  interface ApiKeyRotatedPayload {
    event: 'api_key.rotated';
    emittedAt: string;
    data: {
      organizationId: string;
      organizationName: string;
      userId: string;
      userEmail?: string;
      keyName?: string;
      oldKeyPrefix: string;
      newKeyPrefix: string;
      gracePeriodEnds: string;
      automatic: boolean;
      reason?: string;
      plainKey?: string;
    };
  }

  const emittedAt = new Date().toISOString();
  const payload: ApiKeyRotatedPayload = {
    event: 'api_key.rotated',
    emittedAt,
    data: {
      organizationId: context.organizationId,
      organizationName: context.organizationName ?? '',
      userId: context.userId ?? '',
      userEmail: context.userEmail ?? undefined,
      keyName: context.keyName ?? undefined,
      oldKeyPrefix: context.oldKeyPrefix,
      newKeyPrefix: context.newKeyPrefix,
      gracePeriodEnds: context.gracePeriodEnds.toISOString(),
      automatic: context.automatic,
      reason: context.reason ?? undefined,
    },
  };

  if (notificationConfig.includePlainKeyInWebhook && typeof context.plainKey === 'string') {
    payload.data.plainKey = context.plainKey;
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Ailin-Event': 'api_key.rotated',
    'X-Ailin-Timestamp': emittedAt,
  };

  if (notificationConfig.webhookSecret) {
    const signature = crypto
      .createHmac('sha256', notificationConfig.webhookSecret)
      .update(body)
      .digest('hex');
    headers['X-Ailin-Signature'] = signature;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), notificationConfig.webhookTimeoutMs);

  try {
    const response = await fetchImpl(notificationConfig.webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      notificationLogger.warn(
        {
          channel: 'webhook',
          url: notificationConfig.webhookUrl,
          status: response.status,
        },
        'API key rotation webhook responded with non-OK status'
      );
    } else {
      notificationLogger.info(
        { channel: 'webhook', url: notificationConfig.webhookUrl },
        'API key rotation webhook delivered'
      );
    }
  } catch (error) {
    notificationLogger.warn(
      { error, channel: 'webhook', url: notificationConfig.webhookUrl },
      'Failed to deliver API key rotation webhook'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(value: string | null | undefined): string {
  const stringValue = value ?? '';
  return stringValue
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// Cleanup & Maintenance
// ============================================

/**
 * Revoke expired rotating keys (after grace period)
 * Should run as a scheduled job
 */
export async function revokeExpiredKeys(): Promise<number> {
  const expiredKeys = await prisma.apiKey.findMany({
    where: {
      status: 'rotating',
      expiresAt: { lte: new Date() },
    },
  });

  let revokedCount = 0;

  for (const key of expiredKeys) {
    await prisma.apiKey.update({
      where: { id: key.id },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
      },
    });
    // Best-effort: shrink the auth-cache staleness window below its TTL bound.
    invalidateApiKeyAuthCache(key.quickHash);

    await prisma.apiKeyRotationLog.create({
      data: {
        apiKeyId: key.id,
        action: 'expired',
        reason: 'Grace period ended',
        metadata: {
          originalExpiresAt: key.expiresAt,
        },
      },
    });

    revokedCount++;
  }

  if (revokedCount > 0) {
    logger.info({ revokedCount }, 'Expired rotating keys revoked');
  }

  return revokedCount;
}

/**
 * Check and trigger auto-rotation for keys that need it
 * Should run as a scheduled job
 */
export async function checkAutoRotation(): Promise<number> {
  const now = new Date();

  const keysNeedingRotation = await prisma.apiKey.findMany({
    where: {
      autoRotate: true,
      status: 'active',
      rotationIntervalDays: { not: null },
    },
  });

  let rotatedCount = 0;

  for (const key of keysNeedingRotation) {
    // Calculate next rotation date
    const lastRotation = key.rotatedAt ?? key.createdAt;
    const nextRotationDate = new Date(lastRotation);
    nextRotationDate.setDate(
      nextRotationDate.getDate() + (key.rotationIntervalDays || DEFAULT_ROTATION_INTERVAL_DAYS)
    );

    if (now >= nextRotationDate) {
      try {
        await rotateApiKey({
          keyId: key.id,
          gracePeriodDays: key.gracePeriodDays,
          reason: 'Automatic scheduled rotation',
        });
        rotatedCount++;
      } catch (error) {
        logger.error(
          {
            error,
            apiKeyId: key.id,
          },
          'Failed to auto-rotate API key'
        );
      }
    }
  }

  if (rotatedCount > 0) {
    logger.info({ rotatedCount }, 'Auto-rotated API keys');
  }

  return rotatedCount;
}

// ============================================
// Exports
// ============================================

export const ApiKeyRotationService = {
  generateApiKey,
  hashApiKey,
  quickHash,
  getKeyPrefix,
  validateApiKey,
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  revokeExpiredKeys,
  checkAutoRotation,
};
