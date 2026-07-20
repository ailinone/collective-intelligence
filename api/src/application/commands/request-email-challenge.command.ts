// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Email Challenge Command
 * Application Layer: CQRS Command
 *
 * Encapsulates email challenge request for code authentication
 */

export class RequestEmailChallengeCommand {
  constructor(
    public readonly email: string,
    public readonly organizationId?: string
  ) {}
}
