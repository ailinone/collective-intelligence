// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Get Project Query
 * Application Layer: CQRS Query
 *
 * Resolves a project by EITHER id OR slug. The handler decides which to
 * use based on which is provided (id takes precedence if both are set,
 * but route handlers should send only one).
 */

export class GetProjectQuery {
  constructor(
    public readonly organizationId: string,
    public readonly idOrSlug: string
  ) {}
}
