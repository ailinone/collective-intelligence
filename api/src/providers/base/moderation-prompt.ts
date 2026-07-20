// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Centralized moderation analyzer prompt (R9).
 *
 * Prior to R9, this exact string was duplicated literally across six provider
 * adapters (xai, vertex-ai, deepseek, google, openrouter, cohere). Any edit to
 * one would silently drift the others out of sync, producing per-provider
 * divergence in moderation behavior. All adapters now import this single
 * source of truth.
 *
 * Scope of R9: centralization only. The semantics of the moderation flow are
 * intentionally unchanged — the string is byte-for-byte identical to the prior
 * duplicated value so provider behavior is unaffected.
 */

export const MODERATION_ANALYZER_SYSTEM_PROMPT =
  'You are a content moderation analyzer. Respond only with valid JSON.';
