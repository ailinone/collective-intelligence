// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Version Management System
 *
 * Supports multiple API versions simultaneously with:
 * - Version negotiation
 * - Deprecation warnings
 * - Backward compatibility
 * - Version-specific routing
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface VersionedFastifyRequest extends FastifyRequest {
  apiVersion?: string;
}
import { logger } from '@/utils/logger';

export interface APIVersion {
  version: string;
  status: 'active' | 'deprecated' | 'sunset';
  deprecationDate?: Date;
  sunsetDate?: Date;
  supportedUntil?: Date;
  breaking: boolean;
}

export const API_VERSIONS: Record<string, APIVersion> = {
  v1: {
    version: '1.0.0',
    status: 'active',
    breaking: false,
  },
  v2: {
    version: '2.0.0',
    status: 'active', // Will be for future breaking changes
    deprecationDate: undefined,
    sunsetDate: undefined,
    supportedUntil: new Date('2026-12-31'),
    breaking: true,
  },
};

export const DEFAULT_VERSION = 'v1';
export const LATEST_VERSION = 'v1';

/**
 * Extract API version from request
 */
export function getRequestedVersion(request: FastifyRequest): string {
  // Priority 1: Path-based version (/v1/*, /v2/*)
  const pathMatch = request.url.match(/^\/(v\d+)\//);
  if (pathMatch) {
    return pathMatch[1];
  }

  // Priority 2: Header-based version
  const headerVersion = request.headers['api-version'] as string;
  if (headerVersion && API_VERSIONS[headerVersion]) {
    return headerVersion;
  }

  // Priority 3: Query parameter
  const queryParams = request.query as { version?: string } | undefined;
  const queryVersion = queryParams?.version;
  if (queryVersion && API_VERSIONS[queryVersion]) {
    return queryVersion;
  }

  // Default
  return DEFAULT_VERSION;
}

/**
 * Check if version is deprecated
 */
export function isVersionDeprecated(version: string): boolean {
  const versionInfo = API_VERSIONS[version];
  if (!versionInfo) return false;

  return versionInfo.status === 'deprecated' || versionInfo.status === 'sunset';
}

/**
 * Get deprecation warning message
 */
export function getDeprecationWarning(version: string): string | null {
  const versionInfo = API_VERSIONS[version];
  if (!versionInfo || versionInfo.status === 'active') {
    return null;
  }

  if (versionInfo.status === 'sunset') {
    return `API version ${version} is sunset and no longer supported. Please upgrade to ${LATEST_VERSION}.`;
  }

  if (versionInfo.status === 'deprecated') {
    const sunsetDate = versionInfo.sunsetDate
      ? ` and will be sunset on ${versionInfo.sunsetDate.toISOString().split('T')[0]}`
      : '';
    return `API version ${version} is deprecated${sunsetDate}. Please migrate to ${LATEST_VERSION}.`;
  }

  return null;
}

/**
 * Version negotiation middleware
 *
 * Adds version information to request and response headers
 */
export function versionNegotiationMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const requestedVersion = getRequestedVersion(request);
  const versionInfo = API_VERSIONS[requestedVersion];

  // Store version in request for later use
  (request as VersionedFastifyRequest).apiVersion = requestedVersion;

  // Add version headers to response
  reply.header('X-API-Version', requestedVersion);
  reply.header('X-API-Version-Latest', LATEST_VERSION);

  // Check if version exists
  if (!versionInfo) {
    reply.status(400).send({
      error: {
        code: 'unsupported_api_version',
        message: `API version '${requestedVersion}' is not supported. Supported versions: ${Object.keys(
          API_VERSIONS
        ).join(', ')}`,
      },
    });
    return;
  }

  // Check if version is sunset
  if (versionInfo.status === 'sunset') {
    reply.status(410).send({
      error: {
        code: 'api_version_sunset',
        message: getDeprecationWarning(requestedVersion),
      },
    });
    return;
  }

  // Add deprecation warning if applicable
  const deprecationWarning = getDeprecationWarning(requestedVersion);
  if (deprecationWarning) {
    reply.header('Warning', `299 - "${deprecationWarning}"`);
    reply.header('Deprecation', 'true');
    if (versionInfo.sunsetDate) {
      reply.header('Sunset', versionInfo.sunsetDate.toISOString());
    }

    logger.warn(
      {
        version: requestedVersion,
        deprecationDate: versionInfo.deprecationDate,
        sunsetDate: versionInfo.sunsetDate,
        endpoint: request.url,
      },
      'Deprecated API version used'
    );
  }

  done();
}

/**
 * Register version management middleware
 */
export function registerVersionManagement(server: FastifyInstance): void {
  server.addHook('onRequest', versionNegotiationMiddleware);

  logger.info(
    {
      versions: Object.keys(API_VERSIONS),
      default: DEFAULT_VERSION,
      latest: LATEST_VERSION,
    },
    'API version management initialized'
  );
}

/**
 * Version-specific feature flag
 *
 * Use this to conditionally enable features based on API version
 */
export function isFeatureEnabled(request: FastifyRequest, featureName: string): boolean {
  const version = (request as VersionedFastifyRequest).apiVersion || DEFAULT_VERSION;

  // Define version-specific features here
  const versionFeatures: Record<string, string[]> = {
    v1: [
      'chat_completions',
      'embeddings',
      'models',
      'usage_stats',
      'streaming',
      'multi_model_orchestration',
    ],
    v2: [
      // v2 will have all v1 features plus:
      'chat_completions',
      'embeddings',
      'models',
      'usage_stats',
      'streaming',
      'multi_model_orchestration',
      'advanced_orchestration', // New in v2
      'model_fine_tuning', // New in v2
      'custom_providers', // New in v2
    ],
  };

  return versionFeatures[version]?.includes(featureName) ?? false;
}

/**
 * Get API version from request (helper)
 */
export function getAPIVersion(request: FastifyRequest): string {
  return (request as VersionedFastifyRequest).apiVersion || DEFAULT_VERSION;
}
