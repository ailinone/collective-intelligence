// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GetUser Query
 * CQRS Pattern: Query (Read Operation)
 *
 * Query = Request for data
 * - Immutable
 * - No side effects
 * - Returns DTOs (not domain entities)
 */

export class GetUserQuery {
  public readonly userId: string;
  public readonly requestedBy?: string;

  constructor(data: { userId: string; requestedBy?: string }) {
    if (!data.userId) {
      throw new Error('UserId is required');
    }

    this.userId = data.userId;
    this.requestedBy = data.requestedBy;
  }
}
