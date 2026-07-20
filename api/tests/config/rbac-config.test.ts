// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '@/config/rbac-defaults';

describe('RBAC default role seeds', () => {
  it('includes viewer role with read-only permissions', () => {
    const viewerRole = DEFAULT_ROLES.find((role) => role.name === 'viewer');

    expect(viewerRole).toBeDefined();
    expect(viewerRole?.permissions).toEqual(['org:read', 'users:read']);
  });
});

