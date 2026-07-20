// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const MOCK_KEY_PATTERNS = [/mock/i, /test-/i, /do-not-use/i];

export function isLiveProviderMode(): boolean {
  return process.env.TEST_USE_REAL_API_KEYS === 'true' && process.env.TEST_SKIP_EXTERNAL_APIS !== 'true';
}

export function isLikelyRealApiKey(apiKey?: string): boolean {
  if (!apiKey) {
    return false;
  }

  return !MOCK_KEY_PATTERNS.some((pattern) => pattern.test(apiKey));
}

export function shouldRunLiveProviderSuite(apiKey?: string): boolean {
  return isLiveProviderMode() && isLikelyRealApiKey(apiKey);
}

