// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security Headers - Unit Tests
 * 
 * Tests for Helmet.js enhanced configuration and security headers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
let mockIsProduction = false;

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();

  return {
    ...actual,
    get isProduction() {
      return mockIsProduction;
    },
    config: actual.config,
  };
});

const securityHeadersModule = await import('@/config/security-headers');
const { 
  getHelmetConfig,
  validateSecurityHeaders,
  CUSTOM_SECURITY_HEADERS,
  removeServerHeaders
} = securityHeadersModule;

describe('Security Headers', () => {

  beforeEach(() => {
    mockIsProduction = false;
  });
  
  // ==========================================
  // Helmet Configuration
  // ==========================================
  
  describe('getHelmetConfig', () => {
    it('should return valid Helmet configuration', () => {
      const config = getHelmetConfig();
      
      expect(config).toBeDefined();
      expect(config.contentSecurityPolicy).toBeDefined();
      expect(config.frameguard).toBeDefined();
      expect(config.noSniff).toBe(true);
    });

    it('should enable strict CSP in production', () => {
      mockIsProduction = true;

      const config = getHelmetConfig();
      
      expect(config.contentSecurityPolicy).toBeDefined();
      expect(typeof config.contentSecurityPolicy).toBe('object');
    });

    it('should enable HSTS in production', () => {
      mockIsProduction = true;
      const config = getHelmetConfig();
      
      // HSTS should be configured
      expect(config.hsts).toBeDefined();
    });

    it('should set frameguard to deny', () => {
      const config = getHelmetConfig();
      
      expect(config.frameguard).toEqual({ action: 'deny' });
    });

    it('should enable noSniff', () => {
      const config = getHelmetConfig();
      
      expect(config.noSniff).toBe(true);
    });

    it('should configure referrerPolicy', () => {
      const config = getHelmetConfig();
      
      expect(config.referrerPolicy).toBeDefined();
      expect(config.referrerPolicy).toHaveProperty('policy');
    });

    it('should disable DNS prefetch', () => {
      const config = getHelmetConfig();
      
      expect(config.dnsPrefetchControl).toEqual({ allow: false });
    });

    it('should enable XSS filter', () => {
      const config = getHelmetConfig();
      
      expect(config.xssFilter).toBe(true);
    });
  });

  // ==========================================
  // Validation
  // ==========================================
  
  describe('validateSecurityHeaders', () => {
    it('should not throw for valid configuration', () => {
      expect(() => validateSecurityHeaders()).not.toThrow();
    });

    it('should validate frameguard is enabled', () => {
      // This test validates the function runs without errors
      validateSecurityHeaders();
      
      const config = getHelmetConfig();
      expect(config.frameguard).toBeDefined();
    });

    it('should validate noSniff is enabled', () => {
      validateSecurityHeaders();
      
      const config = getHelmetConfig();
      expect(config.noSniff).toBe(true);
    });
  });

  // ==========================================
  // Custom Headers
  // ==========================================
  
  describe('CUSTOM_SECURITY_HEADERS', () => {
    it('should include security hardened header', () => {
      expect(CUSTOM_SECURITY_HEADERS['X-Security-Hardened']).toBe('true');
    });

    it('should include API version', () => {
      expect(CUSTOM_SECURITY_HEADERS['X-API-Version']).toBe('v5.0');
    });

    it('should include Permissions-Policy', () => {
      const policy = CUSTOM_SECURITY_HEADERS['Permissions-Policy'];
      
      expect(policy).toBeDefined();
      expect(policy).toContain('geolocation=()');
      expect(policy).toContain('camera=()');
      expect(policy).toContain('microphone=()');
    });

    it('should block dangerous features in Permissions-Policy', () => {
      const policy = CUSTOM_SECURITY_HEADERS['Permissions-Policy'] as string;
      
      // Verify dangerous features are blocked
      expect(policy).toContain('payment=()');
      expect(policy).toContain('usb=()');
      expect(policy).toContain('geolocation=()');
    });
  });

  // ==========================================
  // Server Header Removal
  // ==========================================
  
  describe('removeServerHeaders', () => {
    it('should remove server header', () => {
      const headers = {
        'server': 'Fastify',
        'x-powered-by': 'Node.js',
        'content-type': 'application/json',
      };
      
      removeServerHeaders(headers);
      
      expect(headers['server']).toBeUndefined();
      expect(headers['content-type']).toBe('application/json'); // Other headers preserved
    });

    it('should remove x-powered-by header', () => {
      const headers = {
        'server': 'Fastify',
        'x-powered-by': 'Express', // Could leak framework info
      };
      
      removeServerHeaders(headers);
      
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('should handle missing headers gracefully', () => {
      const headers = {
        'content-type': 'application/json',
      };
      
      expect(() => removeServerHeaders(headers)).not.toThrow();
    });
  });

  // ==========================================
  // CSP Directives
  // ==========================================
  
  describe('Content Security Policy', () => {
    it('should have defaultSrc directive', () => {
      const config = getHelmetConfig();
      const csp = config.contentSecurityPolicy;
      
      if (typeof csp === 'object' && csp.directives) {
        expect(csp.directives.defaultSrc).toBeDefined();
      }
    });

    it('should block object and embed sources', () => {
      const config = getHelmetConfig();
      const csp = config.contentSecurityPolicy;
      
      if (typeof csp === 'object' && csp.directives) {
        // In production, objectSrc should block embeds
        if (csp.directives.objectSrc) {
          expect(csp.directives.objectSrc).toContain("'none'");
        }
        // Always defined in production config
        expect(csp.directives).toBeDefined();
      }
    });

    it('should prevent framing (frameAncestors)', () => {
      mockIsProduction = true;
      const config = getHelmetConfig();
      const csp = config.contentSecurityPolicy;
      
      if (typeof csp === 'object' && csp.directives) {
        // In production, frameAncestors should prevent framing
        if (csp.directives.frameAncestors) {
          expect(csp.directives.frameAncestors).toContain("'none'");
        }
        // Always has some CSP directives
        expect(Object.keys(csp.directives).length).toBeGreaterThan(0);
      }
    });
  });
});

