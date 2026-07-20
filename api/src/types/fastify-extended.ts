// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended Fastify Types
 * Proper typing for Fastify request/reply with custom decorators
 */

import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { TenantContext } from '@/api/middleware/tenant-isolation-middleware';
import type { QueueContext } from '@/api/middleware/queue-manager';
import type { OrchestrationContext } from '@/types';

/**
 * Extended FastifyRequest with custom decorators
 */
export interface ExtendedFastifyRequest extends Omit<FastifyRequest, 'user'> {
  user?: FastifyRequest['user'] | {
    userId: string;
    organizationId: string;
    roles: string[];
    email: string;
    name: string;
  };
  correlationId?: string;
  tenantContext?: TenantContext;
  queueContext?: QueueContext;
  apiKey?: {
    id: string;
    name: string;
    permissions: Record<string, unknown> | null;
  };
  apiVersion?: string;
  userId?: string;
  organizationId?: string;
  organizationTier?: string;
  userContext?: OrchestrationContext;
  metricsStartTime?: bigint;
}

/**
 * Extended FastifyReply with proper status codes
 */
export interface ExtendedFastifyReply extends FastifyReply {
  status(code: number): ExtendedFastifyReply;
}

/**
 * Fastify logger config type
 */
export interface FastifyLoggerConfig {
  level: string;
  base: {
    service: string;
    env: string;
  };
  redact: {
    paths: string[];
    censor: string;
  };
  transport?: {
    target: string;
    options: {
      colorize: boolean;
      translateTime: string;
      ignore: string;
    };
  };
}

/**
 * Provider Registry types
 */
export interface ProviderRegistry {
  get: (provider: string) => unknown;
  getProviderNames: () => string[];
  [key: string]: unknown;
}

export interface InitializeProviderRegistry {
  (providers: unknown[]): Promise<ProviderRegistry>;
}

export interface SetProviderRegistry {
  (registry: ProviderRegistry): void;
}

/**
 * Route registration function types
 */
export type RouteRegistrationFunction = (server: FastifyInstance) => Promise<void> | void;

export interface CodebaseRoutesModule {
  registerCodebaseRoutes: RouteRegistrationFunction;
}

export interface CodebaseAnalysisRoutesModule {
  registerCodebaseAnalysisRoutes: RouteRegistrationFunction;
}

export interface EnterpriseQuotaRoutesModule {
  registerEnterpriseQuotaRoutes: RouteRegistrationFunction;
}

export interface EnterpriseBillingRoutesModule {
  registerEnterpriseBillingRoutes: RouteRegistrationFunction;
}

export interface EnterpriseUsageAnalyticsRoutesModule {
  registerEnterpriseUsageAnalyticsRoutes: RouteRegistrationFunction;
}

export interface CacheRoutesModule {
  registerCacheRoutes: RouteRegistrationFunction;
}

export interface QueueRoutesModule {
  registerQueueRoutes: RouteRegistrationFunction;
}

export interface MetricsRouteModule {
  registerMetricsRoute: RouteRegistrationFunction;
}

export interface StatusRoutesModule {
  registerStatusRoutes: RouteRegistrationFunction | FastifyPluginAsync;
}

export interface ToolsRoutesModule {
  registerToolsRoutes: RouteRegistrationFunction;
}

import type { FastifyPluginAsync } from 'fastify';

