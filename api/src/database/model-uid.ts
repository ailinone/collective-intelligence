// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Deterministic UID generator for multi-provider models.
 *
 * The `models` table uses `uid` as its primary key instead of `id`,
 * because the same model ID (e.g. "gpt-4o") can exist across multiple
 * providers (OpenAI direct, Azure, OpenRouter, etc.).
 *
 * uid = MD5(provider_id + ':' + model_id)[0:25]
 *
 * This matches the SQL migration 20260410_multi_provider_models.
 */
import { createHash } from 'crypto';

/**
 * Compute a deterministic uid for a model given its provider and model ID.
 * Must match the DB formula: SUBSTRING(MD5(provider_id || ':' || id), 1, 25)
 */
export function computeModelUid(providerId: string, modelId: string): string {
  return createHash('md5')
    .update(`${providerId}:${modelId}`)
    .digest('hex')
    .substring(0, 25);
}
