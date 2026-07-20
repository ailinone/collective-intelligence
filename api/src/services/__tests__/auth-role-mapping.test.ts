// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { normalizeFederatedRole } from '../auth-role-mapping';

describe('normalizeFederatedRole', () => {
  it('maps id roles into ci rbac roles', () => {
    expect(normalizeFederatedRole('owner')).toBe('owner');
    expect(normalizeFederatedRole('admin')).toBe('admin');
    expect(normalizeFederatedRole('editor')).toBe('developer');
    expect(normalizeFederatedRole('normal')).toBe('member');
    expect(normalizeFederatedRole('dataset_operator')).toBe('member');
  });

  it('keeps supported ci roles stable', () => {
    expect(normalizeFederatedRole('developer')).toBe('developer');
    expect(normalizeFederatedRole('member')).toBe('member');
    expect(normalizeFederatedRole('viewer')).toBe('viewer');
    expect(normalizeFederatedRole('auditor')).toBe('auditor');
  });

  it('defaults unknown roles to viewer', () => {
    expect(normalizeFederatedRole('super-user')).toBe('viewer');
    expect(normalizeFederatedRole('')).toBe('viewer');
  });
});
