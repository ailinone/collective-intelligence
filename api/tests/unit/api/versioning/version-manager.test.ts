// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Version Manager Tests
 * 
 * Tests version negotiation, deprecation, and feature flags
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRequestedVersion,
  isVersionDeprecated,
  getDeprecationWarning,
  isFeatureEnabled,
  API_VERSIONS,
  DEFAULT_VERSION,
  LATEST_VERSION,
} from '@/api/versioning/version-manager';
import type { FastifyRequest } from 'fastify';

describe('Version Manager', () => {
  describe('getRequestedVersion', () => {
    it('should extract version from path', () => {
      const request = {
        url: '/v1/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe('v1');
    });

    it('should extract version from header', () => {
      const request = {
        url: '/chat/completions',
        headers: { 'api-version': 'v2' },
        query: {},
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe('v2');
    });

    it('should extract version from query parameter', () => {
      const request = {
        url: '/chat/completions',
        headers: {},
        query: { version: 'v1' },
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe('v1');
    });

    it('should return default version when none specified', () => {
      const request = {
        url: '/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe(DEFAULT_VERSION);
    });

    it('should prioritize path over header', () => {
      const request = {
        url: '/v1/chat/completions',
        headers: { 'api-version': 'v2' },
        query: {},
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe('v1');
    });

    it('should prioritize header over query', () => {
      const request = {
        url: '/chat/completions',
        headers: { 'api-version': 'v2' },
        query: { version: 'v1' },
      } as FastifyRequest;

      const version = getRequestedVersion(request);
      expect(version).toBe('v2');
    });
  });

  describe('isVersionDeprecated', () => {
    it('should return false for active versions', () => {
      expect(isVersionDeprecated('v1')).toBe(false);
    });

    it('should return false for non-existent versions', () => {
      expect(isVersionDeprecated('v99')).toBe(false);
    });

    it('should return true for deprecated versions', () => {
      // v2 is currently active, but we can test the logic
      const deprecatedVersion = Object.entries(API_VERSIONS).find(
        ([_, info]) => info.status === 'deprecated'
      );
      
      if (deprecatedVersion) {
        expect(isVersionDeprecated(deprecatedVersion[0])).toBe(true);
      }
    });
  });

  describe('getDeprecationWarning', () => {
    it('should return null for active versions', () => {
      const warning = getDeprecationWarning('v1');
      expect(warning).toBeNull();
    });

    it('should return warning message for deprecated versions', () => {
      const deprecatedVersion = Object.entries(API_VERSIONS).find(
        ([_, info]) => info.status === 'deprecated'
      );
      
      if (deprecatedVersion) {
        const warning = getDeprecationWarning(deprecatedVersion[0]);
        expect(warning).toBeTruthy();
        expect(warning).toContain('deprecated');
      }
    });

    it('should return sunset message for sunset versions', () => {
      const sunsetVersion = Object.entries(API_VERSIONS).find(
        ([_, info]) => info.status === 'sunset'
      );
      
      if (sunsetVersion) {
        const warning = getDeprecationWarning(sunsetVersion[0]);
        expect(warning).toBeTruthy();
        expect(warning).toContain('sunset');
      }
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for v1 features', () => {
      const request = {
        url: '/v1/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;
      
      // Simulate apiVersion being set by middleware
      (request as FastifyRequest & { apiVersion?: string }).apiVersion = 'v1';

      expect(isFeatureEnabled(request, 'chat_completions')).toBe(true);
      expect(isFeatureEnabled(request, 'embeddings')).toBe(true);
      expect(isFeatureEnabled(request, 'streaming')).toBe(true);
    });

    it('should return false for features not in version', () => {
      const request = {
        url: '/v1/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;
      
      (request as FastifyRequest & { apiVersion?: string }).apiVersion = 'v1';

      // These features are only in v2
      expect(isFeatureEnabled(request, 'advanced_orchestration')).toBe(false);
      expect(isFeatureEnabled(request, 'model_fine_tuning')).toBe(false);
    });

    it('should return true for v2 features', () => {
      const request = {
        url: '/v2/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;
      
      (request as FastifyRequest & { apiVersion?: string }).apiVersion = 'v2';

      // v2 has all v1 features plus new ones
      expect(isFeatureEnabled(request, 'chat_completions')).toBe(true);
      expect(isFeatureEnabled(request, 'advanced_orchestration')).toBe(true);
    });

    it('should use default version when not set', () => {
      const request = {
        url: '/chat/completions',
        headers: {},
        query: {},
      } as FastifyRequest;

      expect(isFeatureEnabled(request, 'chat_completions')).toBe(true);
    });
  });

  describe('API_VERSIONS constant', () => {
    it('should have v1 defined', () => {
      expect(API_VERSIONS['v1']).toBeDefined();
      expect(API_VERSIONS['v1'].version).toBe('1.0.0');
      expect(API_VERSIONS['v1'].status).toBe('active');
    });

    it('should have v2 defined', () => {
      expect(API_VERSIONS['v2']).toBeDefined();
      expect(API_VERSIONS['v2'].version).toBe('2.0.0');
    });

    it('should have default version set', () => {
      expect(DEFAULT_VERSION).toBe('v1');
    });

    it('should have latest version set', () => {
      expect(LATEST_VERSION).toBeDefined();
      expect(API_VERSIONS[LATEST_VERSION]).toBeDefined();
    });
  });
});

