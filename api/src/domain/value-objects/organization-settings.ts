// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { z } from 'zod';
import type { AuthMode } from '@/types';

const authModeSchema = z.enum(['email_code', 'password', 'sso']);

export const organizationSettingsOverridesSchema = z
  .object({
    auth: z
      .object({
        defaultMode: authModeSchema.optional(),
        allowPasswordFallback: z.boolean().optional(),
        mfaRequired: z.boolean().optional(),
      })
      .partial()
      .optional(),
    quotas: z
      .object({
        requestsPerMinute: z.number().int().positive().optional(),
        requestsPerHour: z.number().int().positive().optional(),
        concurrentRequests: z.number().int().positive().optional(),
        tokensPerDay: z.number().int().positive().optional(),
        costPerHourUsd: z.number().nonnegative().optional(),
      })
      .partial()
      .optional(),
    features: z
      .object({
        advancedOrchestration: z.boolean().optional(),
        multiModelExecution: z.boolean().optional(),
        prioritySupport: z.boolean().optional(),
        customModels: z.boolean().optional(),
        apiAccess: z.boolean().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export type OrganizationSettingsOverrides = z.infer<typeof organizationSettingsOverridesSchema>;

export interface OrganizationSettings {
  auth: {
    defaultMode: AuthMode;
    allowPasswordFallback: boolean;
    mfaRequired: boolean;
  };
  quotas: {
    requestsPerMinute: number;
    requestsPerHour: number;
    concurrentRequests: number;
    tokensPerDay?: number;
    costPerHourUsd?: number;
  };
  features: {
    advancedOrchestration: boolean;
    multiModelExecution: boolean;
    prioritySupport: boolean;
    customModels: boolean;
    apiAccess: boolean;
  };
}

export function mergeOrganizationSettings(
  base: OrganizationSettings,
  overrides?: OrganizationSettingsOverrides
): OrganizationSettings {
  if (!overrides) {
    return base;
  }

  const merged: OrganizationSettings = {
    auth: {
      ...base.auth,
      ...(overrides.auth ?? {}),
      defaultMode: overrides.auth?.defaultMode ?? base.auth.defaultMode,
      allowPasswordFallback:
        overrides.auth?.allowPasswordFallback ?? base.auth.allowPasswordFallback,
      mfaRequired: overrides.auth?.mfaRequired ?? base.auth.mfaRequired,
    },
    quotas: {
      ...base.quotas,
      ...(overrides.quotas ?? {}),
      requestsPerMinute: overrides.quotas?.requestsPerMinute ?? base.quotas.requestsPerMinute,
      requestsPerHour: overrides.quotas?.requestsPerHour ?? base.quotas.requestsPerHour,
      concurrentRequests: overrides.quotas?.concurrentRequests ?? base.quotas.concurrentRequests,
      tokensPerDay: overrides.quotas?.tokensPerDay ?? base.quotas.tokensPerDay,
      costPerHourUsd: overrides.quotas?.costPerHourUsd ?? base.quotas.costPerHourUsd,
    },
    features: {
      ...base.features,
      ...(overrides.features ?? {}),
      advancedOrchestration:
        overrides.features?.advancedOrchestration ?? base.features.advancedOrchestration,
      multiModelExecution:
        overrides.features?.multiModelExecution ?? base.features.multiModelExecution,
      prioritySupport: overrides.features?.prioritySupport ?? base.features.prioritySupport,
      customModels: overrides.features?.customModels ?? base.features.customModels,
      apiAccess: overrides.features?.apiAccess ?? base.features.apiAccess,
    },
  };

  return merged;
}

export function sanitizeOrganizationSettingsOverrides(
  value: unknown
): OrganizationSettingsOverrides {
  return organizationSettingsOverridesSchema.parse(value ?? {});
}
