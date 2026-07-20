// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { getHeaderString, isObject } from '@/utils/type-guards';

export interface CanonicalIdentityContext {
  userId?: string;
  organizationId?: string;
  tenantId?: string;
  workspaceId?: string;
}

function normalizeString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getQueryString(query: unknown, key: string): string | undefined {
  if (!isObject(query)) return undefined;
  const raw = query[key];
  if (typeof raw === 'string') return normalizeString(raw);
  return undefined;
}

function resolveUserId(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return (
    normalizeString(getHeaderString(headers, 'x-user-id')) ??
    normalizeString(getHeaderString(headers, 'x-auth-request-user')) ??
    getQueryString(query, 'user_id') ??
    getQueryString(query, 'userId')
  );
}

function resolveOrganizationHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return (
    normalizeString(getHeaderString(headers, 'x-organization-id')) ??
    getQueryString(query, 'organizationId') ??
    getQueryString(query, 'organization_id')
  );
}

function resolveTenantHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return normalizeString(getHeaderString(headers, 'x-tenant-id')) ?? getQueryString(query, 'tenant_id');
}

function resolveWorkspaceHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return (
    normalizeString(getHeaderString(headers, 'x-workspace-id')) ??
    getQueryString(query, 'workspace_id') ??
    getQueryString(query, 'workspaceId')
  );
}

/**
 * Resolve canonical identity context at service boundaries.
 *
 * Canonical semantics:
 * - `organizationId` is canonical in CI API.
 * - `tenant_id` is accepted as alias and translated explicitly.
 * - `workspace_id` is preserved as additional context.
 */
export function resolveCanonicalIdentityContext(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): CanonicalIdentityContext {
  const userId = resolveUserId(headers, query);
  const organizationHeader = resolveOrganizationHeader(headers, query);
  const tenantHeader = resolveTenantHeader(headers, query);
  const workspaceHeader = resolveWorkspaceHeader(headers, query);

  const organizationId = organizationHeader ?? tenantHeader ?? workspaceHeader;
  const tenantId = tenantHeader ?? organizationId ?? workspaceHeader;
  const workspaceId = workspaceHeader ?? tenantId ?? organizationId;

  return {
    userId,
    organizationId,
    tenantId,
    workspaceId,
  };
}

export function resolveOrganizationId(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return resolveCanonicalIdentityContext(headers, query).organizationId;
}

export function resolveTenantId(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return resolveCanonicalIdentityContext(headers, query).tenantId;
}

export function resolveWorkspaceId(
  headers: Record<string, string | string[] | undefined> | undefined,
  query?: unknown
): string | undefined {
  return resolveCanonicalIdentityContext(headers, query).workspaceId;
}

export function buildCanonicalContextHeaders(context: CanonicalIdentityContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.userId) headers['X-User-Id'] = context.userId;
  if (context.organizationId) headers['X-Organization-Id'] = context.organizationId;
  if (context.tenantId) headers['X-Tenant-Id'] = context.tenantId;
  if (context.workspaceId) headers['X-Workspace-Id'] = context.workspaceId;
  return headers;
}
