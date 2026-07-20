// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Tenancy Enhanced Configuration
 * Infrastructure Layer: Multi-tenant isolation
 *
 * Enterprise-grade multi-tenancy with:
 * - Resource isolation
 * - Connection pools per tenant
 * - Redis namespacing
 * - Resource quotas
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { Prisma, type UsageQuota } from '@/generated/prisma/index.js';

// Alias for Prisma error type (Prisma 7+ compatible)
const PrismaClientKnownRequestError = Prisma.PrismaClientKnownRequestError;

const log = logger.child({ component: 'multi-tenancy-config' });

/**
 * Tenant Tier Configuration
 * Defines resource limits and capabilities per tier
 */
export interface TierConfig {
  name: string;

  // Database resources
  maxConnections: number;
  connectionPoolSize: number;
  queryTimeout: number; // milliseconds

  // API resources
  requestsPerMinute: number;
  requestsPerHour: number;
  concurrentRequests: number;

  // Storage resources
  maxStorageGB: number;
  maxFileSize: number; // bytes

  // Feature flags
  features: {
    advancedOrchestration: boolean;
    multiModelExecution: boolean;
    prioritySupport: boolean;
    customModels: boolean;
    apiAccess: boolean;
  };
}

/**
 * Tier configurations
 */
export const TIER_CONFIGS: Record<string, TierConfig> = {
  free: {
    name: 'Free',
    maxConnections: 5,
    connectionPoolSize: 2,
    queryTimeout: 5000,
    requestsPerMinute: 10,
    requestsPerHour: 100,
    concurrentRequests: 2,
    maxStorageGB: 1,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    features: {
      advancedOrchestration: false,
      multiModelExecution: false,
      prioritySupport: false,
      customModels: false,
      apiAccess: true,
    },
  },

  pro: {
    name: 'Pro',
    maxConnections: 20,
    connectionPoolSize: 10,
    queryTimeout: 10000,
    requestsPerMinute: 100,
    requestsPerHour: 5000,
    concurrentRequests: 10,
    maxStorageGB: 50,
    maxFileSize: 100 * 1024 * 1024, // 100MB
    features: {
      advancedOrchestration: true,
      multiModelExecution: true,
      prioritySupport: false,
      customModels: false,
      apiAccess: true,
    },
  },

  enterprise: {
    name: 'Enterprise',
    maxConnections: 100,
    connectionPoolSize: 50,
    queryTimeout: 30000,
    requestsPerMinute: 1000,
    requestsPerHour: 50000,
    concurrentRequests: 50,
    maxStorageGB: 1000,
    maxFileSize: 1024 * 1024 * 1024, // 1GB
    features: {
      advancedOrchestration: true,
      multiModelExecution: true,
      prioritySupport: true,
      customModels: true,
      apiAccess: true,
    },
  },
};

/**
 * Get tier configuration
 */
export function getTierConfig(tier: string): TierConfig {
  const config = TIER_CONFIGS[tier.toLowerCase()];

  if (!config) {
    log.warn({ tier }, 'Unknown tier, falling back to free');
    return TIER_CONFIGS.free;
  }

  return config;
}

/**
 * Validate if organization can perform action based on tier
 */
export function canPerformAction(tier: string, action: keyof TierConfig['features']): boolean {
  const config = getTierConfig(tier);
  return config.features[action] || false;
}

/**
 * Get Redis namespace for tenant
 * Ensures Redis key isolation between tenants
 */
export function getRedisNamespace(organizationId: string): string {
  return `tenant:${organizationId}`;
}

/**
 * Get database schema for tenant (if using schema-per-tenant)
 * For now, using shared schema with organizationId filtering
 */
export function getDatabaseSchema(organizationId: string): string {
  const schemaPrefix = process.env.TENANT_SCHEMA_PREFIX;
  if (schemaPrefix && organizationId) {
    return `${schemaPrefix}${organizationId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }
  return 'public'; // Shared schema (Row-Level Security via organizationId)
}

/**
 * Check if tenant is within resource quota
 */
export interface QuotaCheck {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
}

export async function checkQuota(
  organizationId: string,
  tier: string,
  resourceType: 'requests' | 'storage' | 'connections'
): Promise<QuotaCheck> {
  const config = getTierConfig(tier);

  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setMinutes(0, 0, 0);
  const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);

  const where = {
    organizationId_period_periodStart: {
      organizationId,
      period: 'hourly',
      periodStart,
    },
  };

  let quota: UsageQuota | null = await prisma.usageQuota
    .upsert({
      where,
      update: {
        requestLimit: config.requestsPerHour,
        periodEnd,
      },
      create: {
        organizationId,
        period: 'hourly',
        periodStart,
        periodEnd,
        requestLimit: config.requestsPerHour,
      },
    })
    .catch(async (error) => {
      if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.usageQuota.findUnique({
          where,
        });
        if (existing) {
          return existing;
        }
        return null;
      }
      throw error;
    });

  if (!quota) {
    quota = await prisma.usageQuota.findUnique({ where });
    if (!quota) {
      throw new Error('Failed to load usage quota after conflict');
    }
  }

  if (resourceType === 'requests') {
    const remaining = quota.requestLimit - quota.requestCount;
    return {
      allowed: remaining > 0,
      current: quota.requestCount,
      limit: quota.requestLimit,
      remaining: Math.max(remaining, 0),
    };
  }

  if (resourceType === 'connections') {
    const remaining = config.maxConnections - quota.fileCount; // reuse column for tracking concurrent usage
    return {
      allowed: remaining > 0,
      current: quota.fileCount,
      limit: config.maxConnections,
      remaining: Math.max(remaining, 0),
    };
  }

  const storageUsed = quota.tokenCount;
  const storageLimit = config.maxStorageGB * 1024 * 1024 * 1024;

  return {
    allowed: storageUsed < storageLimit,
    current: Number(storageUsed),
    limit: storageLimit,
    remaining: Math.max(storageLimit - Number(storageUsed), 0),
  };
}

log.info('✅ Multi-tenancy configuration loaded');
