// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * List API Keys Handler
 * Application Layer: CQRS Query Handler
 */

import { injectable, inject } from 'tsyringe';
import { ListApiKeysQuery } from '../queries/list-api-keys.query';
import { IApiKeyRepository } from '@/domain/repositories/iapi-key-repository';

export interface ListApiKeysResult {
  success: boolean;
  apiKeys?: Array<{
    id: string;
    name: string;
    status: string;
    lastUsedAt: string | null;
    createdAt: string;
  }>;
  error?: string;
}

@injectable()
export class ListApiKeysHandler {
  constructor(@inject('IApiKeyRepository') private readonly apiKeyRepository: IApiKeyRepository) {}

  async execute(query: ListApiKeysQuery): Promise<ListApiKeysResult> {
    try {
      const apiKeys = await this.apiKeyRepository.findByUser(query.userId);

      return {
        success: true,
        apiKeys: apiKeys.map((key) => ({
          id: key.id,
          name: key.name,
          status: key.status,
          lastUsedAt: key.toPersistence().lastUsedAt?.toISOString() || null,
          createdAt: key.toPersistence().createdAt.toISOString(),
        })),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
