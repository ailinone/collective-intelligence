// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';

interface CacheRuntimeSnapshot {
  enabled: boolean;
  reason: string | null;
  details?: unknown;
}

let runtimeEnabled = true;
let runtimeReason: string | null = null;
let runtimeDetails: unknown;

export function initializeCacheRuntime(initiallyEnabled: boolean): void {
  runtimeEnabled = initiallyEnabled;
  runtimeReason = initiallyEnabled ? null : 'disabled_by_configuration';
  runtimeDetails = undefined;
  logger.debug({ initiallyEnabled }, 'Cache runtime state initialized');
}

export function isCacheEnabled(tenantContext?: { organizationId?: string }): boolean {
  if (!runtimeEnabled) {
    return false;
  }

  if (!tenantContext) {
    return true;
  }

  if (!tenantContext?.organizationId) {
    logger.warn({ tenantContext }, 'Cache access denied: tenant context missing organizationId');
    return false;
  }

  return true;
}

export function disableCacheRuntime(
  reason: string,
  details?: unknown,
  organizationId?: string
): void {
  if (!runtimeEnabled) {
    logger.debug(
      { reason, organizationId },
      'Cache runtime already disabled, ignoring duplicate call'
    );
    return;
  }

  runtimeEnabled = false;
  runtimeReason = reason;
  runtimeDetails =
    details instanceof Error
      ? {
          name: details.name,
          message: details.message,
          stack: details.stack,
        }
      : details;

  logger.warn(
    {
      reason,
      organizationId,
      details: runtimeDetails,
    },
    'Cache runtime disabled'
  );
}

export function getCacheRuntimeState(): CacheRuntimeSnapshot {
  return {
    enabled: runtimeEnabled,
    reason: runtimeReason,
    details: runtimeDetails,
  };
}
