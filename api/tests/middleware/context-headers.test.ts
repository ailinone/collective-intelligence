// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  buildCanonicalContextHeaders,
  resolveCanonicalIdentityContext,
} from '../../src/utils/context-headers.js';

describe('context-headers', () => {
  it('translates tenant header into organization context when organization header is missing', () => {
    const context = resolveCanonicalIdentityContext({
      'x-tenant-id': 'tenant-123',
      'x-user-id': 'user-123',
    });

    expect(context.userId).toBe('user-123');
    expect(context.organizationId).toBe('tenant-123');
    expect(context.tenantId).toBe('tenant-123');
    expect(context.workspaceId).toBe('tenant-123');
  });

  it('prefers explicit organization header over tenant header for organizationId', () => {
    const context = resolveCanonicalIdentityContext({
      'x-organization-id': 'org-123',
      'x-tenant-id': 'tenant-123',
    });

    expect(context.organizationId).toBe('org-123');
    expect(context.tenantId).toBe('tenant-123');
  });

  it('resolves query aliases for organization and workspace', () => {
    const context = resolveCanonicalIdentityContext({}, {
      organizationId: 'org-query',
      workspace_id: 'workspace-query',
    });

    expect(context.organizationId).toBe('org-query');
    expect(context.tenantId).toBe('org-query');
    expect(context.workspaceId).toBe('workspace-query');
  });

  it('builds canonical propagation headers', () => {
    const headers = buildCanonicalContextHeaders({
      userId: 'user-a',
      organizationId: 'org-a',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    });

    expect(headers).toEqual({
      'X-User-Id': 'user-a',
      'X-Organization-Id': 'org-a',
      'X-Tenant-Id': 'tenant-a',
      'X-Workspace-Id': 'workspace-a',
    });
  });
});
