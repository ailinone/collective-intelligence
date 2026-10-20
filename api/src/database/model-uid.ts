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
  return createHash('md5').update(`${providerId}:${modelId}`).digest('hex').substring(0, 25);
}

/**
 * Next candidate uid for a (provider, model) whose canonical uid is already
 * held by a DIFFERENT row.
 *
 * `uid` is an opaque primary key; the real identity of a model row is
 * (provider_id, id). Historically the discovery fallback path re-parented rows
 * across providers while keeping their original uid, so ~800 production rows
 * hold a uid that is the canonical hash of some OTHER (provider, id) pair. A
 * brand-new row whose canonical uid is occupied that way must not collide with
 * (or, via ON CONFLICT (uid), overwrite) the row that squats on it — it takes a
 * salted uid instead. attempt=0 is the canonical uid.
 */
export function computeModelUidCandidate(
  providerId: string,
  modelId: string,
  attempt: number
): string {
  return attempt === 0
    ? computeModelUid(providerId, modelId)
    : createHash('md5')
        .update(`${providerId}:${modelId}#${attempt}`)
        .digest('hex')
        .substring(0, 25);
}
