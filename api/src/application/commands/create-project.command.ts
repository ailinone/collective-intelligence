// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Create Project Command
 * Application Layer: CQRS Command
 */

export class CreateProjectCommand {
  constructor(
    public readonly organizationId: string,
    public readonly createdByUserId: string,
    public readonly name: string,
    public readonly description?: string | null,
    public readonly settings?: Record<string, unknown>
  ) {}
}
