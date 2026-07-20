// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Archive Project Command
 * Application Layer: CQRS Command
 *
 * Reversible soft-delete — sets status='archived' + archivedAt.
 * Hard delete is a separate admin-only flow (CWE-274 mitigation).
 */

export class ArchiveProjectCommand {
  constructor(
    public readonly projectId: string,
    public readonly requesterUserId: string,
    public readonly requesterOrganizationId: string
  ) {}
}

export class RestoreProjectCommand {
  constructor(
    public readonly projectId: string,
    public readonly requesterUserId: string,
    public readonly requesterOrganizationId: string
  ) {}
}
