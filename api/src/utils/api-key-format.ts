// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Canonical API key prefix and format helpers.
 *
 * Single source of truth for "does this token look like an API key" —
 * previously duplicated as raw `startsWith('ak_')` literals across three
 * separate middleware modules (api-key-auth-middleware.ts, server.ts,
 * middleware/auth-middleware.ts), which made the prefix impossible to
 * change safely without missing a spot.
 *
 * Legacy note: customer keys already issued under any `ak_`-rooted shape
 * (`ak_live_...`, `ak_test_...`, `ak_local_...`, or bare `ak_<random>`)
 * must keep authenticating indefinitely — there is no rotation deadline
 * forcing existing customers onto the new prefix. New keys, from every
 * issuance path, use API_KEY_PREFIX going forward.
 */

export const API_KEY_PREFIX = 'ai1sk_';

const LEGACY_API_KEY_PREFIX = 'ak_';

/** True for the current prefix or any legacy `ak_`-rooted shape. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX) || token.startsWith(LEGACY_API_KEY_PREFIX);
}

/** The matched prefix (current or legacy), or null if `token` isn't API-key-shaped. */
export function matchApiKeyPrefix(token: string): string | null {
  if (token.startsWith(API_KEY_PREFIX)) return API_KEY_PREFIX;
  if (token.startsWith(LEGACY_API_KEY_PREFIX)) return LEGACY_API_KEY_PREFIX;
  return null;
}
