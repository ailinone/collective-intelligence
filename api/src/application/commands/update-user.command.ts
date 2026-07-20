// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Update User Command
 * Application Layer: CQRS Command
 *
 * Encapsulates user update request
 */

export class UpdateUserCommand {
  constructor(
    public readonly userId: string,
    public readonly updates: {
      name?: string;
      email?: string;
      // Add more updateable fields as needed
    }
  ) {}
}
