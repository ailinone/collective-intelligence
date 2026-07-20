// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

export interface RoleSeed {
  name: string;
  description?: string;
  permissions: string[];
}

export const DEFAULT_PERMISSIONS: Array<{ name: string; description: string; category?: string }> =
  [
    { name: 'org:read', description: 'Read organization profile', category: 'organization' },
    { name: 'org:update', description: 'Update organization settings', category: 'organization' },
    { name: 'users:read', description: 'View organization users', category: 'users' },
    { name: 'users:invite', description: 'Invite new users', category: 'users' },
    { name: 'users:role_assign', description: 'Assign or revoke roles', category: 'users' },
    { name: 'billing:read', description: 'View billing information', category: 'billing' },
    { name: 'billing:update', description: 'Modify billing configuration', category: 'billing' },
    { name: 'apikeys:manage', description: 'Create or revoke API keys', category: 'security' },
    { name: 'secrets:manage', description: 'Manage managed secrets', category: 'security' },
    { name: 'models:manage', description: 'Manage custom models/catalog', category: 'models' },
    { name: 'quotas:override', description: 'Adjust quota allocations', category: 'operations' },
    { name: 'audit:read', description: 'Read security audit logs', category: 'security' },
    {
      name: 'jobs:trigger',
      description: 'Trigger operational jobs (rotation, sync)',
      category: 'operations',
    },
  ];

export const DEFAULT_ROLES: RoleSeed[] = [
  {
    name: 'viewer',
    description: 'Read-only access to organization workspace data',
    permissions: ['org:read', 'users:read'],
  },
  {
    name: 'owner',
    description: 'Full control over the organization',
    permissions: DEFAULT_PERMISSIONS.map((perm) => perm.name),
  },
  {
    name: 'admin',
    description: 'Manage users, billing, and operations',
    permissions: [
      'org:read',
      'org:update',
      'users:read',
      'users:invite',
      'users:role_assign',
      'billing:read',
      'billing:update',
      'apikeys:manage',
      'models:manage',
      'audit:read',
      'jobs:trigger',
    ],
  },
  {
    name: 'developer',
    description: 'Build and operate workflows',
    permissions: ['org:read', 'users:read', 'models:manage'],
  },
  {
    name: 'member',
    description: 'Standard access for daily tasks',
    permissions: ['org:read', 'users:read'],
  },
  {
    name: 'auditor',
    description: 'Read-only access to security and billing data',
    permissions: ['org:read', 'users:read', 'billing:read', 'audit:read'],
  },
];
