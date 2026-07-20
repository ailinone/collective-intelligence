// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { LRUCache } from 'lru-cache';
import { prisma } from '@/database/client';
import { config } from '@/config';
import { getTierConfig } from '@/config/multi-tenancy-config';
import type { AuthMode } from '@/types';
import {
  sanitizeOrganizationSettingsOverrides,
  mergeOrganizationSettings,
  type OrganizationSettings,
  type OrganizationSettingsOverrides,
} from '@/domain/value-objects/organization-settings';
import { logger } from '@/utils/logger';
import { toInputJson } from '@/utils/json';

interface CachedSettings {
  effective: OrganizationSettings;
  overrides: OrganizationSettingsOverrides;
}

const cache = new LRUCache<string, CachedSettings>({
  max: 1000,
  ttl: 60_000,
});

function createDefaultSettings(tier: string): OrganizationSettings {
  const tierConfig = getTierConfig(tier);

  const defaultMode: AuthMode = config.auth.defaultMode;
  const allowPasswordFallback = config.auth.allowPasswordFallback;

  return {
    auth: {
      defaultMode,
      allowPasswordFallback,
      mfaRequired: false,
    },
    quotas: {
      requestsPerMinute: tierConfig.requestsPerMinute,
      requestsPerHour: tierConfig.requestsPerHour,
      concurrentRequests: tierConfig.concurrentRequests,
    },
    features: { ...tierConfig.features },
  };
}

function mergeOverrides(
  current: OrganizationSettingsOverrides,
  patch: OrganizationSettingsOverrides
): OrganizationSettingsOverrides {
  const merged: OrganizationSettingsOverrides = { ...current };

  if (patch.auth) {
    merged.auth = { ...(current.auth ?? {}), ...patch.auth };
  }
  if (patch.quotas) {
    merged.quotas = { ...(current.quotas ?? {}), ...patch.quotas };
  }
  if (patch.features) {
    merged.features = { ...(current.features ?? {}), ...patch.features };
  }

  return merged;
}

function pruneUndefined(overrides: OrganizationSettingsOverrides): OrganizationSettingsOverrides {
  const pruned: OrganizationSettingsOverrides = {};

  if (overrides.auth) {
    const auth = Object.fromEntries(
      Object.entries(overrides.auth).filter(([, value]) => value !== undefined && value !== null)
    );
    if (Object.keys(auth).length > 0) {
      pruned.auth = auth as typeof overrides.auth;
    }
  }

  if (overrides.quotas) {
    const quotas = Object.fromEntries(
      Object.entries(overrides.quotas).filter(([, value]) => value !== undefined && value !== null)
    );
    if (Object.keys(quotas).length > 0) {
      pruned.quotas = quotas as typeof overrides.quotas;
    }
  }

  if (overrides.features) {
    const features = Object.fromEntries(
      Object.entries(overrides.features).filter(
        ([, value]) => value !== undefined && value !== null
      )
    );
    if (Object.keys(features).length > 0) {
      pruned.features = features as typeof overrides.features;
    }
  }

  return pruned;
}

class OrganizationSettingsService {
  private log = logger.child({ service: 'organization-settings' });

  async getSettings(organizationId: string): Promise<OrganizationSettings> {
    const cached = cache.get(organizationId);
    if (cached) {
      return cached.effective;
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { tier: true, settings: true },
    });

    if (!organization) {
      throw new Error(`Organization ${organizationId} not found`);
    }

    const overrides = sanitizeOrganizationSettingsOverrides(organization.settings);
    const defaults = createDefaultSettings(organization.tier);
    const effective = mergeOrganizationSettings(defaults, overrides);

    cache.set(organizationId, { effective, overrides });

    return effective;
  }

  async getOverrides(organizationId: string): Promise<OrganizationSettingsOverrides> {
    const cached = cache.get(organizationId);
    if (cached) {
      return cached.overrides;
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true, tier: true },
    });

    if (!organization) {
      throw new Error(`Organization ${organizationId} not found`);
    }

    const overrides = sanitizeOrganizationSettingsOverrides(organization.settings);
    cache.set(organizationId, {
      effective: mergeOrganizationSettings(createDefaultSettings(organization.tier), overrides),
      overrides,
    });
    return overrides;
  }

  async updateSettings(
    organizationId: string,
    patch: OrganizationSettingsOverrides
  ): Promise<OrganizationSettings> {
    const parsedPatch = sanitizeOrganizationSettingsOverrides(patch);
    const currentOverrides = await this.getOverrides(organizationId);
    const mergedOverrides = pruneUndefined(mergeOverrides(currentOverrides, parsedPatch));

    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: {
        settings: toInputJson(mergedOverrides),
      },
      select: { tier: true },
    });

    const defaults = createDefaultSettings(organization.tier);
    const effective = mergeOrganizationSettings(defaults, mergedOverrides);
    cache.set(organizationId, { effective, overrides: mergedOverrides });
    this.log.info({ organizationId }, 'Organization settings updated');
    return effective;
  }

  invalidate(organizationId?: string): void {
    if (organizationId) {
      cache.delete(organizationId);
    } else {
      cache.clear();
    }
  }
}

export const organizationSettingsService = new OrganizationSettingsService();
