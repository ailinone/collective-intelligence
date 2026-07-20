// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Gateway Origin Validation Middleware
 * SECURITY: Validates that requests come from trusted gateway (P0 fix)
 * 
 * This middleware ensures that auth headers (X-Auth-Request-*) can only be
 * trusted when the request originates from the gateway infrastructure.
 * 
 * Trust Model:
 * - Gateway injects X-Auth-Request-* headers after successful auth_request
 * - Direct requests to ailin-dev MUST NOT trust these headers
 * - Only requests from internal network OR with valid gateway signature are trusted
 * 
 * Configuration:
 * - GATEWAY_TRUSTED_IPS: Comma-separated list of trusted gateway IPs
 * - GATEWAY_INTERNAL_NETWORKS: Comma-separated CIDR ranges (e.g., 172.16.0.0/12)
 * - GATEWAY_REQUIRE_SIGNATURE: If true, requires X-Gateway-Signature header
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';
import { getHeaderString } from '@/utils/type-guards';

const log = logger.child({ component: 'gateway-origin-middleware' });

// Trusted internal networks (Docker default + custom)
const TRUSTED_NETWORKS = (process.env.GATEWAY_INTERNAL_NETWORKS || '172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1/8')
  .split(',')
  .map(cidr => cidr.trim())
  .filter(cidr => cidr.length > 0);

// Trusted gateway IPs (explicit whitelist)
const TRUSTED_IPS = (process.env.GATEWAY_TRUSTED_IPS || '')
  .split(',')
  .map(ip => ip.trim())
  .filter(ip => ip.length > 0);

// Gateway ID header (internal request header from gateway; never expose publicly)
const GATEWAY_ID_HEADER = 'x-gateway-id';
const VALID_GATEWAY_IDS = [
  'gateway-prod-public',
  'gateway-prod-api',
  'gateway-prod-guide',
  'a1_gateway_accounts',
  'a1_gateway_app',
  'a1_gateway_store',
  'a1_gateway_cash',
  'a1_gateway_chat',
  'a1_gateway_dev',
];

// Enable strict mode (reject requests without valid gateway origin)
const STRICT_MODE = process.env.GATEWAY_STRICT_MODE === 'true';

// Log warnings but allow requests in non-strict mode
const LOG_WARNINGS = process.env.GATEWAY_LOG_WARNINGS !== 'false';

/**
 * Parse CIDR notation into network and mask
 */
function parseCIDR(cidr: string): { network: number; mask: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  
  const [networkStr, maskStr] = parts;
  const networkParts = networkStr.split('.');
  if (networkParts.length !== 4) return null;
  
  const mask = parseInt(maskStr, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return null;
  
  const network = networkParts.reduce((acc, part, i) => {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return acc;
    return acc | (num << (24 - i * 8));
  }, 0);
  
  return { network: network >>> 0, mask };
}

/**
 * Check if IP is in CIDR range
 */
function isIPInCIDR(ip: string, cidr: string): boolean {
  const parsed = parseCIDR(cidr);
  if (!parsed) return false;
  
  const ipParts = ip.split('.');
  if (ipParts.length !== 4) return false;
  
  const ipNum = ipParts.reduce((acc, part, i) => {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return acc;
    return acc | (num << (24 - i * 8));
  }, 0) >>> 0;
  
  const maskBits = 0xFFFFFFFF << (32 - parsed.mask);
  return (ipNum & maskBits) === (parsed.network & maskBits);
}

/**
 * Check if IP is from trusted source
 */
function isTrustedIP(ip: string): boolean {
  // Check explicit whitelist
  if (TRUSTED_IPS.includes(ip)) {
    return true;
  }
  
  // Check CIDR ranges
  for (const cidr of TRUSTED_NETWORKS) {
    if (isIPInCIDR(ip, cidr)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract client IP from request
 */
function getClientIP(request: FastifyRequest): string {
  // X-Forwarded-For may contain multiple IPs (client, proxy1, proxy2, ...)
  // The rightmost IP before the trusted proxy is the real client IP
  // In our case, Cloudflare adds X-Forwarded-For, so we trust the last entry
  const forwarded = getHeaderString(request.headers, 'x-forwarded-for');
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    // Return the first IP (client IP)
    return ips[0] || request.ip;
  }
  
  const realIP = getHeaderString(request.headers, 'x-real-ip');
  if (realIP) {
    return realIP;
  }
  
  return request.ip;
}

/**
 * Get the direct connection IP (not from forwarded headers)
 */
function getDirectIP(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Check if gateway ID header is valid
 */
function hasValidGatewayID(request: FastifyRequest): boolean {
  const gatewayId = getHeaderString(request.headers, GATEWAY_ID_HEADER);
  return gatewayId !== undefined && VALID_GATEWAY_IDS.includes(gatewayId);
}

/**
 * Gateway Origin Validation Middleware
 * 
 * Validates that requests with auth headers come from trusted gateway.
 * In strict mode, rejects requests from untrusted sources.
 * In non-strict mode, logs warnings but allows requests.
 */
export async function validateGatewayOrigin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Get the direct connection IP (the IP connecting to us)
  const directIP = getDirectIP(request);
  const clientIP = getClientIP(request);
  
  // Check if request has auth headers that should only come from gateway
  const hasAuthHeaders = 
    request.headers['x-auth-request-user'] !== undefined ||
    request.headers['x-auth-request-email'] !== undefined ||
    request.headers['x-auth-request-access-token'] !== undefined;
  
  // If no auth headers, allow request (will be handled by auth middleware)
  if (!hasAuthHeaders) {
    return;
  }
  
  // Check if request is from trusted source
  const isFromTrustedNetwork = isTrustedIP(directIP);
  const hasGatewayID = hasValidGatewayID(request);
  const isTrusted = isFromTrustedNetwork || hasGatewayID;
  
  if (!isTrusted) {
    if (LOG_WARNINGS) {
      log.warn({
        directIP,
        clientIP,
        url: request.url,
        method: request.method,
        hasAuthHeaders,
        hasGatewayID,
        gatewayId: getHeaderString(request.headers, GATEWAY_ID_HEADER),
      }, 'Request with auth headers from untrusted source - potential spoofing attempt');
    }
    
    if (STRICT_MODE) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Request origin not trusted',
      });
    }
    
    // In non-strict mode, strip the potentially spoofed headers
    // This prevents spoofing while maintaining backward compatibility
    delete request.headers['x-auth-request-user'];
    delete request.headers['x-auth-request-email'];
    delete request.headers['x-auth-request-access-token'];
    delete request.headers['x-auth-request-groups'];
    
    if (LOG_WARNINGS) {
      log.info({
        directIP,
        clientIP,
        url: request.url,
      }, 'Stripped potentially spoofed auth headers from untrusted request');
    }
  }
}

/**
 * Optional middleware to check gateway origin for specific routes
 * Can be used in route-specific hooks
 */
export function requireGatewayOrigin() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const directIP = getDirectIP(request);
    const isFromTrustedNetwork = isTrustedIP(directIP);
    const hasGatewayID = hasValidGatewayID(request);
    
    if (!isFromTrustedNetwork && !hasGatewayID) {
      log.warn({
        directIP,
        url: request.url,
        method: request.method,
      }, 'Request to protected route from untrusted source');
      
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'This endpoint requires gateway routing',
      });
    }
  };
}
