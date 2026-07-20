// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Login With Code Handler
 * Application Layer: CQRS Handler
 *
 * Handles user login with email verification code
 */

import { inject as _inject, injectable } from 'tsyringe';
import { LoginWithCodeCommand } from '../commands/login-with-code.command';
import { getAuthService } from '@/services/auth-service';

export interface LoginWithCodeResult {
  success: boolean;
  userId?: string;
  email?: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
}

@injectable()
export class LoginWithCodeHandler {
  private authService = getAuthService();

  async execute(command: LoginWithCodeCommand): Promise<LoginWithCodeResult> {
    try {
      const result = await this.authService.verifyEmailCode(command.challengeId, command.code);

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Code authentication failed',
        };
      }

      // Calculate expiresIn in seconds from the JWT expiresIn string (e.g., "24h" -> 86400)
      let expiresInSeconds: number | undefined;
      if (result.tokens?.expiresIn) {
        const expiresInStr = result.tokens.expiresIn;
        if (expiresInStr.endsWith('h')) {
          expiresInSeconds = parseInt(expiresInStr.slice(0, -1), 10) * 3600;
        } else if (expiresInStr.endsWith('m')) {
          expiresInSeconds = parseInt(expiresInStr.slice(0, -1), 10) * 60;
        } else if (expiresInStr.endsWith('s')) {
          expiresInSeconds = parseInt(expiresInStr.slice(0, -1), 10);
        } else if (expiresInStr.endsWith('d')) {
          expiresInSeconds = parseInt(expiresInStr.slice(0, -1), 10) * 86400;
        } else {
          // Default to 24 hours if format is unknown
          expiresInSeconds = 86400;
        }
      }

      return {
        success: true,
        userId: result.user?.id,
        email: result.user?.email,
        organizationId: result.user?.organizationId,
        role: result.user?.roles?.[0],
        roles: result.user?.roles,
        accessToken: result.tokens?.accessToken,
        refreshToken: result.tokens?.refreshToken,
        expiresIn: expiresInSeconds,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      console.error('LoginWithCodeHandler error:', errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
