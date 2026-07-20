// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Email Challenge Handler
 * Application Layer: CQRS Handler
 *
 * Handles email challenge requests for code authentication
 */

import { inject as _inject, injectable } from 'tsyringe';
import { RequestEmailChallengeCommand } from '../commands/request-email-challenge.command';
import { getAuthService } from '@/services/auth-service';

export interface RequestEmailChallengeResult {
  success: boolean;
  loginMode?: string;
  challengeId?: string;
  expiresAt?: Date | number;
  cooldownExpiresAt?: number;
  statusCode?: number;
  message?: string;
  error?: string;
}

@injectable()
export class RequestEmailChallengeHandler {
  private authService = getAuthService();

  async execute(command: RequestEmailChallengeCommand): Promise<RequestEmailChallengeResult> {
    try {
      const result = await this.authService.requestEmailCode(command.email, command.organizationId);

      if (!result.success) {
        return {
          success: false,
          statusCode: result.statusCode,
          error: result.error || 'Failed to send email challenge',
        };
      }

      return {
        success: true,
        loginMode: result.loginMode,
        challengeId: result.challengeId,
        expiresAt: result.expiresAt instanceof Date ? result.expiresAt.getTime() : result.expiresAt,
        cooldownExpiresAt: result.cooldownExpiresAt instanceof Date ? result.cooldownExpiresAt.getTime() : result.cooldownExpiresAt,
        message: result.message,
      };
    } catch (error: unknown) {
      // Preserve the specific error message to help diagnose configuration issues
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      console.error('RequestEmailChallengeHandler error:', errorMessage);

      return {
        success: false,
        statusCode: 500,
        error: errorMessage,
      };
    }
  }
}
