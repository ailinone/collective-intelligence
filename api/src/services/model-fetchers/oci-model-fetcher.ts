// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OCI Model Fetcher
 * Fetches models from Oracle Cloud Infrastructure
 */

import type { ProviderModel } from './provider-model-fetcher.js';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'oci-fetcher' });

/**
 * Flag to prevent repeated logging of the same message
 */
let hasLoggedOciUnavailable = false;

export class OCIModelFetcher {
  private baseUrl = 'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com';
  private models: ProviderModel[] = [];
  private config?: { tenancyId?: string; userId?: string; fingerprint?: string; privateKey?: string; region?: string };

  constructor(config?: { tenancyId?: string; userId?: string; fingerprint?: string; privateKey?: string; region?: string }) {
    // Store config for API calls
    this.config = config;
    // Models will be fetched dynamically from OCI API
  }

  async getModels(): Promise<ProviderModel[]> {
    return this.fetchModels();
  }

  async fetchModels(): Promise<ProviderModel[]> {
    try {
      // Check if we have API configuration
      if (!this.config?.tenancyId || !this.config?.userId) {
        // Only log once to avoid spam
        if (!hasLoggedOciUnavailable) {
          log.debug('OCI API credentials not configured, returning empty model list');
          hasLoggedOciUnavailable = true;
        }
        return [];
      }

      // OCI Generative AI model listing endpoint not available yet
      // Log only once to avoid excessive logging during discovery cycles
      if (!hasLoggedOciUnavailable) {
        log.debug('OCI Generative AI model listing endpoint not available yet; returning empty model set');
        hasLoggedOciUnavailable = true;
      }
      return [];
    } catch (error: unknown) {
      const { getErrorMessage } = await import('@/utils/type-guards');
      const errorMessage = getErrorMessage(error);
      // Only log first error to avoid spam
      if (!hasLoggedOciUnavailable) {
        log.debug({ error: errorMessage }, 'Failed to fetch OCI models');
        hasLoggedOciUnavailable = true;
      }
      return []; // Return empty array instead of hardcoded models
    }
  }

  async validateModel(modelId: string): Promise<boolean> {
    return this.models.some(model => model.id === modelId);
  }

  getProviderName(): string {
    return 'oci';
  }
}
