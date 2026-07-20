// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

export function normalizeFederatedRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  const map: Record<string, string> = {
    owner: 'owner',
    admin: 'admin',
    editor: 'developer',
    developer: 'developer',
    member: 'member',
    normal: 'member',
    dataset_operator: 'member',
    viewer: 'viewer',
    auditor: 'auditor',
  };
  return map[normalized] ?? 'viewer';
}

