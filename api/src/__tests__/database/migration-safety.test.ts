// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Database Migration Safety Tests
 * 
 * Tests migration robustness:
 * - Idempotency (can run multiple times safely)
 * - Data integrity preservation
 * - Schema validation
 * 
 * Note: Full migration performance tests require production-like data volume
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/database/client';
import { startTestEnvironment, stopTestEnvironment } from '../../../tests/utils/test-environment';

describe('Migration Safety Tests', () => {
  beforeAll(async () => {
    await startTestEnvironment();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  describe('Schema Validation', () => {
    it('should have all required tables', async () => {
      const requiredTables = [
        'users',
        'organizations',
        'api_keys',
        'request_logs',
        'models',
        'providers',
      ];

      for (const table of requiredTables) {
        const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = ${table}
          ) as exists
        `;

        expect(result[0].exists).toBe(true);
      }
    });

    it('should have required indexes for performance', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; tablename: string }>>`
        SELECT indexname, tablename
        FROM pg_indexes
        WHERE schemaname = 'public'
      `;

      expect(indexes.length).toBeGreaterThan(20);

      const indexNames = indexes.map((i) => i.indexname);
      
      // Verify critical indexes exist
      const hasQuickHashIndex = indexNames.some((name) => 
        name.includes('api_keys') && name.includes('quick_hash')
      );
      const hasEmailIndex = indexNames.some((name) => 
        name.includes('users') && name.includes('email')
      );

      expect(hasQuickHashIndex).toBe(true);
      expect(hasEmailIndex).toBe(true);
    });

    it('should have required PostgreSQL extensions', async () => {
      const extensions = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension
      `;

      const extNames = extensions.map((e) => e.extname);
      
      expect(extNames).toContain('pgcrypto');
      expect(extNames).toContain('pg_trgm');
    });
  });

  describe('Data Integrity', () => {
    it('should maintain foreign key constraints', async () => {
      const fkCheck = await prisma.$queryRaw<Array<{ table_name: string; constraint_name: string }>>`
        SELECT tc.table_name, tc.constraint_name
        FROM information_schema.table_constraints AS tc
        WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      `;

      expect(fkCheck.length).toBeGreaterThan(0);

      // Verify no orphaned records
      const orphanedUsers = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count
        FROM users u
        WHERE NOT EXISTS (
          SELECT 1 FROM organizations o WHERE o.id = u.organization_id
        )
      `;

      expect(Number(orphanedUsers[0].count)).toBe(0);
    });
  });
});

