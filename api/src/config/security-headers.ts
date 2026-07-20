// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security Headers Configuration (v5.0)
 *
 * Enterprise-grade security headers for production deployment
 *
 * Protects against:
 * - Clickjacking (X-Frame-Options)
 * - MIME-sniffing (X-Content-Type-Options)
 * - XSS (Content-Security-Policy)
 * - Man-in-the-middle (Strict-Transport-Security)
 * - Information leakage (Referrer-Policy)
 * - Feature abuse (Permissions-Policy)
 *
 * Compliance: OWASP, SOC 2, GDPR
 */

import type { FastifyHelmetOptions } from '@fastify/helmet';
import { isProduction } from './index.js';

// ============================================
// Content Security Policy (CSP)
// ============================================

/**
 * CSP directives for production
 *
 * Defense-in-depth against XSS even if input sanitization is bypassed
 */
const CONTENT_SECURITY_POLICY_PRODUCTION = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    // Allow inline scripts (if needed for admin dashboard)
    // "'unsafe-inline'", // ⚠️ Only enable if absolutely necessary
  ],
  styleSrc: ["'self'", "'unsafe-inline'"], // Inline styles for admin UI
  imgSrc: ["'self'", 'data:', 'https:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: [
    "'self'",
    'https://api.openai.com',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    // Add other LLM provider domains
  ],
  frameSrc: ["'none'"], // No iframes
  objectSrc: ["'none'"], // No Flash, Java, etc.
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"], // Prevent clickjacking
  upgradeInsecureRequests: [], // Force HTTPS
};

/**
 * Relaxed CSP for development
 */
const CONTENT_SECURITY_POLICY_DEVELOPMENT = {
  defaultSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  connectSrc: ["'self'", 'http:', 'https:', 'ws:', 'wss:'],
};

// ============================================
// Helmet Configuration
// ============================================

export function getHelmetConfig(): FastifyHelmetOptions {
  const config: FastifyHelmetOptions = {
    // Content Security Policy
    contentSecurityPolicy: isProduction
      ? {
          directives: CONTENT_SECURITY_POLICY_PRODUCTION,
        }
      : {
          directives: CONTENT_SECURITY_POLICY_DEVELOPMENT,
        },

    // HTTP Strict Transport Security (HSTS)
    // Force HTTPS for all future requests (1 year)
    hsts: isProduction
      ? {
          maxAge: 31536000, // 1 year
          includeSubDomains: true,
          preload: true, // Submit to HSTS preload list
        }
      : false, // Disabled in development (localhost uses HTTP)

    // X-Frame-Options (Clickjacking prevention)
    // Modern browsers prefer CSP frame-ancestors, but this provides fallback
    frameguard: {
      action: 'deny', // Never allow framing
    },

    // X-Content-Type-Options (MIME-sniffing prevention)
    noSniff: true,

    // X-Download-Options (IE8+ only, legacy)
    ieNoOpen: true,

    // X-Permitted-Cross-Domain-Policies (Adobe Flash, legacy)
    permittedCrossDomainPolicies: {
      permittedPolicies: 'none',
    },

    // Referrer-Policy (Information leakage prevention)
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },

    // X-DNS-Prefetch-Control (Privacy)
    dnsPrefetchControl: {
      allow: false, // Disable DNS prefetching
    },

    // Permissions-Policy (Feature control)
    // NOTE: Not directly supported by Helmet, will add via custom header

    // X-XSS-Protection (Legacy, disabled in modern browsers)
    // Modern CSP is preferred, but this provides fallback for old browsers
    xssFilter: true,

    // Cross-Origin-Embedder-Policy (COEP)
    crossOriginEmbedderPolicy: isProduction
      ? {
          policy: 'require-corp',
        }
      : false,

    // Cross-Origin-Opener-Policy (COOP)
    crossOriginOpenerPolicy: isProduction
      ? {
          policy: 'same-origin',
        }
      : false,

    // Cross-Origin-Resource-Policy (CORP)
    crossOriginResourcePolicy: isProduction
      ? {
          policy: 'same-origin',
        }
      : false,

    // Origin-Agent-Cluster (Isolation)
    originAgentCluster: true,
  };

  return config;
}

// ============================================
// Security Headers Validation
// ============================================

/**
 * Validate security headers are properly configured
 */
export function validateSecurityHeaders(): void {
  const config = getHelmetConfig();

  // Check critical headers
  if (isProduction) {
    if (!config.hsts) {
      throw new Error('HSTS must be enabled in production');
    }
    if (!config.contentSecurityPolicy) {
      throw new Error('CSP must be enabled in production');
    }
  }

  // Verify frameguard is enabled
  if (!config.frameguard) {
    throw new Error('Frameguard (X-Frame-Options) must be enabled');
  }

  // Verify noSniff is enabled
  if (!config.noSniff) {
    throw new Error('X-Content-Type-Options must be enabled');
  }
}

// ============================================
// Additional Custom Headers
// ============================================

/**
 * Custom security headers not covered by Helmet
 */
export const CUSTOM_SECURITY_HEADERS = {
  // Server header removal (hide server technology)
  'X-Powered-By': '', // Remove (Fastify adds this, we remove it)

  // Custom security header
  'X-Security-Hardened': 'true',

  // API version
  'X-API-Version': 'v5.0',

  // Permissions-Policy (Helmet doesn't support directly)
  'Permissions-Policy': [
    'geolocation=()',
    'camera=()',
    'microphone=()',
    'payment=()',
    'usb=()',
    'fullscreen=(self)',
    'picture-in-picture=()',
  ].join(', '),

  // Rate limit info (added by rate limiter)
  // 'X-RateLimit-Limit': '1000',
  // 'X-RateLimit-Remaining': '999',
  // 'X-RateLimit-Reset': '1699123456',

  // --------------------------------------------------------------------
  // AGPL §13 conveyance headers: every response advertises the license
  // and where to obtain the Corresponding Source. Override X-Source-Code
  // via AGPL_SOURCE_URL when running a modified version — offering YOUR
  // modified source is your own §13 obligation.
  // --------------------------------------------------------------------
  'X-License': 'AGPL-3.0-or-later',
  'X-Source-Code': process.env.AGPL_SOURCE_URL || 'https://github.com/ailinone/collective-intelligence',
  'X-Copyright': '(C) 2026 Ailin One, Inc.',
};

/**
 * Remove server information headers (security by obscurity)
 */
export function removeServerHeaders(headers: Record<string, string | string[] | undefined>): void {
  delete headers['server'];
  delete headers['x-powered-by'];
}
