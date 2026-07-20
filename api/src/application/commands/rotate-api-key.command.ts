// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RotateApiKey Command
 * CQRS Pattern: Command (Write Operation)
 */

export class RotateApiKeyCommand {
  public readonly apiKeyId: string;
  public readonly userId: string;
  public readonly reason: 'manual' | 'auto-rotation' | 'security';
  public readonly requestedBy?: string;

  constructor(data: {
    apiKeyId: string;
    userId: string;
    reason?: 'manual' | 'auto-rotation' | 'security';
    requestedBy?: string;
  }) {
    if (!data.apiKeyId || !data.userId) {
      throw new Error('ApiKeyId and userId are required');
    }

    this.apiKeyId = data.apiKeyId;
    this.userId = data.userId;
    this.reason = data.reason || 'manual';
    this.requestedBy = data.requestedBy;
  }
}
