// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { toInputJson } from '@/utils/json';
import { securityEventsTotal } from '@/utils/metrics';
import { getPrismaErrorCode } from '@/utils/prisma-error-helpers';

const log = logger.child({ component: 'security-audit' });
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SecurityEvent {
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  userId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordSecurityEvent(event: SecurityEvent): Promise<void> {
  securityEventsTotal
    .labels(event.eventType, event.severity, event.organizationId ? 'true' : 'false')
    .inc();

  if (!config.security.audit.enabled) {
    return;
  }

  logWithSeverity(event);

  try {
    const data = await resolveAuditPayload(event);
    await prisma.securityAuditLog.create({ data });
  } catch (error) {
    log.error({ error, event }, 'Failed to persist security audit log');
  }
}

async function resolveAuditPayload(
  event: SecurityEvent
): Promise<Prisma.SecurityAuditLogUncheckedCreateInput> {
  const metadata: Record<string, unknown> =
    typeof event.metadata === 'object' && event.metadata !== null && !Array.isArray(event.metadata)
      ? { ...(event.metadata as Record<string, unknown>) }
      : event.metadata !== undefined
        ? { originalMetadata: event.metadata }
        : {};

  let resolvedOrganizationId: string | null = null;
  if (event.organizationId) {
    if (!isLikelyUuid(event.organizationId)) {
      metadata.attemptedOrganizationId = event.organizationId;
      log.warn(
        {
          eventType: event.eventType,
          attemptedOrganizationId: event.organizationId,
        },
        'Security audit event received with non-UUID organization identifier. Persisting with null organizationId.'
      );
    } else {
      try {
        const organizationExists = await prisma.organization.count({
          where: { id: event.organizationId },
        });

        if (organizationExists > 0) {
          resolvedOrganizationId = event.organizationId;
        } else {
          metadata.attemptedOrganizationId = event.organizationId;
          log.warn(
            {
              eventType: event.eventType,
              attemptedOrganizationId: event.organizationId,
            },
            'Security audit event received for unknown organization. Persisting with null organizationId.'
          );
        }
      } catch (error) {
        if (isInvalidIdentifierError(error)) {
          metadata.attemptedOrganizationId = event.organizationId;
          log.warn(
            {
              eventType: event.eventType,
              attemptedOrganizationId: event.organizationId,
            },
            'Security audit event received with invalid organization identifier. Persisting with null organizationId.'
          );
        } else {
          throw error;
        }
      }
    }
  }

  let resolvedUserId: string | null = null;
  if (event.userId) {
    if (!isLikelyUuid(event.userId)) {
      metadata.attemptedUserId = event.userId;
      log.warn(
        {
          eventType: event.eventType,
          attemptedUserId: event.userId,
        },
        'Security audit event received with non-UUID user identifier. Persisting with null userId.'
      );
    } else {
      try {
        const userExists = await prisma.user.count({
          where: { id: event.userId },
        });

        if (userExists > 0) {
          resolvedUserId = event.userId;
        } else {
          metadata.attemptedUserId = event.userId;
          log.warn(
            {
              eventType: event.eventType,
              attemptedUserId: event.userId,
            },
            'Security audit event received for unknown user. Persisting with null userId.'
          );
        }
      } catch (error) {
        if (isInvalidIdentifierError(error)) {
          metadata.attemptedUserId = event.userId;
          log.warn(
            {
              eventType: event.eventType,
              attemptedUserId: event.userId,
            },
            'Security audit event received with invalid user identifier. Persisting with null userId.'
          );
        } else {
          throw error;
        }
      }
    }
  }

  const metadataPayload = Object.keys(metadata).length
    ? (toInputJson(metadata) ?? Prisma.JsonNull)
    : Prisma.JsonNull;

  return {
    eventType: event.eventType,
    severity: event.severity,
    message: event.message,
    userId: resolvedUserId,
    organizationId: resolvedOrganizationId,
    metadata: metadataPayload,
  };
}

function logWithSeverity(event: SecurityEvent): void {
  if (event.severity === 'critical') {
    log.error(event, event.message);
    return;
  }

  if (event.severity === 'warning') {
    log.warn(event, event.message);
    return;
  }

  log.info(event, event.message);
}

function isInvalidIdentifierError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return getPrismaErrorCode(error) === 'P2023';
}

function isLikelyUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
