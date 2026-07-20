// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test Isolation Utilities
 * 
 * Provides robust isolation between test files to prevent data interference
 * when multiple test files share the same database instance.
 * 
 * Each test file gets a unique namespace based on its file path hash,
 * ensuring that cleanup operations only affect data created by that file.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * Generate a unique namespace for a test file
 * Uses the test file path to create a deterministic but unique prefix
 */
export function createTestNamespace(testFilePath: string): string {
  // Create a short hash from the file path
  const hash = createHash('sha256')
    .update(testFilePath)
    .digest('hex')
    .substring(0, 8);
  return `test_${hash}_`;
}

/**
 * Test Isolation Manager
 * Manages isolated test data for a single test file
 */
export class TestIsolationManager {
  private readonly namespace: string;
  private readonly createdOrganizationIds = new Set<string>();
  private readonly createdUserIds = new Set<string>();
  private readonly createdApiKeyIds = new Set<string>();

  constructor(testFilePath: string) {
    this.namespace = createTestNamespace(testFilePath);
  }

  /**
   * Get the namespace prefix for this test file
   */
  getNamespace(): string {
    return this.namespace;
  }

  /**
   * Generate an organization name with the test namespace
   */
  generateOrgName(baseName = 'TestOrg'): string {
    return `${this.namespace}${baseName}_${randomUUID().substring(0, 8)}`;
  }

  /**
   * Generate a unique email with the test namespace
   */
  generateEmail(baseName = 'user'): string {
    return `${this.namespace}${baseName}_${randomUUID().substring(0, 8)}@test.local`;
  }

  /**
   * Track a created organization ID
   */
  trackOrganization(id: string): void {
    this.createdOrganizationIds.add(id);
  }

  /**
   * Track a created user ID
   */
  trackUser(id: string): void {
    this.createdUserIds.add(id);
  }

  /**
   * Track a created API key ID
   */
  trackApiKey(id: string): void {
    this.createdApiKeyIds.add(id);
  }

  /**
   * Get all tracked organization IDs
   */
  getTrackedOrganizations(): string[] {
    return Array.from(this.createdOrganizationIds);
  }

  /**
   * Get all tracked user IDs
   */
  getTrackedUsers(): string[] {
    return Array.from(this.createdUserIds);
  }

  /**
   * Get all tracked API key IDs
   */
  getTrackedApiKeys(): string[] {
    return Array.from(this.createdApiKeyIds);
  }

  /**
   * Clear all tracked IDs (call after cleanup)
   */
  clearTracking(): void {
    this.createdOrganizationIds.clear();
    this.createdUserIds.clear();
    this.createdApiKeyIds.clear();
  }

  /**
   * Cleanup test data for this namespace using Prisma client
   * This only cleans up data tracked by this manager or matching the namespace
   */
  async cleanup(prisma: {
    apiKeyRotationLog?: { deleteMany: (args: { where: { apiKeyId: { in: string[] } } }) => Promise<unknown> };
    apiKey: { deleteMany: (args: { where: { id?: { in: string[] }; organization?: { name: { startsWith: string } } } }) => Promise<unknown> };
    user: { deleteMany: (args: { where: { id?: { in: string[] }; organization?: { name: { startsWith: string } } } }) => Promise<unknown> };
    organization: { deleteMany: (args: { where: { id?: { in: string[] }; name?: { startsWith: string } } }) => Promise<unknown> };
  }): Promise<void> {
    const trackedApiKeys = this.getTrackedApiKeys();
    const trackedUsers = this.getTrackedUsers();
    const trackedOrgs = this.getTrackedOrganizations();

    // Delete in order: rotation logs -> API keys -> users -> organizations
    // This respects foreign key constraints

    // 1. Delete API key rotation logs for tracked API keys
    if (trackedApiKeys.length > 0 && prisma.apiKeyRotationLog) {
      await prisma.apiKeyRotationLog.deleteMany({
        where: { apiKeyId: { in: trackedApiKeys } },
      }).catch(() => undefined);
    }

    // 2. Delete tracked API keys
    if (trackedApiKeys.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { id: { in: trackedApiKeys } },
      }).catch(() => undefined);
    }

    // 3. Delete API keys by namespace (for any missed)
    await prisma.apiKey.deleteMany({
      where: { organization: { name: { startsWith: this.namespace } } },
    }).catch(() => undefined);

    // 4. Delete tracked users
    if (trackedUsers.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: trackedUsers } },
      }).catch(() => undefined);
    }

    // 5. Delete users by namespace (for any missed)
    await prisma.user.deleteMany({
      where: { organization: { name: { startsWith: this.namespace } } },
    }).catch(() => undefined);

    // 6. Delete tracked organizations
    if (trackedOrgs.length > 0) {
      await prisma.organization.deleteMany({
        where: { id: { in: trackedOrgs } },
      }).catch(() => undefined);
    }

    // 7. Delete organizations by namespace (for any missed)
    await prisma.organization.deleteMany({
      where: { name: { startsWith: this.namespace } },
    }).catch(() => undefined);

    this.clearTracking();
  }
}

/**
 * Create a test isolation manager for the current test file
 * Usage: const isolation = createIsolation(__filename);
 */
export function createIsolation(testFilePath: string): TestIsolationManager {
  return new TestIsolationManager(testFilePath);
}
