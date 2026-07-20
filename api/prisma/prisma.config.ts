// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma 7.x Configuration
 *
 * This file configures the Prisma CLI for database operations.
 * For Prisma 7+, the datasource URL is configured here instead of schema.prisma.
 *
 * @see https://www.prisma.io/docs/orm/prisma-schema/overview/prisma-config-file
 */

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  // Early access features (optional)
  earlyAccess: true,

  // WHY: Prisma 7 expects `datasource` (singular) in prisma.config.ts.
  // Using `datasources` causes migrate commands to ignore DATABASE_URL.
  datasource: {
    url: env('DATABASE_URL'),
  },
});
