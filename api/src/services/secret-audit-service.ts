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
import type { SecretsProviderType } from '@/types';
import { toInputJson } from '@/utils/json';
import { getPrismaErrorCode } from '@/utils/prisma-error-helpers';

export interface SecretAuditRecord {
  event: 'accessed' | 'created' | 'updated' | 'deleted' | 'rotated';
  secretKey: string;
  providerId: string;
  providerType: SecretsProviderType;
  success: boolean;
  cacheHit: boolean;
  durationMs: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

const DB_RETRY_BACKOFF_MS = 30_000;
let persistenceReady = false;
let persistenceSuspendedUntil = 0;
const OPTIONAL_SECRET_KEYS = new Set([
  'gcs-files-bucket',
  'azure-openai-api-key',
  'azure-openai-endpoint',
  'azure-openai-deployment',
  'orqai-key',
  'orqai-api-key',
  'edenai-key',
  'edenai-api-key',
  'heliconeai-key',
  'heliconeai-api-key',
  'nvidia-key',
  'nvidia-api-key',
  'nvidia-hub-key',
  'nvidia-hub-api-key',
  'aihubmix-key',
  'aihubmix-api-key',
  'novita-key',
  'novita-api-key',
  'moonshot-key',
  'moonshot-api-key',
  'minimax-key',
  'minimax-api-key',
  'jina-key',
  'jina-api-key',
  'friendli-key',
  'friendli-api-key',
  'friendli-team-id',
  'aiml-key',
  'aiml-api-key',
  'imagerouter-key',
  'imagerouter-api-key',
  'oci-tenancy-id',
  'oci-user-id',
  'oci-fingerprint',
  'oci-private-key',
]);

function isExpectedOptionalMissingSecret(record: SecretAuditRecord): boolean {
  if (record.success) {
    return false;
  }
  if (record.event !== 'accessed') {
    return false;
  }
  if (!OPTIONAL_SECRET_KEYS.has(record.secretKey)) {
    return false;
  }
  const error = record.errorMessage?.toLowerCase() ?? '';
  return error.includes('not found') || error.includes('no versions');
}

export function markSecretAuditPersistenceReady(): void {
  persistenceReady = true;
  persistenceSuspendedUntil = 0;
}

export async function recordSecretAudit(record: SecretAuditRecord): Promise<void> {
  if (!config.secrets.audit.enabled) {
    return;
  }

  const logPayload = {
    event: record.event,
    secretKey: record.secretKey,
    providerId: record.providerId,
    providerType: record.providerType,
    success: record.success,
    cacheHit: record.cacheHit,
    durationMs: record.durationMs,
    error: record.errorMessage,
  };

  if (record.success) {
    if (record.event === 'accessed') {
      logger.debug(logPayload, `Secret ${record.event}: ${record.secretKey}`);
    } else {
      logger.info(logPayload, `Secret ${record.event}: ${record.secretKey}`);
    }
  } else if (isExpectedOptionalMissingSecret(record)) {
    logger.debug(logPayload, `Optional secret unavailable: ${record.secretKey}`);
  } else {
    logger.warn(logPayload, `Secret ${record.event} FAILED: ${record.secretKey}`);
  }

  if (!config.secrets.audit.persist) {
    return;
  }

  if (!persistenceReady) {
    logger.debug(
      { secretKey: record.secretKey, event: record.event },
      'Secret audit persistence skipped: database not ready yet'
    );
    return;
  }

  if (Date.now() < persistenceSuspendedUntil) {
    return;
  }

  try {
    await prisma.secretAccessLog.create({
      data: {
        event: record.event,
        secretKey: record.secretKey,
        providerId: record.providerId,
        providerType: record.providerType,
        success: record.success,
        cacheHit: record.cacheHit,
        durationMs: record.durationMs,
        errorMessage: record.errorMessage,
        metadata: toInputJson(record.metadata) ?? Prisma.JsonNull,
      },
    });
  } catch (error) {
    const prismaCode = getPrismaErrorCode(error);
    if (prismaCode === 'P1001') {
      persistenceSuspendedUntil = Date.now() + DB_RETRY_BACKOFF_MS;
      logger.warn(
        { retryInMs: DB_RETRY_BACKOFF_MS, code: prismaCode },
        'Secret audit persistence temporarily suspended: database unreachable'
      );
      return;
    }

    logger.error({ error }, 'Failed to persist secret audit log');
  }
}
